#!/bin/sh
# Sourced by the deploy scripts, never run directly. POSIX sh.

set -eu

# CDPATH= stops an operator's CDPATH making cd print.
DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$DEPLOY_DIR/.." && pwd -P)

SERVICES="daemon control-plane relay"

valid_service() {
  case "$1" in
    daemon | control-plane | relay) return 0 ;;
    *) return 1 ;;
  esac
}

# Every svc_* verb names its compose service through this, so none runs a bare `compose up -d` that recreates the relay too.
compose_service() {
  case "$1" in
    control-plane) printf 'control-plane' ;;
    relay) printf 'relay' ;;
    *)
      echo "compose_service: $1 is not a containerised service" >&2
      exit 2
      ;;
  esac
}

service_backend() {
  case "$1" in
    daemon) printf 'unit' ;;
    control-plane | relay) printf 'docker' ;;
  esac
}

unit_label() {
  case "$INIT_SYSTEM" in
    launchd) printf 'com.reemoat.%s' "$1" ;;
    systemd) printf 'reemoat-%s' "$1" ;;
  esac
}

# Container services exit rather than print empty: a unit with an empty ExecStart renders fine and fails silently.
service_exec() {
  case "$1" in
    daemon) printf '%s/run-daemon.sh' "$DEPLOY_DIR" ;;
    control-plane)
      echo "the control plane has no unit: it runs as a container." >&2
      echo "  use: $DEPLOY_DIR/compose.sh up -d" >&2
      exit 2
      ;;
    relay)
      echo "the relay has no unit: it runs as a container beside the control plane." >&2
      echo "  use: $DEPLOY_DIR/compose.sh up -d" >&2
      exit 2
      ;;
  esac
}

env_file() {
  case "$1" in
    daemon) printf '%s' "${REEMOAT_ENV_FILE:-$HOME/.reemoat/daemon.env}" ;;
    control-plane | relay) printf '%s' "${REEMOAT_CP_ENV_FILE:-$HOME/.reemoat/control-plane.env}" ;;
  esac
}

env_example() {
  case "$1" in
    daemon) printf '%s/.env.example' "$REPO_ROOT" ;;
    control-plane | relay) printf '%s/packages/control-plane/.env.example' "$REPO_ROOT" ;;
  esac
}

# Sourced in a subshell so the file's secrets never enter the caller; a missing file reads as empty.
file_value() {
  # The whole key must be an identifier: it is interpolated into eval.
  case "$2" in
    '' | *[!A-Za-z0-9_]*)
      echo "file_value: bad key \"$2\"" >&2
      exit 2
      ;;
  esac
  (
    if [ -f "$1" ]; then
      set -a
      # shellcheck disable=SC1090  # a deployment path, not input
      . "$1"
      set +a
    fi
    eval "printf '%s' \"\${$2:-}\""
  )
}

env_value() {
  file_value "$(env_file "$1")" "$2"
}

# Prompts go to stderr so `answer=$(ask …)` captures only the answer.

# stdin and stderr, not stdout: `install.sh | tee log` must still be interactive.
interactive() {
  [ "${NON_INTERACTIVE:-0}" = "0" ] && [ -t 0 ] && [ -t 2 ]
}

ask() {
  printf '  %s' "$1" >&2
  if [ -n "${2:-}" ]; then printf ' [%s]' "$2" >&2; fi
  printf ': ' >&2
  IFS= read -r _reply || _reply=""
  printf '%s' "${_reply:-${2:-}}"
}

# A global rather than a trap: a trap here would replace install.sh's $ENV_PARTIAL cleanup traps, which call restore_tty themselves.
_TTY_STATE=""

restore_tty() {
  [ -n "$_TTY_STATE" ] || return 0
  stty "$_TTY_STATE" 2>/dev/null || true
  _TTY_STATE=""
}

# Echo off, asked twice; an apostrophe re-asks rather than letting set_env exit mid-interview.
ask_secret() {
  _asp="$1"
  _asmin="${2:-12}"
  while :; do
    _TTY_STATE=$(stty -g 2>/dev/null) || _TTY_STATE=""
    [ -n "$_TTY_STATE" ] && stty -echo 2>/dev/null
    printf '  %s: ' "$_asp" >&2
    IFS= read -r _as1 || _as1=""
    printf '\n' >&2
    printf '  %s (again): ' "$_asp" >&2
    IFS= read -r _as2 || _as2=""
    printf '\n' >&2
    restore_tty

    if [ "$_as1" != "$_as2" ]; then
      echo "  those do not match. Try again." >&2
      continue
    fi
    if [ ${#_as1} -lt "$_asmin" ]; then
      echo "  at least $_asmin characters, please." >&2
      continue
    fi
    case "$_as1" in
      *\'*)
        echo "  an apostrophe cannot go in this file: docker compose's dotenv parser" >&2
        echo "  rejects the whole file over the POSIX escape, and the stack would not" >&2
        echo "  start or even be inspectable. Pick another character." >&2
        continue
        ;;
    esac
    printf '%s' "$_as1"
    return 0
  done
}

confirm() {
  while :; do
    case "$(ask "$1 (y/n)" "$2")" in
      y | Y | yes | Yes) return 0 ;;
      n | N | no | No) return 1 ;;
      *) echo "  please answer y or n" >&2 ;;
    esac
  done
}

choose() {
  # choose <prompt> <label>... — prints the 1-based index of the pick.
  _prompt="$1"
  shift
  _n=0
  for _label in "$@"; do
    _n=$((_n + 1))
    printf '    %d) %s\n' "$_n" "$_label" >&2
  done
  while :; do
    _pick=$(ask "$_prompt" 1)
    case "$_pick" in
      '' | *[!0-9]*) ;;
      *) if [ "$_pick" -ge 1 ] && [ "$_pick" -le "$_n" ]; then
        printf '%s' "$_pick"
        return 0
      fi ;;
    esac
    echo "  pick a number between 1 and $_n" >&2
  done
}

# Single-quotes a value for a `.`-sourced env file; the x sentinel keeps a trailing newline through $( ).
sq() {
  _sq=$(printf '%sx' "$1" | sed "s/'/'\\\\''/g")
  printf "'%s'" "${_sq%x}"
}

set_env() {
  _key="$1"
  _val="$2"
  _file="$3"
  # Compose's dotenv parser rejects the whole file over sq's '\'' escape, so no apostrophe goes into the control plane's file under any name.
  _cpenv=$(env_file control-plane)
  case "$_file:$_val" in
    *control-plane.env:*\'* | *control-plane.env.partial:*\'* | \
      "$_cpenv:"*\'* | "$_cpenv.partial:"*\'*)
      echo "refusing to write an apostrophe into $_file ($_key)." >&2
      echo "  that file is also parsed by docker compose, whose dotenv grammar" >&2
      echo "  does not understand the POSIX escape — it would reject the whole" >&2
      echo "  file and leave the stack unable to start or be inspected." >&2
      exit 2
      ;;
  esac
  # No newline: the replace arm matches physical lines and would orphan the rest, leaving the file unsourceable.
  _nl='
'
  case "$_val" in
    *"$_nl"*)
      echo "refusing to write a newline into $_file ($_key)." >&2
      echo "  the replace arm matches a physical line, so a multi-line value" >&2
      echo "  orphans its continuation and leaves the file unsourceable." >&2
      exit 2
      ;;
  esac
  _tmp="$_file.tmp.$$"
  _q=$(sq "$_val")
  # umask 077 on the temp file itself: mv carries its mode onto the live file, which holds the token.
  if grep -Eq "^$_key=" "$_file"; then
    # Through ENVIRON, not awk -v, which would unescape a backslash-n into a second assignment; index() compares the key as text.
    (
      umask 077
      _SET_ENV_KEY="$_key" _SET_ENV_VAL="$_q" awk '
        BEGIN { k = ENVIRON["_SET_ENV_KEY"]; v = ENVIRON["_SET_ENV_VAL"] }
        index($0, k "=") == 1 { if (!seen) { print k "=" v; seen = 1 } ; next }
        { print }
      ' "$_file" >"$_tmp"
    )
  else
    (
      umask 077
      cp "$_file" "$_tmp"
      printf '%s=%s\n' "$_key" "$_q" >>"$_tmp"
    )
  fi
  mv "$_tmp" "$_file"
  chmod 600 "$_file"
}

host_addresses() {
  case "$(uname -s)" in
    Darwin)
      ifconfig 2>/dev/null | awk '
        /^[a-z]/ { iface = substr($1, 1, length($1) - 1) }
        /^[[:space:]]*inet / && $2 != "127.0.0.1" { print $2, iface }'
      ;;
    *)
      if command -v ip >/dev/null 2>&1; then
        ip -4 -o addr show 2>/dev/null | awk '
          { split($4, a, "/"); if (a[1] != "127.0.0.1") print a[1], $2 }'
      else
        ifconfig 2>/dev/null | awk '
          /^[a-z]/ { iface = substr($1, 1, length($1) - 1) }
          /^[[:space:]]*inet / {
            addr = $2; sub(/^addr:/, "", addr)
            if (addr != "127.0.0.1") print addr, iface
          }'
      fi
      ;;
  esac
}

lan_address() {
  case "$(uname -s)" in
    Darwin)
      for _if in $(route -n get default 2>/dev/null | awk '/interface:/{print $2}') en0 en1; do
        _a=$(ipconfig getifaddr "$_if" 2>/dev/null || true)
        if [ -n "$_a" ]; then
          printf '%s' "$_a"
          return 0
        fi
      done
      ;;
    Linux)
      # `ip route get` is a routing-table lookup; it sends nothing to 1.1.1.1.
      _a=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
      if [ -n "$_a" ]; then
        printf '%s' "$_a"
        return 0
      fi
      ;;
  esac
  printf ''
}

# A dotted, non-.local name or empty: it becomes REEMOAT_CP_RELAY_URL, which every daemon keeps for good.
host_name() {
  _n=$(hostname -f 2>/dev/null || hostname 2>/dev/null || true)
  case "$_n" in
    '' | *.local | *.local.) printf '' ;;
    *.*) printf '%s' "$_n" ;;
    *) printf '' ;;
  esac
}

# none rather than exiting: a control-plane-only host needs no init system; require_init refuses where one is needed.
detect_init() {
  case "$(uname -s)" in
    Darwin) INIT_SYSTEM=launchd ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        INIT_SYSTEM=systemd
      else
        INIT_SYSTEM=none
      fi
      ;;
    *) INIT_SYSTEM=none ;;
  esac
}

require_init() {
  [ "$INIT_SYSTEM" = none ] || return 0
  echo "no supported init system here (launchd or systemd)." >&2
  echo "  the control plane does not need one — it runs as a container:" >&2
  echo "    $DEPLOY_DIR/compose.sh up -d" >&2
  echo "  the daemon does. Run its wrapper from your own supervisor:" >&2
  echo "    $DEPLOY_DIR/run-daemon.sh" >&2
  exit 2
}

resolve_bin() {
  _p=$(command -v "$1" 2>/dev/null || true)
  if [ -z "$_p" ]; then
    echo "$1 not found on PATH — needed by $2." >&2
    exit 2
  fi
  # A builtin or a relative path is unusable in a unit file.
  case "$_p" in
    /*) ;;
    *)
      echo "$1 resolves to \"$_p\", which is not an absolute path." >&2
      exit 2
      ;;
  esac
  printf '%s' "$_p"
}

# System directories first; a tool that re-resolves elsewhere under that PATH has its directory moved ahead of them, with a warning if others can write to it.
runtime_path() {
  if [ -n "${REEMOAT_UNIT_PATH:-}" ]; then
    printf '%s' "$REEMOAT_UNIT_PATH"
    return 0
  fi

  _acc=""
  for _d in /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    _acc="${_acc:+$_acc:}$_d"
  done
  for _p in "$@"; do
    _d=$(dirname -- "$_p")
    case ":$_acc:" in
      *":$_d:"*) ;;
      *) _acc="$_acc:$_d" ;;
    esac
  done

  for _p in "$@"; do
    _n=$(basename -- "$_p")
    if [ "$(PATH="$_acc" command -v "$_n" 2>/dev/null || true)" = "$_p" ]; then
      continue
    fi
    _d=$(dirname -- "$_p")

    _rebuilt="$_d"
    _rest="$_acc"
    while [ -n "$_rest" ]; do
      _head=${_rest%%:*}
      case "$_rest" in
        *:*) _rest=${_rest#*:} ;;
        *) _rest="" ;;
      esac
      if [ "$_head" != "$_d" ]; then _rebuilt="$_rebuilt:$_head"; fi
    done
    _acc="$_rebuilt"

    echo "  note: $_n here is $_p, so $_d goes ahead of the system directories." >&2
    _mode=$(ls -ld -- "$_d" 2>/dev/null | awk '{print $1 " " $3 ":" $4}')
    case "$_mode" in
      d????w* | d???????w*)
        echo "  WARNING: $_d is writable by more than its owner ($_mode)," >&2
        echo "           and it now shadows the system directories in this unit's" >&2
        echo "           PATH. The daemon spawns bare \"git\", so" >&2
        echo "           anything planted there runs as this service." >&2
        echo "           Fix the mode, or set REEMOAT_UNIT_PATH to a PATH you control." >&2
        ;;
    esac
  done

  printf '%s' "$_acc"
}

unit_target() {
  case "$INIT_SYSTEM" in
    launchd) printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(unit_label "$1")" ;;
    systemd) printf '%s/systemd/user/%s.service' "${XDG_CONFIG_HOME:-$HOME/.config}" "$(unit_label "$1")" ;;
  esac
}

unit_template() {
  case "$INIT_SYSTEM" in
    launchd) printf '%s/launchd/reemoat.plist.in' "$DEPLOY_DIR" ;;
    systemd) printf '%s/systemd/reemoat.service.in' "$DEPLOY_DIR" ;;
  esac
}

log_dir() {
  case "$INIT_SYSTEM" in
    launchd) printf '%s/Library/Logs/reemoat' "$HOME" ;;
    systemd) printf '' ;;
  esac
}

# Through compose.sh, which pins the project, directory, env file and image an operator's own call would use.
compose() {
  "$DEPLOY_DIR/compose.sh" "$@"
}

# 0 installed, 1 not installed, 2 could not ask: an engine that does not answer must never read as "not installed".
svc_installed() {
  case "$(service_backend "$1")" in
    docker)
      command -v "${REEMOAT_DOCKER:-docker}" >/dev/null 2>&1 || return 1
      [ -f "$(env_file "$1")" ] || return 1
      # The relay is probed through the control plane's container, so a host that predates the split still reads as installed.
      _probe=$1
      [ "$_probe" = relay ] && _probe=control-plane
      _ids=$(compose ps -aq "$(compose_service "$_probe")" 2>/dev/null) || return 2
      [ -n "$_ids" ]
      ;;
    unit)
      # Return, never exit: this runs inside deploy.sh's discovery `if` on hosts with no init system.
      [ "$INIT_SYSTEM" = none ] && return 1
      [ -f "$(unit_target "$1")" ]
      ;;
  esac
}

legacy_unit_present() {
  [ "$(service_backend "$1")" = docker ] || return 1
  [ "$INIT_SYSTEM" = none ] && return 1
  [ -f "$(unit_target "$1")" ]
}

svc_start() {
  case "$(service_backend "$1")" in
    docker) compose up -d --no-deps "$(compose_service "$1")" ;;
    unit)
      require_init
      case "$INIT_SYSTEM" in
        launchd)
          # A second bootstrap errors on an already-loaded label, so that is not a failure here.
          launchctl bootstrap "gui/$(id -u)" \
            "$HOME/Library/LaunchAgents/$(unit_label "$1").plist" 2>/dev/null || true
          launchctl kickstart "gui/$(id -u)/$(unit_label "$1")"
          ;;
        systemd)
          systemctl --user enable --now "$(unit_label "$1").service"
          ;;
      esac
      ;;
  esac
}

# `kickstart -k` kills first: the daemon's SQLite lock refuses a second copy, which KeepAlive would retry forever.
svc_restart() {
  case "$(service_backend "$1")" in
    # --force-recreate: `up -d` alone is a no-op when config and image are unchanged.
    docker) compose up -d --force-recreate --no-deps "$(compose_service "$1")" ;;
    unit)
      require_init
      case "$INIT_SYSTEM" in
        launchd) launchctl kickstart -k "gui/$(id -u)/$(unit_label "$1")" ;;
        systemd) systemctl --user restart "$(unit_label "$1").service" ;;
      esac
      ;;
  esac
}

# launchd never re-reads a loaded plist, hence bootout then bootstrap. bootstrap's status is checked: callers use this as an `if` condition.
svc_reload() {
  if [ "$(service_backend "$1")" = docker ]; then
    compose up -d --no-deps "$(compose_service "$1")"
    return
  fi
  require_init
  case "$INIT_SYSTEM" in
    launchd)
      _svc_label=$(unit_label "$1")
      launchctl bootout "gui/$(id -u)/$_svc_label" 2>/dev/null || true
      _n=0
      while [ "$_n" -lt 50 ] && launchctl print "gui/$(id -u)/$_svc_label" >/dev/null 2>&1; do
        _n=$((_n + 1))
        sleep 0.1
      done
      if ! launchctl bootstrap "gui/$(id -u)" "$(unit_target "$1")"; then
        echo "  launchctl bootstrap refused $(unit_target "$1")" >&2
        return 1
      fi
      launchctl kickstart -k "gui/$(id -u)/$_svc_label"
      ;;
    systemd)
      systemctl --user daemon-reload
      systemctl --user enable "$(unit_label "$1").service" >/dev/null 2>&1 || true
      systemctl --user restart "$(unit_label "$1").service"
      ;;
  esac
}

# Idempotent. Refuses a docker-backed service, whose volume holds the fleet's signing key.
svc_uninstall() {
  case "$(service_backend "$1")" in
    docker)
      echo "$1 runs as a container; there is no unit to remove." >&2
      echo "  stop it with: $DEPLOY_DIR/compose.sh down" >&2
      return 1
      ;;
    unit)
      require_init
      case "$INIT_SYSTEM" in
        launchd)
          _svc_label=$(unit_label "$1")
          # Bootout before removing the plist, or launchd loads the file again at the next login.
          launchctl bootout "gui/$(id -u)/$_svc_label" 2>/dev/null || true
          # 30s, and a timeout refuses: the daemon may take 25s to stop, and callers purge worktrees next.
          _n=0
          while [ "$_n" -lt 300 ] && launchctl print "gui/$(id -u)/$_svc_label" >/dev/null 2>&1; do
            _n=$((_n + 1))
            sleep 0.1
          done
          if launchctl print "gui/$(id -u)/$_svc_label" >/dev/null 2>&1; then
            echo "$_svc_label is still loaded 30s after bootout; not removing its unit." >&2
            return 1
          fi
          ;;
        systemd)
          systemctl --user disable --now "$(unit_label "$1").service" >/dev/null 2>&1 || true
          _n=0
          while [ "$_n" -lt 300 ] && systemctl --user is-active --quiet "$(unit_label "$1").service"; do
            _n=$((_n + 1))
            sleep 0.1
          done
          if systemctl --user is-active --quiet "$(unit_label "$1").service"; then
            echo "$(unit_label "$1").service is still active 30s after disable --now; not removing its unit." >&2
            return 1
          fi
          ;;
      esac
      rm -f "$(unit_target "$1")"
      rm -f "$(dirname -- "$(env_file "$1")")/$(basename -- "$(unit_target "$1")").pending"
      case "$INIT_SYSTEM" in systemd) systemctl --user daemon-reload >/dev/null 2>&1 || true ;; esac
      echo "  removed      $(unit_target "$1")"
      ;;
  esac
}

service_desc() {
  case "$1" in
    daemon) printf 'Reemoat daemon (agent sessions on this host)' ;;
    control-plane) printf 'Reemoat control plane (identity, relay, web UI)' ;;
  esac
}

esc_sed() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# Ampersand first, or the later entities get escaped again.
esc_xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

subst_value() {
  case "$INIT_SYSTEM" in
    launchd) esc_sed "$(esc_xml "$1")" ;;
    systemd) esc_sed "$1" ;;
  esac
}

# render_unit <service> [target]; install.sh passes a target to stage a unit it will not start.
render_unit() {
  _svc="$1"
  if [ "$(service_backend "$_svc")" != unit ]; then
    echo "render_unit: $_svc has no unit — it runs as a container." >&2
    echo "  use: $DEPLOY_DIR/compose.sh up -d" >&2
    exit 2
  fi
  require_init
  _node=$(resolve_bin node "$_svc")
  _git=$(resolve_bin git "deploy/deploy.sh")
  _path=$(runtime_path "$_node" "$_git")

  _target=${2:-$(unit_target "$_svc")}
  _logs=$(log_dir)
  mkdir -p "$(dirname -- "$_target")"
  if [ -n "$_logs" ]; then
    mkdir -p "$_logs"
    chmod 700 "$_logs"
  fi

  _tmp="$_target.tmp.$$"
  sed \
    -e "s|@LABEL@|$(subst_value "$(unit_label "$_svc")")|g" \
    -e "s|@SERVICE@|$(subst_value "$_svc")|g" \
    -e "s|@DESC@|$(subst_value "$(service_desc "$_svc")")|g" \
    -e "s|@EXEC@|$(subst_value "$(service_exec "$_svc")")|g" \
    -e "s|@REPO_ROOT@|$(subst_value "$REPO_ROOT")|g" \
    -e "s|@PATH@|$(subst_value "$_path")|g" \
    -e "s|@HOME@|$(subst_value "$HOME")|g" \
    -e "s|@LOG_DIR@|$(subst_value "$_logs")|g" \
    -e "s|@ENV_FILE@|$(subst_value "$(env_file "$_svc")")|g" \
    "$(unit_template "$_svc")" >"$_tmp"
  mv "$_tmp" "$_target"
}

svc_log_lines() {
  case "$(service_backend "$1")" in
    # --no-log-prefix and --no-color so the admin-key scrape reads a bare key. This log does not outlive its container.
    docker)
      compose logs --no-color --no-log-prefix -n "${2:-200}" "$(compose_service "$1")" 2>/dev/null || true
      ;;
    unit)
      require_init
      case "$INIT_SYSTEM" in
        launchd)
          _lf="$(log_dir)/$1.log"
          if [ -f "$_lf" ]; then tail -n "${2:-200}" "$_lf"; fi
          ;;
        systemd)
          journalctl --user -u "$(unit_label "$1")" -n "${2:-200}" --no-pager 2>/dev/null || true
          ;;
      esac
      ;;
  esac
}

# Per target, so a host running only the control plane needs no pnpm and a daemon-only host needs no docker.
require_deploy_tools() {
  NODE_BIN=$(resolve_bin node "deploy/deploy.sh")
  GIT_BIN=$(resolve_bin git "deploy/deploy.sh")
  PNPM_BIN=""
  DOCKER_BIN=""
  for _t in "$@"; do
    case "$(service_backend "$_t")" in
      unit) [ -n "$PNPM_BIN" ] || PNPM_BIN=$(resolve_bin pnpm "deploy/deploy.sh ($_t)") ;;
      docker) [ -n "$DOCKER_BIN" ] || DOCKER_BIN=$(resolve_bin "${REEMOAT_DOCKER:-docker}" "deploy/deploy.sh ($_t)") ;;
    esac
  done
}

# Answers present (1) on anything it cannot determine: a wrong "missing" recreates the relay.
svc_container_missing() {
  [ "$(service_backend "$1")" = docker ] || return 1
  command -v "${REEMOAT_DOCKER:-docker}" >/dev/null 2>&1 || return 1
  _ids=$(compose ps -aq "$(compose_service "$1")" 2>/dev/null) || return 1
  [ -z "$_ids" ]
}

svc_pid() {
  case "$(service_backend "$1")" in
    docker)
      _c=$(compose ps -q "$(compose_service "$1")" 2>/dev/null || true)
      [ -z "$_c" ] || "${REEMOAT_DOCKER:-docker}" inspect -f '{{.State.Pid}}' "$_c" 2>/dev/null || true
      ;;
    unit)
      require_init
      case "$INIT_SYSTEM" in
        launchd)
          # Matched on fields: the indentation of launchctl print is not a documented format.
          launchctl print "gui/$(id -u)/$(unit_label "$1")" 2>/dev/null |
            awk '$1 == "pid" && $2 == "=" { print $3; exit }'
          ;;
        systemd)
          _v=$(systemctl --user show -p MainPID --value "$(unit_label "$1").service" 2>/dev/null || true)
          [ "${_v:-0}" = "0" ] || printf '%s' "$_v"
          ;;
      esac
      ;;
  esac
}

# Runs cpctl.ts with the fleet admin key sourced into this subshell only, so no other child of install.sh inherits it.
cpctl() {
  (
    set -a
    # `if`, not `[ -f ] &&`: a failing AND-list under set -e would kill this subshell.
    if [ -f "$CPCTL_ENV" ]; then
      # shellcheck disable=SC1090  # written by this script's control-plane run
      . "$CPCTL_ENV"
    fi
    set +a
    _tsx="$REPO_ROOT/packages/control-plane/node_modules/.bin/tsx"
    if [ -x "$_tsx" ]; then
      "$_tsx" "$REPO_ROOT/packages/control-plane/scripts/cpctl.ts" "$@"
    else
      # No host tsx on a control-plane-only host, so exec in the container. `-e REEMOAT_CP_KEY` without a value keeps the key out of argv.
      _cp_port=$(file_value "$(env_file control-plane)" REEMOAT_CP_PORT)
      REEMOAT_CP_URL="http://127.0.0.1:${_cp_port:-7888}"
      export REEMOAT_CP_URL
      compose exec -T -e REEMOAT_CP_KEY -e REEMOAT_CP_URL \
        control-plane node --import tsx scripts/cpctl.ts "$@"
    fi
  )
}

# For display only; recreate decisions use cp_image_fingerprint.
cp_image_id() {
  command -v "${REEMOAT_DOCKER:-docker}" >/dev/null 2>&1 || return 0
  "${REEMOAT_DOCKER:-docker}" image inspect \
    --format '{{.Id}}' "$(cp_image_ref)" 2>/dev/null || true
}

# RootFS and Config rather than .Id: the OCI index id moves on every cached build while the image does not.
cp_image_fingerprint() {
  command -v "${REEMOAT_DOCKER:-docker}" >/dev/null 2>&1 || return 0
  "${REEMOAT_DOCKER:-docker}" image inspect \
    --format '{{json .RootFS}}{{json .Config}}' \
    "$(cp_image_ref)" 2>/dev/null || true
}

# The running container's image in the same shape; empty when none, which reads as moved and recreates.
cp_running_fingerprint() {
  command -v "${REEMOAT_DOCKER:-docker}" >/dev/null 2>&1 || return 0
  _cid=$(compose ps -aq "$(compose_service "$1")" 2>/dev/null | head -1) || return 0
  [ -n "$_cid" ] || return 0
  _img=$("${REEMOAT_DOCKER:-docker}" inspect "$_cid" --format '{{.Image}}' 2>/dev/null) || return 0
  [ -n "$_img" ] || return 0
  "${REEMOAT_DOCKER:-docker}" image inspect \
    --format '{{json .RootFS}}{{json .Config}}' "$_img" 2>/dev/null || true
}

cp_image_ref() {
  if [ -n "${REEMOAT_CP_IMAGE:-}" ]; then
    printf '%s' "$REEMOAT_CP_IMAGE"
    return 0
  fi
  # Read, not sourced: this is on every compose.sh verb, and a file sh cannot source must not break `logs` or `down`.
  _cpi=$(sed -n "s/^[[:space:]]*REEMOAT_CP_IMAGE=//p" "$(env_file control-plane)" 2>/dev/null | tail -1)
  _cpi=${_cpi#\'}; _cpi=${_cpi%\'}
  _cpi=${_cpi#\"}; _cpi=${_cpi%\"}
  printf '%s' "${_cpi:-reemoat/control-plane:current}"
}

# build or pull, from docker's registry-host rule on the ref; REEMOAT_CP_SOURCE overrides, and an unknown value is refused.
cp_image_source() {
  case "${REEMOAT_CP_SOURCE:-}" in
    build | pull) printf '%s' "$REEMOAT_CP_SOURCE"; return 0 ;;
    '') : ;;
    *) echo "REEMOAT_CP_SOURCE must be 'build' or 'pull', not \"$REEMOAT_CP_SOURCE\"" >&2; exit 2 ;;
  esac
  _ref=$(cp_image_ref)
  case "${_ref%%/*}" in
    "$_ref")     printf 'build' ;;
    localhost)   printf 'pull' ;;
    *[.:]*)      printf 'pull' ;;
    *)           printf 'build' ;;
  esac
}

CPCTL_ENV="${REEMOAT_CPCTL_ENV:-$HOME/.reemoat/cpctl.env}"

json_field() {
  "${NODE_BIN:-node}" -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const v = JSON.parse(raw)[process.argv[1]];
        process.stdout.write(v === undefined || v === null ? "" : String(v));
      } catch {
        process.stdout.write("");
      }
    });
  ' "$1"
}

# The origin a service answers on from this host, empty for a kernel-assigned port; non-zero only when the env file will not source.
service_origin() {
  _svc="$1"
  _env=$(env_file "$_svc")
  if [ ! -f "$_env" ]; then
    printf ''
    return 0
  fi
  (
    set -a
    # shellcheck disable=SC1090  # the path is chosen by env_file, not by input
    . "$_env"
    set +a
    case "$_svc" in
      daemon)
        _host=${REEMOAT_HOST:-0.0.0.0}
        _port=${REEMOAT_PORT:-7887}
        ;;
      control-plane)
        # The host publish address, not the in-container bind; the port is the same number on both sides.
        _host=${REEMOAT_CP_PUBLISH:-127.0.0.1}
        _port=${REEMOAT_CP_PORT:-7888}
        ;;
      relay)
        # Relay defaults are wide: a relay no daemon can dial is not a relay.
        _host=${REEMOAT_CP_RELAY_PUBLISH:-0.0.0.0}
        _port=${REEMOAT_CP_RELAY_PORT:-7889}
        ;;
    esac
    case "$_host" in
      0.0.0.0 | '' | '*') _host=127.0.0.1 ;;
      '::' | '[::]') _host='[::1]' ;;
    esac
    # REEMOAT_PORT=0 (relay-only daemon) leaves no port to probe.
    [ "$_port" = "0" ] || printf 'http://%s:%s' "$_host" "$_port"
  )
}

# Not /health for the relay: that path is the tunnelled daemon's, and answering it here would show every machine as up.
health_probe_path() {
  case "$1" in
    relay) printf '/__relay/health' ;;
    *) printf '/health' ;;
  esac
}

health_probe_target() {
  _svc="$1"
  _env=$(env_file "$_svc")
  if [ ! -f "$_env" ]; then
    printf 'skip no environment file at %s' "$_env"
    return 0
  fi
  _origin=$(service_origin "$_svc")
  if [ -z "$_origin" ]; then
    printf 'skip %s listens on a kernel-assigned port' "$_svc"
  else
    printf 'ok %s%s' "$_origin" "$(health_probe_path "$_svc")"
  fi
}

# `--noproxy '*'`: curl honours proxy variables even for loopback.
http_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --noproxy '*' --max-time 2 "$1" >/dev/null 2>&1
  else
    "${NODE_BIN:-node}" -e '
      fetch(process.argv[1], { signal: AbortSignal.timeout(2000) })
        .then((r) => process.exit(r.ok ? 0 : 1))
        .catch(() => process.exit(1));
    ' "$1" >/dev/null 2>&1
  fi
}

wait_healthy() {
  _svc="$1"
  _rc=0
  _ans=$(health_probe_target "$_svc") || _rc=$?
  if [ "$_rc" -ne 0 ]; then
    echo "  health: skipped (could not read $(env_file "$_svc") — rc=$_rc)" >&2
    echo "    it exists but would not source; check it for an unquoted value." >&2
    return 0
  fi
  case "$_ans" in
    'skip '*)
      echo "  health: skipped (${_ans#skip })"
      return 0
      ;;
    'ok '*) _url=${_ans#ok } ;;
    *)
      echo "  health: skipped (unrecognised probe answer for $_svc)" >&2
      return 0
      ;;
  esac

  _n=0
  while [ "$_n" -lt 30 ]; do
    if http_ok "$_url"; then
      echo "  health: ok ($_url)"
      return 0
    fi
    _n=$((_n + 1))
    sleep 1
  done

  echo "  health: FAILED after 30s ($_url)" >&2
  echo "    logs: $(log_hint "$_svc")" >&2
  return 1
}

log_hint() {
  case "$(service_backend "$1")" in
    docker) printf '%s/compose.sh logs -n 50 %s' "$DEPLOY_DIR" "$(compose_service "$1")" ;;
    unit)
      case "$INIT_SYSTEM" in
        launchd) printf 'tail -n 50 %s/Library/Logs/reemoat/%s.log' "$HOME" "$1" ;;
        systemd) printf 'journalctl --user -u %s -n 50' "$(unit_label "$1")" ;;
        # Not require_init: exiting here would replace the failure being reported.
        none) printf '(no log location: this host has no supported init system)' ;;
      esac
      ;;
  esac
}

detect_init
