#!/bin/sh
# What a runner does, as a script rather than as YAML.
#
# The first version of this lived in `.github/workflows/deploy.yml` as five
# `run:` blocks, and every one of them was unreachable by any driver — a
# workflow file is exercised by pushing and watching. `deploy.sh` had already
# written down why that is the wrong shape, one file over: *"keeping the logic
# here rather than in a workflow file is what makes 'deploy' the same act
# whether a person or a runner performs it, and what lets it be tested by
# running it."* This is that sentence applied to the runner's own half.
#
# So everything that decides anything is here, and `deploy.yml` is a checkout
# and one call. `deploycheck` drives every branch below with no host, no
# network and no secrets, through two seams:
#
#   SSH  — what actually reaches the box. `echo` in the driver, so the exact
#          remote command is an assertion rather than a hope.
#   GH   — how the commit's CI verdict is read. A stub in the driver, so both
#          the green and the red path are exercised.
#
# The same seam idea as `SmtpDialer` and `AgentProcess`: the thing that needs
# the world is one substitutable command, and everything around it is ordinary
# code somebody can run.
#
# **This deploys the control plane and refuses to deploy a daemon**, which is
# not a limitation but the decision `CLAUDE.md` records, enforced here instead
# of described: a daemon restart interrupts every turn in flight and drops every
# pending approval, and no button should be able to do that to somebody's work.
set -eu

SSH=${SSH:-ssh}
GH=${GH:-gh}
SSH_KEYSCAN=${SSH_KEYSCAN:-ssh-keyscan}
SSH_DIR=${SSH_DIR:-$HOME/.ssh}

DEPLOY_SERVICE=${DEPLOY_SERVICE:-control-plane}
DEPLOY_DIR=${DEPLOY_DIR:-\~/reemoat}

fail() {
  echo "$@" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# What must be set, checked before anything touches a host.
#
# A missing secret is a configuration mistake and has to read as one, rather
# than as ssh failing obscurely half a minute later against `@` as a hostname.
# ---------------------------------------------------------------------------

missing=""
[ -n "${DEPLOY_HOST:-}" ] || missing="$missing DEPLOY_HOST"
[ -n "${DEPLOY_USER:-}" ] || missing="$missing DEPLOY_USER"
[ -n "${DEPLOY_SSH_KEY:-}" ] || missing="$missing DEPLOY_SSH_KEY"
[ -n "${DEPLOY_REF:-}" ] || missing="$missing DEPLOY_REF"

if [ -n "$missing" ]; then
  fail "missing:$missing

  DEPLOY_HOST     the control plane's host, e.g. app.example.com
  DEPLOY_USER     the account that owns the checkout there
  DEPLOY_SSH_KEY  a private key whose public half is in that account's
                  authorized_keys
  DEPLOY_REF      the commit to deploy

Until they are set, deploy by hand on the box: deploy/deploy.sh --ref <sha>"
fi

# ---------------------------------------------------------------------------
# The daemon is not deployable from here, and that is the point.
#
# `CLAUDE.md`: a daemon restart leaves every live session `interrupted`, on the
# same conversation, and drops every pending approval — the sessions come back,
# the work in them does not. That is why there is no CD for it, and a comment
# saying so is weaker than a refusal.
# ---------------------------------------------------------------------------

if [ "$DEPLOY_SERVICE" != "control-plane" ]; then
  fail "refusing to deploy \"$DEPLOY_SERVICE\" from CI.

  Only the control plane is deployable this way. A daemon restart interrupts
  every turn in flight and drops every pending approval on that machine, so it
  stays a thing somebody does on the host, in front of the work it costs:

    deploy/deploy.sh --service daemon"
fi

# ---------------------------------------------------------------------------
# Refuse a commit whose checks are not green.
#
# A gate rather than a courtesy: the drivers are this repository's whole
# automated safety net, and "pushed, then deployed before the run finished" is
# the one way to route around them. `DEPLOY_SKIP_CHECK_GATE=1` is the escape,
# and it is deliberately awkward to type.
# ---------------------------------------------------------------------------

if [ "${DEPLOY_SKIP_CHECK_GATE:-0}" = "1" ]; then
  echo "check gate skipped by DEPLOY_SKIP_CHECK_GATE"
else
  verdict=$("$GH" run list --workflow check --commit "$DEPLOY_REF" \
    --json conclusion,status --limit 20 \
    --jq '[.[] | select(.status == "completed")] | first | .conclusion // "none"' 2>/dev/null || echo "unknown")
  echo "check for $DEPLOY_REF: $verdict"
  if [ "$verdict" != "success" ]; then
    fail "refusing to deploy $DEPLOY_REF: its \`check\` run is \"$verdict\".

  Wait for it, or fix it. If you mean to go around it, say so out loud:
  DEPLOY_SKIP_CHECK_GATE=1"
  fi
fi

# ---------------------------------------------------------------------------
# The key, and the host it is allowed to reach.
# ---------------------------------------------------------------------------

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
key_file="$SSH_DIR/id_reemoat_deploy"

# `umask` before the write rather than `chmod` after it: between the two there
# is a moment when the key is readable, and on a shared runner that is a moment
# somebody could take it.
(umask 077 && printf '%s\n' "$DEPLOY_SSH_KEY" > "$key_file")

# Removed however this exits — a key left on a runner outlives the job on any
# host that reuses one.
cleanup() { rm -f "$key_file"; }
trap cleanup EXIT INT TERM

# Pinned rather than trusted on first use. `StrictHostKeyChecking=no` on a
# deploy path accepts whatever answers, which is the one thing a path that runs
# `git reset --hard` as somebody's user must not do.
"$SSH_KEYSCAN" -H "$DEPLOY_HOST" >> "$SSH_DIR/known_hosts" 2>/dev/null || true

# ---------------------------------------------------------------------------
# The deploy itself — `deploy.sh`, never a reimplementation of it.
#
# That script is what refuses a dirty tree, resolves its tools before touching
# the checkout, restarts only what the diff touched, and keeps the relay's
# tunnels up for a change that never reached them. Rewriting any of that here
# would be a second copy of the decisions, and the two would disagree.
# ---------------------------------------------------------------------------

remote="cd $DEPLOY_DIR && deploy/deploy.sh --ref $DEPLOY_REF --service $DEPLOY_SERVICE"
echo "deploying $DEPLOY_REF to $DEPLOY_USER@$DEPLOY_HOST"
"$SSH" -i "$key_file" -o BatchMode=yes "$DEPLOY_USER@$DEPLOY_HOST" "$remote"
