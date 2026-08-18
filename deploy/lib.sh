#!/bin/sh
# Shared by install.sh and deploy.sh. Not executable on its own.
#
# This is the only file in the repository that knows one machine from another:
# which init system supervises a service, where `node`, `git` and `pnpm`
# actually live, what a service is called once installed, where its unit and its
# logs go, and how one is rendered and reloaded. Everything here is *derived* —
# there is no path, user or package manager prefix written down anywhere in
# `deploy/`, because the operator running this is not the author and their
# machine is not this one.
#
# POSIX sh throughout. The daemon needs git and the control plane needs
# nothing but Node, so a deploy that pulled in bash, python or a package manager
# would be adding a dependency to the *thinnest* part of the system.

# Fail on an unset variable as well as on a non-zero exit: every value below is
# derived, so a typo in a name is the likeliest failure and the silent one.
set -eu

# ---------------------------------------------------------------------------
# Where we are
# ---------------------------------------------------------------------------

# The repository root is the parent of this file's directory, resolved through
# symlinks — never a constant, and never `$PWD`. `deploy.sh` is meant to be
# runnable from anywhere, including from an init system with a working directory
# nobody chose.
#
# `CDPATH=` because a CDPATH set in the operator's profile makes `cd` print and
# occasionally land somewhere else entirely.
DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$DEPLOY_DIR/.." && pwd -P)

# ---------------------------------------------------------------------------
# The three services
# ---------------------------------------------------------------------------
#
# `daemon` and `control-plane` are separate deployments that happen to share a
# repository. They share it because `packages/control-plane` imports the root
# `src/` (`../../../src/token.js`, `auth.js`, `cors.js`, `relay/protocol.js`), so
# neither can be checked out alone — but nothing else about them matches: one is
# per host and runs agents on it, the other is one per fleet and builds the web UI.
#
# `relay` is the third, and it is a different kind of split: it shares the control
# plane's image, its env file and its database, and is separate only because their
# *restart costs* are opposite. Recreating the API is ordinary and constant;
# recreating the relay costs every tunnel in the fleet — tens of seconds of
# reconnecting for every open session and every in-flight request. One container
# made the cheap deploy pay the expensive price every time.
#
# Hence: one repository, one script, three services chosen by argument, and two
# of them on one host.

SERVICES="daemon control-plane relay"

# Guard against a typo becoming a silently skipped service. Every entry point
# validates through this before it does anything.
valid_service() {
  case "$1" in
    daemon | control-plane | relay) return 0 ;;
    *) return 1 ;;
  esac
}

# The compose service a docker-backed service is, which is a different question
# from what this script calls it and is only *coincidentally* the same string.
#
# It exists so no `svc_*` verb below writes a service name into a compose command
# by hand. Every one of them used to run a bare `compose up -d`, i.e. the whole
# project — which is exactly the behaviour the relay was split out to stop:
# restarting the API would have gone on recreating the relay beside it, and the
# split would have bought nothing at all while looking complete.
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

# What supervises a service, which is now the dimension that decides first.
#
# Every `svc_*` verb below used to branch on `$INIT_SYSTEM` alone and take a
# service argument it ignored. The control plane ships as an image and there is
# no second way to run it, so the service decides the backend and the init system
# decides only inside the `unit` arm.
#
# Not configurable, deliberately. A switch here would only be a way to be wrong
# on one machine, and the two backends do not have interchangeable state: a unit
# reads `~/.reemoat/control-plane.db` and a container reads a named volume, so
# "run it the other way for a minute" is a different database rather than a
# different supervisor.
service_backend() {
  case "$1" in
    daemon) printf 'unit' ;;
    control-plane | relay) printf 'docker' ;;
  esac
}

# The unit's name, in whatever the local init system calls names.
unit_label() {
  case "$INIT_SYSTEM" in
    launchd) printf 'com.reemoat.%s' "$1" ;;
    systemd) printf 'reemoat-%s' "$1" ;;
  esac
}

# The program the unit runs.
#
# One service now, and the containerised arms **refuse rather than printing an
# empty string**. That is the whole reason this is not a `case` with a blank
# branch: under `set -u` an empty `$(…)` is not an error, it is a value, and a
# unit rendered with an empty ExecStart is a thing launchd will happily accept
# and then fail to start for a reason nothing prints.
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

# Where each service's environment comes from, overridable because a packaged
# install will not want it under `$HOME`. Nothing in `src/` or `scripts/` reads
# a `.env` file — there is no dotenv, no `--env-file`, nothing — so the
# environment has to be supplied explicitly by whoever starts the process, and
# these are the paths the wrappers and the health check agree on.
#
# **The relay shares the control plane's file, and that is the design.** They are
# two processes of one deployment reading one configuration: the database path,
# the relay port and the issuer have to agree between them or the pair does not
# work at all, and two files is two places for them to disagree. It is the same
# file compose is given, so `compose.sh` and both containers read one artifact.
env_file() {
  case "$1" in
    daemon) printf '%s' "${REEMOAT_ENV_FILE:-$HOME/.reemoat/daemon.env}" ;;
    control-plane | relay) printf '%s' "${REEMOAT_CP_ENV_FILE:-$HOME/.reemoat/control-plane.env}" ;;
  esac
}

# The example each env file is seeded from, mirroring where they live in the
# repository: the daemon's at the root, the control plane's in its own package.
# The relay's is the control plane's, for the reason above.
env_example() {
  case "$1" in
    daemon) printf '%s/.env.example' "$REPO_ROOT" ;;
    control-plane | relay) printf '%s/packages/control-plane/.env.example' "$REPO_ROOT" ;;
  esac
}

# One value out of a service's environment file, or empty when the file or the key
# is absent.
#
# **Sourced inside a subshell, and that is the rule rather than a detail.** These
# files hold REEMOAT_TOKEN and, for the control plane, nothing less sensitive, and
# there is no reason for those values to exist in a process whose job is printing
# things and spawning `pnpm` and `git`. A caller that sourced in the *caller's*
# shell with `set -a` was harmless only because its call sites happened to be
# command substitutions, which is a property of the callers rather than of this
# function.
#
# The `[ -f ]` guard is the other half. Sourcing a file that is not there fails, and
# under `set -e` that failure aborts whatever was in progress — measured: on a
# machine with no daemon environment file, reading a value out of it killed the
# deploy *after* it had already moved the checkout, leaving the tree at the new
# commit with nothing restarted.
file_value() {
  # The key is always a literal from this file, never input; checked anyway,
  # because `eval` is the one construct here where being wrong is unbounded.
  # Anchored across the *whole* key. `[A-Za-z_]*` constrained only the first
  # character, so it rejected nothing worth rejecting: measured,
  # `file_value f 'A:-$(touch PWNED)'` passed it, reached the eval and created the
  # file. Every call site passes a literal, so that was latent — but the comment
  # above claims this check is what makes the eval safe, and it was not.
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

# ---------------------------------------------------------------------------
# Asking
# ---------------------------------------------------------------------------
#
# `install.sh` is a wizard when a person is running it and a plain installer when
# something else is. The test is a terminal on both ends, which is the same
# question the login wizard's pty answers on the other side — a daemon's stdin is
# never a terminal, because there is nobody there to answer.
#
# Prompts go to stderr so that `answer=$(ask …)` captures the answer and nothing
# else. Getting that wrong makes every default silently include its own question.

# **stdin and stderr, not stdin and stdout.** Every prompt is written to stderr and
# every answer read from stdin; stdout carries only the return value of `ask`. So
# testing `-t 1` asked about the one stream the wizard does not use — and
# `deploy/install.sh control-plane | tee install.log`, an entirely ordinary thing to
# do while following a README, silently took the plain-installer branch: no
# interview, no start, no admin-key capture, exit 0. From that operator's point of
# view they were sitting at a terminal.
interactive() {
  [ "${NON_INTERACTIVE:-0}" = "0" ] && [ -t 0 ] && [ -t 2 ]
}

ask() {
  # ask <prompt> [default]
  printf '  %s' "$1" >&2
  if [ -n "${2:-}" ]; then printf ' [%s]' "$2" >&2; fi
  printf ': ' >&2
  IFS= read -r _reply || _reply=""
  printf '%s' "${_reply:-${2:-}}"
}

# Terminal state saved by `ask_secret`, restored by `restore_tty`.
#
# A global rather than a trap inside `ask_secret`, because `trap` in POSIX sh is
# per-shell and not per-function: setting one there would silently replace the two
# `install.sh` installs to clean up `$ENV_PARTIAL`, so an interrupt mid-password
# would restore the terminal and leave a half-written env file behind — trading
# one bad outcome for a worse one. This composes instead: `install.sh` calls
# `restore_tty` from the traps it already has.
_TTY_STATE=""

restore_tty() {
  [ -n "$_TTY_STATE" ] || return 0
  stty "$_TTY_STATE" 2>/dev/null || true
  _TTY_STATE=""
}

# ask_secret <prompt> [min-length]
#
# Like `ask`, with three differences, each of which was a way to leak or lose a
# password.
#
# **Echo is off**, so it is not on the screen and not in the scrollback — and not
# in the file, since `interactive()` deliberately supports `install.sh | tee`.
#
# **It is asked twice and compared.** A mistyped password here is not a typo you
# find at the next prompt; it is the credential to the fleet's control plane,
# discovered wrong at the first sign-in, after the database has been created and
# the value is only a hash.
#
# **An apostrophe re-asks rather than exiting.** `set_env` refuses one with
# `exit 2`, which is right for a programming error and wrong here: it would kill
# the wizard after `$ENV_PARTIAL` is half-written, the trap would delete it, and
# the operator would answer every previous question again — because of one
# character in one field, with no way to know that in advance.
ask_secret() {
  _asp="$1"
  _asmin="${2:-12}"
  while :; do
    _TTY_STATE=$(stty -g 2>/dev/null) || _TTY_STATE=""
    # Only when there is a terminal to turn off. Under a pipe there is nothing to
    # hide the input from, and `stty` would fail rather than silently succeed —
    # which is what lets `deploycheck` drive this at all.
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
  # confirm <prompt> <y|n>
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

# Set a key in an environment file: replace the live assignment if there is one,
# otherwise append. Any *further* live assignment of the same key is dropped,
# because these files are sourced and the last one would win — leaving a value
# that the deploy believes it wrote and the service never sees.
#
# **Commented lines are never touched, and that is the whole of the rule.** An
# earlier version matched `^#? *KEY=` so that a setting commented out in
# `.env.example` would be filled in rather than duplicated. Measured against the
# real file, when the containers block was still in it: a commented line inside a
# paragraph of prose had exactly the shape of a setting, and writing that key
# rewrote the sentence into a second live assignment. The example has been
# rewritten since and that particular line is gone, so this cites the shape rather
# than a line number — a number in a comment is a citation that rots on the next
# edit, which is the mistake this paragraph was already an argument against. It was
# harmless only by luck (it agreed with the real one further down); a different
# value would have been silently overridden, or silently winning. There is no
# reliable way to tell a commented setting from a comment mentioning one, so this
# does not try: a stale comment above an appended value is untidy, and turning
# documentation into configuration is a fault.
#
# Rewritten through a temporary file and moved into place: this file holds the
# only copy of a token, and a half-written one is recoverable from nowhere.
#
# **The value is single-quoted, and that is not tidiness.** These files are
# `.`-sourced by `run-daemon.sh`, so an unquoted value is shell
# source, not data: measured, a file containing
# `REEMOAT_ENROLL_CODE=xy$(touch PWNED)` created the file on source and left the
# code as `xy`. Every value here comes from `ask` — a URL, a bind address, a
# machine name, a pasted enrollment code — so the ordinary failure is a `&` or a
# space breaking the service with `b: command not found` in a log, and the
# ceiling is arbitrary code as the daemon that runs your agents.
#
# Everything inside single quotes is literal to the shell except a single quote,
# which is closed, escaped and reopened. Round-tripped against `&`, `$( )`,
# backticks, spaces, backslashes, `"` and `;`.
#
# **The sentinel is what keeps a trailing newline.** `$( )` strips them, so the
# obvious form silently shortened its own input: measured, a two-byte value `a\n`
# came back as `'a'` and read back one byte. Appending a byte before the
# substitution and removing it after is the only form that survives, and it costs
# nothing for every value that has no trailing newline.
sq() {
  _sq=$(printf '%sx' "$1" | sed "s/'/'\\\\''/g")
  printf "'%s'" "${_sq%x}"
}

set_env() {
  _key="$1"
  _val="$2"
  _file="$3"
  # **An apostrophe is refused for the control plane's file, because two parsers
  # read it and only one understands the escape.** `sq` renders it POSIX-style as
  # `'\''`, which `.`-sourcing handles perfectly and compose's dotenv parser does
  # not: measured against compose v5.1.2, it rejects the *whole file* with
  # `unexpected character "\\" in variable name`, before any verb — so the stack
  # becomes un-startable and un-inspectable at once.
  #
  # **`.partial` is matched too, and leaving it out made this guard decorative.**
  # `install.sh` runs its whole interview against `$ENV_FILE.partial` and `mv`s the
  # result into place, so the live name this pattern was written for is a name
  # `set_env` is never called with during the one flow that takes typed input.
  # Measured: `control-plane.env` with `it's` was refused and
  # `control-plane.env.partial` with the same value was written, escape and all —
  # which then reaches the live file at the end of the interview and takes the
  # stack down at the `compose build` twenty lines later. Reachable today through
  # the "URL daemons will dial" prompt, and reachable much more easily once a
  # password is one of the answers.
  #
  # `deploycheck` drives both names for that reason: the old pattern passes the
  # first and fails the second.
  #
  # **And the name is not the only way to reach that file.** `REEMOAT_CP_ENV_FILE`
  # is a documented override that may name any path, so a packaged install pointing
  # it at `/etc/reemoat/cp.env` matched neither pattern and wrote the escape into
  # the one file compose parses — an admin name of `o'brien` at the interview, then
  # a `compose build` that fails before any verb and leaves the stack unable to
  # start or be inspected, which is the exact outcome this guard exists to prevent.
  # So the resolved path is an arm of its own. The suffix patterns stay beside it
  # rather than being replaced by it: they are what catch a caller passing a path
  # this shell's environment does not agree about, and being refused twice costs
  # nothing.
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
  # **A newline is refused for either file, because the replace arm cannot
  # survive one.** `awk`'s `index($0, k "=") == 1` matches a *physical* line, so
  # replacing a multi-line value rewrites its first line and orphans the rest:
  # measured, `REEMOAT_TOKEN='line1<newline>line2'` re-set to `new` leaves a bare
  # `line2'` behind, and `.`-sourcing the result dies with `unexpected EOF while
  # looking for matching quote` — which is `run-daemon.sh` unable to start the
  # daemon at all. Refused rather than repaired because every value here comes
  # from `ask`, which reads one line with `IFS= read -r`, so no caller can
  # produce one; this narrows nothing anybody can reach.
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
  # `umask 077` around the write, not merely `chmod 600` after the `mv`: the
  # redirect creates the temporary file at 0666 & ~umask — 0644 under the usual
  # 022 — and it holds a byte-for-byte copy of a file whose whole content is
  # REEMOAT_TOKEN. `mv` then carries that mode onto the live file. Measured: the
  # `cp` branch produced 0600 (cp copies the source mode) and the awk branch
  # produced 0644, so the two halves of one function disagreed.
  if grep -Eq "^$_key=" "$_file"; then
    # Through the environment rather than `awk -v`: `-v` escape-processes its
    # value, so the two characters `\n` become a real newline and inject a second
    # assignment, while the `printf` branch below writes them literally. Measured
    # both ways. `index($0, k "=") == 1` rather than a regex, so a key is compared
    # as text and never as a pattern.
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

# This host's address on the network, or empty when it cannot be told. Used only
# to *offer* a default: the operator is the one who knows whether the phone that
# will reach this is on the same LAN, a tailnet, or the far side of a relay.
# Every IPv4 address this host actually has, as `<addr> <interface>` per line,
# loopback excluded.
#
# **The wizard used to offer one guessed address and `0.0.0.0`, and on a real
# machine neither was the answer.** `lan_address` returns the address of the
# default-route interface and nothing else — measured here, `192.0.2.20` on
# `en0` — while the address this fleet is actually reached on is `192.0.2.10`
# on a ZeroTier `feth`. A Tailscale, WireGuard or second-NIC host has the same
# shape. So the choice is built from what the host reports rather than from a
# guess plus a wildcard.
#
# Nothing is filtered, deliberately. A container bridge is obvious noise to a
# human reading `bridge103` beside it, and filtering by name is guessing again —
# the whole point is that the operator knows which interface they mean and this
# script does not.
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
      # `ip route get` is a **routing-table lookup, not a connection**: the kernel
      # answers "which source address would I use to reach this" without sending a
      # packet, so nothing here contacts 1.1.1.1 or resolves anything. The address
      # is a stand-in for "somewhere off this link" and any routable one outside
      # the local subnets would do; this one is the common idiom. Said out loud
      # because a hardcoded public address in a deploy script is exactly what
      # somebody auditing this tree for phone-home behaviour will stop on.
      _a=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
      if [ -n "$_a" ]; then
        printf '%s' "$_a"
        return 0
      fi
      ;;
  esac
  printf ''
}

# A DNS name for this host, or nothing.
#
# For the one prompt whose answer is permanent: `REEMOAT_CP_RELAY_URL` is written
# into every daemon's `identity.relay_url` at enrollment and never asked for
# again, so an address there is a fleet that can never move to a load balancer, a
# second relay or another box without a code typed on every machine.
# `lan_address` is the wrong helper for it and was the one being used, one
# variable over.
#
# A **dotted** name only. `hostname -f` answers a bare label on plenty of hosts
# (`ubuntu`, a Mac's `Rends-MBP`), which resolves for nobody outside that LAN and
# would be a worse default than the address it replaced — it at least looks like
# a name, which is how it would survive the prompt. `.local` goes with it:
# mDNS is not something a daemon on another network can dial.
#
# Empty when there is nothing trustworthy, and the caller says so rather than
# guessing.
host_name() {
  _n=$(hostname -f 2>/dev/null || hostname 2>/dev/null || true)
  case "$_n" in
    '' | *.local | *.local.) printf '' ;;
    *.*) printf '%s' "$_n" ;;
    *) printf '' ;;
  esac
}

# ---------------------------------------------------------------------------
# Which init system
# ---------------------------------------------------------------------------
#
# launchd on macOS, systemd elsewhere. Both are used in *user* mode: neither
# service wants root, and the daemon in particular stores everything under
# `homedir()` — its database and its worktrees — so a
# system-wide unit would run it as a user whose home is not the one holding the
# state.

# **This no longer exits, and the relaxation has a reason rather than being a
# loosening.** A control-plane host needs no init system at all now — the service
# is a container, and Docker's own supervision is what restarts it. Exiting here
# meant a perfectly serviceable Linux box without systemd, or any other OS, could
# not run the one service that no longer needs either.
#
# The refusal moved rather than disappeared: `require_init` below is called by
# everything with a `unit` backend, and says the same sentence at the point where
# it is actually true.
#
# The cost, stated because nothing enforces it: `INIT_SYSTEM=none` is a new
# reachable state that most of the functions in this file cannot serve, and each
# one has to refuse rather than derive an empty string from a `case` that matches
# no arm. It is also untested on both machines this has ever run on, because
# neither can reach it.
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

# Called by everything that needs a unit, and by nothing else.
require_init() {
  [ "$INIT_SYSTEM" = none ] || return 0
  echo "no supported init system here (launchd or systemd)." >&2
  echo "  the control plane does not need one — it runs as a container:" >&2
  echo "    $DEPLOY_DIR/compose.sh up -d" >&2
  echo "  the daemon does. Run its wrapper from your own supervisor:" >&2
  echo "    $DEPLOY_DIR/run-daemon.sh" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# PATH for a supervised process
# ---------------------------------------------------------------------------
#
# launchd and systemd both start a service with a nearly empty PATH — they do
# not read a login shell's profile. A service that works when you start it by
# hand and dies under the supervisor is almost always this, and the error says
# only "pnpm: not found".
#
# So the *resolved* directories are baked into the unit at install time, found
# through `command -v` rather than assumed. Writing `/opt/homebrew/bin` here
# would work on exactly one kind of machine, which is the failure this whole
# file exists to avoid — a Linux host, a Nix profile, an Intel Mac and a
# corepack shim all put these binaries somewhere else.
#
# The daemon additionally needs `git` on PATH: `src/git.ts` shells out to it for
# every worktree, status and diff. Looked up the same way, and a missing one is a
# precondition failure at install time rather than a mystery at the first session.

resolve_bin() {
  # Prints the absolute path of a required program, or fails with the name of
  # the thing that wanted it.
  _p=$(command -v "$1" 2>/dev/null || true)
  if [ -z "$_p" ]; then
    echo "$1 not found on PATH — needed by $2." >&2
    exit 2
  fi
  # `command -v` can answer with a shell builtin or a relative path; neither is
  # usable in a unit file, so insist on something absolute.
  case "$_p" in
    /*) ;;
    *)
      echo "$1 resolves to \"$_p\", which is not an absolute path." >&2
      exit 2
      ;;
  esac
  printf '%s' "$_p"
}

# The PATH a unit is given: the system defaults, then the directories holding the
# tools we resolved, with duplicates removed so the value stays readable in
# `launchctl print` and `systemctl show`.
#
# **System directories first, and the order is the fix rather than a preference.**
# It used to be the other way round, and that was a privilege path: measured on
# the machine this was written on, `node` resolves to `/opt/homebrew/bin/node` and
# `/opt/homebrew/bin` is `drwxrwxr-x rends:admin` — group-writable by every
# administrator account. Ahead of `/usr/bin` it shadows `/usr/bin/git`, and
# `src/git.ts` spawns bare `"git"` — against your own repositories, with your own
# hooks and filters now running, as the daemon that runs your agents. That
# consequence got *worse* when the container went away, not better. Appended
# instead, it can shadow nothing.
#
# The reordering must not silently change *which* node runs, so it is verified
# rather than assumed: each tool is re-resolved under the PATH actually built, and
# a disagreement is a refusal. Measured here — node and git both resolve to
# the same absolute paths under both orders, so nothing legitimate is affected;
# the case that refuses is a machine with two of a tool, where picking the other
# one silently is the worse outcome.
runtime_path() {
  # An explicit override wins outright. On a machine with two of a tool the
  # operator is the only one who can say which is meant, and everything below is a
  # heuristic by comparison.
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

  # A tool that re-resolves to something *else* under the PATH just built has to go
  # in front of the system directories, or the unit would run a different binary
  # than the one checked here. On a repository requiring node >= 24 that is the
  # common case rather than a corner one: a distro `/usr/bin/node` beside an nvm,
  # fnm, asdf or Homebrew install is exactly why a second node exists.
  #
  # **This used to refuse, and the refusal was unactionable.** `_acc` always begins
  # with the system directories, so `PATH="$_acc" command -v` can never prefer the
  # other copy — the printed remedy (`PATH=<dir>:$PATH deploy/install.sh`) produced
  # the identical refusal for ever, and only deleting a distro package escaped it.
  # On `deploy.sh` it would also have landed *after* `git reset --hard`.
  #
  # So the directory is prepended and the cost is *stated*. What made the original
  # order a privilege path was never the ordering by itself — it was the directory
  # being writable by more than its owner, which is the thing worth saying out loud.
  for _p in "$@"; do
    _n=$(basename -- "$_p")
    if [ "$(PATH="$_acc" command -v "$_n" 2>/dev/null || true)" = "$_p" ]; then
      continue
    fi
    _d=$(dirname -- "$_p")

    # Move it to the front, without a sed whose delimiter a path could contain.
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

# ---------------------------------------------------------------------------
# Talking to the init system
# ---------------------------------------------------------------------------
#
# Installed, start, restart, reload, pid, log lines — and the rest of `deploy/`
# never names launchctl, systemctl or journalctl. The one remaining direct call is
# install.sh's `loginctl show-user`, which asks about the operator's *session*
# rather than about a service, and so has no verb here to belong to.

# Where a rendered unit lives, and where its template comes from. Here rather than
# in install.sh because `deploy.sh` re-renders too — a changed template used to be
# checked out and then take effect never, since install.sh was the only renderer
# and nothing calls it on an update.
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

# Only launchd writes files; systemd goes to the journal. Kept here so install.sh
# stops computing a macOS path on Linux.
log_dir() {
  case "$INIT_SYSTEM" in
    launchd) printf '%s/Library/Logs/reemoat' "$HOME" ;;
    systemd) printf '' ;;
  esac
}

# `docker compose`, pointed at the control plane's stack.
#
# Through the wrapper rather than by calling `docker compose` here, because the
# wrapper is what pins the project name, the project directory, the env file and
# the image tag — and an operator typing at 2am has to be able to reach the same
# stack this does. One answer, one file.
compose() {
  "$DEPLOY_DIR/compose.sh" "$@"
}

# **`ps -aq`, not `ps -q`.** Today's test for a unit is the presence of a *file*,
# which is true whether or not the service is up; the container analogue of a
# file is a container that exists, not one that is running. Reading it as "is it
# running" would make `deploy.sh` with no `--service` silently skip the one
# service that is down, which is the opposite of what the operator wants.
#
# The `command -v docker` guard is the load-bearing first line. `deploy.sh`
# iterates every service on *every* host, so this runs on daemon-only machines
# with no Docker at all — and the call site is an `if` condition, where errexit
# is off, so without it every deploy on such a host prints `docker: not found`
# and reports a control plane that was never installed as installed-but-broken.
# Three answers, not two: installed, not installed, and **could not ask**.
#
# The third one is why this is not a one-liner. `[ -f "$(unit_target …)" ]` is a
# stat and cannot fail ambiguously, but asking a container engine can — and a
# probe that reads "the engine did not answer" as "not installed" is how
# `deploy.sh` skips the control plane, restarts the daemon, prints `deployed
# <sha>` and exits 0 while the old image is still running. Measured on this
# machine with the Docker socket absent: `compose ps -aq` exits 1 with an empty
# stdout, which the previous `|| true` turned into a confident "no".
#
# Same shape as `Liveness` and `probeExists` in `src/`, for the same reason and
# for the third time: anything that is not a definite "no" must not be reported
# as one.
#
#   0  installed        1  not installed        2  could not ask
svc_installed() {
  case "$(service_backend "$1")" in
    docker)
      # The CLI being absent is a definite "no": this host cannot be running a
      # container. `deploy.sh` probes every service on every host, so a
      # daemon-only machine reaches this line and must not see an error.
      command -v "${REEMOAT_DOCKER:-docker}" >/dev/null 2>&1 || return 1
      [ -f "$(env_file "$1")" ] || return 1
      # **The relay is asked about by proxy, and that is the migration.**
      #
      # "Installed" is a question about the *deployment*, and the relay is not a
      # deployment of its own: it shares this one's image, env file, database and
      # compose project, and was carved out of the control plane's own process.
      # Asking about its container instead would make every host that predates
      # the split answer "not installed" — so it would never become a target, the
      # deploy would recreate the control plane with `RELAY_MODE=external`, and
      # the fleet would go dark with nothing in the log about a relay at all.
      #
      # Its container not existing yet is therefore a thing to *fix* rather than
      # a reason to skip it, which is what `svc_container_missing` below is for.
      _probe=$1
      [ "$_probe" = relay ] && _probe=control-plane
      _ids=$(compose ps -aq "$(compose_service "$_probe")" 2>/dev/null) || return 2
      [ -n "$_ids" ]
      ;;
    unit)
      # **A probe answers, it does not exit.** `require_init` ends in `exit 2`,
      # and errexit is off inside an `if` condition but a bare `exit` is not —
      # so with `SERVICES="daemon control-plane"` putting the unit-backed service
      # first, the very first discovery probe killed `deploy.sh` outright on a
      # host with no init system. That is exactly the host `detect_init` was
      # relaxed to allow: a control-plane-only box needs no supervisor, and
      # `install.sh control-plane` runs to completion on one.
      [ "$INIT_SYSTEM" = none ] && return 1
      [ -f "$(unit_target "$1")" ]
      ;;
  esac
}

# Whether a *legacy* unit for a now-containerised service is still installed.
#
# There is no supported topology in which this is true and correct; it means a
# host that has not been migrated. It exists because the consequence of not
# noticing is severe — see the refusal in `deploy.sh`.
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
          # `bootstrap` is idempotent only in the sense that a second one errors,
          # so the already-loaded case is not a failure here.
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

# Restart, and mean it: `kickstart -k` kills the running process first, rather
# than starting a second copy. The daemon holds a single-row lock in SQLite and
# refuses to start while another one is up, so a restart that merely *asked*
# would leave the old process running and the new one exiting 2 — which
# launchd's KeepAlive would then retry for ever.
svc_restart() {
  case "$(service_backend "$1")" in
    # `--force-recreate`, because the image may not have moved. `up -d` alone
    # compares the desired config and the image id against labels on the running
    # container and does nothing when both match — which is right for a reload
    # and wrong for a restart somebody asked for.
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

# Make the supervisor read a unit it has already loaded.
#
# This is the half that `install.sh`'s "re-running re-renders the unit, which is
# how a moved repository or a changed node install is picked up" was missing.
# launchd's `bootstrap` errors on an already-bootstrapped label and is swallowed
# by `|| true`, and neither bare `kickstart` nor `kickstart -k` re-reads the
# plist — launchd holds the job definition from the bootstrap. So a new ExecStart
# or PATH landed on disk and was ignored until the next reboot. systemd has the
# same shape for a different reason: `enable --now` is a no-op against a unit that
# is already running, so the new ExecStart waits for a restart nobody asked for.
#
# Bootout before bootstrap, so this is also the path that picks up a template
# change on an update rather than only at install time.
# **`bootstrap`'s status is checked, and that is the load-bearing line.** It used to
# be the middle of three statements whose result was the *last* one's, and this
# function is only ever an `if` condition — so errexit is off inside it and a failed
# bootstrap was neither fatal nor reported. Measured against real launchd: with the
# label still loaded, `bootstrap` answers `Bootstrap failed: 5: Input/output error`
# and `kickstart -k` then answers 0 against the OLD in-memory definition, so this
# returned success while the freshly rendered ExecStart was never read. That is the
# silent failure the function exists to remove, converted into a falsely-reported
# one — and on `deploy.sh` it is the only thing that applies a changed template.
#
# `bootout` is also not synchronous, hence the bounded wait for the label to go.
svc_reload() {
  # For a container this is `up -d` and nothing else, and that is a real
  # simplification rather than a fudge: the render-to-one-side-and-`cmp` dance
  # below exists because launchd and systemd cannot tell whether a unit changed.
  # Compose can — it hashes the desired service config plus the image id against
  # labels on the running container and recreates only on a difference — so the
  # comparison the update path hand-rolls is done by the tool.
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

service_desc() {
  case "$1" in
    daemon) printf 'Reemoat daemon (agent sessions on this host)' ;;
    control-plane) printf 'Reemoat control plane (identity, relay, web UI)' ;;
  esac
}

# Render one service's unit and move it into place.
#
# In lib.sh rather than in install.sh because `deploy.sh` re-renders too: a change
# to a template used to be checked out and then take effect *never*, since
# install.sh was the only renderer and nothing on the update path calls it.
#
# The tools are resolved here rather than passed in, so the update path does not
# have to duplicate install.sh's precondition block. `runtime_path` refuses on an
# ambiguous tool, which is what makes resolving in two places safe.
#
# The same argument decides `@ENV_FILE@`. `REEMOAT_ENV_FILE` is a documented
# override that this file, install.sh and the health probe all obey, and none of
# that reached the supervised process: neither `launchctl bootstrap` nor
# `systemctl --user` carries the invoking shell's environment into the job, so the
# wrapper fell back to `$HOME/.reemoat/daemon.env` while everything around it had
# agreed on another path — configuring one file and supervising another.
#
# Baked into the unit, like `@PATH@` and for the same reason: it is resolved from
# the environment of whoever renders. That cuts both ways and it is the same cut
# `REEMOAT_UNIT_PATH` already makes — `deploy.sh` re-renders whenever a template
# moves, so a host installed with the override needs it in the deploy environment
# too, exactly as it already needs it for the health probe to read the right port.
#
# A sed *replacement* has a grammar of its own: `&` is the whole match, `\` escapes,
# and the delimiter ends the expression. Measured — with a repository at
# `/Users/a&b/reemoat`, `s|@REPO_ROOT@|$REPO_ROOT|` renders
# `/Users/a@REPO_ROOT@b/reemoat`, splicing the placeholder back into the unit, and
# a `|` aborts sed outright. This is the same grammar `changes.ts` avoids in the
# `--no-index` header rewrite by replacing with a function instead of a string;
# there is no function form here, so the value is escaped.
esc_sed() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# And a plist is XML, so a `&`, `<` or `>` that survives the above still makes the
# file unparseable — at which point `launchctl bootstrap` fails, is swallowed by the
# `|| true` in svc_start, and the operator learns only that the service will not
# start. Ampersand first, or the entities introduced below get escaped again.
esc_xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# One value, escaped for the template being rendered: XML only where the template
# is XML.
subst_value() {
  case "$INIT_SYSTEM" in
    launchd) esc_sed "$(esc_xml "$1")" ;;
    systemd) esc_sed "$1" ;;
  esac
}

# `render_unit <service> [target]`. The optional target is how `install.sh` stages a
# unit it is deliberately not going to start — see the note at its call site.
render_unit() {
  _svc="$1"
  if [ "$(service_backend "$_svc")" != unit ]; then
    echo "render_unit: $_svc has no unit — it runs as a container." >&2
    echo "  use: $DEPLOY_DIR/compose.sh up -d" >&2
    exit 2
  fi
  require_init
  _node=$(resolve_bin node "$_svc")
  # Both services get the same PATH now. The daemon's used to carry `docker` as
  # well, which was the only thing that made the two differ.
  _git=$(resolve_bin git "deploy/deploy.sh")
  _path=$(runtime_path "$_node" "$_git")

  _target=${2:-$(unit_target "$_svc")}
  _logs=$(log_dir)
  mkdir -p "$(dirname -- "$_target")"
  # 0700, not the umask's 0755.
  #
  # **The reason changed and the mode did not.** This used to cite the control
  # plane's one-time admin key, which launchd wrote into this directory as the
  # first line of that service's stdout. The control plane has no unit any more
  # and its key goes to `docker logs`, so that citation is now false — the mode
  # stands for the daemon, whose stream carries startup banners, warnings and
  # anything `onDegraded` reports about a process holding every transcript on
  # this machine.
  if [ -n "$_logs" ]; then
    mkdir -p "$_logs"
    chmod 700 "$_logs"
  fi

  # `|` as the delimiter because every value here is a path. Rendered to a
  # temporary file and moved into place, so a unit is never half-written — the
  # supervisor may read it at any moment, including during a reboot.
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

# Recent log lines for a service, however this machine keeps them.
#
# Its one reader is install.sh's admin-key capture, which used to name `journalctl`
# and a macOS log path directly — the second thing in `deploy/` outside this file to
# know one init system from another.
svc_log_lines() {
  case "$(service_backend "$1")" in
    # `--no-log-prefix` so the admin-key scrape's `$NF` reads the key rather than
    # a service name, and `--no-color` because compose colourises per service
    # when it thinks it has a terminal and an ANSI escape would ride along on the
    # captured credential.
    #
    # **This log does not outlive its container**, which is the one way the
    # container path is worse than a launchd file. `compose down` deletes it
    # while the volume keeps the user that makes the key unmintable — see the
    # note at install.sh's capture.
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

# The tools `deploy.sh` shells out to, resolved *before* it does anything
# irreversible.
#
# `install.sh` has always had a precondition block and `deploy.sh` had none: it
# called bare `git` and `pnpm` off the invoker's PATH, and a missing one
# surfaced *after* `git reset --hard` had already moved the checkout. The stated
# future for that script is a self-hosted runner invoking it with `--ref <sha>`, and
# a systemd-spawned runner has precisely the minimal PATH this file exists to defend
# against. `curl` is deliberately not required — `http_ok` falls back to node.
#
# **Per target, which is the shape it was written for.** It took `$TARGETS` and
# ignored it. That mattered little while both services came out of one workspace
# install; it matters now, because a control-plane-only host has no reason to
# have pnpm — its dependencies are inside the image — and a daemon-only host has
# no reason to have docker. Requiring both would refuse to deploy a correctly
# provisioned machine.
#
# `git` and `node` are unconditional: git because this script resets the
# checkout, node because `http_ok` and `json_field` fall back to it and a host
# with neither curl nor node cannot probe at all.
require_deploy_tools() {
  NODE_BIN=$(resolve_bin node "deploy/deploy.sh")
  GIT_BIN=$(resolve_bin git "deploy/deploy.sh")
  PNPM_BIN=""
  DOCKER_BIN=""
  # `"$@"`, because the one caller passes `$TARGETS` unquoted and it arrives
  # word-split into one argument per service.
  for _t in "$@"; do
    case "$(service_backend "$_t")" in
      unit) [ -n "$PNPM_BIN" ] || PNPM_BIN=$(resolve_bin pnpm "deploy/deploy.sh ($_t)") ;;
      docker) [ -n "$DOCKER_BIN" ] || DOCKER_BIN=$(resolve_bin "${REEMOAT_DOCKER:-docker}" "deploy/deploy.sh ($_t)") ;;
    esac
  done
}

# Whether a containerised service has no container at all yet.
#
# Different from `svc_installed`, which answers about the deployment: this asks
# about one container, and its one caller is `deploy.sh` deciding that a relay
# which has never existed must be created even though nothing it is made of
# moved. On the first deploy after the split that is the only thing that brings
# it up.
#
# Answers 1 (present) on anything it cannot determine, deliberately: an engine
# that will not talk is not evidence that a container is missing, and the cost of
# guessing "missing" is a recreate of the one service this file exists to leave
# alone.
svc_container_missing() {
  [ "$(service_backend "$1")" = docker ] || return 1
  command -v "${REEMOAT_DOCKER:-docker}" >/dev/null 2>&1 || return 1
  _ids=$(compose ps -aq "$(compose_service "$1")" 2>/dev/null) || return 1
  [ -z "$_ids" ]
}

# The pid, or empty when it is not running. Used only for reporting: a deploy
# that says "restart: none" should be checkable against a pid that did not move.
svc_pid() {
  case "$(service_backend "$1")" in
    # **Weaker than the unit arm, and worth knowing where.** This is a pid in the
    # container's namespace — on macOS, inside the VM — so `ps -p` on the host
    # finds nothing. The property it serves survives ("restart: none" is
    # checkable against a number that did not move) and its usefulness for
    # anything else does not.
    docker)
      _c=$(compose ps -q "$(compose_service "$1")" 2>/dev/null || true)
      [ -z "$_c" ] || "${REEMOAT_DOCKER:-docker}" inspect -f '{{.State.Pid}}' "$_c" 2>/dev/null || true
      ;;
    unit)
      require_init
      case "$INIT_SYSTEM" in
        launchd)
          # Matched on fields rather than on leading whitespace: `launchctl print`
          # indents with a tab today and that is not a documented format.
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

# ---------------------------------------------------------------------------
# Driving the control plane
# ---------------------------------------------------------------------------
#
# Only used by the wizard, and only when the control plane is on this same
# machine — which is the one topology where the daemon's enrollment code can be
# fetched rather than typed, because minting one is an admin call and the admin
# key is here.
#
# Run through the control plane's own tsx rather than `pnpm cpctl`, so this needs
# no package manager on PATH and no workspace resolution. It is the same file
# `pnpm cpctl` ends up executing.
# **The credential is sourced here, in a subshell, and nowhere else.** Callers used
# to `set -a; . "$CPCTL_ENV"` in their own shell, which put REEMOAT_CP_KEY — the
# fleet admin key, able to mint enrollment codes, users and grants for every machine
# — into install.sh's environment and therefore into every child it spawned
# afterwards: sed, launchctl, systemctl, curl, journalctl, loginctl. Only this one
# process needs it, and now only this one process has it.
cpctl() {
  (
    set -a
    # `if`, not `[ -f … ] && .` — under `set -e` an AND-list whose test fails is
    # itself a failing command, so an absent file would kill this subshell instead
    # of letting cpctl report the missing key itself.
    if [ -f "$CPCTL_ENV" ]; then
      # shellcheck disable=SC1090  # written by this script's control-plane run
      . "$CPCTL_ENV"
    fi
    set +a
    _tsx="$REPO_ROOT/packages/control-plane/node_modules/.bin/tsx"
    if [ -x "$_tsx" ]; then
      "$_tsx" "$REPO_ROOT/packages/control-plane/scripts/cpctl.ts" "$@"
    else
      # **The same file, from inside the image.** A control-plane host no longer
      # runs `pnpm install` — the dependencies are in the image — so on one of
      # those there is no host tsx to exec. Every host that runs a daemon still
      # has one, because that is the same workspace install.
      #
      # `-e REEMOAT_CP_KEY` with no value takes it from *this subshell's*
      # environment rather than from argv, so the fleet's admin key never appears
      # in `ps` on the host. The URL is loopback because it is being read from
      # inside the container, where the API is bound wide.
      #
      # Two costs, stated: this arm needs the container to be *running*, where
      # the host arm needs only the API to answer — so cpctl against a stopped
      # control plane now fails with a docker error rather than a refused
      # connection. And the key passes through the docker daemon's exec
      # configuration, which is the same daemon that already holds the volume
      # with the signing key in it, so it is not a new trust boundary but it is a
      # new place the value exists.
      #
      # Loopback *inside the container*, which is not what `service_origin`
      # answers: that one gives the host's publish address, and a LAN address
      # published on the host resolves to nothing from in here. The in-container
      # port is the same number as the published one by design, so the port is
      # still read from the same key.
      _cp_port=$(file_value "$(env_file control-plane)" REEMOAT_CP_PORT)
      REEMOAT_CP_URL="http://127.0.0.1:${_cp_port:-7888}"
      export REEMOAT_CP_URL
      compose exec -T -e REEMOAT_CP_KEY -e REEMOAT_CP_URL \
        control-plane node --import tsx scripts/cpctl.ts "$@"
    fi
  )
}

# The control-plane image's id, or empty when it has never been built.
#
# What `install.sh` **prints**, and only that. An id rather than a tag, because
# the tag is a moving name; a digest an operator can paste into
# `docker image inspect` is the useful thing to show.
#
# It is deliberately **not** what decides a recreate any more — see
# `cp_image_fingerprint` below for the measurement that took that job away.
cp_image_id() {
  command -v "${REEMOAT_DOCKER:-docker}" >/dev/null 2>&1 || return 0
  "${REEMOAT_DOCKER:-docker}" image inspect \
    --format '{{.Id}}' "${REEMOAT_CP_IMAGE:-reemoat/control-plane:current}" 2>/dev/null || true
}

# What the image actually *is*, for `deploy.sh` to compare across a build.
#
# **`.Id` is not that, and the difference is measured rather than reasoned
# about.** On this host (Docker Compose v5.1.2, buildx 0.33.0, containerd image
# store) `docker image inspect --format '{{.Id}}'` returns the digest of the OCI
# *index* — `application/vnd.oci.image.index.v1+json`, 856 bytes. Three
# consecutive fully-cached builds of an unchanged tree produced three different
# `.Id` values while `.Created`, every entry of `.RootFS.Layers` and the whole of
# `.Config` were byte-identical. The build log names the moving part outright:
# across two such builds `exporting config` and `exporting manifest` print the
# *same* digest and `exporting attestation manifest` prints a different one each
# time — so the index, which lists it, moves with it. The wrapper moved, the
# image did not, and the comparison believed the wrapper.
#
# The consequence was small and entirely in one direction, which is why it went
# unnoticed: `deploy.sh` recreated `control-plane` on **every** deploy that ran a
# build, including one where nothing had changed, and the relay's `and` guard
# degraded to its second term alone. Neither is unsafe — a recreate is idempotent
# and `RELAY_INPUTS` is the term that protects the tunnels — but "a fully-cached
# rebuild produces a byte-identical id and nothing is recreated" was written in
# three files and was false in all of them.
#
# **`provenance: false` in `compose.yml`'s `build:` does not turn that off**, and
# it was tried first. The schema accepts the field — `compose config` echoes it —
# and the attestation manifest is exported anyway, so the id still moved across
# three builds with it set. It was taken back out rather than left in as a change
# that reads like a fix and is not one. Fixing the *export* would mean reaching
# past compose into the builder; comparing the right thing does not, and is
# correct on a classic image store too, where `.Id` happens to be stable.
#
# Layers **and** config, because either alone is a hole: a `CMD` or `ENV` change
# with identical layers must still recreate. Never printed, so it is left as the
# raw ~2 KiB string rather than hashed — a hash would need a digest tool this
# file does not otherwise require, on a host that deliberately carries no node.
cp_image_fingerprint() {
  command -v "${REEMOAT_DOCKER:-docker}" >/dev/null 2>&1 || return 0
  "${REEMOAT_DOCKER:-docker}" image inspect \
    --format '{{json .RootFS}}{{json .Config}}' \
    "${REEMOAT_CP_IMAGE:-reemoat/control-plane:current}" 2>/dev/null || true
}

# Where the admin API key is kept once the control plane has printed it. Not a
# credential this daemon uses — nothing in `src/` ever calls the control plane
# except at enrollment — but `cpctl` needs it, and a key printed exactly once and
# then lost means the only way back is deleting the database.
CPCTL_ENV="${REEMOAT_CPCTL_ENV:-$HOME/.reemoat/cpctl.env}"

# One field out of a JSON object, via node — which is already a hard requirement
# here, unlike jq. Empty when absent, so the caller checks rather than trusting.
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

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
#
# Both services answer an unauthenticated `GET /health` — `src/server.ts` and
# `packages/control-plane/src/app.ts`. It is the only honest end to a deploy:
# without it "deployed" means "the supervisor did not complain", and every way
# these processes fail at startup (a missing REEMOAT_TOKEN, a port in use, a
# database another daemon holds) exits *after* the unit has been accepted.

# Address to probe, read out of the service's own env file rather than from
# constants here, so an operator who moved a port does not get a false red.
#
# Sourced in a subshell: the env files hold REEMOAT_TOKEN and, for the control
# plane, nothing less sensitive. There is no reason for those values to exist in
# the deploying process, which prints things.
# **The answer is a tagged line on stdout, not an exit code.**
#
# This returned sentinel codes (3 for a kernel-assigned port, 4 for a missing file),
# which shares a namespace with the exit status of the env file being sourced under
# `set -e`. Measured: a file whose last assignment is `X=$(exit 4)` makes the
# subshell exit 4, and the caller then reported "no env file" naming a file sitting
# right in front of the operator — verbatim the miscommunication the sentinel was
# introduced to prevent. A non-zero status now means one thing only: the file exists
# and would not source.
# The origin a service answers on **from this host**, or empty when there is no
# port to know. Non-zero only when the environment file exists and will not
# source, which is the one contract `wait_healthy` distinguishes.
#
# Extracted so that it has two readers rather than two implementations. The other
# is install.sh's `cpctl.env`, which wrote a hardcoded `http://127.0.0.1:$port`
# under a comment claiming "the API answers on the loopback of whatever it
# bound" — false for the interview's own second option, which binds one LAN
# address, after which cpctl talked to a loopback port nothing was listening on.
# One rule, one place: a wildcard means loopback and anything else means itself.
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
        # **The publish address, not the bind address.** The bind is pinned to
        # 0.0.0.0 inside the container and says nothing about who can reach this;
        # the host side of the published port does, and it is in this same file.
        # The port is deliberately the same number on both sides of the mapping
        # (see deploy/docker/compose.yml), so it is still read straight out.
        _host=${REEMOAT_CP_PUBLISH:-127.0.0.1}
        _port=${REEMOAT_CP_PORT:-7888}
        ;;
      relay)
        # The relay's own publish pair, out of the same file — its defaults are
        # the opposite ones, because a relay no daemon can dial is not a relay.
        # A wildcard collapses to loopback below, which is right here for the
        # same reason it is right above: this probe is always local.
        _host=${REEMOAT_CP_RELAY_PUBLISH:-0.0.0.0}
        _port=${REEMOAT_CP_RELAY_PORT:-7889}
        ;;
    esac
    # A wildcard publish is not an address you can connect to. The loopback is
    # always part of what it covers, and this is always local.
    case "$_host" in
      0.0.0.0 | '' | '*') _host=127.0.0.1 ;;
      '::' | '[::]') _host='[::1]' ;;
    esac
    # `REEMOAT_PORT=0` is a documented, supported setting: a relay-only daemon
    # lets the kernel choose, because nothing outside ever addresses its
    # listener. There is then no port to probe and no way to learn one from here.
    [ "$_port" = "0" ] || printf 'http://%s:%s' "$_host" "$_port"
  )
}

# The path each service answers a health probe on, which is **not** the same path
# for all three.
#
# The daemon and the control plane both answer `/health` unauthenticated. The
# relay must not: that path belongs to the daemon on the far side of a tunnel and
# is exactly what a browser fetches, with a token, to decide whether a machine is
# reachable — so answering it at the relay would report every machine in the fleet
# as up. Its own probe is under the prefix it already reserves for `TUNNEL_PATH`,
# and `packages/control-plane/src/relay/listener.ts` is where that constant lives.
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
  # A failure here is the subshell above refusing to source the file, and it
  # propagates deliberately — `wait_healthy` reads a non-zero status as exactly
  # that and nothing else.
  _origin=$(service_origin "$_svc")
  if [ -z "$_origin" ]; then
    printf 'skip %s listens on a kernel-assigned port' "$_svc"
  else
    printf 'ok %s%s' "$_origin" "$(health_probe_path "$_svc")"
  fi
}

# Poll until it answers. Startup is not instant — the daemon opens SQLite, takes
# its lock, restores sessions and reaps orphans first — so a single request
# immediately after a restart tests nothing but our own patience.
# One request, as an exit status. **curl if it is there, node if it is not.**
#
# The probe used to be a bare `curl … >/dev/null 2>&1`, so "curl is not installed"
# (127), "the proxy environment is hostile" and "the service is dead" were one
# outcome — announced 30 seconds later as `health: FAILED`, which then decided the
# exit status of the whole deploy. curl ships on stock macOS and most distributions
# but not on a slim Debian or Alpine, which is exactly the shape of host a control
# plane runs on. node is already a hard requirement here, which is the same
# argument `json_field` makes for not needing jq.
# `--noproxy '*'` is not decoration. curl honours http_proxy/HTTP_PROXY/ALL_PROXY
# even for a loopback probe and node's `fetch` ignores them entirely, so without it
# the two arms disagree about the same healthy service — measured against a live
# server with `http_proxy=http://127.0.0.1:9`: curl rc 7, node rc 0. On any host
# with a proxy in the environment, which a corporate VPS running a control plane
# very much is, that reported an up service as down and failed the deploy.
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
  # The skip cases are distinct and must not collapse into one message: "no env
  # file" is a machine that was never finished, "kernel-assigned port" is a
  # correctly configured relay-only daemon, and "would not source" is a broken file
  # that is sitting right there. Reporting any of them as another sends an operator
  # looking for the wrong thing — which the catch-all arm did, one arm over from a
  # comment saying it must not.
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
        # Not `require_init`: this is only ever interpolated into a message that
        # is already reporting a failure, and exiting 2 from inside one would
        # replace the diagnosis with a different complaint.
        none) printf '(no log location: this host has no supported init system)' ;;
      esac
      ;;
  esac
}

detect_init
