#!/bin/sh
# deploy/deploy.sh [--service daemon|control-plane|all] [--ref <git-ref>] [--force]
# Restarts only what the change touched; CI's deploy workflow runs exactly this script with --ref.
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

# Refused before the reset, which would delete run-cp.sh that an old control-plane unit still execs at the next reboot.
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
# 2 is "could not ask": dropping the service then would deploy the other one alone and exit 0.
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
    # --service control-plane carries the relay: they are one deployment, and the relay arm below still decides for itself.
    if [ "$WANT" = control-plane ] && svc_installed relay; then
      TARGETS="$TARGETS relay"
    fi
    ;;
esac

echo "deploying: $TARGETS"
echo "  repository: $REPO_ROOT"

# Before anything irreversible: a missing tool must fail before git reset --hard moves the checkout.
require_deploy_tools $TARGETS

# After the reset a failure leaves the source at NEW and dependencies or image at OLD, so the trap says how to recover.
DEPLOY_STAGE=pre-reset
_on_exit() {
  _rc=$?
  case "${DEPLOY_STAGE:-}" in
    post-reset)
      [ "$_rc" -ne 0 ] || return 0
      echo >&2
      echo "deploy failed with the checkout already moved to ${NEW_SHORT:-?}." >&2
      echo "  dependencies and the control-plane image may still be from" >&2
      echo "  ${OLD_SHORT:-?}, and the services are running whatever they last loaded." >&2
      ;;
    image-built)
      [ "$_rc" -ne 0 ] || return 0
      echo >&2
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
  # Not fatal: --ref may name a commit this clone holds, which is the rollback-during-an-outage case.
  echo "  warning: git fetch failed; resolving $REF from the local clone"
fi

NEW=$("$GIT_BIN" -C "$REPO_ROOT" rev-parse --verify "${REF}^{commit}" 2>/dev/null) || {
  echo "cannot resolve ref: $REF" >&2
  exit 2
}

# A pull host is never idle on the checkout alone: taking a new image edits REEMOAT_CP_IMAGE and moves no commit.
_idle_ok=1
[ "$(cp_image_source)" = pull ] && _idle_ok=0

if [ "$OLD" = "$NEW" ] && [ "$FORCE" -eq 0 ] && [ "$_idle_ok" -eq 1 ]; then
  echo "  already at $("$GIT_BIN" -C "$REPO_ROOT" rev-parse --short "$NEW") — nothing to do"
  echo
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

CHANGED=$("$GIT_BIN" -C "$REPO_ROOT" diff --name-only "$OLD" "$NEW")

touched() {
  if [ "$FORCE" -eq 1 ]; then return 0; fi
  for _pat in "$@"; do
    if printf '%s\n' "$CHANGED" | grep -Eq "$_pat"; then return 0; fi
  done
  return 1
}

INSTALL_DEPS='^package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^packages/[^/]+/package\.json$'

# Root manifest only: a packages/web or lockfile-only change must not restart the daemon and drop its live turns.
RESTART_DEPS='^package\.json$'

SHARED='^src/'

# Only this machine's init system's template: the other one is inert here and must not trigger a reload.
UNITS="^deploy/$INIT_SYSTEM/"

# Everything the image COPYs: a missed input means no rebuild, and a stale image reported as unchanged.
# packages/protocol is here because the gate bundle imports it; tsconfig.json because tsx resolves it in the container.
CP_IMAGE_INPUTS='^src/|^packages/control-plane/|^packages/protocol/|^packages/web/|^package\.json$|^tsconfig\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^deploy/docker/|^\.dockerignore$'

# The relay's own inputs, ANDed with the image fingerprint below; deploycheck fails if the relay's import closure leaves this pattern.
# schema.sql is here because the relay holds prepared statements against the migrated tables.
RELAY_INPUTS='^src/relay/|^src/(token|auth|http|cors)\.ts$|^packages/control-plane/src/relay/|^packages/control-plane/src/(store|keys|quota|settings|machines|machinekeys)\.ts$|^packages/control-plane/src/mail/address\.ts$|^packages/control-plane/src/schema\.sql$|^package\.json$|^tsconfig\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^deploy/docker/|^\.dockerignore$'

# Both tsx binaries, since packages/control-plane has its own node_modules; only for unit-backed services, as the control plane installs inside its image.
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

restart_list=""
reload_list=""
BUILD_FAILED=""

# Declared before the image step, which also appends to it (set -u).
FAILED=""

# Built once, outside the per-service loop: a second build between the before and after fingerprints would read as unchanged.
CP_IMAGE_MOVED=0
_cp_targets=""
for svc in $TARGETS; do
  [ "$(service_backend "$svc")" = docker ] && _cp_targets="${_cp_targets:+$_cp_targets }$svc"
done

if [ -n "$_cp_targets" ]; then
  echo
  echo "image:"
  _cp_source=$(cp_image_source)
  echo "  source: $_cp_source ($(cp_image_ref))"

  why=""
  if [ "$_cp_source" = pull ]; then
    # No diff in pull mode: the ref names exact bytes, and pulling a digest already held is a no-op.
    why="pulling"
  elif [ "$FORCE" -eq 1 ]; then
    why="--force"
  elif touched "$CP_IMAGE_INPUTS"; then
    why="an image input changed"
  fi

  # The fingerprint, not .Id, which moves on every cached build. In pull mode it is read off the running container, since the ref already names the target.
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
    # Collected, never a bare statement: under set -e a failed image would abort before the daemon's restart.
    # A case, not an && || chain, which would run the build after a successful pull.
    _image_ok=0
    case "$_cp_source" in
      pull)  "$DEPLOY_DIR/compose.sh" pull  || _image_ok=1 ;;
      build) "$DEPLOY_DIR/compose.sh" build || _image_ok=1 ;;
    esac
    if [ "$_image_ok" -ne 0 ]; then
      if [ "$_cp_source" = pull ]; then
        echo "  image: PULL FAILED" >&2
        echo "         $(cp_image_ref) could not be fetched. Nothing has been restarted." >&2
      else
        echo "  image: BUILD FAILED" >&2
      fi
      # Its own list, not FAILED: the container still answers from the old image, so "not answering" would be the wrong verdict.
      BUILD_FAILED="$_cp_targets"
    fi
  else
    echo "  image: skipped (nothing that goes into it moved)"
  fi

  if [ -z "$BUILD_FAILED" ]; then
    _after_image=$(cp_image_fingerprint)
    # From here a failure leaves the image at NEW and the container at OLD; see the EXIT trap.
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

  # Rendered to one side and compared, so a template edit that leaves the rendered bytes alone costs no reload.
  # Gated on the backend: render_unit refuses a container service, which would abort the loop.
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

  case " $BUILD_FAILED " in *" $svc "*) continue ;; esac

  case "$svc" in
    control-plane)
      if [ "$CP_IMAGE_MOVED" -eq 1 ] ||
        touched '^deploy/docker/compose\.yml$' '^deploy/compose\.sh$'; then
        restart_list="${restart_list:+$restart_list }$svc"
      fi
      ;;

    relay)
      # Both terms are required: the image alone would drop every tunnel for a CSS change, RELAY_INPUTS alone for a change no image carries.
      if { [ "$CP_IMAGE_MOVED" -eq 1 ] && touched "$RELAY_INPUTS"; } ||
        touched '^deploy/docker/compose\.yml$' '^deploy/compose\.sh$'; then
        restart_list="${restart_list:+$restart_list }$svc"
      elif [ "$(cp_image_source)" = pull ] &&
        [ "$(cp_running_fingerprint "$svc")" != "$(cp_image_fingerprint)" ]; then
        # Pull mode has no diff (a new image moves no commit), so ask whether the relay runs this deploy's image; an absent container fingerprints empty.
        echo "  recreate: the relay is not on the image this deploy is running"
        restart_list="${restart_list:+$restart_list }$svc"
      elif svc_container_missing "$svc"; then
        echo "  create: the relay has no container here yet"
        restart_list="${restart_list:+$restart_list }$svc"
      else
        echo "  recreate: no — nothing the relay is made of moved, so the tunnels stay up"
      fi
      ;;

    daemon)
      # Refresh, never install, the agent CLIs before the restart: pnpm install brings none (Q4.114); the channel is passed so a stable host stays stable (Q4.115).
      # Every prune is withheld, since only the daemon knows which harness has a live agent; a refresh is seen at the CLI's next use (Q6.112).
      _daemon_env=$(env_file daemon)
      _agent_updates=$(file_value "$_daemon_env" REEMOAT_AGENT_UPDATES | tr '[:upper:]' '[:lower:]')
      case "$_agent_updates" in
        off | 0 | false | no | never)
          echo "  agents: off (REEMOAT_AGENT_UPDATES=$_agent_updates), so nothing is installed or refreshed here either"
          ;;
        *)
          # Lowercased, as the daemon's agentSourceFrom reads it, so one env file never gives two answers.
          _agent_source=$(file_value "$_daemon_env" REEMOAT_AGENT_SOURCE | tr '[:upper:]' '[:lower:]')
          [ "$_agent_source" = npm ] || _agent_source=vendor
          _agent_channel=$(file_value "$_daemon_env" REEMOAT_AGENT_CHANNEL | tr '[:upper:]' '[:lower:]')
          [ "$_agent_channel" = stable ] || _agent_channel=latest
          _agent_claude=$(file_value "$_daemon_env" CLAUDE_CODE_EXECUTABLE)
          _agent_codex=$(file_value "$_daemon_env" CODEX_PATH)
          echo "  agents ($_agent_source, refresh only)"
          (
            PATH="${NODE_BIN:+$(dirname -- "$NODE_BIN"):}$PATH"; export PATH
            [ -z "$_agent_claude" ] || { CLAUDE_CODE_EXECUTABLE=$_agent_claude; export CLAUDE_CODE_EXECUTABLE; }
            [ -z "$_agent_codex" ] || { CODEX_PATH=$_agent_codex; export CODEX_PATH; }
            "$REPO_ROOT/deploy/agents.sh" --source "$_agent_source" --channel "$_agent_channel" --refresh-only --skip claude --skip codex --skip opencode --skip kimi --skip grok
          ) || echo "  agents: the script did not finish; the daemon retries daily" >&2
          ;;
      esac
      if touched "$SHARED" '^scripts/daemon\.ts$' "$RESTART_DEPS" '^deploy/run-daemon\.sh$'; then
        restart_list="${restart_list:+$restart_list }$svc"
      fi
      ;;
  esac
done

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
  # A case over every service with no catch-all: a missing arm would announce the wrong cost.
  for svc in $act_list; do
    case "$svc" in
      daemon)
        echo "restart: daemon — the daemon reattaches an agent to each session on"
        echo "         its way back up, in the same conversation. A turn that was"
        echo "         in flight does not continue, and a pending approval is gone."
        ;;
      relay)
        echo "restart: relay — every tunnel in the fleet drops and redials. Sessions"
        echo "         reconnect on their own; requests in flight are lost, and so is"
        echo "         an approval tapped in the window."
        ;;
      control-plane)
        echo "restart: control-plane — the API and the web UI. The tunnels belong to"
        echo "         the relay, so nothing that is connected notices."
        ;;
    esac
  done
fi

# Failures are collected, not fatal: every target is finished and the exit status is decided at the end.

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
          echo "$svc: pid ${before:-none} (unchanged)"
          ;;
      esac
      ;;
  esac
  wait_healthy "$svc" || FAILED="${FAILED:+$FAILED }$svc"
done

# The deploy itself is finished; clearing the stage keeps the EXIT trap's warning off a successful run.
DEPLOY_STAGE=done

echo
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
