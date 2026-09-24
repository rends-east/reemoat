#!/bin/sh
# Sets up one service on this host: a wizard with a terminal, a plain installer without one or under --non-interactive.
set -eu

# shellcheck source=deploy/lib.sh
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

usage() {
  echo "usage: deploy/install.sh <daemon|control-plane> [--non-interactive]" >&2
  echo >&2
  echo "  daemon         owns agent sessions on this host; runs them as you" >&2
  echo "  control-plane  identity and the relay; one per fleet" >&2
  exit 2
}

SERVICE=""
NON_INTERACTIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) [ -z "$SERVICE" ] || usage
      SERVICE="$1" ;;
  esac
  shift
done
[ -n "$SERVICE" ] || usage
valid_service "$SERVICE" || usage

echo
echo "installing $SERVICE"
echo "  repository:   $REPO_ROOT"
echo "  supervisor:   $INIT_SYSTEM"

NODE_BIN=$(resolve_bin node "$SERVICE")

if [ "$(service_backend "$SERVICE")" = unit ]; then
  NODE_MAJOR=$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
  if [ "$NODE_MAJOR" -lt 24 ]; then
    echo >&2
    echo "node $NODE_MAJOR is too old: the daemon requires >= 24." >&2
    echo "  node:sqlite is behind --experimental-sqlite before 24, and it" >&2
    echo "  opens a database before it serves anything." >&2
    exit 2
  fi

  TSX="$REPO_ROOT/node_modules/.bin/tsx"
  if [ ! -x "$TSX" ]; then
    echo >&2
    echo "dependencies are not installed in this checkout." >&2
    echo "  run: (cd $REPO_ROOT && pnpm install --frozen-lockfile)" >&2
    exit 2
  fi
else
  DOCKER_BIN=$(resolve_bin "${REEMOAT_DOCKER:-docker}" "$SERVICE")
  if ! "$DOCKER_BIN" compose version >/dev/null 2>&1; then
    echo >&2
    echo "docker is present but 'docker compose' is not." >&2
    echo "  the control plane ships as a compose stack; the v1 'docker-compose'" >&2
    echo "  binary is not a substitute. Install the compose plugin." >&2
    exit 2
  fi
fi


# Precondition only: a host with no git must fail now, not in its first deploy.sh after the hard reset.
resolve_bin git "deploy/deploy.sh" >/dev/null

ENV_FILE=$(env_file "$SERVICE")
ENV_EXAMPLE=$(env_example "$SERVICE")

if [ -f "$ENV_FILE" ]; then
  echo "  environment:  $ENV_FILE (existing, left alone)"
else
  ENV_DIR=$(dirname -- "$ENV_FILE")
  # Only a directory this script created is chmod'd: REEMOAT_ENV_FILE may point into a shared one such as /etc.
  if [ -d "$ENV_DIR" ]; then
    case "$(ls -ld -- "$ENV_DIR" | cut -c1-10)" in
      drwx------) ;;
      *)
        echo "  warning: $ENV_DIR already exists, is not 0700, and is about to hold"
        echo "           a credential. Not re-permissioning a directory I did not make:"
        echo "             chmod 700 $ENV_DIR"
        ;;
    esac
  else
    mkdir -p "$ENV_DIR"
    chmod 700 "$ENV_DIR"
  fi
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  environment:  $ENV_FILE (created from $(basename -- "$ENV_EXAMPLE"))"
fi


# Staged beside the env file, outside any directory the supervisor scans, so nothing can start it.
STAGED_UNIT=""
if [ "$(service_backend "$SERVICE")" = unit ]; then
  STAGED_UNIT="$(dirname -- "$ENV_FILE")/$(basename -- "$(unit_target "$SERVICE")").pending"
fi

pick_address() {
  _pa_prompt="$1"
  _pa_default="${2:-}"

  # POSIX sh has no arrays: two index-aligned newline lists, read back with sed because set -- would clobber the positional parameters.
  _pa_labels="this machine only (127.0.0.1) — safest; put a TLS proxy in front"
  _pa_values="127.0.0.1"
  _pa_route=$(lan_address)

  while IFS=' ' read -r _pa_addr _pa_if; do
    [ -n "$_pa_addr" ] || continue
    _pa_note=""
    [ "$_pa_addr" = "$_pa_route" ] && _pa_note=" — default route"
    [ -n "$_pa_default" ] && [ "$_pa_addr" = "$_pa_default" ] && _pa_note="$_pa_note — same as the API"
    _pa_labels="$_pa_labels
$_pa_addr on $_pa_if$_pa_note"
    _pa_values="$_pa_values
$_pa_addr"
  done <<EOF
$(host_addresses)
EOF

  _pa_labels="$_pa_labels
every interface (0.0.0.0) — anything that can route to this host reaches it
something else — type it (an address that is not up on this host yet)"
  _pa_values="$_pa_values
0.0.0.0
"

  # shellcheck disable=SC2046  # deliberate word splitting: one label per line
  _pa_pick=$(IFS='
'; choose "$_pa_prompt" $(printf '%s' "$_pa_labels" | sed 's/^$/ /'))
  _pa_out=$(printf '%s\n' "$_pa_values" | sed -n "${_pa_pick}p")

  if [ -z "$_pa_out" ]; then
    _pa_out=$(ask "address to publish on" "${_pa_default:-127.0.0.1}")
  fi
  printf '%s' "$_pa_out"
}

ask_control_plane() {

  echo
  echo "the control plane holds the key that signs every token in the fleet,"
  echo "so who can reach it is the first question."
  echo

  _host=$(pick_address "reachable from")
  # PUBLISH, not HOST: the in-container bind is pinned to 0.0.0.0, so this is the host side of the published port.
  set_env REEMOAT_CP_PUBLISH "$_host" "$ENV_FILE"
  case "$_host" in
    0.0.0.0 | '*' | '::')
      echo
      echo "  note: you asked for every interface, on the port that carries"
      echo "        /v1/admin/* and, behind it, the key that mints every token in"
      echo "        the fleet. On Linux a published port is a DNAT rule evaluated"
      echo "        before the chain ufw and firewalld write to, so 'ufw deny'"
      echo "        will not take it back. One interface address needs no"
      echo "        firewall to cooperate."
      ;;
  esac

  _port=$(ask "port" 7888)
  set_env REEMOAT_CP_PORT "$_port" "$ENV_FILE"

  _hops_default=0
  case "$_host" in 127.0.0.1 | ::1 | localhost) _hops_default=1 ;; esac
  echo
  echo "  a reverse proxy in front of this service (nginx, Caddy, Cloudflare) is"
  echo "  what makes x-forwarded-for trustworthy. Answer 0 if nothing is in"
  echo "  front: the header is then a value the caller writes, and believing it"
  echo "  lets anybody choose — or forge — the address every rate limit counts."
  _hops=$(ask "reverse proxies of your own in front (0 = none)" "$_hops_default")
  set_env REEMOAT_CP_TRUSTED_PROXY_HOPS "$_hops" "$ENV_FILE"

  echo
  echo "the relay is how every browser reaches every daemon: they dial out to it"
  echo "and hold one connection, so a machine behind NAT needs no inbound port."
  _rport=$(ask "relay port" 7889)

  echo
  echo "  the relay is a second listener, separate from the API above."
  if [ "$_host" = "127.0.0.1" ]; then
    echo "  the API is on 127.0.0.1; publishing this wider would undo that."
  fi
  _rhost_default=$_host
  echo "  daemons dial in to it, so loopback reaches only daemons on this host."
  _rhost=$(pick_address "relay reachable from" "$_rhost_default")

  _rurl_host=$_rhost
  case "$_rhost" in
    0.0.0.0 | '*' | '::')
      _rurl_host=$(lan_address)
      _rurl_host=${_rurl_host:-$_host}
      ;;
  esac
  # Prompt copy goes to stderr: only the answer of ask may reach stdout, which deploycheck and piping through tee rely on.
  _rurl_name=$(host_name)
  {
    echo ""
    echo "  ⚠ this is baked into every daemon at enrollment and is never asked"
    echo "    for again. Changing it later means a new enrollment code typed on"
    echo "    every machine in the fleet, by hand."
    echo "    Use a DNS name you control, over https, with a TLS proxy in front:"
    echo "    a name can be re-pointed at a load balancer or another box, an"
    echo "    address cannot. http here also downgrades the browser's WebSocket"
    echo "    to plaintext, carrying each caller's token."
  } >&2
  if [ -n "$_rurl_name" ]; then
    _rurl_default="https://$_rurl_name"
  else
    _rurl_default="http://$_rurl_host:$_rport"
    {
      echo "    (this host reports no name, so the default below is its address —"
      echo "     replace it with a name before anybody enrolls against it.)"
    } >&2
  fi
  _rurl=$(ask "URL daemons will dial" "$_rurl_default")
  case "$_rurl" in
    https://*) ;;
    *)
      echo "    note: '$_rurl' is not https. See deploy/RELAYS.md before enrolling." >&2
      ;;
  esac
  set_env REEMOAT_CP_RELAY_PUBLISH "$_rhost" "$ENV_FILE"
  set_env REEMOAT_CP_RELAY_PORT "$_rport" "$ENV_FILE"
  set_env REEMOAT_CP_RELAY_URL "$_rurl" "$ENV_FILE"

  echo
  echo "registration: whether people can create their own accounts."
  echo "  closed  — only an admin creates accounts (the default)"
  echo "  open    — anybody who can reach this control plane can sign up"
  echo
  echo "  it can be changed later under Settings → Server settings, without a"
  echo "  redeploy. With email configured a sign-up must confirm an address"
  echo "  before the account exists; without it, nothing verifies who they are."
  if confirm "allow people to sign themselves up" n; then
    set_env REEMOAT_CP_REGISTRATION_ENABLED true "$ENV_FILE"
    case "$_host" in
      0.0.0.0 | '*' | '::')
        echo
        echo "  note: this API is published on every interface and now accepts"
        echo "        sign-ups. That is the port carrying /v1/admin/*. On Linux a"
        echo "        published port is a DNAT rule evaluated before the chain ufw"
        echo "        and firewalld write to, so put a TLS proxy in front."
        ;;
    esac
  else
    set_env REEMOAT_CP_REGISTRATION_ENABLED false "$ENV_FILE"
  fi

  echo
  echo "the admin account. One admin, created on this service's first start;"
  echo "everybody else is added later, by them."
  _aname=$(ask "admin name" admin)
  set_env REEMOAT_CP_BOOTSTRAP_ADMIN "$_aname" "$ENV_FILE"

  echo
  if [ "$(choose "admin password" \
      "generate one and show it to me once (recommended)" \
      "I will type one")" = "2" ]; then
    _apw=$(ask_secret "admin password")
    set_env REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD "$_apw" "$ENV_FILE"
    echo
    echo "  note: that value stays in $ENV_FINAL, which compose reads on every"
    echo "        command. It is only used on the first start — remove the line"
    echo "        once you have signed in."
  fi
}

ask_daemon() {
  echo
  echo "how should this daemon decide who is asking?"
  echo

  _local_cp=0
  if [ -f "$CPCTL_ENV" ]; then _local_cp=1; fi

  if [ "$_local_cp" = "1" ]; then
    _pick=$(choose "identity" \
      "enroll against the control plane on this machine (recommended)" \
      "enroll against a control plane elsewhere" \
      "a shared secret — one credential, one machine, no control plane")
  else
    _pick=$(choose "identity" \
      "a shared secret — one credential, one machine, no control plane" \
      "enroll against a control plane")
    case "$_pick" in
      1) _pick=3 ;;
      2) _pick=2 ;;
    esac
  fi

  case "$_pick" in
    3)
      _token=$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')
      set_env REEMOAT_AUTH shared_secret "$ENV_FILE"
      set_env REEMOAT_TOKEN "$_token" "$ENV_FILE"
      echo
      echo "  shared secret written to $ENV_FILE"
      echo "  every client uses it. No fleet, no grants, nothing to enroll against."
      ;;
    2)
      _cp=$(ask "control plane URL" "http://127.0.0.1:7888")
      echo
      # The fleet-wide provisioning key is never asked for on the host being provisioned; only a single-use enrollment code travels here.
      echo "  this host needs an enrollment code: single-use, one hour."
      echo
      echo "  whoever will own the machine makes one in Settings → Machines."
      echo "  or an admin makes one for them, from their own machine:"
      echo "    cpctl provision <user> <name>          # with REEMOAT_CP_PROVISION_KEY"
      echo "    cpctl admin addmachine <name> --owner <userId> && cpctl admin enroll <machineId>"
      echo
      _code=$(ask "enrollment code")
      set_env REEMOAT_AUTH signed "$ENV_FILE"
      set_env REEMOAT_CONTROL_PLANE "$_cp" "$ENV_FILE"
      set_env REEMOAT_ENROLL_CODE "$_code" "$ENV_FILE"
      ;;
    1)
      # Everything is read and validated before addmachine and enroll spend anything irreversible.
      _cp_url=$(file_value "$CPCTL_ENV" REEMOAT_CP_URL)
      if [ -z "$_cp_url" ]; then
        echo >&2
        echo "REEMOAT_CP_URL is missing from $CPCTL_ENV." >&2
        echo "  That file is written by 'deploy/install.sh control-plane'. Fix or" >&2
        echo "  remove it, or choose 'enroll against a control plane elsewhere' and" >&2
        echo "  paste a code you minted by hand." >&2
        exit 2
      fi
      _name=$(ask "name for this machine in the control plane" "$(uname -n)")

      # The owner is asked before addmachine so the single-use code is minted last; registering for somebody else is its own power (Q1.631, Q7.74).
      _owner=""
      _users=$(cpctl admin users --ids 2>/dev/null) || _users=""
      if [ -z "$_users" ]; then
        echo "  no users yet on that control plane."
        _person=$(ask "create one now, named" "$(id -un)")
        # Captured once and read field by field: piping straight into json_field would discard the one-time password.
        _created=$(cpctl admin adduser "$_person" --json) || _created=""
        _owner=$(printf '%s' "$_created" | json_field id)
        _opw=$(printf '%s' "$_created" | json_field password)
        if [ -n "$_owner" ]; then
          echo
          echo "  user:     $_owner"
          echo "  password: $_opw"
          echo "  Shown once — only hashes are stored."
          echo "  They install the Reemoat app and point it at ${_cp_url},"
          echo "  then sign in as '$_person' with that password and change it"
          echo "  under Settings → Account."
          echo "  If they want a key for cpctl or a terminal, they mint their own:"
          echo "    pnpm cpctl key"
          echo
        fi
      else
        echo
        echo "  who does this machine belong to?"
        # `set --` rather than an array: this is POSIX sh.
        # shellcheck disable=SC2086  # deliberate word splitting on a controlled list
        _labels=$(printf '%s\n' "$_users" | while IFS=' ' read -r _uid _uname; do printf '%s\n' "$_uname ($_uid)"; done)
        _old_ifs=$IFS
        IFS='
'
        # shellcheck disable=SC2046
        set -- $_labels
        IFS=$_old_ifs
        _pick=$(choose "owner" "$@")
        _owner=$(printf '%s\n' "$_users" | sed -n "${_pick}p" | cut -d' ' -f1)
      fi
      if [ -z "$_owner" ]; then
        echo "could not decide who this machine belongs to" >&2
        exit 2
      fi

      _mid=$(cpctl admin addmachine "$_name" --owner "$_owner" --json | json_field id)
      if [ -z "$_mid" ]; then
        echo "could not register the machine — is the control plane running?" >&2
        exit 2
      fi
      echo "  machine: $_mid"
      _code=$(cpctl admin enroll "$_mid" --json | json_field code)
      if [ -z "$_code" ]; then
        echo "could not mint an enrollment code for $_mid" >&2
        exit 2
      fi
      echo "  enrollment code minted (single-use, one hour)"
      set_env REEMOAT_AUTH signed "$ENV_FILE"
      set_env REEMOAT_CONTROL_PLANE "$_cp_url" "$ENV_FILE"
      set_env REEMOAT_ENROLL_CODE "$_code" "$ENV_FILE"
      MACHINE_ID="$_mid"
      ;;
  esac
}

# The interview writes to a copy moved into place after the last answer, so an interrupted run leaves the example intact for the next cmp.
ENV_PARTIAL="$ENV_FILE.partial"
rm -f "$ENV_PARTIAL"
# restore_tty first because ask_secret turns echo off; the INT arm must exit, since a handler that returns lets the script carry on.
trap 'restore_tty; rm -f "$ENV_PARTIAL"' EXIT
trap 'restore_tty; rm -f "$ENV_PARTIAL"; exit 130' INT TERM

if cmp -s "$ENV_FILE" "$ENV_EXAMPLE" && interactive; then
  ENV_FINAL="$ENV_FILE"
  cp "$ENV_FILE" "$ENV_PARTIAL"
  chmod 600 "$ENV_PARTIAL"
  ENV_FILE="$ENV_PARTIAL"
  case "$SERVICE" in
    control-plane) ask_control_plane ;;
    daemon) ask_daemon ;;
  esac
  mv "$ENV_PARTIAL" "$ENV_FINAL"
  ENV_FILE="$ENV_FINAL"
  ENV_ANSWERED=1
else
  ENV_ANSWERED=0
fi

# Carries an older wizard's bind keys into the publish keys, which are what compose actually honours.
carry_publish() {
  _old=$(file_value "$ENV_FILE" "$1")
  _new=$(file_value "$ENV_FILE" "$2")
  [ -n "$_old" ] || return 0
  [ -z "$_new" ] || return 0
  set_env "$2" "$_old" "$ENV_FILE"
  echo
  echo "  note: $1 is the in-container bind now, and compose pins it."
  echo "        carried its value ($_old) into $2,"
  echo "        which is the host side of the published port and the setting"
  echo "        that actually decides who can reach this service."
}

if [ "$SERVICE" = control-plane ] && [ -f "$ENV_FILE" ]; then
  carry_publish REEMOAT_CP_HOST REEMOAT_CP_PUBLISH
  carry_publish REEMOAT_CP_RELAY_HOST REEMOAT_CP_RELAY_PUBLISH
fi

if [ "$(service_backend "$SERVICE")" = unit ]; then
  LABEL=$(unit_label "$SERVICE")
  LOG_DIR=$(log_dir)
  NAME="$LABEL"
else
  LABEL=""
  LOG_DIR=""
  NAME="the control-plane stack"
fi

# An if, not an AND-list: under set -e a failing AND-list kills a fresh install.
UNIT_EXISTED=0
if svc_installed "$SERVICE"; then UNIT_EXISTED=1; fi

# A unit that will not be started is staged, never installed: launchd loads every plist in LaunchAgents at login.

if [ "$ENV_ANSWERED" = "0" ] && cmp -s "$ENV_FILE" "$ENV_EXAMPLE"; then
  echo
  case "$SERVICE" in
    daemon)
      render_unit "$SERVICE" "$STAGED_UNIT"
      echo "  unit:         $STAGED_UNIT"
      echo "                (staged, not installed — nothing will try to start it)"
      ;;
    control-plane)
      echo "  stack:        not created (nothing will try to start it)"
      echo "                inspect what would run: $DEPLOY_DIR/compose.sh config"
      ;;
  esac
  echo
  echo "$ENV_FILE is still the example and is not filled in."
  case "$SERVICE" in
    daemon)
      echo "Not starting $SERVICE: it would fail, and the supervisor would retry it"
      echo "every 10 seconds while you read this."
      echo
      echo "Set at least REEMOAT_TOKEN — the daemon exits 2 without one:"
      echo "  echo \"REEMOAT_TOKEN='\$(openssl rand -hex 16)'\" >> $ENV_FILE"
      ;;
    control-plane)
      echo "Not starting $SERVICE: REEMOAT_CP_RELAY_URL has no default at all and"
      echo "the service refuses to start without one, because every daemon dials it."
      echo "With 'restart: unless-stopped' the docker daemon would retry it at every"
      echo "boot. Review:"
      echo "  REEMOAT_CP_RELAY_URL, REEMOAT_CP_PUBLISH"
      ;;
  esac
  echo
  echo "Then run this again, from a terminal, to be walked through the rest."
  exit 0
fi

echo
if [ "$(service_backend "$SERVICE")" = unit ]; then
  render_unit "$SERVICE"
  TARGET=$(unit_target "$SERVICE")
  rm -f "$STAGED_UNIT"
  echo "  unit:         $TARGET"
else
  _legacy_db="$HOME/.reemoat/control-plane.db"
  if [ -f "$_legacy_db" ] && [ -z "$("$DEPLOY_DIR/compose.sh" ps -aq control-plane 2>/dev/null || true)" ]; then
    _vol=$("${REEMOAT_DOCKER:-docker}" volume inspect --format '{{.Name}}' \
      "${REEMOAT_CP_VOLUME:-reemoat-cp-state}" 2>/dev/null || true)
    if [ -z "$_vol" ]; then
      echo >&2
      echo "  there is already a control-plane database at $_legacy_db," >&2
      echo "  and no volume for the container to read instead." >&2
      echo >&2
      echo "  starting now would create an empty volume, mint a NEW signing key," >&2
      echo "  and un-enroll every daemon in the fleet — while looking healthy." >&2
      echo >&2
      echo "  carry it across first: $DEPLOY_DIR/docker/README.md" >&2
      echo "  (or set REEMOAT_CP_VOLUME to a volume you have already loaded)" >&2
      exit 2
    fi
  fi

  echo "  building the control-plane image (a few minutes on a cold cache)"
  if ! "$DEPLOY_DIR/compose.sh" build; then
    echo >&2
    echo "  the image did not build. Nothing has been started." >&2
    exit 2
  fi
  echo "  image:        $(cp_image_id)"
fi

START_FAILED=0
HEALTH_FAILED=0
# Separate from START_FAILED, which gates the one-time admin key capture: a relay failure says nothing about the API.
RELAY_FAILED=0

if [ "$UNIT_EXISTED" = "1" ]; then
  if [ "$SERVICE" = daemon ]; then
    echo
    echo "  $LABEL is already installed, so this re-reads its unit — which restarts it."
    echo "  every live session becomes 'interrupted'; reattach with: pnpm client resume <id>"
  fi
  if svc_reload "$SERVICE"; then
    echo "  reloaded:     $NAME"
  else
    echo "  could not reload $NAME — see $(log_hint "$SERVICE")" >&2
    START_FAILED=1
  fi
elif svc_start "$SERVICE"; then
  echo "  started:      $NAME"
else
  echo "  could not start $NAME — see $(log_hint "$SERVICE")" >&2
  START_FAILED=1
fi

# Guarded: under set -e a health timeout would abort before the one-time admin key is captured.
if [ "$START_FAILED" = "0" ]; then
  wait_healthy "$SERVICE" || HEALTH_FAILED=1
fi

if [ "$SERVICE" = control-plane ] && [ "$START_FAILED" = "0" ]; then
  if svc_start relay; then
    echo "  started:      relay"
  else
    echo "  could not start the relay — see $(log_hint relay)" >&2
    RELAY_FAILED=1
  fi
  if [ "$RELAY_FAILED" = "0" ]; then
    wait_healthy relay || RELAY_FAILED=1
  fi
fi

if [ "$SERVICE" = control-plane ] && [ ! -f "$CPCTL_ENV" ] && [ "$START_FAILED" = "0" ]; then
  # Both scrapes are anchored and need one space-free value, so an operator-chosen name or a sentence is never taken for a credential.
  _key=""
  _pw=""
  _pw_src=""
  _n=0
  while [ "$_n" -lt 60 ]; do
    _log=$(svc_log_lines control-plane 400)
    _key=$(printf '%s\n' "$_log" | awk '/^ *API key: [^ ]+$/{ print $NF }' | tail -1)
    _pw=$(printf '%s\n' "$_log" | awk '/^ *admin password: [^ ]+$/{ print $NF }' | tail -1)
    _pw_src=$(printf '%s\n' "$_log" | awk '/^ *admin password source: /{ print "1"; exit }')
    # Wait for the password line too: it follows the key and is written nowhere else.
    if [ -n "$_key" ] && { [ -n "$_pw" ] || [ -n "$_pw_src" ]; }; then break; fi
    case "$_log" in *'listening on'*) break ;; esac
    _n=$((_n + 1))
    sleep 1
  done

  if [ -n "$_key" ]; then
    # Guarded: service_origin sources the env file and may fail, and dying here would lose the scraped one-time key.
    _cp_port=$(file_value "$ENV_FILE" REEMOAT_CP_PORT)
    _cp_port=${_cp_port:-7888}
    _cp_origin=$(service_origin control-plane) || _cp_origin=""
    _cp_origin=${_cp_origin:-http://127.0.0.1:7888}
    # umask 077 around the write so the key never exists at 0644; values single-quoted because the file is sourced.
    (
      umask 077
      printf 'REEMOAT_CP_URL=%s\nREEMOAT_CP_KEY=%s\n' \
        "$(sq "$_cp_origin")" "$(sq "$_key")" >"$CPCTL_ENV"
    )
    chmod 600 "$CPCTL_ENV"
    echo
    echo "  admin API key saved to $CPCTL_ENV"
    echo
    _cp_ui=$(service_origin control-plane) || _cp_ui=""
    _admin_name=$(file_value "$ENV_FILE" REEMOAT_CP_BOOTSTRAP_ADMIN)
    _admin_name=${_admin_name:-admin}
    # Only the line carrying a password uses the admin password marker; the other arms use a different prefix so no scrape takes a sentence.
    if [ -n "$_pw" ]; then
      echo "  admin password: $_pw"
      echo "    Written nowhere. Point the Reemoat app at ${_cp_ui:-this control plane},"
      echo "    sign in as '$_admin_name', and change it under Settings → Account."
      echo "    Lost it? Add an address under Settings → Account first — a"
      echo "    forgotten password is recovered by mail and by nothing else."
      echo "    No admin, including this one, can set somebody's password."
      echo
    elif [ -n "$_pw_src" ]; then
      echo "  admin password source: REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD — the"
      echo "    value you set there. It was not printed and is not shown here."
      echo "    Point the Reemoat app at ${_cp_ui:-this control plane} and sign in as '$_admin_name'."
      echo "    It is only read on the very first start, and compose reads"
      echo "    $ENV_FILE on every command — remove that line once you are in."
      echo
    else
      echo "  the admin password did not appear in this service's log."
      echo "    It is printed once and only its hash is stored, so if it was"
      echo "    printed at all, it is gone — and an API key cannot set a password,"
      echo "    which is a thing this installer used to claim and never could."
      echo "    Configure mail under Settings → Server settings, add an address"
      echo "    to the account, and use the reset link. Where there is no mail"
      echo "    there is no recovery: delete the account and create it again."
      echo
    fi
    echo "  use it with:"
    echo "    set -a; . $CPCTL_ENV; set +a"
    echo "    REEMOAT_CP_URL=http://127.0.0.1:${_cp_port:-7888} \\"
    echo "      $DEPLOY_DIR/compose.sh exec -T -e REEMOAT_CP_KEY -e REEMOAT_CP_URL \\"
    echo "      control-plane node --import tsx scripts/cpctl.ts admin users"
    echo "  or, on a host that also has the workspace installed:"
    echo "    set -a; . $CPCTL_ENV; set +a; pnpm cpctl admin users"
    echo
    echo "  note: the key is also in this container's log, which does NOT survive"
    echo "        the container. '$DEPLOY_DIR/compose.sh down' deletes it while the"
    echo "        volume keeps the user — after which the key is gone and the only"
    echo "        way back is deleting the volume. Redact it before sharing a log."
  else
    # No key printed: ask the database whether users exist, since every re-run legitimately prints none.
    _users=$("$DEPLOY_DIR/compose.sh" exec -T control-plane node -e '
      const {DatabaseSync} = require("node:sqlite");
      const db = new DatabaseSync(process.env.REEMOAT_CP_DB, {readOnly: true});
      process.stdout.write(String(db.prepare("SELECT COUNT(*) AS n FROM users").get().n));
    ' 2>/dev/null | tr -dc '0-9')

    if [ -n "$_users" ] && [ "$_users" -gt 0 ] 2>/dev/null; then
      echo
      echo "  no admin key was printed, and that is correct here: this database"
      echo "  already holds $_users user(s), so nothing was bootstrapped. The key you"
      echo "  already have still works."
      echo
      _origin=$(service_origin control-plane) || _origin=""
      echo "  to write $CPCTL_ENV, put your key there yourself:"
      echo "    umask 077"
      echo "    { echo \"REEMOAT_CP_URL='${_origin:-http://127.0.0.1:7888}'\"; echo \"REEMOAT_CP_KEY='rk_…'\"; } > $CPCTL_ENV"
      echo "  a person mints their own with: pnpm cpctl key"
    else
    echo >&2
    echo "  warning: could not find the admin API key in this service's log." >&2
    echo "           It is printed exactly once, on the first start with no users," >&2
    echo "           and only its hash is stored — so if this really was that start," >&2
    echo "           the key is gone." >&2
    echo >&2
    echo "           the last of what it did say:" >&2
    svc_log_lines control-plane 40 | sed 's/^/           | /' >&2 || true
    echo >&2
    echo "           If you already hold one, that person mints more with 'cpctl key'." >&2
    echo "           Otherwise the way back is deleting the control plane's" >&2
    echo "           volume and letting it bootstrap again — which destroys the" >&2
    echo "           signing key and un-enrolls every daemon in the fleet." >&2
    fi
  fi
fi

if [ "$SERVICE" = control-plane ] && interactive && [ -f "$CPCTL_ENV" ]; then
  echo
  if confirm "create the first person now" y; then
    _person=$(ask "their name" "$(id -un)")
    # cpctl sources CPCTL_ENV in its own subshell, so the admin key never enters this environment.
    _created=$(cpctl admin adduser "$_person" --json) || _created=""
    _uid=$(printf '%s' "$_created" | json_field id)
    _upw=$(printf '%s' "$_created" | json_field password)
    if [ -n "$_uid" ]; then
      echo
      echo "  user:     $_uid"
      echo "  password: $_upw"
      echo "  Shown once — only hashes are stored."
      echo "  They sign in in the Reemoat app with the name '$_person' and that"
      echo "  password, and change it under Settings → Account."
      echo
      echo "  They add their own machines from Settings → Machines."
    fi
  fi
fi

echo
echo "done. update it later with: $DEPLOY_DIR/deploy.sh --service $SERVICE"
echo "logs: $(log_hint "$SERVICE")"

if [ "$SERVICE" = daemon ] && [ -n "${MACHINE_ID:-}" ]; then
  echo
  echo "this machine is $MACHINE_ID, and it already belongs to the person you picked."
  echo "they will see it in the app as soon as this daemon dials the relay."
  echo
  # Share runs as the owner: this shell holds the admin key, and cpctl share resolves through ownedMachine.
  echo "share it with somebody else — run these as the machine's OWNER, not here:"
  echo "  pnpm cpctl admin adduser <name>   # here, as admin: prints a user id and a password"
  echo
  echo "  # then on the owner's machine, with the owner's own credential:"
  echo "  pnpm cpctl login <name>           # prints a REEMOAT_CP_KEY to export"
  echo "  pnpm cpctl share $MACHINE_ID <userId>   # <userId> is what they read off 'cpctl me'"
fi

if [ "$(service_backend "$SERVICE")" = unit ]; then
  case "$INIT_SYSTEM" in
    systemd)
      if command -v loginctl >/dev/null 2>&1 &&
        [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
        echo
        echo "warning: user lingering is off, so this unit stops when your last"
        echo "         session ends. To survive logout and reboot:"
        echo "           sudo loginctl enable-linger $(id -un)"
      fi
      ;;
    launchd)
      echo
      echo "note: a gui/ agent needs a logged-in user session. On a headless Mac,"
      echo "      enable automatic login, or the service will not come back after"
      echo "      a reboot."
      ;;
  esac
fi

# Deferred to here so an unhealthy start still keeps everything this run captured.
if [ "$START_FAILED" != "0" ] || [ "$HEALTH_FAILED" != "0" ] || [ "$RELAY_FAILED" != "0" ]; then
  echo >&2
  if [ "$START_FAILED" != "0" ] || [ "$HEALTH_FAILED" != "0" ]; then
    echo "$SERVICE is installed but is not answering." >&2
    echo "  Everything above still happened, including any credential captured." >&2
    echo "  Fix the cause, then: $DEPLOY_DIR/deploy.sh --service $SERVICE --force" >&2
    echo "  logs: $(log_hint "$SERVICE")" >&2
  fi
  if [ "$RELAY_FAILED" != "0" ]; then
    echo "the relay is not answering, so no machine in the fleet is reachable." >&2
    echo "  Everything above still happened, including any credential captured." >&2
    echo "  Fix the cause, then: $DEPLOY_DIR/compose.sh up -d --no-deps relay" >&2
    echo "  logs: $(log_hint relay)" >&2
  fi
  exit 1
fi
