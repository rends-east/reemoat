#!/bin/sh
# deploy/agents.sh — install the coding-agent CLIs, and keep them moving.
#
#   deploy/agents.sh                 # install what is missing, refresh what is there
#   deploy/agents.sh --check         # say what would happen, change nothing
#   deploy/agents.sh --source npm    # the same four from the npm registry rather than the
#                                    #   vendors' own hosts — the arm for a machine behind
#                                    #   a firewall. `vendor` is the default and the only
#                                    #   other value
#   deploy/agents.sh --skip <agent>  # keep that harness's previous build on disk; repeatable,
#                                    #   and what the daemon passes for each harness with a
#                                    #   live agent (see below for what it withholds)
#
# Exits 0 whatever the vendors answered — a failure is a line on stderr, never a
# status, and the daemon forwards those lines as warnings — and 2 only for a flag
# it does not know, a `--source` that is neither `vendor` nor `npm`, or a `--skip`
# or `--source` with nothing after it. With no `HOME` at all it stops at its first
# line, non-zero: a state no caller can produce, since the daemon sets `HOME`
# itself and the other two run from a shell that has one.
#
# **One script and three callers, because install and update are the same act
# here.** `deploy/bootstrap.sh` runs it once so a fresh machine ends with working
# agents; `deploy/deploy.sh` runs it on every daemon update, before it decides the
# restart, with every prune withheld; `src/agentupdate.ts` runs it on a timer so
# they do not rot. Written as install-if-absent then refresh-if-present so all
# three take the same path and there is no second code path to keep in step.
# Q4.113 is the measurement and the argument; what is here is the shape.
#
# **Why this exists at all: not one of the four self-updates under ACP.** Measured
# 2026-09-03. Their updaters are all gated on a terminal that a daemon-spawned agent
# never has — claude's is an Ink component mounted only by TUI screens, codex only
# prints a nag, opencode's `checkUpgrade` is reached from its TUI command handler and
# never from `acp`, and kimi's preflight runs only from its main command. The drift
# is the proof, on the machine this was written on: kimi 0.29.2 against 0.40.1
# upstream and codex 0.146.1 against 0.153.0, both months behind and both never run
# in a terminal here, while claude — which *is* run in a terminal here — sat at the
# newest build. So the vendor's own machinery cannot be relied on and reemoat owns
# the cadence.
#
# ⚠ **These are the only copies, and the daemon cannot start a harness without one.**
# `pnpm install` used to bring a pinned copy of three of the four — exactly as old as
# the release, and never the one that ran once one of these was on the machine — and
# it no longer does (Q4.114). So a vendor that cannot be reached on a fresh machine is
# a harness that is *absent* until the next run, and the daemon says so on the tile
# rather than failing at spawn. Nothing here is a fallback for anything.
#
# **`--source npm` is for the machine that cannot reach `claude.ai`, `chatgpt.com` or
# `opencode.ai` at all.** Every one of the four is also published on the npm registry
# — `@anthropic-ai/claude-code`, `@openai/codex`, `opencode-ai` and
# `@moonshot-ai/kimi-code` — so behind a firewall with an npm mirror they install from
# there, into reemoat's own toolchain, the way kimi always has. npm's own
# `npm_config_registry` (or `~/.npmrc`) is how the mirror is named; nothing here reads
# it. It is a *choice* rather than a fallback on purpose: a vendor outage silently
# switching a machine to a differently built binary is the kind of change nobody
# asked for, and the daemon passes the value from `REEMOAT_AGENT_SOURCE` on every run
# so the install and the refresh never disagree.
#
# ⚠ **And it decides how an *absent* harness is installed, nothing about one that is
# present** — see `provenance` below. A copy is refreshed through the door it came in
# by, whatever the flag says today, which is what makes switching the flag on a
# machine that already has its agents safe in both directions.
#
# **No sudo, ever. No system package manager. No shell profile is touched** — the
# PATH export below is what makes codex's and opencode's own profile writers
# early-return, and it is load-bearing rather than convenience.
#
# ⚠ **This does write outside `~/.reemoat`**, which narrows a promise
# `bootstrap.sh` used to make whole: under `--source vendor` the CLIs land in the
# vendors' own directories (`~/.local/bin`, `~/.local/share/claude`, `~/.codex`,
# `~/.opencode`) because none of the three native installers is relocatable.
# `--uninstall` deliberately leaves them: they hold credentials somebody signed in
# with, and taking those away is not what removing reemoat means. Under
# `--source npm` everything lands under `~/.reemoat/toolchain`.
#
# Never fatal. A vendor that is down, a network that is blocked or an installer that
# changed its mind must not fail an install or a nightly run — every agent that
# cannot be reached is a warning on stderr, and the timer tries again within the day.
#
# POSIX sh. Fails on an unset variable as well as a non-zero exit.
set -eu

CHECK=0
SKIP=" "
SOURCE=vendor
_want_skip=0
_want_source=0
for _arg in "$@"; do
  if [ "$_want_skip" = 1 ]; then SKIP="$SKIP$_arg "; _want_skip=0; continue; fi
  if [ "$_want_source" = 1 ]; then
    case "$_arg" in
      vendor | npm) SOURCE=$_arg ;;
      *) printf -- '--source takes vendor or npm, not %s\n' "$_arg" >&2; exit 2 ;;
    esac
    _want_source=0
    continue
  fi
  case "$_arg" in
    --check)  CHECK=1 ;;
    --skip)   _want_skip=1 ;;
    --source) _want_source=1 ;;
    *) printf 'unknown flag: %s\n' "$_arg" >&2; exit 2 ;;
  esac
done
[ "$_want_skip" = 1 ] && { printf -- '--skip needs an agent name\n' >&2; exit 2; }
[ "$_want_source" = 1 ] && { printf -- '--source needs vendor or npm\n' >&2; exit 2; }

# ⚠ **What `--skip` withholds, and which harnesses have anything to withhold.** The
# three native installers all swap by *rename* — a symlink repointed, or a `mv` over
# the old file — so a process already running keeps the inode it opened and never
# notices; there is nothing to skip, and a skip there was measured as the thing that
# left a long-lived session's harness stale for ever. An npm package is different:
# `npm i -g` writes over a tree in place — `ETXTBSY` against a live process on Linux
# and, worse, a half-written install — so every harness that arrives as one (kimi
# always; all four under `--source npm`) is put into a *versioned* directory of its
# own and `$TOOLCHAIN/bin/<agent>` is repointed by rename, the same shape as the
# installers. The one thing left that could hurt a live process is pruning the build
# it is running. That is all `--skip <agent>` withholds: the install still happens,
# the symlink still moves, and the previous build stays until a run with no live
# agent on that harness.
skipped() { case "$SKIP" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

say()  { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# **Kept in step with `MANAGED_CLI_DIRS` in `src/acp/agents.ts` by `deploycheck`,
# which imports that constant rather than restating it.** Two files naming the same
# directories is the hazard `CLAUDE.md` already records for `.dockerignore` and the
# Dockerfile; importing is what stops them drifting.
#
# Exported rather than merely searched: it is what makes codex's `add_to_path` and
# opencode's profile writer return early, so nothing edits a shell profile.
#
# ⚠ **Appended, never prepended** — the rule `MANAGED_CLI_DIRS` states for the
# daemon, for the same reason: this script runs `curl`, `sh`, `bash`, `head` and
# `npm` by bare name, daily, as the daemon's uid, and `~/.local/bin` is a directory
# that uid can write to. In front of `/usr/bin` it would win every one of those
# lookups. What the vendors' profile writers test is membership, which an append
# satisfies just as well.
HOME_DIR=${HOME:?HOME is not set}
PATH="$PATH:$HOME_DIR/.local/bin:$HOME_DIR/.opencode/bin:$HOME_DIR/.reemoat/toolchain/bin"
export PATH

# Where an npm-installed harness goes, and where the bootstrap's own node already lives.
TOOLCHAIN="$HOME_DIR/.reemoat/toolchain"

# Where an installer script lands before it runs — see `download`.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/reemoat-agents.XXXXXX") || { warn "  cannot make a temporary directory; nothing was changed"; exit 0; }
trap 'rm -rf "$TMP"' EXIT

failed=0

# What to say after a step that reported success.
#
# ⚠ **Under `--check` nothing ran, so nothing may be claimed.** Written as a plain
# `--version` call it announced `opencode installed` with an empty version on a
# machine where opencode is not installed at all — a dry run asserting the outcome
# it was asked not to produce.
done_note() {
  if [ "$CHECK" = 1 ]; then note "$1 would $2"
  else note "$1 $2 $($3 --version 2>/dev/null | head -1)"; fi
}

# Runs a step unless --check, and never lets its failure escape.
attempt() {
  _what=$1
  shift
  if [ "$CHECK" = 1 ]; then
    note "$_what: would run: $*"
    return 0
  fi
  if "$@" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Where a copy came from, read off where it is: `toolchain` (an npm install of
# ours), `vendor` (the vendor's own installer, whoever ran it — its directories are
# not relocatable, so the place is the proof), `outside` (anywhere else: Homebrew, a
# global npm, a hand-built one), or empty for none at all.
#
# The place is a proof with one known hole: `~/.local/bin` is also where a global
# npm with `prefix=~/.local` (and pipx, and uv) puts what it installs, so a claude
# or codex somebody installed that way reads as `vendor` and is handed the vendor's
# own update verb, whose answer on an npm tree is unmeasured — at worst a "keeping"
# warning, since the verb's failure is caught. A stronger proof would `readlink`
# against the vendors' own trees (`~/.local/share/claude/versions`,
# `~/.codex/packages/standalone`); it is not taken until the hole is measured to
# matter.
#
# ⚠ **`--source` decides how a harness that is absent is installed, and nothing
# about one that is present: a copy is refreshed through the door it came in by.**
# Measured before this existed, both directions of a switch went wrong: under `npm`
# a claude the vendor arm had put in `~/.local/bin` read as "installed outside
# reemoat" and was never refreshed again — on exactly the machine `npm` is for, one
# whose vendor hosts went dark after a vendor install — and under `vendor` the
# native updaters were run against copies npm had installed under the toolchain.
# The one thing a switch cannot do is refresh a vendor-installed copy from the
# registry: under `npm` that copy is named, counted as a failure so the daemon
# warns daily, and the remedy is said — remove it, and the next run installs from
# npm.
provenance() {
  case "$(command -v "$1" 2>/dev/null || true)" in
    "") printf '' ;;
    "$TOOLCHAIN"/bin/*) printf 'toolchain' ;;
    "$HOME_DIR"/.local/bin/* | "$HOME_DIR"/.opencode/bin/*) printf 'vendor' ;;
    *) printf 'outside' ;;
  esac
}

# A copy this script did not install is named and not moved. Installing beside it
# would download a file nothing runs — the daemon's `findOnPath` walks `PATH` first
# and these directories after — and updating it would be moving somebody else's
# install.
#   outside_note "<agent, padded>" <agent>
outside_note() {
  note "$1 $("$2" --version 2>/dev/null | head -1) — installed outside reemoat, not updated from here"
}

# The one thing a switch to `npm` cannot do — see `provenance`. A warning rather
# than a note, because it is the state in which a harness rots: the vendor's own
# updater is the only thing that refreshes this copy, and `--source npm` was set
# precisely because that updater's host cannot be reached.
#   vendor_copy_stays "<agent, padded>" <agent>
vendor_copy_stays() {
  warn "  $1 $("$2" --version 2>/dev/null | head -1) at $(command -v "$2") was installed by the vendor's installer, which --source npm does not reach; remove it and the next run installs from the npm registry"
  failed=$((failed + 1))
}

# The installer script into `$TMP`, with a deadline, and never straight into a shell.
#
# ⚠ **`curl … | bash` has no exit status of its own to give.** Without `pipefail` —
# which POSIX `sh` does not have — the pipeline's status is bash's, so a download cut
# off mid-way is a *prefix* executed to its last complete line and reported as
# success. The vendors' scripts wrap themselves in a `main` for exactly this reason,
# and this script must not rely on every one of them having done so: a file is a
# whole download or a failure. The deadline is what stops one stalled vendor holding
# the daemon's run for its whole budget — and, on the bootstrap, spending the hour an
# enrollment code lives.
download() {
  if [ "$CHECK" = 1 ]; then note "$1: would download $2"; return 0; fi
  curl -fsSL --connect-timeout 30 --max-time 600 -o "$TMP/$1.sh" "$2" >/dev/null 2>&1
}

# One harness from the npm registry, into a directory of its own.
#
#   ensure_npm <agent> <package> "<agent, padded for the column>"
#
# kimi's arm, generalised: kimi has always arrived this way because its native
# installer refuses musl outright and needs glibc >= 2.28 plus libstdc++, while the
# npm package carries no `os` restriction — the arm that works on a bare server. Under
# `--source npm` the other three take the same door. It goes into reemoat's own prefix
# with the node the bootstrap already installed, so it neither needs nor touches a
# system npm.
#
# ⚠ **An operator's own copy wins, and installing beside it would be the silent no-op
# this script refuses everywhere.** The daemon's `findOnPath` walks `PATH` first and
# `MANAGED_CLI_DIRS` after it, so where the harness is already on `PATH` from
# somewhere else (a global npm, Homebrew), a managed copy could never be the one that
# runs — and putting one there would download ~100 MB to produce a file nothing
# executes while reporting success. Say whose it is instead; a copy this daemon did
# not install is not its to move.
#
# ⚠ **Into a directory of its own, named by version, and never over the one that
# runs.** `npm i -g` writes a tree in place, and a live process that lazily
# `require`s a file it has not loaded yet would read the *new* build's copy if the
# tree changed under it. So each build lands in `$TOOLCHAIN/<agent>-<version>` —
# staged under `$TOOLCHAIN` first so the final `mv` is one `rename(2)` on one
# filesystem — and `$TOOLCHAIN/bin/<agent>` is repointed by renaming a fresh symlink
# over the old one. A process already running keeps the directory it started from,
# which is `~/.local/share/claude/versions/` one vendor over.
ensure_npm() {
  _agent=$1
  _pkg=$2
  _pad=$3
  case "$(provenance "$_agent")" in
    "") _verb=install ;;
    toolchain) _verb=refresh ;;
    # A vendor-installed kimi lands here too, since kimi has no vendor arm of its
    # own: `kimi upgrade` lies (below), so it is left alone like any other copy.
    *) outside_note "$_pad" "$_agent"; return 0 ;;
  esac
  _npm=$TOOLCHAIN/bin/npm
  have "$_npm" || _npm=npm
  have "$_npm" || { warn "  $_pad skipped: no npm to install it with"; failed=$((failed + 1)); return 0; }
  # The node beside that npm, for reading a manifest below; npm's own shim needs
  # one on PATH anyway, so this resolves wherever npm does.
  _node=$(dirname -- "$(command -v "$_npm")")/node
  [ -x "$_node" ] || _node=node
  if [ "$CHECK" = 1 ]; then
    note "$_agent: would run: $_npm i -g --prefix $TOOLCHAIN/$_agent-<version> $_pkg@latest, then repoint $TOOLCHAIN/bin/$_agent"
    done_note "$_pad" "$_verb" "$_agent"
    return 0
  fi
  mkdir -p "$TOOLCHAIN/bin"
  _stage=$(mktemp -d "$TOOLCHAIN/$_agent.stage.XXXXXX") || { warn "  $_pad install failed; cannot stage under $TOOLCHAIN"; failed=$((failed + 1)); return 0; }
  if ! "$_npm" i -g --prefix "$_stage" "$_pkg@latest" >/dev/null 2>&1 || [ ! -x "$_stage/bin/$_agent" ]; then
    rm -rf "$_stage"
    # Said by what is true afterwards: a failed refresh leaves the previous build
    # linked and running, and only a failed install leaves nothing.
    if [ "$_verb" = refresh ]; then
      warn "  $_pad refresh failed; keeping $("$_agent" --version 2>/dev/null | head -1)"
    else
      warn "  $_pad install failed; this machine has no copy of it until the next run"
    fi
    failed=$((failed + 1))
    return 0
  fi
  # The version off the manifest npm wrote, read as JSON rather than by line: a
  # published `package.json` may be one line, and a `sed` anchored on the line
  # start then answered nothing and every run landed in a directory named by the
  # clock — so nothing was ever "already the build on disk", and every nightly run
  # repointed and pruned over an unchanged version. The date is the last resort,
  # and it costs only that.
  _manifest=$_stage/lib/node_modules/$_pkg/package.json
  _ver=$("$_node" -p 'require(process.argv[1]).version' "$_manifest" 2>/dev/null || true)
  # The *first* `"version"` on the file, since a one-line manifest may carry a
  # nested one after it and a greedy `sed` took the last.
  [ -n "$_ver" ] || _ver=$(grep -o '"version": *"[^"]*"' "$_manifest" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "$_ver" ] || _ver=$(date +%Y%m%d%H%M%S)
  _build=$TOOLCHAIN/$_agent-$_ver
  if [ -d "$_build" ]; then
    # Already the build on disk: nothing moved, and nothing needs to.
    rm -rf "$_stage"
  else
    mv "$_stage" "$_build"
  fi
  # A leftover `.new.<pid>` from a run killed between the two calls would make the
  # `ln` fail and the `mv` never happen, with the note below still claiming a
  # refresh; cleared first, and every stale one swept with the builds.
  rm -f "$TOOLCHAIN/bin/$_agent.new.$$"
  if ! { ln -s "$_build/bin/$_agent" "$TOOLCHAIN/bin/$_agent.new.$$" && mv -f "$TOOLCHAIN/bin/$_agent.new.$$" "$TOOLCHAIN/bin/$_agent"; }; then
    warn "  $_pad could not repoint $TOOLCHAIN/bin/$_agent; the build that ran before still does"
    failed=$((failed + 1))
    return 0
  fi
  # Every build but the one just linked — unless this harness is live, in which case
  # the one it replaced may be the tree that session started from, and the daemon
  # says so with `--skip <agent>`. Pruned on the next run with none live, so a
  # superseded build survives for as long as anything might be on it.
  if skipped "$_agent"; then
    note "$_pad previous build kept: an agent is using it"
  else
    for _d in "$TOOLCHAIN/$_agent"-* "$TOOLCHAIN/$_agent".stage.*; do
      [ -d "$_d" ] && [ "$_d" != "$_build" ] && rm -rf "$_d"
    done
    for _l in "$TOOLCHAIN/bin/$_agent".new.*; do
      [ -L "$_l" ] && rm -f "$_l"
    done
  fi
  done_note "$_pad" "$_verb" "$_agent"
}

ensure_claude() {
  # An operator who named the build in `CLAUDE_CODE_EXECUTABLE` has answered the
  # question this script exists to ask, and the daemon never looks past an
  # override — a copy refreshed beside it would be a download nothing runs.
  [ -z "${CLAUDE_CODE_EXECUTABLE:-}" ] || { note "claude        left alone: CLAUDE_CODE_EXECUTABLE names the build that runs"; return 0; }
  case "$(provenance claude)" in
    toolchain) ensure_npm claude @anthropic-ai/claude-code "claude       "; return 0 ;;
    outside) outside_note "claude       " claude; return 0 ;;
    vendor)
      if [ "$SOURCE" = npm ]; then vendor_copy_stays "claude       " claude; return 0; fi
      # ⚠ **`claude update`, never a re-run of the installer.** That script has no
      # already-installed check and downloads ~200 MB every time; the CLI's own
      # update verb resolves the channel and exits without downloading when it is
      # current.
      if attempt "claude" claude update; then done_note "claude       " refresh claude
      else warn "  claude        update failed; keeping $(claude --version 2>/dev/null | head -1)"; failed=$((failed + 1)); fi
      return 0
      ;;
  esac
  if [ "$SOURCE" = npm ]; then ensure_npm claude @anthropic-ai/claude-code "claude       "; return 0; fi
  have curl || { warn "  claude        skipped: curl is not on PATH"; failed=$((failed + 1)); return 0; }
  # `stable` rather than `latest`, chosen rather than inherited: the two are tens of
  # patches apart, and a fleet that lands on whatever shipped this morning is a fleet
  # whose agents differ from each other for no reason anybody chose.
  if download claude https://claude.ai/install.sh && attempt "claude" bash "$TMP/claude.sh" stable; then
    done_note "claude       " install claude
  else
    warn "  claude        install failed; this machine has no copy of it until the next run"
    failed=$((failed + 1))
  fi
}

ensure_codex() {
  [ -z "${CODEX_PATH:-}" ] || { note "codex         left alone: CODEX_PATH names the build that runs"; return 0; }
  case "$(provenance codex)" in
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
  # ⚠ **Never under `sudo`.** This installer has no root guard of its own, and run as
  # root it would put a binary the service user cannot update into a directory the
  # service user does not own.
  if download codex https://chatgpt.com/codex/install.sh && attempt "codex" env CODEX_NON_INTERACTIVE=1 sh "$TMP/codex.sh"; then
    done_note "codex        " install codex
  else
    warn "  codex         install failed; this machine has no copy of it until the next run"
    failed=$((failed + 1))
  fi
}

ensure_opencode() {
  case "$(provenance opencode)" in
    toolchain) ensure_npm opencode opencode-ai "opencode     "; return 0 ;;
    outside) outside_note "opencode     " opencode; return 0 ;;
    vendor)
      if [ "$SOURCE" = npm ]; then vendor_copy_stays "opencode     " opencode; return 0; fi
      # `--method curl` is required rather than tidy: without it the resolver can
      # answer `unknown` and the upgrade stops on a prompt nobody is there to answer.
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
  # ⚠ **`kimi upgrade` is never called from here, and its absence is asserted.**
  # Measured 2026-09-03: without a TTY it prints the manual command and **exits 0
  # without installing anything**. A timer that shelled out to it and checked the
  # exit code would report success for ever while the build never moved — worse than
  # not trying, because it looks like it worked. npm under either `--source`, for the
  # reasons `ensure_npm` gives.
  ensure_npm kimi @moonshot-ai/kimi-code "kimi         "
}

main() {
  if [ "$SOURCE" = npm ]; then _how="from the npm registry"; else _how="with each vendor's own installer"; fi
  if [ "$CHECK" = 1 ]; then say "agents (--check: nothing will be changed; $_how)"; else say "agents ($_how)"; fi
  ensure_claude
  ensure_codex
  ensure_opencode
  ensure_kimi
  # Exit 0 whatever happened. The caller is an installer that must not abort over a
  # vendor being down, a deploy that must not either, or a timer whose failure mode
  # is a warning; the first two print the stderr lines above, and the daemon
  # forwards them.
  if [ "$failed" -gt 0 ]; then
    warn "  $failed of 4 agents were not installed or refreshed; the lines above say why"
  fi
  return 0
}

main "$@"
