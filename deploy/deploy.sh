#!/bin/sh
# deploy/deploy.sh [--service daemon|control-plane|all] [--ref <git-ref>] [--force]
#
# The update path, for every machine that runs any part of this: fetch, move the
# checkout, install what changed, rebuild what needs rebuilding, restart only
# what has to restart, and prove the result answers.
#
# It is one script for two services because they share a repository and nothing
# else. What each one does on an update has almost no overlap — the control plane
# builds the web UI it serves and the daemon builds nothing at all — so the
# per-service work is separated below rather than merged into a list of steps that
# happen to be skipped half the time.
#
# CI is wired to this now, and it calls exactly this script with `--ref <sha>` —
# `.github/workflows/deploy.yml`, for the control plane only. Keeping the logic
# here rather than in a workflow file is what makes "deploy" the same act whether
# a person or a runner performs it, and what lets it be tested by running it.
# That workflow is `workflow_dispatch` and nothing else: the runner replaces the
# ssh session, never the judgement about when.
set -eu

# shellcheck source=deploy/lib.sh
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

REF="origin/main"
WANT=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --service)
      [ $# -ge 2 ] || {
        echo "--service needs a value" >&2
        exit 2
      }
      WANT="$2"
      shift 2
      ;;
    --ref)
      [ $# -ge 2 ] || {
        echo "--ref needs a value" >&2
        exit 2
      }
      REF="$2"
      shift 2
      ;;
    # For a machine whose services are installed but whose checkout is already at
    # the target commit — after a failed deploy, or a hand-edited environment.
    # Without it "nothing changed" correctly does nothing at all.
    --force)
      FORCE=1
      shift
      ;;
    -h | --help)
      echo "usage: deploy/deploy.sh [--service daemon|control-plane|all] [--ref <git-ref>] [--force]"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Which services this machine runs
# ---------------------------------------------------------------------------
#
# Derived from what is installed, not from a flag with a default. A host running
# only the daemon should not have to remember to say so on every deploy, and a
# default of "all" would have it building a web UI nothing there serves.

# **Refused before anything else, because the next step deletes the program the
# old unit runs.** A host whose control plane is still a launchd plist or a
# systemd unit is invisible to `svc_installed` — the backend is `docker` and
# there is no container — so this script would deploy the daemon alone, report
# success, and `git reset --hard` would remove `deploy/run-cp.sh`, which is
# `@EXEC@` in every already-rendered control-plane unit. Nothing breaks until the
# next reboot, at which point launchd execs a missing file and retries it every
# ten seconds for ever, taking the fleet's identity, relay and web UI with it.
#
# Not a warning. The whole point of the refusal is that the damage is invisible
# at the time and unattributable later.
for svc in $SERVICES; do
  if legacy_unit_present "$svc"; then
    echo >&2
    echo "$svc still has a $INIT_SYSTEM unit at $(unit_target "$svc")," >&2
    echo "but it now runs as a container. This deploy would remove the program" >&2
    echo "that unit execs, and you would not find out until the next reboot." >&2
    echo >&2
    echo "  migrate first: $DEPLOY_DIR/docker/README.md" >&2
    echo "  it carries the database across — which holds the key that signs" >&2
    echo "  every token in the fleet — and then removes the unit." >&2
    exit 2
  fi
done

TARGETS=""
# `svc_installed` has three answers and 2 is "could not ask" — an engine that is
# not running, or a user not in the docker group. Dropping the service on that
# would restart the daemon to NEW and leave the control plane on OLD, out of one
# `^src/` diff, and exit 0.
case "$WANT" in
  "" | all)
    for svc in $SERVICES; do
      _rc=0
      svc_installed "$svc" || _rc=$?
      case "$_rc" in
        0) TARGETS="${TARGETS:+$TARGETS }$svc" ;;
        1) ;;
        *)
          echo "cannot tell whether $svc is installed here." >&2
          echo "  its backend did not answer — is the container engine running," >&2
          echo "  and is $(id -un) allowed to talk to it?" >&2
          echo "  refusing rather than deploying the other service alone." >&2
          exit 2
          ;;
      esac
    done
    if [ -z "$TARGETS" ]; then
      echo "no Reemoat services are installed on this machine." >&2
      echo "  run: $DEPLOY_DIR/install.sh <daemon|control-plane>" >&2
      exit 2
    fi
    ;;
  *)
    valid_service "$WANT" || {
      # `$SERVICES` rather than a transcription of it: this line named two
      # services for one revision after `relay` became a third and a valid
      # argument, so somebody following the error would never have found the one
      # verb that recreates the relay alone.
      echo "unknown service: $WANT (expected one of: $SERVICES)" >&2
      exit 2
    }
    _rc=0
    svc_installed "$WANT" || _rc=$?
    case "$_rc" in
      0) ;;
      1)
        echo "$WANT is not installed on this machine." >&2
        echo "  run: $DEPLOY_DIR/install.sh $WANT" >&2
        exit 2
        ;;
      *)
        echo "cannot tell whether $WANT is installed here — its backend did not answer." >&2
        exit 2
        ;;
    esac
    TARGETS="$WANT"
    ;;
esac

echo "deploying: $TARGETS"
echo "  repository: $REPO_ROOT"

# **Before anything irreversible.** This script shells out to git and pnpm, and
# until now resolved neither: they came off the invoker's PATH, so a missing one
# surfaced *after* `git reset --hard` had already moved the checkout.
# That future arrived as a GitHub-hosted runner reaching this over ssh with
# `--ref <sha>`, which is the same shape for this purpose: a non-login shell with
# exactly the minimal PATH that `runtime_path` exists to defend the units
# against.
require_deploy_tools $TARGETS

# Everything after the reset runs against a checkout that has already moved, so a
# failure there leaves the source at NEW and the dependencies or the bundle at
# OLD — with the services still running whatever they loaded at their last
# start. The next crash, KeepAlive restart or reboot then brings NEW source up
# against OLD dependencies, at a moment nobody is watching. Exiting bare said none
# of that.
DEPLOY_STAGE=pre-reset
_on_exit() {
  _rc=$?
  case "${DEPLOY_STAGE:-}" in
    post-reset)
      [ "$_rc" -ne 0 ] || return 0
      echo >&2
      echo "deploy failed with the checkout already moved to ${NEW_SHORT:-?}." >&2
      # No longer "the agent image": that was the per-tenant sandbox, deleted
      # along with the tenancy model, and the message outlived it. The
      # control plane's image is a real artifact again, but it is built in a
      # later stage and has its own arm below.
      echo "  dependencies and the control-plane image may still be from" >&2
      echo "  ${OLD_SHORT:-?}, and the services are running whatever they last loaded." >&2
      ;;
    image-built)
      [ "$_rc" -ne 0 ] || return 0
      echo >&2
      # A genuinely new mid-way state, and one that survives a reboot: nothing
      # before the container existed could be at NEW while the running process
      # was at OLD in a way a restart would not resolve.
      echo "deploy failed with the control-plane image built and tagged at ${NEW_SHORT:-?}" >&2
      echo "  while the running container is still the old one." >&2
      echo >&2
      echo "  finish it:      $DEPLOY_DIR/compose.sh up -d" >&2
      ;;
    *) exit "$_rc" ;;
  esac
  echo >&2
  echo "  fix and retry:  $DEPLOY_DIR/deploy.sh --force" >&2
  echo "  or roll back:   $DEPLOY_DIR/deploy.sh --ref ${OLD_SHORT:-<old-sha>}" >&2
  exit "$_rc"
}
trap _on_exit EXIT

# ---------------------------------------------------------------------------
# Refuse to destroy work
# ---------------------------------------------------------------------------
#
# This does `git reset --hard`, which is the correct way to make a checkout be a
# commit and a catastrophic way to treat a working tree somebody is editing.
#
# The advice this replaces was "keep production in its own clone", and that is
# still the right topology — but advice only protects the operator who followed
# it, while a refusal protects the one who ran this in the directory they happen
# to develop in. Which, on a machine where the daemon runs next to the work, is
# the likeliest mistake there is.
if [ -n "$("$GIT_BIN" -C "$REPO_ROOT" status --porcelain)" ]; then
  echo >&2
  echo "the working tree at $REPO_ROOT has uncommitted changes." >&2
  echo "deploy would run 'git reset --hard' and destroy them. Refusing." >&2
  echo >&2
  echo "  commit or stash them, or deploy from a separate clone:" >&2
  echo "    git clone <url> ~/srv/reemoat && ~/srv/reemoat/deploy/install.sh ..." >&2
  exit 2
fi

OLD=$("$GIT_BIN" -C "$REPO_ROOT" rev-parse HEAD)

if ! "$GIT_BIN" -C "$REPO_ROOT" fetch --quiet --prune origin; then
  # Not fatal on its own: `--ref` may already name a commit this clone holds,
  # which is exactly the case when rolling back during an outage that is itself
  # the reason the network is unhappy.
  echo "  warning: git fetch failed; resolving $REF from the local clone"
fi

NEW=$("$GIT_BIN" -C "$REPO_ROOT" rev-parse --verify "${REF}^{commit}" 2>/dev/null) || {
  echo "cannot resolve ref: $REF" >&2
  exit 2
}

# ⚠ **A pull host is never idle on the strength of the checkout alone.** This
# gate asks "did the commit move", which in build mode is the whole of what the
# image is made from. Against a registry it is the wrong repository: the
# documented way to take a new image is to edit `REEMOAT_CP_IMAGE` in the env
# file and run this — and that moves no commit, so the gate answered "already at
# <sha> — nothing to do" and exited 0 without pulling or restarting anything. It
# would also have swallowed the very first build→pull switch on any current host.
# The same argument the pull arm makes further down, applied one level up.
_idle_ok=1
[ "$(cp_image_source)" = pull ] && _idle_ok=0

if [ "$OLD" = "$NEW" ] && [ "$FORCE" -eq 0 ] && [ "$_idle_ok" -eq 1 ]; then
  echo "  already at $("$GIT_BIN" -C "$REPO_ROOT" rev-parse --short "$NEW") — nothing to do"
  echo
  # Collected rather than fatal, for the same reason as the restart loop below:
  # this branch is a read-only status report, and aborting at the first unhealthy
  # service would leave the second one unreported on a host running both.
  _idle_failed=""
  for svc in $TARGETS; do
    running=$(svc_pid "$svc" || true)
    echo "$svc: pid ${running:-none}"
    wait_healthy "$svc" || _idle_failed="${_idle_failed:+$_idle_failed }$svc"
  done
  [ -z "$_idle_failed" ] || {
    echo "not answering: $_idle_failed" >&2
    exit 1
  }
  exit 0
fi

OLD_SHORT=$("$GIT_BIN" -C "$REPO_ROOT" rev-parse --short "$OLD")
NEW_SHORT=$("$GIT_BIN" -C "$REPO_ROOT" rev-parse --short "$NEW")
echo "  $OLD_SHORT -> $NEW_SHORT ($REF)"

# **Say what is about to be run, not just where it came from.** The default ref is a
# mutable remote branch, and the next two steps execute that tree's lifecycle
# scripts on the machine your agents run on, as you. Nothing here can make that
# safe by itself; it can stop being silent about it, and it can enforce a
# signature wherever a signing policy actually exists.
echo "  $("$GIT_BIN" -C "$REPO_ROOT" log -1 --format='%an, %ad — %s' --date=short "$NEW")"
if [ -n "${REEMOAT_DEPLOY_REQUIRE_SIGNATURE:-}" ]; then
  if "$GIT_BIN" -C "$REPO_ROOT" verify-commit "$NEW" 2>/dev/null; then
    echo "  signature: ok"
  else
    echo "commit $NEW_SHORT carries no signature this machine trusts," >&2
    echo "and REEMOAT_DEPLOY_REQUIRE_SIGNATURE is set. Refusing." >&2
    exit 2
  fi
fi

"$GIT_BIN" -C "$REPO_ROOT" reset --quiet --hard "$NEW"
DEPLOY_STAGE=post-reset

# ---------------------------------------------------------------------------
# What changed
# ---------------------------------------------------------------------------
#
# The whole point of the gating below is that a restart is not free. The control
# plane's costs an outage of every relay tunnel — they reconnect on their own,
# with full jitter, which is designed for exactly this. The daemon's costs every
# live session: they come back `interrupted`, and an approval that was waiting
# when it went down is gone for good, because a pending permission holds a live
# resolve closure that cannot be serialized.
#
# So a deploy restarts what the change actually touched, and says which.

CHANGED=$("$GIT_BIN" -C "$REPO_ROOT" diff --name-only "$OLD" "$NEW")

touched() {
  if [ "$FORCE" -eq 1 ]; then return 0; fi
  for _pat in "$@"; do
    if printf '%s\n' "$CHANGED" | grep -Eq "$_pat"; then return 0; fi
  done
  return 1
}

# What makes `pnpm install` necessary: any manifest in the workspace, or the
# lockfile. Both services live in this one dependency tree.
INSTALL_DEPS='^package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^packages/[^/]+/package\.json$'

# What makes a *service* restart, and the narrowing is the whole point.
#
# This used to be the pattern above, which matches `packages/web/package.json` —
# so a lucide-react bump fed straight into the daemon's restart test and turned
# every live session `interrupted`, dropping every pending permission, to deliver
# a change to a bundle the daemon does not serve. `CLAUDE.md` and the README both
# said a change confined to `packages/web` restarts nothing; this is what makes
# that true.
#
# `pnpm-lock.yaml` is deliberately absent too. It moves for any package in the
# workspace, so as a restart trigger it has the same fault one level down. The
# cost is stated rather than hidden: a transitive dependency of the daemon that
# moves in the lockfile alone reaches the running process at its next restart
# rather than at this one — which is what a running process does with its
# already-loaded modules regardless.
RESTART_DEPS='^package\.json$'

# The root src/ is imported by the control plane through ../../../src/, so a
# change there is a change to both services. That shared import is the reason
# these two ship from one repository at all.
SHARED='^src/'

# The deployment machinery is not exempt from its own gating. A changed wrapper is
# what the supervisor `exec`s, so it needs the same restart as the code it starts;
# a changed template needs a re-render *and* a reload, because nothing on this
# path used to call `install.sh` and a new `KeepAlive` or `TimeoutStopSec` landed
# in the checkout and nowhere else.
#
# **Only this machine's own template.** The pattern matched both, so a comment-only
# edit to `deploy/systemd/reemoat.service.in` — a file that is inert on a launchd
# host — re-rendered the plist and reloaded the daemon, turning every live session
# `interrupted` and dropping every pending permission to deliver a change the
# machine does not use. That is the same over-broad trigger `RESTART_DEPS` was split
# out of `INSTALL_DEPS` to close, one level up.
UNITS="^deploy/$INIT_SYSTEM/"

# What goes *into* the control plane's image, which is a wider set than what
# restarts the daemon — deliberately, and the asymmetry has a reason rather than
# an oversight behind it.
#
# `RESTART_DEPS` is the root manifest alone because a lucide-react bump must not
# turn every live session `interrupted` and drop every pending permission.
# Nothing comparable is at stake here: recreating this container drops the relay
# tunnels, which reconnect on their own with full jitter. **So the rule is
# decided by the cost, not by the artifact**, and once that is said out loud it
# is fine for the two services to disagree about `pnpm-lock.yaml`.
#
# `^packages/web/` is on this list, and it is the row that gets worse. A web-only
# change used to restart *nothing* — the SPA fallback re-reads index.html from
# disk per request precisely so it could — and with the bundle baked into the
# image it becomes a rebuild and a recreate. The alternative, bind-mounting
# `dist` from the host, preserves the old behaviour and destroys the property
# that makes containerising worth doing, because the image would no longer be the
# deployment. There is no escape hatch today — `REEMOAT_CP_WEB` names a path
# inside the container and nothing mounts a host directory there.
#
# `tsconfig.json` is on the list because the image copies it and `tsx` resolves
# it: `packages/control-plane` has no tsconfig of its own, so the root one is
# what compiles every file in that container. Without it a tsconfig-only commit
# ran no build, and the image-id comparison below cannot catch what was never
# built — so the log said "nothing that goes into it moved" about a file that
# had.
CP_IMAGE_INPUTS='^src/|^packages/control-plane/|^packages/web/|^package\.json$|^tsconfig\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^deploy/docker/|^\.dockerignore$'

# What goes into the **relay**, which is a subset of the image and the reason the
# split is worth anything.
#
# One image runs both services, so the image id moves for a CSS change — and the
# image id is what decides whether the control plane is recreated. If it decided
# for the relay too, a web-only deploy would go on dropping every tunnel in the
# fleet and the split would have bought nothing while looking complete. So the
# relay gets its own list, and it is `and`ed with the image id below: a rebuild
# that produced nothing new recreates neither, and a rebuild that produced
# something recreates the relay only if that something was *its*.
#
# The cost of getting this list wrong is a relay left running code it should have
# replaced — silent, and exactly the "written down twice" shape as the
# .dockerignore/Dockerfile pair. So it is not maintained by inspection:
# `deploycheck` walks the import closure of `packages/control-plane/src/relay/main.ts`
# and fails if any file it reaches is outside this pattern.
#
# `schema.sql` is on the list for a reason no import closure would show: the relay
# holds prepared statements against `machines`, `users`, `grants`, `signing_keys`
# and `machine_tunnel_keys`, and an un-recreated relay beside a migrated database
# is the one skew that fails at runtime rather than at start.
#
# `quota.ts` and the three files it drags in (`settings.ts` for the instance
# default, and `machines.ts` and `mail/address.ts` behind that) arrived with the
# machine limit, which the relay enforces itself: `relay/authorize.ts` refuses a
# machine over its owner's limit before a byte enters the tunnel, and
# `tunnel-endpoint.ts` refuses the dial. A relay left running the old rule would
# keep carrying traffic for machines the API considers switched off — which is
# precisely the silent skew this list exists to prevent, and `deploycheck` caught
# the omission the moment the import landed.
RELAY_INPUTS='^src/relay/|^src/(token|auth|http|cors)\.ts$|^packages/control-plane/src/relay/|^packages/control-plane/src/(store|keys|quota|settings|machines)\.ts$|^packages/control-plane/src/mail/address\.ts$|^packages/control-plane/src/schema\.sql$|^package\.json$|^tsconfig\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^deploy/docker/|^\.dockerignore$'

# Both tsx binaries, not just the root one — `packages/control-plane` is a
# separate workspace package with its own node_modules, so a tree wiped by a
# `pnpm prune`, a moved store or a partial install used to pass this guard, skip
# the install, restart and die with exit 127 under a supervisor retrying every
# ten seconds.
#
# **Only when a unit-backed service is a target.** The control plane's
# dependencies are installed inside its image now, so a control-plane-only host
# has no workspace tree to keep current and no reason to have pnpm at all — which
# is why `require_deploy_tools` no longer demands one. The skip is announced with
# its reason rather than silently, because a step that used to be unconditional
# vanishing from a log reads as a bug.
#
# The `packages/control-plane/node_modules/.bin/tsx` half of the guard stays, and
# the reason changed rather than vanished: nothing supervised execs it any
# more, but `cpctl` on a host that has a workspace still does. On a host without
# one, that path falls through to running the same file inside the container.
_needs_workspace=0
for svc in $TARGETS; do
  [ "$(service_backend "$svc")" = unit ] && _needs_workspace=1
done

if [ "$_needs_workspace" -eq 0 ]; then
  echo "  pnpm install: skipped (no unit-backed service here; the control plane installs inside its image)"
elif touched "$INSTALL_DEPS" ||
  [ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ] ||
  [ ! -x "$REPO_ROOT/packages/control-plane/node_modules/.bin/tsx" ]; then
  echo "  pnpm install"
  (cd "$REPO_ROOT" && "$PNPM_BIN" install --frozen-lockfile)
else
  echo "  pnpm install: skipped (no manifest or lockfile change)"
fi

# ---------------------------------------------------------------------------
# Per-service work
# ---------------------------------------------------------------------------

restart_list=""
reload_list=""
BUILD_FAILED=""

# **Declared before the loop that can now add to it.** The image build below
# collects a failure rather than aborting, which is the same rule the restart
# loop further down was fixed to follow; under `set -u` a `FAILED` first assigned
# after that loop would be an unbound variable at exactly the moment something
# had gone wrong.
FAILED=""

# ---------------------------------------------------------------------------
# The image, once
# ---------------------------------------------------------------------------
#
# **Outside the per-service loop, because one image now serves two services.**
# Built per-service it would be built twice on the ordinary host that runs both —
# the second a full cache hit, so not wrong, but the *decisions* downstream read
# `_before_image` and `_after_image`, and a second build between them would
# compare an id against itself and report "unchanged" for a rebuild that had just
# happened.
#
# Nothing here recreates anything. This step answers one question — did the image
# move — and the loop below decides, per service, what that means.
CP_IMAGE_MOVED=0
_cp_targets=""
for svc in $TARGETS; do
  [ "$(service_backend "$svc")" = docker ] && _cp_targets="${_cp_targets:+$_cp_targets }$svc"
done

if [ -n "$_cp_targets" ]; then
  echo
  echo "image:"
  # The reason is worked out before the build rather than implied by which branch
  # ran, because `touched` answers true for everything under --force and a message
  # naming a path would then be a plain falsehood in the log of a deploy nobody
  # was watching.
  # **Built here or pulled from a registry, decided in one place.**
  # `cp_image_source` derives it from the shape of `REEMOAT_CP_IMAGE` and
  # `REEMOAT_CP_SOURCE` overrides. Printed on every run rather than inferred from
  # which branch produced output: a mode switch nobody can see in the log is how
  # a host ends up in the state `deploy/README.md` used to warn about in prose.
  _cp_source=$(cp_image_source)
  echo "  source: $_cp_source ($(cp_image_ref))"

  why=""
  if [ "$_cp_source" = pull ]; then
    # **No diff is consulted, and that is a simplification rather than a gap.**
    # `CP_IMAGE_INPUTS` is a *guess* at what a build would produce; against a
    # registry the ref is a name for exact bytes, and asking git whether they
    # moved is asking the wrong repository. A pull whose digest is already local
    # is a no-op, so the unconditional form costs nothing.
    why="pulling"
  elif [ "$FORCE" -eq 1 ]; then
    why="--force"
  elif touched "$CP_IMAGE_INPUTS"; then
    why="an image input changed"
  fi

  # The fingerprint, not `.Id`. On a containerd image store `.Id` is the digest
  # of the OCI *index*, which buildkit re-exports every build — so this compared
  # the wrapper and answered "moved" for three consecutive cached builds of an
  # unchanged tree. `cp_image_fingerprint` is layers plus config, measured stable
  # across the same three; the reasoning is written at the function.
  # ⚠ **In pull mode this is read off the running container, not off the ref.**
  # `cp_image_fingerprint` resolves through `cp_image_ref`, which now reads the
  # env file — i.e. the image being moved *to*. Rolling back by pointing the
  # variable at an older tag that is still in the local store therefore
  # fingerprinted the same value before and after, reported `image: unchanged`,
  # recreated nothing, and exited 0 with the container still on the newer image.
  # In build mode the tag is fixed, so the ref really did describe both sides.
  if [ "$_cp_source" = pull ]; then
    _before_image=$(cp_running_fingerprint control-plane)
  else
    _before_image=$(cp_image_fingerprint)
  fi
  if [ -n "$why" ]; then
    if [ "$_cp_source" = pull ]; then
      echo "  docker pull ($why)"
    else
      echo "  docker build ($why)"
    fi
    # Collected, never a bare statement. `pnpm web:build` used to sit here as
    # one, so under `set -e` a failed bundle aborted the whole script inside the
    # per-service loop — on a host running both, leaving the daemon un-restarted
    # after `git reset --hard` had already moved the tree. That is verbatim the
    # defect the restart loop below was fixed for, and it must not be
    # reintroduced one block up.
    #
    # The pull arm collects the same way and for the same reason: a registry that
    # is down must cost the control plane's restart, never the daemon's.
    # A `case` and not an `&&`/`||` chain. Those are left-associative with equal
    # precedence in sh, so `[ x = pull ] && pull || [ x = build ] && build` runs
    # the **build** after a successful pull — the `||` short-circuits on the
    # pull's own success and hands a true left-hand side to the `&&`. Written
    # once as a one-liner here and caught before it shipped; a `case` cannot say
    # it.
    _image_ok=0
    case "$_cp_source" in
      pull)  "$DEPLOY_DIR/compose.sh" pull  || _image_ok=1 ;;
      build) "$DEPLOY_DIR/compose.sh" build || _image_ok=1 ;;
    esac
    if [ "$_image_ok" -ne 0 ]; then
      # **"PULL FAILED", not "BUILD FAILED".** Two distinct outcomes may not
      # collapse into one message — the rule is written twice in this file
      # already and once in lib.sh — and here the remedies differ completely: one
      # is a compiler or a dependency, the other is a registry, a network or a
      # digest that does not exist yet.
      if [ "$_cp_source" = pull ]; then
        echo "  image: PULL FAILED" >&2
        echo "         $(cp_image_ref) could not be fetched. Nothing has been restarted." >&2
      else
        echo "  image: BUILD FAILED" >&2
      fi
      # Its own list, not FAILED. FAILED is what the health loop appends to, and
      # its final line reads "but these are not answering" — which for a build
      # failure names a container answering perfectly on the old image and sends
      # the operator to read a healthy log. Distinct outcomes must not collapse
      # into one message; that rule is written twice in this file already and
      # once in lib.sh.
      #
      # Every containerised target, because one build served all of them.
      BUILD_FAILED="$_cp_targets"
    fi
  else
    echo "  image: skipped (nothing that goes into it moved)"
  fi

  if [ -z "$BUILD_FAILED" ]; then
    # The *ref* on both modes here: after a pull it names exactly what the next
    # `up -d` will run, which is the other half of the comparison.
    _after_image=$(cp_image_fingerprint)
    # From here a failure leaves an image at NEW and a container at OLD, which is
    # a different remedy from "the checkout moved" — see the EXIT trap.
    if [ "$_before_image" != "$_after_image" ]; then
      CP_IMAGE_MOVED=1
      DEPLOY_STAGE=image-built
    fi
    echo "  image: $([ "$CP_IMAGE_MOVED" -eq 1 ] && echo "moved" || echo "unchanged")"
  fi
fi

for svc in $TARGETS; do
  echo
  echo "$svc:"

  # A template change re-renders here rather than waiting for somebody to run
  # install.sh again. `render_unit` lives in lib.sh for exactly this reason, and
  # the reload that follows subsumes a restart — so a service on this list is
  # deliberately not added to `restart_list` as well.
  # Rendered to one side and compared, so an edit that does not change the rendered
  # bytes — a comment, a reordering, a change to the other init system's copy that
  # slipped past the pattern — costs nothing. A reload restarts, and for the daemon
  # a restart is the most expensive thing this script can do.
  # Gated on the backend as well as on the pattern: on a launchd host running a
  # containerised control plane, an edit to the plist template must not send
  # `render_unit` looking for a unit that service does not have — it refuses, and
  # refusing mid-loop would abort a deploy over a file the service never reads.
  if [ "$(service_backend "$svc")" = unit ] && touched "$UNITS"; then
    _unit=$(unit_target "$svc")
    render_unit "$svc" "$_unit.new"
    if cmp -s "$_unit.new" "$_unit"; then
      rm -f "$_unit.new"
      echo "  unit: unchanged (template moved, render did not)"
    else
      mv "$_unit.new" "$_unit"
      echo "  unit: re-rendered ($_unit)"
      reload_list="${reload_list:+$reload_list }$svc"
    fi
  fi

  # A build that failed left every containerised service on its old image, and
  # there is nothing per-service left to decide about it.
  case " $BUILD_FAILED " in *" $svc "*) continue ;; esac

  case "$svc" in
    control-plane)
      # No `web:build` and no `pnpm install` here any more: both moved inside the
      # image, which is what lets a control-plane host carry no package manager,
      # no node_modules and no web toolchain. The build itself moved *out of this
      # loop*, because one image now serves this service and the relay both.
      #
      # **What the image *is* decides, not a pattern.** A rebuild whose layers all
      # came from cache produces byte-identical layers and config, so "unchanged"
      # is a measurement where a path regex is a guess. It errs in the safe
      # direction: a cold cache says "changed" when nothing did, and the cost of
      # that is one recreate nobody needed — `compose up -d` is idempotent, so a
      # wrong prediction costs a truthful log line and no action.
      #
      # This said "the image **id** decides" and that was false everywhere it was
      # written: `.Id` is the OCI index digest and buildkit re-exports it every
      # build, so *every* deploy that rebuilt landed in the "safe direction" and
      # recreated the API for nothing. `cp_image_fingerprint` is what closed it.
      if [ "$CP_IMAGE_MOVED" -eq 1 ] ||
        touched '^deploy/docker/compose\.yml$' '^deploy/compose\.sh$'; then
        restart_list="${restart_list:+$restart_list }$svc"
      fi
      ;;

    relay)
      # **The one place the split is cashed in.**
      #
      # Both terms are required and each covers the other's failure. The image id
      # alone would recreate the relay for a CSS change, which is exactly the cost
      # this service was separated to stop paying: every tunnel in the fleet, tens
      # of seconds of reconnecting for every open session, every in-flight
      # request, and any approval tapped in the window. `RELAY_INPUTS` alone would
      # recreate it for a change that never survived into an image, which is the
      # guess the image id replaced with a measurement.
      #
      # A compose or wrapper change still recreates it either way: that is a
      # change to how the container itself is defined, and no image id can see it.
      if { [ "$CP_IMAGE_MOVED" -eq 1 ] && touched "$RELAY_INPUTS"; } ||
        touched '^deploy/docker/compose\.yml$' '^deploy/compose\.sh$'; then
        restart_list="${restart_list:+$restart_list }$svc"
      elif svc_container_missing "$svc"; then
        # The first deploy on a host that predates the split, and the one case
        # where "nothing moved" must still act: there is no relay container at
        # all, the control plane beside it is about to stop holding tunnels, and
        # nothing else in this script would ever create one.
        echo "  create: the relay has no container here yet"
        restart_list="${restart_list:+$restart_list }$svc"
      else
        echo "  recreate: no — nothing the relay is made of moved, so the tunnels stay up"
      fi
      ;;

    daemon)
      # Nothing to build. The daemon runs straight off tsx and spawns agents from
      # PATH, so an update is a checkout, an install, and a restart if anything
      # the running process already loaded has moved.
      if touched "$SHARED" '^scripts/daemon\.ts$' "$RESTART_DEPS" '^deploy/run-daemon\.sh$'; then
        restart_list="${restart_list:+$restart_list }$svc"
      fi
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Restart, then prove it
# ---------------------------------------------------------------------------

# A reload restarts the service as part of making it re-read its unit, so the two
# lists merge for the announcement and the reload wins when acting.
act_list="$reload_list"
for svc in $restart_list; do
  case " $reload_list " in
    *" $svc "*) ;;
    *) act_list="${act_list:+$act_list }$svc" ;;
  esac
done

echo
if [ -z "$act_list" ]; then
  echo "restart: none"
else
  # **A case over the service, not `daemon` versus everything else.** This is the
  # one place a deploy says what an operator is about to lose, and with a third
  # service the `else` arm said two false things at once: it printed
  # "control-plane" while recreating the *relay*, and it attributed dropped
  # tunnels to the control plane — which is exactly backwards after the split,
  # where the API holds no tunnel at all and the relay holds every one of them.
  # A missing arm is a silent falsehood here, so there is no catch-all.
  for svc in $act_list; do
    case "$svc" in
      daemon)
        # Before, not after. This is a consequence somebody may want to wait out.
        #
        # It used to say every live session becomes 'interrupted' and name the
        # command to reattach one by hand. Both halves were wrong by the end: a
        # *graceful* stop writes `daemon_shutdown`, which derived `exited` rather
        # than `interrupted`, and the daemon now puts an agent back on every
        # session it ended by itself at the next boot. What is still lost is real
        # and is what this line is for.
        echo "restart: daemon — the daemon reattaches an agent to each session on"
        echo "         its way back up, in the same conversation. A turn that was"
        echo "         in flight does not continue, and a pending approval is gone."
        ;;
      relay)
        # The expensive one, and the whole reason the other is now cheap.
        echo "restart: relay — every tunnel in the fleet drops and redials. Sessions"
        echo "         reconnect on their own; requests in flight are lost, and so is"
        echo "         an approval tapped in the window."
        ;;
      control-plane)
        # Says what it does *not* cost, because that is the new fact and the one
        # somebody deciding whether to wait needs. True under the shape compose.yml
        # pins (`REEMOAT_CP_RELAY_MODE=external`), which is the only shape this
        # script deploys; when the relay is being recreated too, its own line above
        # is what carries the cost.
        echo "restart: control-plane — the API and the web UI. The tunnels belong to"
        echo "         the relay, so nothing that is connected notices."
        ;;
    esac
  done
fi

# **Failures are collected, not fatal.** `svc_restart` and `wait_healthy` return
# non-zero, and as plain statements under `set -e` they aborted this loop. TARGETS
# is built by iterating `SERVICES="daemon control-plane"`, so on a host running
# both, a daemon that failed its health probe meant the control plane was **never
# restarted at all** — after `git reset --hard` had already moved the checkout —
# and `deployed <sha>` never printed, so nothing said the other half had not
# happened. Every target is finished now, and the exit status is decided at the end.
#
# `FAILED` is declared above, before the per-service loop that also appends to it.

for svc in $TARGETS; do
  before=$(svc_pid "$svc" || true)
  case " $reload_list " in
    *" $svc "*)
      if svc_reload "$svc"; then
        echo "$svc: pid ${before:-none} -> $(svc_pid "$svc" || true) (unit reloaded)"
      else
        echo "$svc: reload FAILED" >&2
        FAILED="${FAILED:+$FAILED }$svc"
        continue
      fi
      ;;
    *)
      case " $restart_list " in
        *" $svc "*)
          if svc_restart "$svc"; then
            echo "$svc: pid ${before:-none} -> $(svc_pid "$svc" || true)"
          else
            echo "$svc: restart FAILED" >&2
            FAILED="${FAILED:+$FAILED }$svc"
            continue
          fi
          ;;
        *)
          # Printed even when nothing happened, because "restart: none" is a claim an
          # operator should be able to check against a pid that did not move. An
          # empty pid says "not running", which on this branch is worth seeing: it
          # means nothing needed restarting and nothing is up either.
          echo "$svc: pid ${before:-none} (unchanged)"
          ;;
      esac
      ;;
  esac
  wait_healthy "$svc" || FAILED="${FAILED:+$FAILED }$svc"
done

# Past this point the deploy itself is finished: the checkout moved, the install,
# the build and the image all ran against NEW, and the only thing left to report is
# whether a service answered. Clearing the stage keeps the EXIT trap's
# "dependencies may still be from <old>" warning for exits that really did stop
# partway — it used to fire on the line below too, contradicting `deployed <sha>`
# three lines after it printed.
DEPLOY_STAGE=done

echo
# **Its own line, before the health verdict.** A build that failed and a service
# that will not answer are different facts with different remedies, and the
# service whose image failed to build is — by construction — still answering,
# from the old image. Reported under "not answering" it sent an operator to read
# a healthy log and conclude the probe was flaky, while the real outcome was that
# the new commit was never packaged at all.
if [ -n "$BUILD_FAILED" ]; then
  echo "image build FAILED for: $BUILD_FAILED" >&2
  echo "  the old image is still running, so this host is serving $OLD_SHORT" >&2
  echo "  even though the checkout is at $NEW_SHORT." >&2
fi

if [ -n "$FAILED" ] || [ -n "$BUILD_FAILED" ]; then
  echo "deployed $("$GIT_BIN" -C "$REPO_ROOT" rev-parse --short "$NEW")" >&2
  if [ -n "$FAILED" ]; then
    echo "but these are not answering: $FAILED" >&2
    for svc in $FAILED; do echo "  logs: $(log_hint "$svc")" >&2; done
  fi
  exit 1
fi
echo "deployed $("$GIT_BIN" -C "$REPO_ROOT" rev-parse --short "$NEW")"
