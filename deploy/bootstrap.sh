#!/bin/sh
# Get a machine from nothing to enrolled, in one command.
#
#   curl -fsSL https://app.reemoat.com/install.sh | sh
#
# **It arrives three ways, and only one of them knows where to point.** The
# README's one-liner downloads it from a **release asset on the repository** — a
# neutral place, so the URL says where the software is and nothing more; there
# the placeholder below is untouched and the script *asks* which control plane to
# join. `GET /install.sh` on a control plane serves the same file with that
# instance's own origin substituted in, shell-quoted, which is what Settings ->
# Machines prints and why there is nothing to type. And `--url` or
# `REEMOAT_CONTROL_PLANE` says it outright, over both.
#
# ⚠ **The asking arm has no default.** Letting a download URL also mean "and join
# the author's fleet" is how somebody who wanted their own control plane ends up
# in one they do not run, by pressing Enter. See Q4.107 and Q4.112.
#
# **It is `bootstrap.sh` and it is served at `/install.sh`, and the difference is
# deliberate.** `deploy/install.sh` configures a service on a checkout somebody
# already has; this gets a machine from *nothing* — no repository, possibly no
# node — to a running daemon, and then hands the last third to `install.sh`
# rather than reimplementing unit rendering, PATH computation and the health
# probe. Two files named `install.sh` in one repository is a trap, and the one
# people would grep for is the wrong one.
#
# ## Three properties of a piped installer, each of which cost something to learn
#
# **Everything is inside `main`, called on the last line.** `curl … | sh`
# executes bytes as they arrive, so a download cut off half-way runs a *prefix*
# of this file — with `set -e` doing nothing about it, because nothing failed.
# Wrapped, a truncated file defines a function and exits having done nothing.
# `deploycheck` asserts the shape, because it is a fact about the file rather
# than about any function in it.
#
# **stdin is the download, so nothing here may read it.** Every question is
# asked on fd 3, opened from `/dev/tty`. This is also why `deploy/lib.sh`'s
# `interactive()` is not reused for the questions above the clone: it tests
# `[ -t 0 ]`, and stdin here is a pipe on a perfectly interactive terminal.
# Teaching `interactive()` to redirect was considered and refused — it would
# change the meaning of every existing caller and make `deploycheck`'s
# EOF-driven `ask` cases unreachable.
#
# **POSIX `sh`, and the floor is `dash` rather than bash.** `/bin/sh` is bash on
# macOS, so no `local`, no `[[`, no arrays and no `pipefail` — none of which
# fails on the machine this was written on and all of which fail on Debian.
#
# ## What it will not do
#
# No sudo, ever. No package manager. Nothing written to `~/.zshrc` or any other
# profile: the daemon does not need node on *your* PATH, because `runtime_path`
# in `lib.sh` bakes the resolved node's directory into the unit. Nothing lands
# outside `~/.reemoat` and the checkout, which is what makes `--uninstall`
# complete rather than approximate.
set -eu

# Substituted by `GET /install.sh`. Left literal in a checkout — the `case` in
# `resolve_control_plane` is what notices, and the value is spelled once here so
# `deploycheck` can assert this file names no control-plane host of its own.
# ⚠ **Unquoted here on purpose.** `GET /install.sh` substitutes a value that is
# *already* shell-quoted — that is the whole point of `shellQuote` on the route —
# so a pair of quotes around the placeholder makes the result `''http://host''`.
# That concatenates to the right thing for a plain hostname, which is exactly why
# it survived every offline driver: `imagecheck` asking a real container is what
# found it. With an apostrophe in the origin the two pairs interleave and the
# quoting can be stepped out of, which is the case the quoting exists for.
# The placeholder holds no character a shell treats specially, so a checkout copy
# is still a valid assignment and still refuses in `resolve_control_plane`.
CONTROL_PLANE_DEFAULT=@REEMOAT_CONTROL_PLANE@

# Pinned, and tied to the repository by `deploycheck` rather than by memory: it
# reads `packageManager` out of the root `package.json` and `engines.node`, and
# fails when either stops agreeing with these two lines. A bootstrap that
# installs pnpm 10 against a lockfile written by 11.17.0 fails on a stranger's
# laptop, and nothing else in this tree would notice.
NODE_MAJOR=24
PNPM_VERSION=11.17.0

REEMOAT_HOME="${REEMOAT_HOME:-$HOME/.reemoat}"
TOOLCHAIN="$REEMOAT_HOME/toolchain"
# Written when this script installs a node, and the only thing `--uninstall`
# consults before removing one. A path derived from a flag is never `rm -rf`ed.
TOOLCHAIN_MARKER="$TOOLCHAIN/.installed-by-bootstrap"

CP=""
API_KEY="${REEMOAT_API_KEY:-}"
ENROLL_CODE=""
LABEL=""
CHECKOUT="$HOME/srv/reemoat"
GIT_REF=""
NODE_BIN=""
ASSUME_YES=0
UNINSTALL=0
PURGE=0
TTY_OPEN=0
SESSION_TOKEN=""

say()  { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die()  { printf '%s\n' "$*" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Asking, on a terminal that is not stdin
# ---------------------------------------------------------------------------

open_tty() {
  # `exec 3</dev/tty` and not a test for one: a controlling terminal can exist
  # and still be unopenable (a detached process, some CI runners), and the only
  # honest test is the open itself.
  # ⚠ **Tested in a subshell first, and that is not defensiveness.** `exec` is a
  # POSIX *special builtin*, so a failed redirection on it terminates a
  # non-interactive shell outright — no `if`, no `||`, no trap. A brace group
  # silences the message and changes nothing about the exit. Measured against the
  # real file: `dash` exits 2 with **zero bytes of output** where bash-as-sh
  # reaches the `else`, which is macOS passing and every Debian host — the
  # documented non-interactive path, cloud-init, CI, `ssh host 'curl … | sh -s --
  # --enroll-code …'` — dying silently with nothing installed and nothing said.
  # In a subshell the death is the subshell's, and its status is the answer.
  if ( exec 3</dev/tty ) 2>/dev/null; then
    exec 3</dev/tty
    TTY_OPEN=1
  else
    TTY_OPEN=0
  fi
}

# **On the terminal when there is one, on stderr otherwise — never both.**
# Writing to both was the first shape and it prints every question twice in the
# ordinary case, where stderr *is* the terminal. Under `curl … | sh > install.log`
# stderr is the log and `/dev/tty` is where the person is looking, which is the
# case this exists for; with no terminal at all there is nothing to ask anyway and
# stderr is where the refusal goes.
prompt() {
  if [ "$TTY_OPEN" = 1 ]; then printf '%s' "$1" >/dev/tty; else printf '%s' "$1" >&2; fi
}

# The newline after an answer, on whichever stream the question went to. Its own
# function because `prompt "\n"` prints a literal backslash-n — `printf '%s'`
# does not interpret escapes, which is the property that makes `prompt` safe for
# a caller-supplied string in the first place.
prompt_eol() {
  if [ "$TTY_OPEN" = 1 ]; then printf '\n' >/dev/tty; else printf '\n' >&2; fi
}

tty_ask() {
  _p="$1"; _default="${2:-}"
  [ "$TTY_OPEN" = 1 ] || die "no terminal to ask on."
  if [ -n "$_default" ]; then prompt "$_p [$_default]: "; else prompt "$_p: "; fi
  IFS= read -r _reply <&3 || _reply=""
  prompt_eol
  [ -n "$_reply" ] || _reply="$_default"
  printf '%s' "$_reply"
}

# A pasted credential is not a chosen one: read once, never twice, and never
# with `lib.sh`'s `ask_secret`, whose apostrophe refusal exists for compose's
# dotenv parser and has no meaning for a value that reaches no file.
tty_secret() {
  _p="$1"
  [ "$TTY_OPEN" = 1 ] || die "no terminal to ask on."
  prompt "$_p: "
  # A subshell with the terminal on stdin, so a plain `stty` applies and neither
  # `stty -F` (GNU) nor `stty -f` (BSD) has to be chosen between. The trap is
  # `restore_tty`'s lesson: an interrupt between here and the restore leaves the
  # operator's own shell not echoing, with nothing on screen saying why.
  _value=$( exec </dev/tty
            _saved=$(stty -g)
            trap 'stty "$_saved" 2>/dev/null' EXIT INT TERM
            stty -echo
            IFS= read -r _v || _v=""
            printf '%s' "$_v" )
  prompt_eol
  printf '%s' "$_value"
}

# ---------------------------------------------------------------------------
# Choosing with the arrow keys
# ---------------------------------------------------------------------------
#
# **Nothing here is typed that can be picked.** A one-shot installer that makes
# somebody read four options and then type `3` has turned two keystrokes into a
# reading exercise, and a mistyped digit into a wrong fleet. Up/down and Enter.
#
# Raw mode, one byte at a time through `dd`, because POSIX `read` has no `-n1` —
# that is a bashism and the floor here is `dash`. The byte is converted to a
# **number** by `od` rather than read as a character, and that is what makes
# Enter readable at all: command substitution strips trailing newlines, so
# reading the character would return an empty string for the one key that
# matters most.
_key() { dd bs=1 count=1 2>/dev/null <&3 | od -An -tu1 | tr -dc '0-9'; }

# The terminal as it was before a menu touched it. A global rather than a trap
# inside `menu`, because traps in `sh` are process-wide: one set inside a
# function replaces the script's own, and losing the EXIT trap here would leave
# the enrollment code unrevoked. The main traps call this instead.
#
# ⚠ **Do not verify this with `stty -g` before and after.** Measured on macOS
# through a real pty: the two strings differ by `lflag` gaining `0x20000000`,
# which is `PENDIN` — a transient kernel bit meaning "input was pending when the
# mode changed", not a setting anybody chose. Everything a person can feel is
# restored exactly (`echo icanon icrnl isig opost`, compared field for field).
# A `-g` comparison reads as a leak and is not one.
TTY_SAVED=""
restore_tty() {
  [ -n "$TTY_SAVED" ] || return 0
  stty "$TTY_SAVED" <&3 2>/dev/null || true
  TTY_SAVED=""
  printf '\033[?25h' >/dev/tty 2>/dev/null || true
}

# menu "Title" "option" "option" … → prints the 1-based index chosen.
#
# ⚠ **The first option is the default**, because Enter takes it. Order matters
# wherever one of the choices is a decision somebody should not arrive at by
# pressing Enter — the hosted control plane is second for exactly that reason.
menu() {
  _t="$1"; shift
  [ "$TTY_OPEN" = 1 ] || die "no terminal to choose on."
  _n=$#; _sel=1
  printf '\033[?25l' >/dev/tty
  [ -n "$_t" ] && printf '%s\n' "$_t" >/dev/tty
  _menu_draw "$@"
  TTY_SAVED=$(stty -g <&3 2>/dev/null || printf '')
  stty raw -echo <&3 2>/dev/null || true
  while :; do
    _k=$(_key)
    case "$_k" in
      10 | 13) break ;;
      # In raw mode the terminal stops turning Ctrl-C into a signal and hands
      # over byte 3, so the only thing that can honour it is this.
      3) restore_tty; printf '\n' >/dev/tty; exit 130 ;;
      27)
        [ "$(_key)" = 91 ] || continue
        case "$(_key)" in
          65) _sel=$((_sel - 1)); [ "$_sel" -lt 1 ] && _sel=$_n ;;
          66) _sel=$((_sel + 1)); [ "$_sel" -gt "$_n" ] && _sel=1 ;;
        esac ;;
      107) _sel=$((_sel - 1)); [ "$_sel" -lt 1 ] && _sel=$_n ;;
      106) _sel=$((_sel + 1)); [ "$_sel" -gt "$_n" ] && _sel=1 ;;
      "") break ;;
      *) continue ;;
    esac
    printf '\033[%dA' "$_n" >/dev/tty
    _menu_draw "$@"
  done
  restore_tty
  # The list is replaced by the answer. Four lines of options that have been
  # answered are four lines of scrollback saying nothing.
  printf '\033[%dA' "$_n" >/dev/tty
  _i=1
  for _o in "$@"; do
    [ "$_i" = "$_sel" ] && printf '\033[K  %s\n' "$_o" >/dev/tty
    _i=$((_i + 1))
  done
  _i=1
  while [ "$_i" -lt "$_n" ]; do printf '\033[K\n' >/dev/tty; _i=$((_i + 1)); done
  [ "$_n" -gt 1 ] && printf '\033[%dA' "$((_n - 1))" >/dev/tty
  printf '%s' "$_sel"
}

_menu_draw() {
  _i=1
  for _o in "$@"; do
    if [ "$_i" = "$_sel" ]; then
      printf '\033[K\033[7m  %s  \033[0m\n' "$_o" >/dev/tty
    else
      printf '\033[K  %s\n' "$_o" >/dev/tty
    fi
    _i=$((_i + 1))
  done
}

tty_confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  # ⚠ **Checked here rather than left to `menu`.** `menu`'s `die` runs inside
  # `$( … )`, so its `exit 2` would kill only the command substitution.
  # Reproduced with `--uninstall --purge` and no terminal.
  [ "$TTY_OPEN" = 1 ] || die "$1
  No terminal to ask on. Re-run with --yes if you mean it."
  # No first, because every caller is asking about something irreversible.
  [ "$(menu "$1" "No" "Yes")" = 2 ]
}

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------

# ⚠ **`shift` is a special builtin, so `shift 2 || die` never runs the `die`.**
# Shifting past `$#` terminates a non-interactive shell before the `||` is
# reached — measured, `sh -s -- --url` prints dash's own `shift: can't shift that
# many` and exits, where bash-as-sh printed the message this script wanted. The
# arity is checked before the shift instead.
need_value() {
  _flag="$1"
  shift
  [ "$#" -ge 2 ] || die "$_flag needs a value"
}

usage() {
  cat <<'USAGE'
Set up a Reemoat daemon on this machine and add it to the app.

  curl -fsSL https://<control-plane>/install.sh | sh
  curl -fsSL https://<control-plane>/install.sh | sh -s -- [options]

  The <control-plane> is whichever one you fetched this from. It is already
  substituted into the copy you are running; these two lines are how somebody
  else would fetch it.

  --url <origin>        the control plane to join. Defaults to whichever one
                        served this script; there is no built-in fallback
  --api-key <rk_...>    use an API key instead of signing in. Prefer the
                        REEMOAT_API_KEY environment variable — argv is visible
                        in `ps` to everybody on this machine
  --enroll-code <ec_..> a code already minted in Settings -> Machines. Needs no
                        account credential at all, and is the smallest thing
                        that works
  --label <name>        what to call this machine. Defaults to its hostname
  --dir <path>          where to put the checkout (default ~/srv/reemoat)
  --ref <git-ref>       clone this instead of the version the control plane runs
  --node <path>         use this node, install none
  --yes                 do not ask to confirm anything
  --uninstall           stop and remove the service and anything this script
                        installed. Names your data; deletes none of it
  --purge               with --uninstall, also delete ~/.reemoat and the
                        checkout. Worktrees hold uncommitted work: read the
                        list it prints first
USAGE
}

parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --url)         CP="${2:-}"; need_value "--url" "$@"; shift 2 ;;
      --api-key)     API_KEY="${2:-}"; need_value "--api-key" "$@"; shift 2
                     warn "note: --api-key is visible in \`ps\`. REEMOAT_API_KEY is the quieter way." ;;
      --enroll-code) ENROLL_CODE="${2:-}"; need_value "--enroll-code" "$@"; shift 2 ;;
      --label)       LABEL="${2:-}"; need_value "--label" "$@"; shift 2 ;;
      --dir)         CHECKOUT="${2:-}"; need_value "--dir" "$@"; shift 2 ;;
      --ref)         GIT_REF="${2:-}"; need_value "--ref" "$@"; shift 2 ;;
      --node)        NODE_BIN="${2:-}"; need_value "--node" "$@"; shift 2 ;;
      --yes | -y)    ASSUME_YES=1;         shift ;;
      --uninstall)   UNINSTALL=1;          shift ;;
      --purge)       PURGE=1;              shift ;;
      --help | -h)   usage; exit 0 ;;
      *)             usage >&2; die "unknown option: $1" ;;
    esac
  done
}

# **Where the software came from and which fleet it joins are two questions, and
# this is the one place they meet.**
#
# There are three provenances and they answer differently:
#
#   * **`--url`, or `REEMOAT_CONTROL_PLANE`** — said outright, and it wins over
#     everything. The non-interactive path.
#   * **Fetched from a control plane.** `GET /install.sh` substitutes its own
#     origin, so the copy your own panel hands out joins your own panel with
#     nothing to type. It says which, rather than leaving it implied.
#   * **Fetched from the repository** — a release asset, `git clone`, anything
#     neutral. The placeholder is still literal and the honest answer is that
#     this script does not know, so it **asks**.
#
# ⚠ **The asking arm has no default, and that is the decision.** A download URL
# is where the *software* comes from; making it silently also mean "and join the
# author's fleet" is how a self-hoster ends up with their laptop in somebody
# else's control plane by pressing Enter. The hosted instance is named as an
# option because otherwise somebody who wants it has to go and find it, but it
# is never what an empty answer means. `deploycheck` asserts no control-plane
# host is written into this file outside that one sentence.
resolve_control_plane() {
  [ -n "$CP" ] || CP="${REEMOAT_CONTROL_PLANE:-}"
  if [ -z "$CP" ]; then
    case "$CONTROL_PLANE_DEFAULT" in
      '@'*'@' | "") : ;;
      *) CP="$CONTROL_PLANE_DEFAULT"
         note "control plane $CP" ;;
    esac
  fi
  if [ -z "$CP" ]; then
    [ "$TTY_OPEN" = 1 ] || die "this installer does not know which control plane to join.

  It was fetched from somewhere neutral — the repository — so there is no
  address in it. Name one:
      ... | sh -s -- --url https://<your-control-plane>
  or set REEMOAT_CONTROL_PLANE.

  A control plane is the piece you run yourself; deploy/install.sh
  control-plane sets one up. The author runs one at https://app.reemoat.com."
    say ""
    # ⚠ **The hosted one is second, and that is the decision.** Enter takes the
    # first row, so putting it there would make "join the author's fleet" the
    # thing that happens to somebody who did not read. Named, never default.
    if [ "$(menu "Which control plane?" "My own" "app.reemoat.com  (run by the author)")" = 2 ]; then
      CP="https://app.reemoat.com"
    else
      while [ -z "$CP" ]; do CP=$(tty_ask "  address"); done
    fi
  fi
  case "$CP" in
    https://* | http://127.0.0.1* | http://localhost*) : ;;
    http://*) warn "warning: $CP is plaintext. Everything below, including a password, crosses it in the clear." ;;
    *) die "--url must be an http(s) origin, not: $CP" ;;
  esac
  # One trailing slash, removed once, so nothing downstream builds `//v1/...`.
  case "$CP" in */) CP="${CP%/}" ;; esac
}

# ---------------------------------------------------------------------------
# This machine
# ---------------------------------------------------------------------------

detect_platform() {
  case "$(uname -s)" in
    Darwin) PLATFORM=darwin ;;
    Linux)  PLATFORM=linux ;;
    *) die "$(uname -s) has no supervisor this can install into.

  The daemon itself is portable — deploy/run-daemon.sh from a checkout works
  anywhere node does. What is missing here is launchd or systemd." ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) ARCH=arm64 ;;
    x86_64 | amd64)  ARCH=x64 ;;
    *) die "no official node build for $(uname -m).

  Install node $NODE_MAJOR yourself and re-run with --node <path>." ;;
  esac
}

# ---------------------------------------------------------------------------
# HTTP, and JSON without assuming a JSON tool
# ---------------------------------------------------------------------------

# Body on stdout, status on fd 4 via the caller's `HTTP_STATUS`. `-o` plus
# `-w '%{http_code}'` rather than `-i`, because a header block would have to be
# split off the body and every way of doing that in POSIX sh is worse than this.
http_request() {
  _method="$1"; _url="$2"; _body="${3:-}"; _auth="${4:-}"
  _out="$TMP/response.$$"
  set -- -sS -X "$_method" -o "$_out" -w '%{http_code}' --max-time 30
  [ -n "$_body" ] && set -- "$@" -H 'content-type: application/json' --data-binary "$_body"
  [ -n "$_auth" ] && set -- "$@" -H "authorization: Bearer $_auth"
  HTTP_STATUS=$(curl "$@" "$_url" 2>/dev/null) || HTTP_STATUS=000
  if [ "$HTTP_STATUS" = 000 ]; then
    HTTP_BODY=""
  else
    HTTP_BODY=$(cat "$_out")
  fi
  rm -f "$_out"
}

# A dotted path out of a JSON object, through node — which by this point is a
# hard requirement anyway. `lib.sh`'s `json_field` reads a *top-level* key only,
# and this file needs `registration.enabled`, `source.version` and
# `enrollment.code`; `deploycheck` asserts the two agree on the flat case, so
# this is a widening rather than a second implementation.
json_path() {
  printf '%s' "$2" | "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let value;
      try {
        value = process.argv[1].split(".").reduce((o, k) => (o == null ? o : o[k]), JSON.parse(raw));
      } catch {
        // Unreadable is empty, deliberately: every caller checks, and a throw
        // here would turn "the server said something odd" into a stack trace.
        value = undefined;
      }
      process.stdout.write(value === undefined || value === null ? "" : String(value));
    });
  ' "$1" 2>/dev/null || printf ''
}

# The server writes both halves of a refusal — a code and a sentence meant for a
# person. Print the sentence; the code is for us to branch on.
api_message() { json_path error.message "$1"; }
api_code()    { json_path error.code "$1"; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

node_major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p'; }

# Reuse before install, always: on a developer's machine this is the whole of
# it and nothing is downloaded. The private prefix exists for the laptop that
# has never had node, where the alternatives are sudo, Homebrew or NodeSource —
# a password, somebody else's whole ecosystem, or a permanent third-party write
# path into a box that runs your agents.
ensure_node() {
  if [ -n "$NODE_BIN" ]; then
    [ -x "$NODE_BIN" ] || die "--node $NODE_BIN is not executable."
    _m=$(node_major "$NODE_BIN")
    [ -n "$_m" ] && [ "$_m" -ge "$NODE_MAJOR" ] || die "--node $NODE_BIN is v${_m:-?}; the daemon needs $NODE_MAJOR or newer."
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    _m=$(node_major "$(command -v node)")
    if [ -n "$_m" ] && [ "$_m" -ge "$NODE_MAJOR" ]; then
      NODE_BIN=$(command -v node)
      note "node          v$_m"
      return 0
    fi
    note "node          v${_m:-?} is too old, need $NODE_MAJOR"
  fi
  if [ -x "$TOOLCHAIN/bin/node" ]; then
    _m=$(node_major "$TOOLCHAIN/bin/node")
    if [ -n "$_m" ] && [ "$_m" -ge "$NODE_MAJOR" ]; then
      NODE_BIN="$TOOLCHAIN/bin/node"
      note "node          v$_m"
      return 0
    fi
  fi
  install_node
}

# One checksum tool, and no arm that skips the check. A verification that
# silently does not happen is worse than none, because the line saying it
# happened is still printed.
verify_sha256() {
  _file="$1"; _sums="$2"; _name="$3"
  if   command -v sha256sum >/dev/null 2>&1; then ( cd "$(dirname -- "$_file")" && grep " $_name\$" "$_sums" | sha256sum -c - >/dev/null 2>&1 )
  elif command -v shasum    >/dev/null 2>&1; then ( cd "$(dirname -- "$_file")" && grep " $_name\$" "$_sums" | shasum -a 256 -c - >/dev/null 2>&1 )
  elif command -v openssl   >/dev/null 2>&1; then
    _want=$(sed -n "s/^\([0-9a-f]*\)  $_name\$/\1/p" "$_sums")
    _got=$(openssl dgst -sha256 "$_file" | sed 's/.*= *//')
    [ -n "$_want" ] && [ "$_want" = "$_got" ]
  else
    die "no sha256 tool here (sha256sum, shasum or openssl), so the node download cannot be verified.

  Install node $NODE_MAJOR yourself and re-run with --node <path>."
  fi
}

install_node() {
  note "node          installing $NODE_MAJOR (~50 MB, into $TOOLCHAIN)"
  _plat="$PLATFORM"; [ "$_plat" = darwin ] && _plat=darwin
  _dist="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  mkdir -p "$TMP/node"
  # `SHASUMS256.txt` first: one fetch gives both the current patch version and
  # the digest to check it against, with no JSON parsing on a machine that by
  # definition has no node yet.
  curl -fsSL "$_dist/SHASUMS256.txt" -o "$TMP/node/SHASUMS256.txt" \
    || die "cannot reach $_dist — check the network, or install node $NODE_MAJOR yourself and use --node."
  _tar=$(sed -n "s/^[0-9a-f]*  \(node-v[0-9.]*-$_plat-$ARCH\.tar\.gz\)\$/\1/p" "$TMP/node/SHASUMS256.txt" | head -1)
  [ -n "$_tar" ] || die "nodejs.org publishes no $_plat-$ARCH build for v$NODE_MAJOR."
  curl -fsSL "$_dist/$_tar" -o "$TMP/node/$_tar" || die "the node download failed."
  verify_sha256 "$TMP/node/$_tar" "$TMP/node/SHASUMS256.txt" "$_tar" \
    || die "the node download does not match its published checksum. Nothing has been installed."
  rm -rf "$TOOLCHAIN"
  mkdir -p "$TOOLCHAIN"
  tar -xzf "$TMP/node/$_tar" -C "$TOOLCHAIN" --strip-components=1 || die "could not unpack $_tar."
  : > "$TOOLCHAIN_MARKER"
  NODE_BIN="$TOOLCHAIN/bin/node"
  [ -x "$NODE_BIN" ] || die "node unpacked but $NODE_BIN is not executable."
  note "node          $("$NODE_BIN" --version)"
}

pnpm_version_of() { "$1" --version 2>/dev/null; }

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm_version_of "$(command -v pnpm)")" = "$PNPM_VERSION" ]; then
    PNPM_BIN=$(command -v pnpm)
    note "pnpm          $PNPM_VERSION"
    return 0
  fi
  if [ -x "$TOOLCHAIN/bin/pnpm" ] && [ "$(pnpm_version_of "$TOOLCHAIN/bin/pnpm")" = "$PNPM_VERSION" ]; then
    PNPM_BIN="$TOOLCHAIN/bin/pnpm"
    note "pnpm          $PNPM_VERSION"
    return 0
  fi
  _npm="$(dirname -- "$NODE_BIN")/npm"
  # Never `--prefix` into a system node's prefix: that needs sudo and writes
  # into a directory this script does not own. Our own prefix always.
  [ -x "$_npm" ] || _npm=$(command -v npm 2>/dev/null || true)
  [ -n "$_npm" ] || die "no npm beside $NODE_BIN, so pnpm cannot be installed."
  mkdir -p "$TOOLCHAIN"
  : > "$TOOLCHAIN_MARKER"
  # Not corepack. It downloads pnpm at first use, which turns `pnpm install`
  # into a network dependency at exactly the moment somebody is counting
  # seconds — the reason services/premium's provision.sh gives, in production.
  PATH="$(dirname -- "$NODE_BIN"):$PATH" "$_npm" install -g --no-fund --no-audit \
    --prefix "$TOOLCHAIN" "pnpm@$PNPM_VERSION" >/dev/null 2>&1 \
    || die "could not install pnpm $PNPM_VERSION."
  PNPM_BIN="$TOOLCHAIN/bin/pnpm"
  [ -x "$PNPM_BIN" ] || die "pnpm installed but $PNPM_BIN is not executable."
  note "pnpm          $PNPM_VERSION"
}

# git cannot be installed without a package manager, so this refuses with the
# line for *this* machine rather than a general apology.
ensure_git() {
  if [ "$PLATFORM" = darwin ] && ! xcode-select -p >/dev/null 2>&1; then
    # A bare `git` here opens a modal GUI dialog. From a piped script the
    # person sees nothing and the script appears to hang.
    die "the Command Line Tools are not installed, so there is no git.

  Run this, let it finish, then run this installer again:
      xcode-select --install"
  fi
  command -v git >/dev/null 2>&1 && return 0
  for _pm in apt-get dnf pacman apk zypper; do
    command -v "$_pm" >/dev/null 2>&1 || continue
    case "$_pm" in
      apt-get) die "git is not installed. Run: sudo apt-get install -y git" ;;
      dnf)     die "git is not installed. Run: sudo dnf install -y git" ;;
      pacman)  die "git is not installed. Run: sudo pacman -S --noconfirm git" ;;
      apk)     die "git is not installed. Run: sudo apk add git" ;;
      zypper)  die "git is not installed. Run: sudo zypper install -y git" ;;
    esac
  done
  die "git is not installed, and this machine has no package manager I recognise."
}

# A warning rather than a refusal: the daemon runs perfectly without `script`,
# and what is missing is the pty behind *agent logins* — a button that is not
# offered rather than a broken install.
check_script_binary() {
  command -v script >/dev/null 2>&1 && return 0
  warn "note: \`script\` is not on PATH, so signing an agent in from the app will not work."
  warn "      It comes with util-linux on Linux and with the base system on macOS."
}

# ---------------------------------------------------------------------------
# The control plane
# ---------------------------------------------------------------------------

# Read before the menu is drawn, so an arm that cannot work is not offered and
# then refused. It also hands over the two things this script would otherwise
# have to write down: which repository to clone and which version of it — the
# AGPL section 13 offer, which names what that instance is actually running. A
# fork that obeys the licence gets a correct installer for free.
probe_instance() {
  http_request GET "$CP/v1/instance"
  case "$HTTP_STATUS" in
    200) : ;;
    000) die "cannot reach $CP.

  Check the address and the network. Nothing has been installed." ;;
    *)   die "$CP answered $HTTP_STATUS to GET /v1/instance, so it is not a Reemoat control plane
  (or it is behind something that answered for it)." ;;
  esac
  INSTANCE_JSON="$HTTP_BODY"
  REG_ENABLED=$(json_path registration.enabled "$INSTANCE_JSON")
  REG_EMAIL=$(json_path registration.requiresEmail "$INSTANCE_JSON")
  SOURCE_URL=$(json_path source.url "$INSTANCE_JSON")
  SOURCE_VERSION=$(json_path source.version "$INSTANCE_JSON")
  note "control plane $CP (${SOURCE_VERSION:-?})"
}

# `POST /v1/login` answers one thing for an unknown name, an unconfirmed
# address, a wrong password and an account with no password row — deliberately,
# so this cannot tell them apart either and must not pretend to.
sign_in() {
  _name=$(tty_ask "  username or email")
  [ -n "$_name" ] || die "no username given."
  _pass=$(tty_secret "  password")
  [ -n "$_pass" ] || die "no password given."
  _body=$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify({name: process.argv[1], password: process.argv[2]}))' "$_name" "$_pass")
  http_request POST "$CP/v1/login" "$_body"
  case "$HTTP_STATUS" in
    200) SESSION_TOKEN=$(json_path token "$HTTP_BODY"); AUTH="$SESSION_TOKEN"; return 0 ;;
    429) die "too many sign-in attempts. $(api_message "$HTTP_BODY")" ;;
    *)   die "sign-in refused: $(api_message "$HTTP_BODY")" ;;
  esac
}

# **There is no polling loop here, and that is a measurement rather than a
# style.** `POST /v1/login` counts every 401 against `DEFAULT_THROTTLE`:
# five failures in fifteen minutes, then a block starting at 30s and doubling to
# a fifteen-minute ceiling. A five-second poll spends the whole budget in
# twenty-five seconds and then sits blocked out of an account the person created
# ninety seconds ago. So the wait is on the *person*: one attempt per keypress,
# capped at five, which is exactly the budget before the first block. A 429
# arriving anyway is honoured rather than retried through.
wait_for_confirmation() {
  _name="$1"; _pass="$2"; _email="$3"
  say ""
  say "  Link sent to $_email. Open it, then press Enter."
  _tries=0
  while [ "$_tries" -lt 5 ]; do
    _tries=$((_tries + 1))
    tty_ask "  Enter when done" "" >/dev/null
    _body=$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify({name: process.argv[1], password: process.argv[2]}))' "$_name" "$_pass")
    http_request POST "$CP/v1/login" "$_body"
    case "$HTTP_STATUS" in
      200) SESSION_TOKEN=$(json_path token "$HTTP_BODY"); AUTH="$SESSION_TOKEN"; say "  signed in."; return 0 ;;
      429) die "the control plane is rate-limiting sign-ins. $(api_message "$HTTP_BODY")

  Wait, then re-run this installer and choose \"sign in\"." ;;
      *)   warn "  not confirmed yet (or the password is wrong) — the server does not say which." ;;
    esac
  done
  die "still not signed in after five tries, and five is the whole budget before
  this control plane starts blocking sign-ins for the account you just made.

  Open the link, then sign in at $CP/ and add a machine there — or re-run this
  with --api-key once you have one."
}

register() {
  _name=$(tty_ask "  username")
  [ -n "$_name" ] || die "no username given."
  _email=""
  if [ "$REG_EMAIL" = true ]; then
    _email=$(tty_ask "  email")
    [ -n "$_email" ] || die "this control plane confirms sign-ups by mail, so it needs an address."
  fi
  _pass=$(tty_secret "  password")
  _again=$(tty_secret "  again")
  [ "$_pass" = "$_again" ] || die "the two passwords are not the same."
  _body=$("$NODE_BIN" -e '
    const [name, password, email] = process.argv.slice(1);
    process.stdout.write(JSON.stringify(email ? {name, password, email} : {name, password}));
  ' "$_name" "$_pass" "$_email")
  http_request POST "$CP/v1/register" "$_body"
  case "$HTTP_STATUS" in
    201)
      # No mail configured on this instance, so the account exists now and the
      # response already carries a session. Nothing to wait for.
      SESSION_TOKEN=$(json_path token "$HTTP_BODY"); AUTH="$SESSION_TOKEN"
      note "account       created"
      return 0 ;;
    200) wait_for_confirmation "$_name" "$_pass" "$_email"; return 0 ;;
    403) die "this control plane is not taking sign-ups. Ask whoever runs it for an account." ;;
    *)   die "sign-up refused: $(api_message "$HTTP_BODY")" ;;
  esac
}

# Least authority first, on purpose. An enrollment code is single-use, lives an
# hour and is worth exactly one machine; an API key is the whole account.
choose_credential() {
  AUTH=""
  [ -n "$ENROLL_CODE" ] && return 0
  if [ -n "$API_KEY" ]; then AUTH="$API_KEY"; return 0; fi
  if [ "$TTY_OPEN" != 1 ]; then
    die "no terminal, so there is nothing to ask on. Give this a credential outright:

      curl -fsSL $CP/install.sh | sh -s -- --enroll-code ec_...
      REEMOAT_API_KEY=rk_... sh -c \"\$(curl -fsSL $CP/install.sh)\""
  fi
  say ""
  # Most-common-first now that Enter takes the top row: signing in is what
  # almost everybody does, and a setup code is the expert path. The row that
  # cannot work is **absent** rather than present-and-refusing — a menu whose
  # options are not all real is a menu you have to read twice.
  if [ "$REG_ENABLED" = true ]; then
    _pick=$(menu "Who are you on it?" "Sign in" "Create an account" "API key" "Setup code")
  else
    _pick=$(menu "Who are you on it?" "Sign in" "API key" "Setup code")
    [ "$_pick" -ge 2 ] && _pick=$((_pick + 1))
  fi
  case "$_pick" in
    1) sign_in ;;
    2) register ;;
    # Used to mint one enrollment code and then dropped: never written to the
    # env file, and nothing on this host keeps it.
    3) API_KEY=$(tty_secret "  API key"); AUTH="$API_KEY" ;;
    4) ENROLL_CODE=$(tty_secret "  setup code") ;;
  esac
}

# ---------------------------------------------------------------------------
# The machine
# ---------------------------------------------------------------------------

# `MACHINE_LABEL` in packages/control-plane/src/machines.ts is
# /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, and `MACHINE_LABEL_RESERVED` refuses
# anything shaped like a machine id. `deploycheck` drives this against both
# regexes read out of that file rather than retyped here.
sanitize_label() {
  _in=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-')
  _in=$(printf '%s' "$_in" | sed 's/^[^A-Za-z0-9]*//' | cut -c1-64)
  case "$_in" in
    "") _in=laptop ;;
    # Both arms of `MACHINE_LABEL_RESERVED` — `^m_(?:[0-9a-f]{8}|[0-9a-f]{16})$`.
    # Mirroring only the 8-hex one let `m_0123456789abcdef` through to a route
    # that refuses it; `deploycheck` drives both widths off that regex now.
    m_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] | \
    m_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) _in="$_in-1" ;;
  esac
  printf '%s' "$_in"
}

# **A name somebody typed is refused, never rewritten.** `sanitize_label` is for
# the hostname, which this script chose and may therefore correct; `--label` is a
# decision, and quietly turning `MacBook Pro.local` into `MacBook-Pro.local`
# leaves somebody looking for a machine under a name they never gave. Checked
# here rather than at the control plane so it costs no round trip and so
# `--yes`, which has no retry, fails before the machine exists.
check_label() {
  case "$1" in
    "" | [!A-Za-z0-9]*) die "a machine name has to start with a letter or a digit: \"$1\"" ;;
    *[!A-Za-z0-9._-]*)  die "a machine name may hold only letters, digits and . _ - : \"$1\"" ;;
  esac
  [ "${#1}" -le 64 ] || die "a machine name is at most 64 characters: \"$1\""
  case "$1" in
    m_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] | \
    m_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      die "\"$1\" is shaped like a machine id, which the control plane keeps for itself." ;;
  esac
}

# **Before the clone and before `pnpm install`, and the order is the point.** A
# fresh account on an instance whose machine limit is zero gets `409
# machine_limit` — and under the other order that refusal arrives after 750 MB
# and several minutes of somebody's evening.
create_machine() {
  # A code already names a machine on the control plane, so nothing is created
  # here — but the summary still has to call it something, and `LABEL` is unset
  # on every path that gets here. Measured: `--enroll-code ec_…` ended with
  # `done — "" is on https://…`. The hostname is the honest stand-in; the real
  # name is whatever the person called it when they minted the code.
  if [ -n "$ENROLL_CODE" ]; then
    [ -n "$LABEL" ] || LABEL=$(sanitize_label "$(uname -n)")
    return 0
  fi
  # `--label` was already checked in `main`, before anything reached the network.
  [ -n "$LABEL" ] || LABEL=$(sanitize_label "$(uname -n)")
  if [ "$TTY_OPEN" = 1 ] && [ "$ASSUME_YES" != 1 ]; then
    # Typed at the prompt is typed: checked, and asked again rather than rewritten.
    while :; do
      _typed=$(tty_ask "  machine name" "$LABEL")
      if ( check_label "$_typed" ) 2>/dev/null; then LABEL="$_typed"; break; fi
      ( check_label "$_typed" ) 2>&1 | head -1 >&2 || true
    done
  fi
  while :; do
    _body=$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify({name: process.argv[1]}))' "$LABEL")
    http_request POST "$CP/v1/machines" "$_body" "$AUTH"
    case "$HTTP_STATUS" in
      201)
        MACHINE_ID=$(json_path machine.id "$HTTP_BODY")
        ENROLL_CODE=$(json_path enrollment.code "$HTTP_BODY")
        # The server's own view of the address a daemon should dial, which is
        # not always the one we asked on — a proxy, a split-horizon DNS.
        _url=$(json_path controlPlaneUrl "$HTTP_BODY")
        [ -n "$_url" ] && CP="$_url"
        [ -n "$ENROLL_CODE" ] || die "the control plane created $MACHINE_ID but sent no enrollment code."
        note "machine       $LABEL"
        return 0 ;;
      409)
        case "$(api_code "$HTTP_BODY")" in
          machine_exists)
            [ "$TTY_OPEN" = 1 ] || die "you already have a machine called \"$LABEL\". Pass --label <other>."
            warn "  you already have a machine called \"$LABEL\"."
            LABEL=$(sanitize_label "$(tty_ask "  another name")") ;;
          # Never retried. The server writes both sentences, including the one
          # for a limit of zero, and a retry would be asking a settled question
          # again.
          *) die "$(api_message "$HTTP_BODY")" ;;
        esac ;;
      403)
        case "$(api_code "$HTTP_BODY")" in
          password_change_required)
            # `POST /v1/machines` sits below `requirePasswordCurrent`, and an
            # account created by an admin owes a password change. This script
            # cannot do it — `POST /v1/me/password` needs the current one.
            die "this account has to change its password before it can add a machine.

  Sign in at $CP/ , set a password, then run this again." ;;
          *) die "refused: $(api_message "$HTTP_BODY")" ;;
        esac ;;
      401) die "that credential was refused: $(api_message "$HTTP_BODY")" ;;
      000) die "lost the control plane while adding the machine. Nothing has been installed." ;;
      *)   die "the control plane answered $HTTP_STATUS: $(api_message "$HTTP_BODY")" ;;
    esac
  done
}

# The session existed to mint one enrollment code. `…/sessions/current` and not
# `…/sessions/:id`: the `:id` form is registered *below* `requirePasswordCurrent`
# and would 403 for exactly the account most likely to be running this.
# Best-effort — the code is already in hand and a session expires on its own.
revoke_session() {
  [ -n "$SESSION_TOKEN" ] || return 0
  http_request DELETE "$CP/v1/me/sessions/current" "" "$SESSION_TOKEN" || true
  SESSION_TOKEN=""
}

# ---------------------------------------------------------------------------
# The checkout
# ---------------------------------------------------------------------------

# **Which ref: the version that control plane is running.** `GET /v1/instance`'s
# `source` is the AGPL section 13 offer, so it names the repository *and* the
# version, and cloning that pair is honouring the offer rather than restating
# it. Not `main`: docs/RELEASING.md rule 6 is that only a tag publishes and rule
# 1 is that every branch push bumps, so `main` is routinely ahead of every tag
# and would put an unreleased daemon on a stranger's laptop.
resolve_ref() {
  [ -z "$GIT_REF" ] || return 0
  if [ -n "$SOURCE_VERSION" ] && git ls-remote --tags "$REPO_URL" "v$SOURCE_VERSION" 2>/dev/null | grep -q .; then
    GIT_REF="v$SOURCE_VERSION"
    return 0
  fi
  # Said out loud rather than fallen through silently: a version with no tag
  # behind it is a fact about that instance somebody should know.
  warn "note: $CP runs ${SOURCE_VERSION:-an unnamed version} and $REPO_URL has no v$SOURCE_VERSION tag."
  warn "      Taking the default branch instead."
  GIT_REF=""
}

resolve_repo_url() {
  REPO_URL="$SOURCE_URL"
  [ -n "$REPO_URL" ] || die "$CP did not say where its source is, so there is nothing to clone."
  case "$REPO_URL" in
    # A leading dash would be read by git as an option rather than a URL.
    -*) die "the control plane named a source that is not a URL: $REPO_URL" ;;
    https://*) : ;;
    *) die "the control plane's source is not https: $REPO_URL" ;;
  esac
}

clone_or_fetch() {
  if [ -d "$CHECKOUT/.git" ]; then
    _origin=$(git -C "$CHECKOUT" remote get-url origin 2>/dev/null || printf '')
    [ "$_origin" = "$REPO_URL" ] || die "$CHECKOUT is a checkout of $_origin, not $REPO_URL.

  Pass --dir <somewhere-else>, or move that directory."
    note "checkout      $CHECKOUT"
    git -C "$CHECKOUT" fetch --tags --quiet origin || die "could not fetch $REPO_URL."
  else
    [ ! -e "$CHECKOUT" ] || [ -z "$(ls -A "$CHECKOUT" 2>/dev/null)" ] \
      || die "$CHECKOUT exists and is not empty. Pass --dir <somewhere-else>."
    note "checkout      $CHECKOUT"
    mkdir -p "$(dirname -- "$CHECKOUT")"
    # `--filter=blob:none` rather than `--depth 1`: deploy/deploy.sh fetches and
    # resets later, and a shallow clone makes that a special case.
    git clone --filter=blob:none --quiet -- "$REPO_URL" "$CHECKOUT" || die "the clone failed."
  fi
  if [ -n "$GIT_REF" ]; then
    git -C "$CHECKOUT" checkout --detach --quiet "$GIT_REF" || die "no such ref in $REPO_URL: $GIT_REF"
    note "version       $GIT_REF"
  else
    # With no tag to check out, an *existing* checkout would otherwise be fetched
    # and then left exactly where it was — an "update" that moved nothing.
    # `origin/HEAD` rather than a branch name, because the default branch is the
    # remote's business and this script does not get to assume it is `main`.
    _head=$(git -C "$CHECKOUT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || printf '')
    if [ -n "$_head" ]; then
      git -C "$CHECKOUT" checkout --detach --quiet "$_head" || die "could not check out $_head."
    fi
    note "version       $(git -C "$CHECKOUT" rev-parse --short HEAD)"
  fi
}

install_dependencies() {
  note "deps          installing (~750 MB, a few minutes)"
  ( cd "$CHECKOUT" && PATH="$(dirname -- "$NODE_BIN"):$(dirname -- "$PNPM_BIN"):$PATH" \
      "$PNPM_BIN" install --frozen-lockfile ) || die "pnpm install failed. Nothing has been started."
}

# ---------------------------------------------------------------------------
# The env file, and the hand-off
# ---------------------------------------------------------------------------

# Written through `deploy/lib.sh`'s own `set_env`, never by hand. That function
# single-quotes every value through `sq`, which exists because
# `REEMOAT_ENROLL_CODE=xy$(touch PWNED)` was measured *creating the file* when
# run-daemon.sh sourced it. `deploycheck` drives `sq` and `set_env` over that
# exact case; a fourth quoting implementation here would inherit none of it.
#
# `sh -c '…' <path-to-lib.sh>` rather than a plain `.`: lib.sh derives
# `DEPLOY_DIR` from `$0`, and under `curl | sh` that is the bare string `sh`.
# Passing the library's own path as `$0` makes both it and `REPO_ROOT` resolve.
write_env_file() {
  sh -c '
    set -eu
    . "$0"
    _env=$(env_file daemon)
    _dir=$(dirname -- "$_env")
    if [ -d "$_dir" ]; then
      # Deliberately not re-permissioned. install.sh makes the same choice for
      # the same reason: this may be a directory somebody chose, and silently
      # tightening it is a change nobody asked for.
      case "$(ls -ld "$_dir" | cut -c1-10)" in drwx------) : ;; *) echo "note: $_dir is readable by more than you." >&2 ;; esac
    else
      mkdir -p "$_dir" && chmod 700 "$_dir"
    fi
    [ -f "$_env" ] || { cp "$(env_example daemon)" "$_env" && chmod 600 "$_env"; }
    set_env REEMOAT_AUTH           signed "$_env"
    set_env REEMOAT_CONTROL_PLANE  "$1"   "$_env"
    set_env REEMOAT_ENROLL_CODE    "$2"   "$_env"
    printf "%s" "$_env"
  ' "$CHECKOUT/deploy/lib.sh" "$CP" "$ENROLL_CODE" > "$TMP/envpath" \
    || die "could not write the daemon's environment file."
  ENV_FILE=$(cat "$TMP/envpath")
  note "settings      $ENV_FILE"
}

# **Writing the env file first is what makes this non-interactive**, and it is a
# property of install.sh rather than of the flag: both its interview and its
# refusal-to-start are gated on `cmp -s "$ENV_FILE" "$ENV_EXAMPLE"`. With a real
# file in place it renders the unit, starts it and probes it. services/premium's
# provision.sh does exactly this, in production.
hand_off() {
  note "service       installing"
  # PATH prefixed for this one call so `resolve_bin node` finds ours and
  # `runtime_path` bakes its directory into the unit — which is why nothing had
  # to be appended to a shell profile. </dev/null so nothing downstream can read
  # what is left of our own download.
  PATH="$(dirname -- "$NODE_BIN"):$(dirname -- "$PNPM_BIN"):$PATH" \
    "$CHECKOUT/deploy/install.sh" daemon --non-interactive </dev/null \
    || die "deploy/install.sh could not install the service."
  if [ "$PLATFORM" = linux ] && command -v loginctl >/dev/null 2>&1; then
    # A --user unit stops when the last session for that user ends. Attempted,
    # never escalated: printing the one line is the whole of what a script
    # without a password can honestly do.
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 \
      || warn "note: the daemon will stop when you log out. To keep it running:
      sudo loginctl enable-linger $(id -un)"
  fi
}

# ---------------------------------------------------------------------------
# Proof
# ---------------------------------------------------------------------------

# Three distinct claims and three distinct messages. Collapsing them is the
# thing deploy.sh warns about twice and lib.sh once: "it did not work" sends
# somebody to read a healthy log.
verify_running() {
  sh -c '
    set -eu
    . "$0"
    _ok=1
    if svc_installed daemon && [ -n "$(svc_pid daemon || true)" ]; then
      echo "  running       yes"
    else
      echo "  running       NO — the supervisor has no live process" >&2; _ok=0
    fi
    # ⚠ **`wait_healthy`, not `http_ok` on a raw `health_probe_target`.** That
    # function answers `ok <url>` or `skip <reason>` — a *prefixed* answer — and
    # `wait_healthy` is what strips it, classifies the three skip cases and
    # retries for 30s. Passing it straight to `http_ok` asked for a URL that
    # begins `ok http://…`, which never answers: measured, every healthy install
    # printed `answering: NO — nothing answered at ok http://127.0.0.1:7887/health`
    # and exited 2, seconds after `install.sh` had printed `health: ok` for the
    # same daemon on the line above.
    if wait_healthy daemon; then :; else _ok=0; fi
    if svc_log_lines daemon 300 2>/dev/null | grep -q "enrolled as m_"; then
      echo "  enrolled      $(svc_log_lines daemon 300 | sed -n "s/.*enrolled as \(m_[0-9a-f]*\).*/\1/p" | tail -1)"
    else
      echo "  enrolled      NO — the code has not been exchanged" >&2; _ok=0
    fi
    # A note rather than a failure: a machine that enrolled and got no relay is
    # unreachable from a phone, and the daemon redials on its own backoff.
    svc_log_lines daemon 300 2>/dev/null | grep -qi "relay" \
      || echo "  relay         not up yet — it dials with backoff" >&2
    echo "  logs          $(log_hint daemon)"
    exit $(( 1 - _ok ))
  ' "$CHECKOUT/deploy/lib.sh"
}

summary() {
  say ""
  say "\"$LABEL\" is on $CP — open it."
  say ""
  note "update        $CHECKOUT/deploy/deploy.sh"
  note "uninstall     curl -fsSL $CP/install.sh | sh -s -- --uninstall"
}

# ---------------------------------------------------------------------------
# Already here
# ---------------------------------------------------------------------------

# Asked before a credential is, so nobody signs in to be told there was nothing
# to do. Re-enrolling is offered but never the default: it mints a *second*
# machine row, which spends a slot against `machines.per_user` and leaves a
# duplicate in somebody's list.
existing_install() {
  _env="${REEMOAT_ENV_FILE:-$HOME/.reemoat/daemon.env}"
  [ -f "$_env" ] || return 1
  _bound=$(sed -n "s/^REEMOAT_CONTROL_PLANE='\{0,1\}\([^']*\)'\{0,1\}.*/\1/p" "$_env" | tail -1)
  [ -n "$_bound" ] || return 1
  say ""
  if [ "$TTY_OPEN" != 1 ]; then
    die "already set up here, joined to $_bound.
      $CHECKOUT/deploy/deploy.sh                        # update
      curl -fsSL $CP/install.sh | sh -s -- --uninstall  # remove"
  fi
  # Leaving it alone is first: this runs on a machine that already works, and
  # Enter must not be the key that changes it.
  case "$(menu "Already joined to $_bound." "Leave it" "Update" "Add as a second machine")" in
    1) exit 0 ;;
    2) update_existing || die "the update did not finish. Nothing else changed."
       exit 0 ;;
    3) tty_confirm "Adds a second machine and spends a slot." && return 1
       exit 0 ;;
  esac
}

update_existing() {
  [ -d "$CHECKOUT/.git" ] || die "there is a service here but no checkout at $CHECKOUT.

  Point --dir at the checkout it was installed from."
  say ""
  say "updating $CHECKOUT"
  # deploy.sh is the update path and it knows what a restart costs — an
  # in-flight turn and every pending approval. Reimplementing it here would be
  # a second answer to a question that already has one.
  #
  # ⚠ Its status is **returned**, not left to `set -e`. `existing_install` is
  # called as `existing_install || true`, and an `||` list suppresses `set -e`
  # for everything inside it — so a failed `deploy.sh` here reached the `exit 0`
  # below and the installer reported success over it. Reproduced with a stub.
  "$CHECKOUT/deploy/deploy.sh" --service daemon || return 1
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

# **Stops the service; names the data; deletes none of it.** `~/.reemoat`
# holds the SQLite file with every session's history and, under `worktrees/`,
# git working copies that may carry uncommitted work. An installer that threw
# somebody's branch away is not recoverable by anything, so `--purge` is a
# separate flag and it prints the list first.
do_uninstall() {
  _env="${REEMOAT_ENV_FILE:-$HOME/.reemoat/daemon.env}"
  _stopped=1
  if [ -d "$CHECKOUT/deploy" ]; then
    sh -c '
      set -eu
      . "$0"
      svc_uninstall daemon
    ' "$CHECKOUT/deploy/lib.sh" || _stopped=0
  else
    _stopped=0
    warn "note: no checkout at $CHECKOUT, so the service could not be stopped through lib.sh."
  fi
  # ⚠ **`--purge` is refused if the daemon is still up.** It deletes
  # `~/.reemoat/worktrees`, which are git working copies an agent may be editing,
  # and doing that under a live process is the one outcome here nothing can undo.
  if [ "$_stopped" = 0 ]; then
    warn "note: could not confirm the service is stopped."
    [ "$PURGE" = 1 ] && die "refusing --purge while the daemon may still be running.
  Stop it, then re-run."
  fi
  # Only a toolchain this script created, and only on the evidence of the
  # marker it wrote. A path that came from a flag is never removed.
  if [ -f "$TOOLCHAIN_MARKER" ]; then
    rm -rf "$TOOLCHAIN"
    say "removed      $TOOLCHAIN"
  fi
  say ""
  if [ "$PURGE" = 1 ]; then
    if [ -d "$REEMOAT_HOME/worktrees" ] && [ -n "$(ls -A "$REEMOAT_HOME/worktrees" 2>/dev/null)" ]; then
      say "these working copies are about to be deleted, and they may hold uncommitted work:"
      ls -1 "$REEMOAT_HOME/worktrees" | sed 's/^/  /'
      say ""
      tty_confirm "delete $REEMOAT_HOME and $CHECKOUT anyway?" || die "nothing was deleted."
    fi
    rm -rf "$REEMOAT_HOME" "$CHECKOUT"
    say "removed      $REEMOAT_HOME"
    say "removed      $CHECKOUT"
  else
    say "left alone, because this is your data:"
    note "$_env"
    note "${REEMOAT_DB:-$REEMOAT_HOME/reemoat.db}   sessions and their history"
    note "$REEMOAT_HOME/worktrees                   working copies, possibly with uncommitted work"
    note "$CHECKOUT"
    say ""
    note "to delete them too: re-run with --uninstall --purge"
  fi
  say ""
  say "the machine row is still in your fleet. Retire it in Settings -> Machines"
  say "if you are not coming back to this host."
}

# ---------------------------------------------------------------------------

main() {
  parse_flags "$@"
  open_tty
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/reemoat-install.XXXXXX") || die "cannot make a temporary directory."
  # The session is revoked here as well as on the happy path, so an interrupt
  # between minting one and finishing does not leave a live credential behind.
  trap 'restore_tty; revoke_session; rm -rf "$TMP"' EXIT
  trap 'restore_tty; revoke_session; rm -rf "$TMP"; exit 130' INT TERM

  detect_platform
  # A name somebody typed is checked here, before a single request: a typo should
  # cost nothing, and under `--yes` there is no prompt to correct it at.
  [ -z "$LABEL" ] || check_label "$LABEL"
  # Before `resolve_control_plane`, because taking a daemon off this machine is
  # not a question about a control plane and `do_uninstall` never reads one. Run
  # from a checkout the other order refused with a message about *joining* one.
  if [ "$UNINSTALL" = 1 ]; then do_uninstall; return 0; fi
  resolve_control_plane

  ensure_git
  check_script_binary
  ensure_node
  ensure_pnpm

  probe_instance
  existing_install || true

  choose_credential
  create_machine
  revoke_session

  resolve_repo_url
  resolve_ref
  clone_or_fetch
  install_dependencies

  write_env_file
  hand_off

  verify_running || die "
  the service is installed but did not come up. The log is where the reason is."
  summary
}

main "$@"
