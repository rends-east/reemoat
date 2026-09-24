#!/bin/sh
# The runner's half of a control-plane deploy; deploycheck drives every branch through the SSH and GH seams. Never deploys a daemon.
set -eu

SSH=${SSH:-ssh}
GH=${GH:-gh}
SSH_DIR=${SSH_DIR:-$HOME/.ssh}

DEPLOY_SERVICE=${DEPLOY_SERVICE:-control-plane}
DEPLOY_DIR=${DEPLOY_DIR:-\~/reemoat}

fail() {
  echo "$@" >&2
  exit 2
}

missing=""
[ -n "${DEPLOY_HOST:-}" ] || missing="$missing DEPLOY_HOST"
[ -n "${DEPLOY_USER:-}" ] || missing="$missing DEPLOY_USER"
[ -n "${DEPLOY_SSH_KEY:-}" ] || missing="$missing DEPLOY_SSH_KEY"
[ -n "${DEPLOY_KNOWN_HOSTS:-}" ] || missing="$missing DEPLOY_KNOWN_HOSTS"
[ -n "${DEPLOY_REF:-}" ] || missing="$missing DEPLOY_REF"

if [ -n "$missing" ]; then
  fail "missing:$missing

  DEPLOY_HOST         the control plane's host, e.g. app.example.com
  DEPLOY_USER         the account that owns the checkout there
  DEPLOY_SSH_KEY      a private key whose public half is in that account's
                      authorized_keys
  DEPLOY_KNOWN_HOSTS  that host's public keys as known_hosts lines, checked
                      against its own fingerprints. Pinned, never scanned
  DEPLOY_REF          the commit to deploy

Until they are set, deploy by hand on the box: deploy/deploy.sh --ref <sha>"
fi

if [ "$DEPLOY_SERVICE" != "control-plane" ]; then
  fail "refusing to deploy \"$DEPLOY_SERVICE\" from CI.

  Only the control plane is deployable this way. A daemon restart interrupts
  every turn in flight and drops every pending approval on that machine, so it
  stays a thing somebody does on the host, in front of the work it costs:

    deploy/deploy.sh --service daemon"
fi

# Pending is waited on, not refused: a deploy may be dispatched right after the push. Same gate as ci-release.sh; DEPLOY_SKIP_CHECK_GATE=1 skips it.

if [ "${DEPLOY_SKIP_CHECK_GATE:-0}" = "1" ]; then
  echo "check gate skipped by DEPLOY_SKIP_CHECK_GATE"
else
  check_wait=${DEPLOY_CHECK_WAIT_SECONDS:-420}
  check_poll=${DEPLOY_CHECK_POLL_SECONDS:-15}
  waited=0
  while :; do
    verdict=$("$GH" run list --workflow check --commit "$DEPLOY_REF" \
      --json conclusion,status --limit 20 \
      --jq 'if length == 0 then "none"
            elif any(.[]; .status == "completed")
            then ([.[] | select(.status == "completed")] | first | .conclusion // "unknown")
            else "pending" end' 2>/dev/null || echo "unknown")
    [ "$verdict" = "pending" ] || break
    if [ "$waited" -ge "$check_wait" ]; then
      verdict="timeout"
      break
    fi
    echo "check for $DEPLOY_REF: still running, ${waited}s of ${check_wait}s"
    sleep "$check_poll"
    waited=$((waited + check_poll))
  done
  echo "check for $DEPLOY_REF: $verdict"
  if [ "$verdict" = "timeout" ]; then
    fail "refusing to deploy $DEPLOY_REF: its \`check\` run was still going after ${check_wait}s.

  Something is stuck, or a check got slower than this gate expects. Look at it,
  then dispatch again. DEPLOY_CHECK_WAIT_SECONDS raises the bound."
  fi
  if [ "$verdict" != "success" ]; then
    fail "refusing to deploy $DEPLOY_REF: its \`check\` run is \"$verdict\".

  Wait for it, or fix it. If you mean to go around it, say so out loud:
  DEPLOY_SKIP_CHECK_GATE=1"
  fi
fi

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
key_file="$SSH_DIR/id_reemoat_deploy"
known_hosts="$SSH_DIR/known_hosts_reemoat_deploy"

# umask before the write, not chmod after: the key is never readable.
(umask 077 && printf '%s\n' "$DEPLOY_SSH_KEY" > "$key_file")

# Removed however this exits: a key left on a reused runner outlives the job.
cleanup() { rm -f "$key_file"; }
trap cleanup EXIT INT TERM

# Its own file, overwritten: a reused runner's known_hosts may hold keys nobody checked.
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$known_hosts"

# Only deploy.sh, never a reimplementation of its decisions.

remote="cd $DEPLOY_DIR && deploy/deploy.sh --ref $DEPLOY_REF --service $DEPLOY_SERVICE"
echo "deploying $DEPLOY_REF to $DEPLOY_USER@$DEPLOY_HOST"
"$SSH" -i "$key_file" -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$known_hosts" -o GlobalKnownHostsFile=/dev/null \
  "$DEPLOY_USER@$DEPLOY_HOST" "$remote"
