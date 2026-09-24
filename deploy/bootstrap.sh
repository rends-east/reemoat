#!/bin/sh
# From nothing to an enrolled daemon via `curl … | sh`; POSIX sh with dash as the floor, no sudo, no profile edits.
# All work runs from `main` on the last line so a truncated download does nothing; stdin is the download, so questions use fd 3.
set -eu

# Substituted already shell-quoted by `GET /install.sh`, so it stays unquoted; a checkout copy refuses in resolve_control_plane.
CONTROL_PLANE_DEFAULT=@REEMOAT_CONTROL_PLANE@

# deploycheck holds these to package.json's engines.node and packageManager.
NODE_MAJOR=24
PNPM_VERSION=11.17.0

REEMOAT_HOME="${REEMOAT_HOME:-$HOME/.reemoat}"
TOOLCHAIN="$REEMOAT_HOME/toolchain"
TOOLCHAIN_MARKER="$TOOLCHAIN/.installed-by-bootstrap"

CP=""
# Taken out of the environment so no child (pnpm scripts, vendor installers) inherits the account key.
API_KEY="${REEMOAT_API_KEY:-}"
unset REEMOAT_API_KEY
ENROLL_CODE=""
AGENT_SOURCE=vendor
AGENT_SOURCE_GIVEN=0
# claude's release channel (Q4.115).
AGENT_CHANNEL=latest
AGENT_CHANNEL_GIVEN=0
# Empty by default: only a press in the app installs a harness. For provisioners; each name is forwarded as --only.
INSTALL_AGENTS=""
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

open_tty() {
  # Probed in a subshell: a failed redirection on `exec` kills a non-interactive dash outright.
  if ( exec 3</dev/tty ) 2>/dev/null; then
    exec 3</dev/tty
    TTY_OPEN=1
    # Saved here, in the process holding the traps: menu runs inside a $( ) subshell.
    TTY_SAVED=$(stty -g <&3 2>/dev/null || printf '')
  else
    TTY_OPEN=0
  fi
}

prompt() {
  if [ "$TTY_OPEN" = 1 ]; then printf '%s' "$1" >/dev/tty; else printf '%s' "$1" >&2; fi
}

prompt_eol() {
  if [ "$TTY_OPEN" = 1 ]; then printf '\n' >/dev/tty; else printf '\n' >&2; fi
}

tty_say() {
  if [ "$TTY_OPEN" = 1 ]; then printf '%s\n' "$*" >/dev/tty; else printf '%s\n' "$*" >&2; fi
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

tty_secret() {
  _p="$1"
  [ "$TTY_OPEN" = 1 ] || die "no terminal to ask on."
  prompt "$_p: "
  # Terminal on stdin so plain stty works on GNU and BSD; the trap restores echo on interrupt.
  _value=$( exec </dev/tty
            _saved=$(stty -g)
            trap 'stty "$_saved" 2>/dev/null' EXIT INT TERM
            stty -echo
            IFS= read -r _v || _v=""
            printf '%s' "$_v" )
  prompt_eol
  printf '%s' "$_value"
}

# One raw byte through dd (dash has no read -n1); od makes it a number so Enter survives $( ).
_key() { dd bs=1 count=1 2>/dev/null <&3 | od -An -tu1 | tr -dc '0-9'; }

# A global, not a trap: a trap inside menu would replace the script's EXIT trap that revokes the session.
TTY_SAVED=""
restore_tty() {
  if [ -n "$TTY_SAVED" ]; then
    stty "$TTY_SAVED" <&3 2>/dev/null || true
    TTY_SAVED=""
  fi
  { printf '\033[?25h' >/dev/tty; } 2>/dev/null || true
}

# menu "Title" option… prints the 1-based index. Enter takes the first option, so never put an irreversible choice first.
menu() {
  _t="$1"; shift
  [ "$TTY_OPEN" = 1 ] || die "no terminal to choose on."
  _n=$#; _sel=1
  printf '\033[?25l' >/dev/tty
  [ -n "$_t" ] && printf '%s\n' "$_t" >/dev/tty
  _menu_draw "$@"
  if [ -n "$TTY_SAVED" ]; then stty raw -echo <&3 2>/dev/null || true; fi
  while :; do
    _k=$(_key)
    case "$_k" in
      10 | 13) break ;;
      # Raw mode delivers Ctrl-C as byte 3. `kill -INT "$$"` because exit would end only the caller's $( ) subshell.
      3) restore_tty; printf '\r\n' >/dev/tty; kill -INT "$$" 2>/dev/null; exit 130 ;;
      27)
        case "$(_key)" in 91 | 79) ;; *) continue ;; esac
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
  printf '\033[%dA' "$_n" >/dev/tty
  _i=1
  for _o in "$@"; do
    [ "$_i" = "$_sel" ] && printf '\r\033[K  %s\n' "$_o" >/dev/tty
    _i=$((_i + 1))
  done
  _i=1
  while [ "$_i" -lt "$_n" ]; do printf '\r\033[K\n' >/dev/tty; _i=$((_i + 1)); done
  [ "$_n" -gt 1 ] && printf '\033[%dA' "$((_n - 1))" >/dev/tty
  printf '%s' "$_sel"
}

# Each line starts with a carriage return: raw mode clears opost, so a bare line feed keeps the column.
_menu_draw() {
  _i=1
  for _o in "$@"; do
    if [ "$_i" = "$_sel" ]; then
      printf '\r\033[K\033[7m  %s  \033[0m\n' "$_o" >/dev/tty
    else
      printf '\r\033[K  %s\n' "$_o" >/dev/tty
    fi
    _i=$((_i + 1))
  done
}

tty_confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  # Checked here: menu's die runs inside $( ) and would end only the substitution.
  [ "$TTY_OPEN" = 1 ] || die "$1
  No terminal to ask on. Re-run with --yes if you mean it."
  [ "$(menu "$1" "No" "Yes")" = 2 ]
}

# shift is a special builtin: shifting past $# kills dash before any ||, so the arity is checked first.
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
  --agent-source <src>  where the coding-agent CLIs come from: `vendor` (each
                        vendor's own installer, the default) or `npm` (the same
                        four from the npm registry, for a machine that cannot
                        reach claude.ai, chatgpt.com or opencode.ai — point npm at
                        your mirror with npm_config_registry or ~/.npmrc). Written
                        into the daemon's settings, so its daily refresh agrees
  --agent-channel <ch>  which of claude's release channels this machine follows:
                        `latest` (the default — the newest build) or `stable`,
                        which trails it by weeks and, on 2026-09-05, by a model.
                        Claude only: codex's and opencode's installers have no
                        channel. Written into the daemon's settings, and
                        re-applied by every daily refresh
  --install-agents <a,b> install these coding-agent CLIs on the way in. **Nothing
                        is installed by default**: a harness arrives on a machine
                        when somebody presses Install in the app, which is the
                        whole of what keeps a new one from appearing on every
                        machine in the fleet by itself. This flag is for a caller
                        with nobody to press it — a provisioner. Names are the
                        ones `deploy/agents.sh --only` takes, and it validates them
  --yes                 do not ask to confirm anything
  --uninstall           stop and remove the service and the node this script
                        installed. Names your data; deletes none of it. Exits
                        non-zero and keeps the node if the service could not
                        be stopped — pass --dir <the checkout it runs from>
  --purge               with --uninstall, also delete ~/.reemoat and the
                        checkout. Always asks, after naming the database, the
                        checkout and every worktree (uncommitted work lives
                        there); --yes answers
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
      --agent-source)
                     AGENT_SOURCE="${2:-}"; need_value "--agent-source" "$@"; shift 2
                     AGENT_SOURCE_GIVEN=1
                     case "$AGENT_SOURCE" in
                       vendor | npm) ;;
                       *) die "--agent-source takes vendor or npm, not $AGENT_SOURCE" ;;
                     esac ;;
      --install-agents)
                     INSTALL_AGENTS="${2:-}"; need_value "--install-agents" "$@"; shift 2
                     # Shape only, since agents.sh --only owns the names; a list of bare separators must die here, or agents.sh installs everything.
                     case "$INSTALL_AGENTS" in
                       *[!a-z,]*) die "--install-agents takes a comma-separated list of agent names, not $INSTALL_AGENTS" ;;
                       *[a-z]*) ;;
                       *) die "--install-agents names no agent in \"$INSTALL_AGENTS\"; omit the flag to install none" ;;
                     esac
                     ;;
      --agent-channel)
                     AGENT_CHANNEL="${2:-}"; need_value "--agent-channel" "$@"; shift 2
                     AGENT_CHANNEL_GIVEN=1
                     case "$AGENT_CHANNEL" in
                       stable | latest) ;;
                       *) die "--agent-channel takes stable or latest, not $AGENT_CHANNEL" ;;
                     esac ;;
      --yes | -y)    ASSUME_YES=1;         shift ;;
      --uninstall)   UNINSTALL=1;          shift ;;
      --purge)       PURGE=1;              shift ;;
      --help | -h)   usage; exit 0 ;;
      *)             usage >&2; die "unknown option: $1" ;;
    esac
  done
}

# Precedence: --url or REEMOAT_CONTROL_PLANE, then the origin GET /install.sh substituted, else ask with no default (Q4.107, Q4.112).
# deploycheck keeps every control-plane hostname inside resolve_control_plane and never on the menu's first row.

# The one place an origin is judged, the server's controlPlaneUrl included. Assigns CP rather than printing: die inside $( ) exits only the substitution.
adopt_origin() {
  _o=$1
  case "$_o" in */) _o=${_o%/} ;; esac
  case "$_o" in
    https://* | http://*) : ;;
    *) die "$2: $1" ;;
  esac
  # An origin only: every request appends /v1/…, and user:pass@ would put a credential into the env file.
  case "${_o#*://}" in
    "" | */* | *\?* | *\#* | *@*) die "$2: $1" ;;
  esac
  # Anchored on the host so 127.0.0.10 or localhost.example do not pass as loopback.
  case "$_o" in
    https://* | http://127.0.0.1 | http://127.0.0.1:* | http://localhost | http://localhost:*) : ;;
    http://*) warn "warning: $_o is plaintext. Everything below, including a password, crosses it in the clear." ;;
  esac
  CP=$_o
}

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
    # The hosted one is second: Enter takes the first row, and joining the author's fleet is never the default.
    if [ "$(menu "Which control plane?" "My own" "app.reemoat.com  (run by the author)")" = 2 ]; then
      CP="https://app.reemoat.com"
    else
      while [ -z "$CP" ]; do CP=$(tty_ask "  address"); done
    fi
  fi
  adopt_origin "$CP" "--url must be an http(s) origin, not"
}

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

# Sets HTTP_STATUS (000 when curl got no answer) and HTTP_BODY.
http_request() {
  _method="$1"; _url="$2"; _body="${3:-}"; _auth="${4:-}"
  _out="$TMP/response.$$"
  set -- -sS -X "$_method" -o "$_out" -w '%{http_code}' --max-time 30
  # Neither body nor token may reach argv, which every account can read: both go through 0600 files in $TMP.
  if [ -n "$_body" ]; then
    ( umask 077; printf '%s' "$_body" >"$TMP/request.$$" )
    # `--data-binary @file`, not -K: the config parser mangles JSON.
    set -- "$@" -H 'content-type: application/json' --data-binary "@$TMP/request.$$"
  fi
  if [ -n "$_auth" ]; then
    # -K because -H has no @file form; quotes, backslashes and non-printables are refused so the line cannot be escaped.
    case "$_auth" in
      *'"'* | *'\'* | *[![:print:]]*) die "that credential holds a character this installer cannot send safely." ;;
    esac
    ( umask 077; printf 'header = "authorization: Bearer %s"\n' "$_auth" >"$TMP/auth.$$" )
    set -- "$@" -K "$TMP/auth.$$"
  fi
  HTTP_STATUS=$(curl "$@" "$_url" 2>/dev/null) || HTTP_STATUS=000
  rm -f "$TMP/request.$$" "$TMP/auth.$$"
  if [ "$HTTP_STATUS" = 000 ]; then
    HTTP_BODY=""
  else
    HTTP_BODY=$(cat "$_out")
  fi
  rm -f "$_out"
}

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

api_message() { json_path error.message "$1"; }
api_code()    { json_path error.code "$1"; }

node_major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p'; }

# Password reaches node on stdin, NUL-separated, never argv.
credential_body() {
  printf '%s\0%s\0%s\0%s\0' "$1" "$2" "${3:-}" "${4:-}" | "$NODE_BIN" -e '
    const [name, password, email, accepted] = require("fs").readFileSync(0, "utf8").split("\0");
    const body = email ? {name, password, email} : {name, password};
    if (accepted === "yes") body.acceptedTerms = true;
    process.stdout.write(JSON.stringify(body));
  '
}

# Every refusal comes after ensure_node, so it must not claim nothing was installed.
nothing_installed() {
  if [ -f "$TOOLCHAIN_MARKER" ]; then
    printf 'No service has been installed. There is a private node in %s, which `--uninstall` removes.' "$TOOLCHAIN"
  else
    printf 'Nothing has been installed.'
  fi
}

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

# No arm skips the check; with no sha256 tool, refuse.
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
  curl -fsSL "$_dist/SHASUMS256.txt" -o "$TMP/node/SHASUMS256.txt" \
    || die "cannot reach $_dist — check the network, or install node $NODE_MAJOR yourself and use --node."
  _tar=$(sed -n "s/^[0-9a-f]*  \(node-v[0-9.]*-$_plat-$ARCH\.tar\.gz\)\$/\1/p" "$TMP/node/SHASUMS256.txt" | head -1)
  [ -n "$_tar" ] || die "nodejs.org publishes no $_plat-$ARCH build for v$NODE_MAJOR."
  curl -fsSL "$_dist/$_tar" -o "$TMP/node/$_tar" || die "the node download failed."
  verify_sha256 "$TMP/node/$_tar" "$TMP/node/SHASUMS256.txt" "$_tar" \
    || die "the node download does not match its published checksum. $(nothing_installed)"
  # Node's own files only, never the directory: $TOOLCHAIN also holds agent CLIs a live session may be on (Q4.114).
  mkdir -p "$TOOLCHAIN"
  for _f in bin/node bin/npm bin/npx bin/corepack lib/node_modules/npm lib/node_modules/corepack include share CHANGELOG.md LICENSE README.md; do
    rm -rf "$TOOLCHAIN/$_f"
  done
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
  # Always our own prefix: a system node's prefix needs sudo.
  [ -x "$_npm" ] || _npm=$(command -v npm 2>/dev/null || true)
  [ -n "$_npm" ] || die "no npm beside $NODE_BIN, so pnpm cannot be installed."
  mkdir -p "$TOOLCHAIN"
  : > "$TOOLCHAIN_MARKER"
  # Not corepack: it downloads pnpm at first use, making `pnpm install` a network dependency.
  PATH="$(dirname -- "$NODE_BIN"):$PATH" "$_npm" install -g --no-fund --no-audit \
    --prefix "$TOOLCHAIN" "pnpm@$PNPM_VERSION" >/dev/null 2>&1 \
    || die "could not install pnpm $PNPM_VERSION."
  PNPM_BIN="$TOOLCHAIN/bin/pnpm"
  [ -x "$PNPM_BIN" ] || die "pnpm installed but $PNPM_BIN is not executable."
  note "pnpm          $PNPM_VERSION"
}

ensure_git() {
  if [ "$PLATFORM" = darwin ] && ! xcode-select -p >/dev/null 2>&1; then
    # A bare git here opens a modal GUI dialog that a piped script cannot show.
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

check_script_binary() {
  command -v script >/dev/null 2>&1 && return 0
  warn "note: \`script\` is not on PATH, so signing an agent in from the app will not work."
  warn "      It comes with util-linux on Linux and with the base system on macOS."
}

probe_instance() {
  http_request GET "$CP/v1/instance"
  case "$HTTP_STATUS" in
    200) : ;;
    000) die "cannot reach $CP.

  Check the address and the network. $(nothing_installed)" ;;
    *)   die "$CP answered $HTTP_STATUS to GET /v1/instance, so it is not a Reemoat control plane
  (or it is behind something that answered for it)." ;;
  esac
  INSTANCE_JSON="$HTTP_BODY"
  REG_ENABLED=$(json_path registration.enabled "$INSTANCE_JSON")
  REG_EMAIL=$(json_path registration.requiresEmail "$INSTANCE_JSON")
  REG_LEGAL=$(json_path legal.documents "$INSTANCE_JSON")
  SOURCE_URL=$(json_path source.url "$INSTANCE_JSON")
  SOURCE_VERSION=$(json_path source.version "$INSTANCE_JSON")
  note "control plane $CP (${SOURCE_VERSION:-?})"
}

# /v1/login answers every failure alike on purpose; do not try to tell them apart.
sign_in() {
  _name=$(tty_ask "  username or email")
  [ -n "$_name" ] || die "no username given."
  _pass=$(tty_secret "  password")
  [ -n "$_pass" ] || die "no password given."
  _body=$(credential_body "$_name" "$_pass")
  http_request POST "$CP/v1/login" "$_body"
  case "$HTTP_STATUS" in
    200) SESSION_TOKEN=$(json_path token "$HTTP_BODY"); AUTH="$SESSION_TOKEN"; return 0 ;;
    429) die "too many sign-in attempts. $(api_message "$HTTP_BODY")" ;;
    # 000 is no answer and carries no error.message; never report it as a refused password.
    000) die "lost $CP while signing in. $(nothing_installed)" ;;
    *)   die "sign-in refused: $(api_message "$HTTP_BODY")" ;;
  esac
}

# No polling: /v1/login throttles after five 401s, so one attempt per keypress, capped at five.
wait_for_confirmation() {
  _name="$1"; _pass="$2"; _email="$3"
  say ""
  say "  Link sent to $_email. Open it, then press Enter."
  _tries=0
  while [ "$_tries" -lt 5 ]; do
    _tries=$((_tries + 1))
    tty_ask "  Enter when done" "" >/dev/null
    _body=$(credential_body "$_name" "$_pass")
    http_request POST "$CP/v1/login" "$_body"
    case "$HTTP_STATUS" in
      200) SESSION_TOKEN=$(json_path token "$HTTP_BODY"); AUTH="$SESSION_TOKEN"; say "  signed in."; return 0 ;;
      429) die "the control plane is rate-limiting sign-ins. $(api_message "$HTTP_BODY")

  Wait, then re-run this installer and choose \"sign in\"." ;;
      000) warn "  could not reach $CP just then. Press Enter to try again." ;;
      *)   warn "  not confirmed yet (or the password is wrong) — the server does not say which." ;;
    esac
  done
  die "still not signed in after five tries, and five is the whole budget before
  this control plane starts blocking sign-ins for the account you just made.

  Open the link, then sign in to the Reemoat app pointed at $CP and add a
  machine there — or re-run this with --api-key once you have one."
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
  _accepted=""
  if [ "$REG_LEGAL" = true ]; then
    say ""
    say "  Before creating an account, please read:"
    note "Terms of Use            $CP/terms"
    note "Acceptable Use Policy   $CP/acceptable-use"
    note "Privacy Policy          $CP/privacy"
    _agree=$(tty_ask "  type yes to agree to all three")
    [ "$_agree" = yes ] || die "sign-up needs agreement to the terms; nothing was created. $(nothing_installed)"
    _accepted=yes
  fi
  _body=$(credential_body "$_name" "$_pass" "$_email" "$_accepted")
  http_request POST "$CP/v1/register" "$_body"
  case "$HTTP_STATUS" in
    201)
      SESSION_TOKEN=$(json_path token "$HTTP_BODY"); AUTH="$SESSION_TOKEN"
      note "account       created"
      return 0 ;;
    200) wait_for_confirmation "$_name" "$_pass" "$_email"; return 0 ;;
    403) die "this control plane is not taking sign-ups. Ask whoever runs it for an account." ;;
    000) die "lost $CP while creating the account. $(nothing_installed)" ;;
    *)   die "sign-up refused: $(api_message "$HTTP_BODY")" ;;
  esac
}

# Least authority first: an enrollment code is one machine, an API key the whole account.
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
  if [ "$REG_ENABLED" = true ]; then
    _pick=$(menu "Who are you on it?" "Sign in" "Create an account" "API key" "Setup code")
  else
    _pick=$(menu "Who are you on it?" "Sign in" "API key" "Setup code")
    # Without the register row, picks 2 and 3 shift up one; matched as strings so a non-number never reaches arithmetic.
    case "$_pick" in 2 | 3) _pick=$((_pick + 1)) ;; esac
  fi
  case "$_pick" in
    1) sign_in ;;
    2) register ;;
    # Used for one enrollment code, then dropped: never written to the env file.
    3) API_KEY=$(tty_secret "  API key"); AUTH="$API_KEY" ;;
    4) ENROLL_CODE=$(tty_secret "  setup code") ;;
    # An empty answer (the menu's subshell died) must never fall through to create_machine.
    *) die "nothing was chosen." ;;
  esac
}

dir_flag() {
  case "$CHECKOUT" in
    "$HOME/srv/reemoat") : ;;
    *) printf " --dir '%s'" "$(printf '%s' "$CHECKOUT" | sed "s/'/'\\\\''/g")" ;;
  esac
}

sanitize_label() {
  _in=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-')
  _in=$(printf '%s' "$_in" | sed 's/^[^A-Za-z0-9]*//' | cut -c1-64)
  case "$_in" in
    "") _in=laptop ;;
    # Both arms of MACHINE_LABEL_RESERVED in the control plane's machines.ts; deploycheck drives both widths off that regex.
    m_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] | \
    m_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) _in="$_in-1" ;;
  esac
  printf '%s' "$_in"
}

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

# Before the clone and pnpm install, so a machine_limit 409 arrives before minutes of downloads.
create_machine() {
  if [ -n "$ENROLL_CODE" ]; then
    [ -n "$LABEL" ] || LABEL=$(sanitize_label "$(uname -n)")
    return 0
  fi
  [ -n "$LABEL" ] || LABEL=$(sanitize_label "$(uname -n)")
  if [ "$TTY_OPEN" = 1 ] && [ "$ASSUME_YES" != 1 ]; then
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
        _url=$(json_path controlPlaneUrl "$HTTP_BODY")
        # Judged like a typed address: it is written into the env file the daemon dials for good.
        [ -z "$_url" ] || adopt_origin "$_url" "the control plane named an address that is not an http(s) origin"
        [ -n "$ENROLL_CODE" ] || die "the control plane created $MACHINE_ID but sent no enrollment code."
        note "machine       $LABEL"
        return 0 ;;
      409)
        case "$(api_code "$HTTP_BODY")" in
          machine_exists)
            [ "$TTY_OPEN" = 1 ] || die "you already have a machine called \"$LABEL\". Pass --label <other>."
            warn "  you already have a machine called \"$LABEL\"."
            # Checked, never sanitize_label'd: a typed name is refused, not rewritten.
            while :; do
              _typed=$(tty_ask "  another name")
              if ( check_label "$_typed" ) 2>/dev/null; then LABEL="$_typed"; break; fi
              ( check_label "$_typed" ) 2>&1 | head -1 >&2 || true
            done ;;
          # Never retried: the server's sentence is the answer, a limit of zero included.
          *) die "$(api_message "$HTTP_BODY")" ;;
        esac ;;
      403)
        case "$(api_code "$HTTP_BODY")" in
          password_change_required)
            die "this account has to change its password before it can add a machine.

  Sign in at $CP/ , set a password, then run this again." ;;
          *) die "refused: $(api_message "$HTTP_BODY")" ;;
        esac ;;
      401) die "that credential was refused: $(api_message "$HTTP_BODY")" ;;
      000) die "lost the control plane while adding the machine. $(nothing_installed)" ;;
      *)   die "the control plane answered $HTTP_STATUS: $(api_message "$HTTP_BODY")" ;;
    esac
  done
}

# /sessions/current, because /sessions/:id sits behind requirePasswordCurrent. Best-effort.
revoke_session() {
  [ -n "$SESSION_TOKEN" ] || return 0
  http_request DELETE "$CP/v1/me/sessions/current" "" "$SESSION_TOKEN" || true
  SESSION_TOKEN=""
}

resolve_ref() {
  [ -z "$GIT_REF" ] || return 0
  if [ -n "$SOURCE_VERSION" ] && git ls-remote --tags "$REPO_URL" "v$SOURCE_VERSION" 2>/dev/null | grep -q .; then
    GIT_REF="v$SOURCE_VERSION"
    return 0
  fi
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
    # A partial clone rather than a shallow one: deploy.sh fetches and resets later.
    git clone --filter=blob:none --quiet -- "$REPO_URL" "$CHECKOUT" || die "the clone failed."
  fi
  if [ -n "$GIT_REF" ]; then
    git -C "$CHECKOUT" checkout --detach --quiet "$GIT_REF" || die "no such ref in $REPO_URL: $GIT_REF"
    note "version       $GIT_REF"
  else
    _head=$(git -C "$CHECKOUT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || printf '')
    if [ -n "$_head" ]; then
      git -C "$CHECKOUT" checkout --detach --quiet "$_head" || die "could not check out $_head."
    fi
    note "version       $(git -C "$CHECKOUT" rev-parse --short HEAD)"
  fi
}

install_dependencies() {
  note "deps          installing (~220 MB, a minute or two)"
  ( cd "$CHECKOUT" && PATH="$(dirname -- "$NODE_BIN"):$(dirname -- "$PNPM_BIN"):$PATH" \
      "$PNPM_BIN" install --frozen-lockfile ) || die "pnpm install failed. Nothing has been started."
}

# Installs only the harnesses --install-agents names; a failure warns rather than dies. Must run before hand_off.
# The env file carries the same --agent-source and --agent-channel; the refresh re-applies the channel, so one it lacked would be undone (Q4.115).
install_agents() {
  [ -n "$INSTALL_AGENTS" ] || { note "agents        none installed; open the app and press Install"; return 0; }
  _only=""
  _rest=$INSTALL_AGENTS
  while [ -n "$_rest" ]; do
    _one=${_rest%%,*}
    [ "$_one" = "$_rest" ] && _rest="" || _rest=${_rest#*,}
    [ -z "$_one" ] || _only="$_only --only $_one"
  done
  note "agents        installing ${INSTALL_AGENTS} (a few minutes)"
  # Node's directory in front: agents.sh's npm installs need npm and node, which may not be on PATH yet.
  # shellcheck disable=SC2086 # `_only` is a built argument list, deliberately split.
  ( PATH="$(dirname -- "$NODE_BIN"):$PATH" "$CHECKOUT/deploy/agents.sh" --source "$AGENT_SOURCE" --channel "$AGENT_CHANNEL" $_only ) || warn "
  some agent CLIs could not be installed. Open the app and press Install to try
  again. The lines above say which and why."
}

# Through lib.sh's set_env and its sq quoting, never by hand. lib.sh is passed as $0, which is the bare `sh` under curl | sh.
write_env_file() {
  # The code arrives on stdin, never argv, and is read before lib.sh is sourced.
  printf '%s' "$ENROLL_CODE" | sh -c '
    set -eu
    _code=$(cat)
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
    set_env REEMOAT_CONTROL_PLANE  "$1"     "$_env"
    set_env REEMOAT_ENROLL_CODE    "$_code" "$_env"
    # Only the non-default is written, so an env file says what somebody chose and
    # nothing else; the daemon reads an absent value as `vendor`, and an absent
    # channel as `latest`.
    if [ "$2" = npm ]; then set_env REEMOAT_AGENT_SOURCE npm "$_env"; fi
    if [ "$3" = stable ]; then set_env REEMOAT_AGENT_CHANNEL stable "$_env"; fi
    printf "%s" "$_env"
  ' "$CHECKOUT/deploy/lib.sh" "$CP" "$AGENT_SOURCE" "$AGENT_CHANNEL" > "$TMP/envpath" \
    || die "could not write the daemon's environment file."
  ENV_FILE=$(cat "$TMP/envpath")
  note "settings      $ENV_FILE"
}

# A real env file first is what makes install.sh non-interactive: its interview is gated on the file matching the example.
hand_off() {
  note "service       installing"
  # PATH prefixed so runtime_path bakes our node into the unit; </dev/null so nothing reads the rest of our download.
  PATH="$(dirname -- "$NODE_BIN"):$(dirname -- "$PNPM_BIN"):$PATH" \
    "$CHECKOUT/deploy/install.sh" daemon --non-interactive </dev/null \
    || die "deploy/install.sh could not install the service."
  if [ "$PLATFORM" = linux ] && command -v loginctl >/dev/null 2>&1; then
    # A --user unit stops at the last logout; linger is attempted, never escalated.
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 \
      || warn "note: the daemon will stop when you log out. To keep it running:
      sudo loginctl enable-linger $(id -un)"
  fi
}

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
  note "uninstall     curl -fsSL $CP/install.sh | sh -s -- --uninstall$(dir_flag)"
}

# Asked before a credential. Re-enrolling is never the default: it mints a second machine row and spends a slot.
existing_install() {
  _env="${REEMOAT_ENV_FILE:-$HOME/.reemoat/daemon.env}"
  [ -f "$_env" ] || return 1
  _bound=$(sed -n "s/^REEMOAT_CONTROL_PLANE='\{0,1\}\([^']*\)'\{0,1\}.*/\1/p" "$_env" | tail -1)
  [ -n "$_bound" ] || return 1
  [ "$AGENT_SOURCE_GIVEN" = 0 ] || die "already set up here, so --agent-source changes nothing.
      Set REEMOAT_AGENT_SOURCE=$AGENT_SOURCE in $_env and restart the daemon,
      or run $CHECKOUT/deploy/agents.sh --source $AGENT_SOURCE now."
  [ "$AGENT_CHANNEL_GIVEN" = 0 ] || die "already set up here, so --agent-channel changes nothing.
      Set REEMOAT_AGENT_CHANNEL=$AGENT_CHANNEL in $_env and restart the daemon: its refresh
      re-applies that file's channel five minutes after a start and daily after that. To move
      claude now rather than in five minutes, also run $CHECKOUT/deploy/agents.sh --channel $AGENT_CHANNEL;
      on its own, the next daily run puts the env file's channel back."
  say ""
  if [ "$TTY_OPEN" != 1 ]; then
    die "already set up here, joined to $_bound.
      $CHECKOUT/deploy/deploy.sh   # update
      curl -fsSL $CP/install.sh | sh -s -- --uninstall$(dir_flag)   # remove"
  fi
  case "$(menu "Already joined to $_bound." "Leave it" "Update" "Add as a second machine")" in
    1) exit 0 ;;
    2) update_existing || die "the update did not finish. Nothing else changed."
       exit 0 ;;
    3) tty_confirm "Adds a second machine and spends a slot." && return 1
       exit 0 ;;
    # An unanswered menu must not fall through: return 1 here means enroll another machine.
    *) exit 130 ;;
  esac
}

update_existing() {
  [ -d "$CHECKOUT/.git" ] || die "there is a service here but no checkout at $CHECKOUT.

  Point --dir at the checkout it was installed from."
  say ""
  say "updating $CHECKOUT"
  # Its status is returned: `existing_install || true` suppresses set -e.
  "$CHECKOUT/deploy/deploy.sh" --service daemon || return 1
}

do_uninstall() {
  _env="${REEMOAT_ENV_FILE:-$HOME/.reemoat/daemon.env}"
  _stopped=1
  if [ -d "$CHECKOUT/deploy" ]; then
    sh -c '
      set -eu
      . "$0"
      svc_uninstall daemon
    ' "$CHECKOUT/deploy/lib.sh" || _stopped=0
  elif [ ! -f "$_env" ]; then
    say "no checkout at $CHECKOUT and no $_env, so the install never reached the service; nothing to stop."
  else
    _stopped=0
    warn "note: no checkout at $CHECKOUT, so the service could not be stopped through lib.sh."
  fi
  # --purge is refused while the daemon may be running: it deletes worktrees an agent may be editing.
  if [ "$_stopped" = 0 ]; then
    warn "note: could not confirm the service is stopped."
    [ "$PURGE" = 1 ] && die "refusing --purge while the daemon may still be running.
  Stop it, then re-run."
  fi
  # Only a toolchain this script created, and only once the unit is gone: the unit runs the node inside it.
  if [ "$_stopped" = 1 ] && [ -f "$TOOLCHAIN_MARKER" ]; then
    rm -rf "$TOOLCHAIN"
    say "removed      $TOOLCHAIN"
  fi
  say ""
  if [ "$PURGE" = 1 ]; then
    tty_say "--purge deletes:"
    tty_say "  ${REEMOAT_DB:-$REEMOAT_HOME/reemoat.db}   sessions and their history"
    tty_say "  $CHECKOUT"
    _copies=$(ls -1 "$REEMOAT_HOME/worktrees" 2>/dev/null | sed 's/^/  /')
    if [ -n "$_copies" ]; then
      tty_say ""
      tty_say "and these working copies, which may hold uncommitted work:"
      tty_say "$_copies"
    fi
    # The desktop app's per-server daemons live here too and _stopped cannot see them, so they are named (Q7.148, Q7.149).
    _servers=$(ls -1 "$REEMOAT_HOME/servers" 2>/dev/null | sed 's/^/  /')
    if [ -n "$_servers" ]; then
      tty_say ""
      tty_say "and the desktop app's daemons for these other servers and accounts, each with its own sessions and working copies:"
      tty_say "$_servers"
      tty_say "Quit Reemoat first: it may be running these right now."
    fi
    tty_say ""
    tty_confirm "delete $REEMOAT_HOME and $CHECKOUT?" || die "nothing was deleted."
    rm -rf "$REEMOAT_HOME" "$CHECKOUT"
    say "removed      $REEMOAT_HOME"
    say "removed      $CHECKOUT"
  else
    say "left alone, because this is your data:"
    note "$_env"
    note "${REEMOAT_DB:-$REEMOAT_HOME/reemoat.db}   sessions and their history"
    note "$REEMOAT_HOME/worktrees                   working copies, possibly with uncommitted work"
    # `if`, never `[ … ] && note`: a false list as a function's last command ends the run under set -e.
    if [ -d "$REEMOAT_HOME/servers" ]; then
      note "$REEMOAT_HOME/servers                     the desktop app's daemons for other servers and accounts"
    fi
    note "$CHECKOUT"
    say ""
    note "to delete them too: re-run with --uninstall --purge"
  fi
  say ""
  say "the machine row is still in your fleet. Retire it in Settings -> Machines"
  say "if you are not coming back to this host."
  [ "$_stopped" = 1 ] || die "
  the service was NOT removed: there is no checkout at $CHECKOUT to stop it
  through, or stopping it failed. $TOOLCHAIN was left alone, because the unit
  still runs the node inside it.

  Re-run with --dir <the checkout it was installed from>."
}

main() {
  parse_flags "$@"
  open_tty
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/reemoat-install.XXXXXX") || die "cannot make a temporary directory."
  # Revoked on exit too, so an interrupt does not leave a live session credential behind.
  trap 'restore_tty; revoke_session; rm -rf "$TMP"' EXIT
  trap 'restore_tty; revoke_session; rm -rf "$TMP"; exit 130' INT TERM

  detect_platform
  # Checked before any request, since under --yes there is no prompt to correct it at.
  [ -z "$LABEL" ] || check_label "$LABEL"
  # Before resolve_control_plane: uninstalling never needs a control plane.
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
  install_agents

  write_env_file
  hand_off

  verify_running || die "
  the service is installed but did not come up. The log is where the reason is."
  summary
}

main "$@"
