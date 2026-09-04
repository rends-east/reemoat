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

# ⚠ **SIGPIPE is ignored before the first byte is written, because the daemon is
# a reader that leaves.** `src/agentupdate.ts` spawns this script on pipes
# (`stdio: ["ignore", "pipe", "pipe"]`, detached) and `process.exit`s on shutdown
# without waiting for it; libuv resets every signal disposition to its default in
# the child, so the next `printf` after the daemon is gone is a SIGPIPE, and the
# default action ends the script where it stands — mid-install, with the EXIT trap
# never run and `$TMP` left behind. Measured with the fake registry and a reader
# that exits after one line: status 141, three of the four builds missing, and
# under dash the temporary directory still on disk (bash runs the EXIT trap on its
# way out and loses only the builds). Ignored, a write to the closed pipe is `EPIPE` instead,
# which `say`, `note` and `warn` swallow so `set -e` does not turn the failed
# builtin into the same early end. The disposition is inherited by everything this
# script runs — the three vendor installers and `npm` among them — which then see
# `EPIPE` on a write like any program whose reader has gone, rather than dying on
# a signal in a run whose *caller* has already stopped reading.
trap '' PIPE

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

# Each tolerates a closed stream: with SIGPIPE ignored (above) a `printf` whose
# reader has gone fails with `EPIPE`, and under `set -e` a failing builtin ends the
# script as surely as the signal would have. The `2>/dev/null` sits *after* `>&2`
# in `warn`, so the message still reaches stderr and only the shell's own "write
# error" complaint is dropped. None of the three is read through `$( … )` — the
# substitutions in `done_note` and `outside_note` are *arguments* to `note` — so
# swallowing the status changes no value anything computes.
#
# ⚠ **In a subshell, and that is the measured half.** bash keeps the bytes a
# failed builtin write could not deliver in its stdio buffer, and the next
# `$( … )` — a forked copy of the same buffer — flushes them into the value it
# captures: with stdout closed, `_ver=$("$_node" -p …)` came back as every note
# printed so far with the version on the end, and `codex --version` "printed" the
# claude line above it. dash discards on error and was clean. Forked, the dirty
# buffer dies with the subshell and the parent's stays empty, on both.
#
# `warn`'s two redirections are inside the subshell and in that order, because a
# `2>/dev/null` on the *subshell* is applied first and the `>&2` inside then dups
# a stderr that is already `/dev/null`: measured as every warning in the file —
# the "in progress" sentence, the vendor-copy remedy, the failure count — going
# nowhere, with the run still exiting 0.
say()  { ( printf '%s\n' "$*" ) 2>/dev/null || :; }
note() { ( printf '  %s\n' "$*" ) 2>/dev/null || :; }
warn() { ( printf '%s\n' "$*" >&2 2>/dev/null ) || :; }
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

# **One run at a time, whoever started it.** Three callers and nothing between
# them: the daemon's timer, `deploy.sh` on the update that is about to restart
# that daemon, the bootstrap — and a fourth nobody starts on purpose, the run a
# previous daemon left behind. `src/agentupdate.ts`'s `running` guard is a field
# in the daemon's memory, and `runScript` spawns this script *detached*, so a
# daemon that exits mid-run leaves it going and the daemon that replaces it starts
# another five minutes later beside the orphan. Two runs do not share a stage —
# `mktemp` sees to that — but each prunes every build that is not its own,
# including the one the other has just linked, both race on `$TOOLCHAIN/bin/<agent>`,
# and two vendor installers write the same `~/.local/bin` file over each other.
#
# The lock is a directory, since `mkdir` is the one atomic create-or-fail POSIX
# `sh` has, holding the pid of the run that owns it. A pid that no longer answers
# `kill -0` is a run that was killed — the daemon's deadline is a `SIGKILL` to the
# whole group, which runs no trap — and its lock is taken over; a pid that does
# answer is a run in progress, and this one says so and exits 0, because every
# caller's contract is that this script never fails. A pid file that is not there
# yet is given one second, the window between `mkdir` and the write being
# microseconds and a crash inside it being the only way to an owner with no pid.
# The one hole is pid reuse: a stale pid handed to an unrelated process reads as
# "in progress" until that process ends, and a run is skipped rather than doubled,
# which is the right way round. `--check` changes nothing and takes no lock, so a
# preview is never refused by a run.
#
# ⚠ **One EXIT trap, releasing both.** `sh` holds one trap per signal, so the
# `rm -rf "$TMP"` that stood here alone is now the same function, and the lock is
# released only by the run that took it — `exit 0` on the sentence above must not
# remove another run's lock on its way out.
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
           exit 0
         fi ;;
    esac
    # Stale: the owner is gone. Taken over by removing it and going round again,
    # so a second taker in the same instant loses the `mkdir` rather than both
    # proceeding.
    rm -rf "$LOCK"
  done
  warn "  could not take $LOCK after 3 tries; nothing was changed"
  exit 0
}

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
#
# ⚠ **`https` in, `https` all the way, or nothing.** Every one of these URLs is
# `https://`, and `-L` follows what the vendor answers — including a `Location:`
# to `http://`, which curl follows by default, so a redirect on the vendor's side
# (or on a path in between) would land a script this daemon then *executes* on a
# plaintext hop. `--proto '=https'` holds the first request to https and
# `--proto-redir '=https'` every hop after it; a downgrade is then curl exiting 1
# and the harness "not installed until the next run", which is the failure this
# script already knows how to say.
download() {
  if [ "$CHECK" = 1 ]; then note "$1: would download $2"; return 0; fi
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 -o "$TMP/$1.sh" "$2" >/dev/null 2>&1
}

# What an npm-installed harness leaves on disk after a run: every build but the
# one linked now (`$_build`) and the one linked when the run began (`$_prev`) —
# unless this harness is live, in which case nothing is pruned at all, the daemon
# having said so with `--skip <agent>`. Reads those three from `ensure_npm`.
#
# ⚠ **The previous build is kept for one run even with no `--skip`, because the
# daemon's `--skip` set is a snapshot.** `src/agentupdate.ts` reads `busy()` once,
# when it spawns this script, and a run is minutes long: a session that starts
# *during* it resolves `$TOOLCHAIN/bin/<agent>` to whatever the symlink names at
# that instant — the old build until the `mv` in `ensure_npm`, and a build the
# daemon's snapshot never named. Pruning "every build but `$_build`" then took the
# tree a live process had just started from. Reading the symlink at the top of
# `ensure_npm` is what names that build, and sparing it means a superseded build
# survives the run that superseded it and goes on the next run with no `--skip`
# — a day later, by which time the snapshot has had a chance to see the session.
# Older builds still go now. A function rather than a paragraph inside
# `ensure_npm`, because the run that found nothing newer prunes too: otherwise
# the build spared yesterday would live until the next *release* rather than the
# next run, and "one run" above would be false for every quiet week.
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
  # ⚠ A function's status is its last command's, and that is a `for` whose last
  # body command is an `&&` list — false on an unmatched glob. Inline, that status
  # was discarded; as a function called bare under `set -e` it ended the run after
  # the first harness, exit 1, nothing on stderr. Measured by `deploycheck`.
  return 0
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
#
# ⚠ **A refresh asks the registry which version it has before staging anything.**
# Written as stage-then-compare, every run wrote a whole install into a fresh
# stage and only then found `[ -d "$_build" ]` — measured at 126 MB written and
# deleted per day per npm-installed harness (kimi always; all four under
# `--source npm`) to learn "nothing to do", which is the pattern the claude arm
# already refuses in so many words ("downloads ~200 MB every time"). So for a copy
# that is ours — the `refresh` verb; an install has nothing to compare — the build
# the launcher names is read off `$_prev` and `npm view <pkg>@latest version` is
# asked, one small request. Equal means nothing is staged, nothing moves and the
# note says `current`; the prune still runs, for the reason `prune_builds` gives.
# Anything else — a newer version, `view` failing, `view` answering nothing, a
# build directory named by the clock — falls through to the path above, which is
# the one that was measured safe, so a registry that cannot answer the question
# costs exactly what every run cost before it was asked. No deadline of its own:
# a stalled `view` holds the run no longer than the stalled `npm i` it replaces
# could, and the daemon's deadline bounds both. Under `--check` the registry is
# not asked at all; the note says what would be compared.
ensure_npm() {
  _agent=$1
  _pkg=$2
  _pad=$3
  # The build `$TOOLCHAIN/bin/<agent>` pointed at when this run began — its
  # directory, `$TOOLCHAIN/<agent>-<version>` — read *before* anything moves, and
  # never pruned by this run; see the prune below for why one previous build
  # outlives the run that superseded it.
  _prev=""
  if [ -L "$TOOLCHAIN/bin/$_agent" ]; then
    _prev=$(readlink "$TOOLCHAIN/bin/$_agent" 2>/dev/null || true)
    _prev=${_prev%/bin/*}
  fi
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
  # The version part of `$TOOLCHAIN/<agent>-<version>`, or empty when the launcher
  # names nothing of that shape.
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
  prune_builds
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
  take_lock
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
