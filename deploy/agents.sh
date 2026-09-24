#!/bin/sh
# Installs and refreshes the agent CLIs: none self-updates under ACP (opencode's checkUpgrade is TUI-only), so reemoat owns the cadence (Q4.113).
# Exits 0 whatever the vendors answer; 2 on a bad flag, 3 only under --fail-if-locked.
set -eu

# SIGPIPE ignored: the daemon may stop reading mid-run, and the default action would end the script with its EXIT trap unrun.
trap '' PIPE

CHECK=0
SKIP=" "
ONLY=" "
REFRESH_ONLY=0
FAIL_IF_LOCKED=0
SOURCE=vendor
# claude's own two channel spellings; anything else is refused here (Q4.115).
CHANNEL=latest

AGENTS="claude codex opencode kimi grok"

_want_skip=0
_want_only=0
_want_source=0
_want_channel=0
for _arg in "$@"; do
  if [ "$_want_skip" = 1 ]; then SKIP="$SKIP$_arg "; _want_skip=0; continue; fi
  if [ "$_want_only" = 1 ]; then
    # --only validates its value, unlike --skip: a mistyped --only would install nothing and report success.
    case " $AGENTS " in
      *" $_arg "*) ONLY="$ONLY$_arg " ;;
      *) printf -- '--only takes one of %s, not %s\n' "$AGENTS" "$_arg" >&2; exit 2 ;;
    esac
    _want_only=0
    continue
  fi
  if [ "$_want_source" = 1 ]; then
    case "$_arg" in
      vendor | npm) SOURCE=$_arg ;;
      *) printf -- '--source takes vendor or npm, not %s\n' "$_arg" >&2; exit 2 ;;
    esac
    _want_source=0
    continue
  fi
  if [ "$_want_channel" = 1 ]; then
    case "$_arg" in
      stable | latest) CHANNEL=$_arg ;;
      *) printf -- '--channel takes stable or latest, not %s\n' "$_arg" >&2; exit 2 ;;
    esac
    _want_channel=0
    continue
  fi
  case "$_arg" in
    --check)          CHECK=1 ;;
    --refresh-only)   REFRESH_ONLY=1 ;;
    --fail-if-locked) FAIL_IF_LOCKED=1 ;;
    --skip)           _want_skip=1 ;;
    --only)           _want_only=1 ;;
    --source)         _want_source=1 ;;
    --channel)        _want_channel=1 ;;
    *) printf 'unknown flag: %s\n' "$_arg" >&2; exit 2 ;;
  esac
done
[ "$_want_skip" = 1 ] && { printf -- '--skip needs an agent name\n' >&2; exit 2; }
[ "$_want_only" = 1 ] && { printf -- '--only needs an agent name\n' >&2; exit 2; }
[ "$_want_source" = 1 ] && { printf -- '--source needs vendor or npm\n' >&2; exit 2; }
[ "$_want_channel" = 1 ] && { printf -- '--channel needs stable or latest\n' >&2; exit 2; }

# --skip withholds only the pruning of a live harness's previous npm build; the install and relink still happen.
skipped() { case "$SKIP" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

wanted() { case "$ONLY" in " ") return 0 ;; *" $1 "*) return 0 ;; *) return 1 ;; esac; }

not_installed() { note "$1 not installed; --refresh-only fetches nothing new"; }

# Each survives a closed stream under set -e; the subshell stops bash flushing unwritten bytes into a later command substitution.
# warn's two redirections stay inside the subshell and in this order, or its output goes to /dev/null.
say()  { ( printf '%s\n' "$*" ) 2>/dev/null || :; }
note() { ( printf '  %s\n' "$*" ) 2>/dev/null || :; }
warn() { ( printf '%s\n' "$*" >&2 2>/dev/null ) || :; }
have() { command -v "$1" >/dev/null 2>&1; }

# The one machine-readable line; readStep in src/agentinstall.ts is its only reader, and deploycheck drives both.
step() { [ "$CHECK" = 1 ] || ( printf 'step: %s %s\n' "$1" "$2" ) 2>/dev/null || :; }

# Kept in step with MANAGED_CLI_DIRS by deploycheck; exported so codex's and opencode's profile writers return early.
# Appended, never prepended: this uid can write ~/.local/bin, which must not shadow /usr/bin.
HOME_DIR=${HOME:?HOME is not set}
PATH="$PATH:$HOME_DIR/.local/bin:$HOME_DIR/.opencode/bin:$HOME_DIR/.reemoat/toolchain/bin"
export PATH

TOOLCHAIN="$HOME_DIR/.reemoat/toolchain"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/reemoat-agents.XXXXXX") || { warn "  cannot make a temporary directory; nothing was changed"; exit 0; }

# One run at a time: a mkdir lock holding the owner's pid; a dead pid's lock is taken over, a live one ends this run with exit 0.
# One EXIT trap releases both, and only the run that took the lock removes it.
LOCK="$TOOLCHAIN/.agents.lock"
LOCK_HELD=0
finish() {
  rm -rf "$TMP"
  [ "$LOCK_HELD" = 1 ] && rm -rf "$LOCK"
  return 0
}
trap finish EXIT

take_lock() {
  [ "$CHECK" = 1 ] && return 0
  mkdir -p "$TOOLCHAIN" 2>/dev/null || { warn "  cannot create $TOOLCHAIN; nothing was changed"; exit 0; }
  _tries=0
  while [ "$_tries" -lt 3 ]; do
    _tries=$((_tries + 1))
    if mkdir "$LOCK" 2>/dev/null; then
      LOCK_HELD=1
      printf '%s\n' "$$" > "$LOCK/pid"
      return 0
    fi
    _pid=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [ -z "$_pid" ]; then
      sleep 1
      _pid=$(cat "$LOCK/pid" 2>/dev/null || true)
    fi
    case "$_pid" in
      "" | *[!0-9]*) : ;;
      *) if kill -0 "$_pid" 2>/dev/null; then
           warn "another run of deploy/agents.sh (pid $_pid) is in progress; nothing was changed"
           # --fail-if-locked lets a pressed install tell contention from success; the other callers need exit 0.
           [ "$FAIL_IF_LOCKED" = 1 ] && exit 3
           exit 0
         fi ;;
    esac
    rm -rf "$LOCK"
  done
  warn "  could not take $LOCK after 3 tries; nothing was changed"
  [ "$FAIL_IF_LOCKED" = 1 ] && exit 3
  exit 0
}

failed=0
attempted=0

done_note() {
  if [ "$CHECK" = 1 ]; then note "$1 would $2"
  else note "$1 $2 $($3 --version 2>/dev/null | head -1)"; fi
}

attempt() {
  _what=$1
  shift
  if [ "$CHECK" = 1 ]; then
    note "$_what: would run: $*"
    return 0
  fi
  step "$_what" install
  if "$@" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# --source decides only how an absent harness is installed; a present copy is refreshed the way it came in.
provenance() {
  case "$(command -v "$1" 2>/dev/null || true)" in
    "") printf '' ;;
    "$TOOLCHAIN"/bin/*) printf 'toolchain' ;;
    "$HOME_DIR"/.local/bin/* | "$HOME_DIR"/.opencode/bin/*) printf 'vendor' ;;
    *) printf 'outside' ;;
  esac
}

# Named and not moved: the daemon's findOnPath would never run a managed copy installed beside it.
outside_note() {
  note "$1 $("$2" --version 2>/dev/null | head -1) — installed outside reemoat, not updated from here"
}

# Counted as a failure so the daemon warns: under --source npm nothing else refreshes this copy.
vendor_copy_stays() {
  warn "  $1 $("$2" --version 2>/dev/null | head -1) at $(command -v "$2") was installed by the vendor's installer, which --source npm does not reach; remove it and the next run installs from the npm registry"
  failed=$((failed + 1))
}

# Downloaded whole with a deadline and never piped into a shell (no pipefail); https only, redirects included.
download() {
  if [ "$CHECK" = 1 ]; then note "$1: would download $2"; return 0; fi
  step "$1" download
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 -o "$TMP/$1.sh" "$2" >/dev/null 2>&1
}

# The previous build is spared for one run as well, because the daemon's --skip set is a snapshot taken at spawn.
prune_builds() {
  if skipped "$_agent"; then
    note "$_pad previous build kept: an agent is using it"
  else
    for _d in "$TOOLCHAIN/$_agent"-* "$TOOLCHAIN/$_agent".stage.*; do
      [ -d "$_d" ] && [ "$_d" != "$_build" ] && [ "$_d" != "$_prev" ] && rm -rf "$_d"
    done
    for _l in "$TOOLCHAIN/bin/$_agent".new.*; do
      [ -L "$_l" ] && rm -f "$_l"
    done
  fi
  # Explicit: the loop's status is false on an unmatched glob, which set -e turns into an early exit.
  return 0
}

# Each build lands in its own versioned directory, renamed in from a stage under TOOLCHAIN; bin/<agent> is repointed by renaming a fresh symlink.
# A refresh asks the registry for the latest version first and stages nothing when it is unchanged.
ensure_npm() {
  _agent=$1
  _pkg=$2
  _pad=$3
  _prev=""
  if [ -L "$TOOLCHAIN/bin/$_agent" ]; then
    _prev=$(readlink "$TOOLCHAIN/bin/$_agent" 2>/dev/null || true)
    _prev=${_prev%/bin/*}
  fi
  case "$(provenance "$_agent")" in
    # The --refresh-only guard sits on every absent arm, this one and each vendor fall-through; one missing downloads on a refresh-only run.
    "") if [ "$REFRESH_ONLY" = 1 ]; then not_installed "$_pad"; return 0; fi
        _verb=install ;;
    toolchain) _verb=refresh ;;
    *) outside_note "$_pad" "$_agent"; return 0 ;;
  esac
  _npm=$TOOLCHAIN/bin/npm
  have "$_npm" || _npm=npm
  have "$_npm" || { warn "  $_pad skipped: no npm to install it with"; failed=$((failed + 1)); return 0; }
  _node=$(dirname -- "$(command -v "$_npm")")/node
  [ -x "$_node" ] || _node=node
  _cur=""
  case "$_prev" in "$TOOLCHAIN/$_agent-"?*) _cur=${_prev#"$TOOLCHAIN/$_agent-"} ;; esac
  if [ "$CHECK" = 1 ]; then
    if [ "$_verb" = refresh ] && [ -n "$_cur" ]; then
      note "$_agent: would ask the registry for $_pkg@latest, and stage nothing if it is still $_cur"
    fi
    note "$_agent: would run: $_npm i -g --prefix $TOOLCHAIN/$_agent-<version> $_pkg@latest, then repoint $TOOLCHAIN/bin/$_agent"
    done_note "$_pad" "$_verb" "$_agent"
    return 0
  fi
  if [ "$_verb" = refresh ] && [ -n "$_cur" ]; then
    _latest=$("$_npm" view "$_pkg@latest" version 2>/dev/null || true)
    if [ -n "$_latest" ] && [ "$_latest" = "$_cur" ]; then
      _build=$_prev
      prune_builds
      done_note "$_pad" current "$_agent"
      return 0
    fi
  fi
  mkdir -p "$TOOLCHAIN/bin"
  _stage=$(mktemp -d "$TOOLCHAIN/$_agent.stage.XXXXXX") || { warn "  $_pad install failed; cannot stage under $TOOLCHAIN"; failed=$((failed + 1)); return 0; }
  step "$_agent" install
  if ! "$_npm" i -g --prefix "$_stage" "$_pkg@latest" >/dev/null 2>&1 || [ ! -x "$_stage/bin/$_agent" ]; then
    rm -rf "$_stage"
    if [ "$_verb" = refresh ]; then
      warn "  $_pad refresh failed; keeping $("$_agent" --version 2>/dev/null | head -1)"
    else
      warn "  $_pad install failed; this machine has no copy of it until the next run"
    fi
    failed=$((failed + 1))
    return 0
  fi
  _manifest=$_stage/lib/node_modules/$_pkg/package.json
  _ver=$("$_node" -p 'require(process.argv[1]).version' "$_manifest" 2>/dev/null || true)
  [ -n "$_ver" ] || _ver=$(grep -o '"version": *"[^"]*"' "$_manifest" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "$_ver" ] || _ver=$(date +%Y%m%d%H%M%S)
  _build=$TOOLCHAIN/$_agent-$_ver
  if [ -d "$_build" ]; then
    rm -rf "$_stage"
  else
    mv "$_stage" "$_build"
  fi
  rm -f "$TOOLCHAIN/bin/$_agent.new.$$"
  step "$_agent" link
  if ! { ln -s "$_build/bin/$_agent" "$TOOLCHAIN/bin/$_agent.new.$$" && mv -f "$TOOLCHAIN/bin/$_agent.new.$$" "$TOOLCHAIN/bin/$_agent"; }; then
    warn "  $_pad could not repoint $TOOLCHAIN/bin/$_agent; the build that ran before still does"
    failed=$((failed + 1))
    return 0
  fi
  prune_builds
  done_note "$_pad" "$_verb" "$_agent"
}

ensure_claude() {
  [ -z "${CLAUDE_CODE_EXECUTABLE:-}" ] || { note "claude        left alone: CLAUDE_CODE_EXECUTABLE names the build that runs"; return 0; }
  case "$(provenance claude)" in
    # A false if with no else exits 0, so the fall-through to the install path survives set -e.
    "") if [ "$REFRESH_ONLY" = 1 ]; then not_installed "claude       "; return 0; fi ;;
    toolchain) ensure_npm claude @anthropic-ai/claude-code "claude       "; return 0 ;;
    outside) outside_note "claude       " claude; return 0 ;;
    vendor)
      if [ "$SOURCE" = npm ]; then vendor_copy_stays "claude       " claude; return 0; fi
      # The install verb with the channel: update follows the last-saved autoUpdatesChannel, and the installer script downloads ~200 MB every time.
      if attempt "claude" claude install "$CHANNEL"; then done_note "claude       " refresh claude
      else warn "  claude        install $CHANNEL failed; keeping $(claude --version 2>/dev/null | head -1)"; failed=$((failed + 1)); fi
      return 0
      ;;
  esac
  if [ "$SOURCE" = npm ]; then ensure_npm claude @anthropic-ai/claude-code "claude       "; return 0; fi
  have curl || { warn "  claude        skipped: curl is not on PATH"; failed=$((failed + 1)); return 0; }
  if download claude https://claude.ai/install.sh && attempt "claude" bash "$TMP/claude.sh" "$CHANNEL"; then
    done_note "claude       " install claude
  else
    warn "  claude        install failed; this machine has no copy of it until the next run"
    failed=$((failed + 1))
  fi
}

ensure_codex() {
  [ -z "${CODEX_PATH:-}" ] || { note "codex         left alone: CODEX_PATH names the build that runs"; return 0; }
  case "$(provenance codex)" in
    "") if [ "$REFRESH_ONLY" = 1 ]; then not_installed "codex        "; return 0; fi ;;
    toolchain) ensure_npm codex @openai/codex "codex        "; return 0 ;;
    outside) outside_note "codex        " codex; return 0 ;;
    vendor)
      if [ "$SOURCE" = npm ]; then vendor_copy_stays "codex        " codex; return 0; fi
      if attempt "codex" codex update; then done_note "codex        " refresh codex
      else warn "  codex         update failed; keeping $(codex --version 2>/dev/null | head -1)"; failed=$((failed + 1)); fi
      return 0
      ;;
  esac
  if [ "$SOURCE" = npm ]; then ensure_npm codex @openai/codex "codex        "; return 0; fi
  have curl || { warn "  codex         skipped: curl is not on PATH"; failed=$((failed + 1)); return 0; }
  # Never under sudo: run as root, this installer leaves a binary the service user cannot update.
  if download codex https://chatgpt.com/codex/install.sh && attempt "codex" env CODEX_NON_INTERACTIVE=1 sh "$TMP/codex.sh"; then
    done_note "codex        " install codex
  else
    warn "  codex         install failed; this machine has no copy of it until the next run"
    failed=$((failed + 1))
  fi
}

ensure_opencode() {
  case "$(provenance opencode)" in
    "") if [ "$REFRESH_ONLY" = 1 ]; then not_installed "opencode     "; return 0; fi ;;
    toolchain) ensure_npm opencode opencode-ai "opencode     "; return 0 ;;
    outside) outside_note "opencode     " opencode; return 0 ;;
    vendor)
      if [ "$SOURCE" = npm ]; then vendor_copy_stays "opencode     " opencode; return 0; fi
      # --method curl is required, or the upgrade can stop on a prompt nobody answers.
      if attempt "opencode" opencode upgrade --method curl; then done_note "opencode     " refresh opencode
      else warn "  opencode      upgrade failed; keeping $(opencode --version 2>/dev/null | head -1)"; failed=$((failed + 1)); fi
      return 0
      ;;
  esac
  if [ "$SOURCE" = npm ]; then ensure_npm opencode opencode-ai "opencode     "; return 0; fi
  have curl || { warn "  opencode      skipped: curl is not on PATH"; failed=$((failed + 1)); return 0; }
  if download opencode https://opencode.ai/install && attempt "opencode" bash "$TMP/opencode.sh" --no-modify-path; then
    done_note "opencode     " install opencode
  else
    warn "  opencode      install failed; this machine has no copy of it until the next run"
    failed=$((failed + 1))
  fi
}

ensure_kimi() {
  # Never kimi's own upgrade verb: without a TTY it exits 0 having installed nothing; deploycheck asserts its absence.
  ensure_npm kimi @moonshot-ai/kimi-code "kimi         "
}

ensure_grok() {
  # npm under either --source, because grok's vendor installer edits shell profiles.
  # Never --no-optional: the platform binary is an optional dependency. --no-auto-update is resolveAgent's to pass.
  ensure_npm grok @xai-official/grok "grok         "
}

main() {
  take_lock
  if [ "$SOURCE" = npm ]; then _how="from the npm registry"
  elif wanted claude; then _how="with each vendor's own installer, claude on its $CHANNEL channel"
  else _how="with each vendor's own installer"; fi
  if [ "$SOURCE" = npm ] && [ "$CHANNEL" != latest ]; then note "claude        --channel $CHANNEL does not apply under --source npm: the registry has no channels, so @latest is what is installed"; fi
  _mode=""
  if [ "$REFRESH_ONLY" = 1 ]; then _mode="refresh only, nothing new is installed; "; fi
  if [ "$ONLY" != " " ]; then _named=${ONLY# }; _mode="$_mode${_named% } only; "; fi
  if [ "$CHECK" = 1 ]; then _mode="--check: nothing will be changed; $_mode"; fi
  say "agents ($_mode$_how)"
  # Not _agent, which ensure_npm uses as a global.
  for _which in $AGENTS; do
    wanted "$_which" || continue
    attempted=$((attempted + 1))
    _was=$failed
    step "$_which" start
    case "$_which" in
      claude)   ensure_claude ;;
      codex)    ensure_codex ;;
      opencode) ensure_opencode ;;
      kimi)     ensure_kimi ;;
      grok)     ensure_grok ;;
    esac
    if [ "$failed" = "$_was" ]; then step "$_which" done; else step "$_which" failed; fi
  done
  if [ "$failed" -gt 0 ]; then
    warn "  $failed of $attempted agents were not installed or refreshed; the lines above say why"
  fi
  return 0
}

main "$@"
