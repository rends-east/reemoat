#!/bin/sh
# deploy/install.sh <daemon|control-plane> [--non-interactive]
#
# Sets up *one* service on this machine, and asks you the questions it cannot
# answer for you. `deploy/deploy.sh` handles every update afterwards.
#
# One service per invocation, never both at once, because that is the shape of
# the thing: a host running only the daemon must not acquire a control-plane unit
# it will never start, and a VPS running only the control plane must not acquire a
# daemon one. Asking for both is two commands, and the second is the unusual case.
#
# **It is a wizard when a person runs it and a plain installer when a script
# does.** With a terminal on both ends it walks the whole way — settings, unit,
# start, and the fleet wiring that used to be a checklist in a README: the
# control plane hands back its one-time admin key and can register this host and
# mint an enrollment code, and the daemon spends that code without anybody
# copying it. Without a terminal it does what it always did: writes the
# environment file from the example, stops, and says what to fill in. That
# fallback is not a leftover — it is what keeps this callable from CI later, and
# `--non-interactive` forces it.
#
# Idempotent: re-running re-renders the unit, which is how a moved repository or
# a changed node install is picked up, and leaves an existing environment file
# alone.
set -eu

# shellcheck source=deploy/lib.sh
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

usage() {
  echo "usage: deploy/install.sh <daemon|control-plane> [--non-interactive]" >&2
  echo >&2
  echo "  daemon         owns agent sessions on this host; runs them as you" >&2
  echo "  control-plane  identity, relay and the web UI; one per fleet" >&2
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

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
#
# Checked per service, and only what that service actually needs. Failing here is
# the point: every one of these otherwise surfaces later as a supervisor
# restarting something every ten seconds, or — worse for the daemon — as a session
# that fails at its first prompt, after a worktree has already been made.

# node is needed on *every* host regardless of backend, because `http_ok` falls
# back to it when curl is absent and `json_field` uses it outright. What it is no
# longer needed *for*, on a control-plane host, is running the service.
NODE_BIN=$(resolve_bin node "$SERVICE")

if [ "$(service_backend "$SERVICE")" = unit ]; then
  # `engines` is >=24 because node:sqlite needs --experimental-sqlite on 22, and
  # the daemon opens a database at startup. Checked only for a service this host
  # actually runs: the control plane's node is the one inside its image, pinned
  # by the Dockerfile, and refusing to install it because the *host's* node is
  # old would be refusing over a version nothing reads.
  NODE_MAJOR=$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
  if [ "$NODE_MAJOR" -lt 24 ]; then
    echo >&2
    echo "node $NODE_MAJOR is too old: the daemon requires >= 24." >&2
    echo "  node:sqlite is behind --experimental-sqlite before 24, and it" >&2
    echo "  opens a database before it serves anything." >&2
    exit 2
  fi

  # tsx is what actually runs the daemon — there is no build step. Its absence
  # means dependencies were never installed in this checkout.
  TSX="$REPO_ROOT/node_modules/.bin/tsx"
  if [ ! -x "$TSX" ]; then
    echo >&2
    echo "dependencies are not installed in this checkout." >&2
    echo "  run: (cd $REPO_ROOT && pnpm install --frozen-lockfile)" >&2
    exit 2
  fi
else
  # The control plane's only runtime requirement on this host. Its dependencies,
  # its node and its web bundle are all inside the image, which is why this host
  # needs neither pnpm nor a populated node_modules.
  DOCKER_BIN=$(resolve_bin "${REEMOAT_DOCKER:-docker}" "$SERVICE")
  if ! "$DOCKER_BIN" compose version >/dev/null 2>&1; then
    echo >&2
    echo "docker is present but 'docker compose' is not." >&2
    echo "  the control plane ships as a compose stack; the v1 'docker-compose'" >&2
    echo "  binary is not a substitute. Install the compose plugin." >&2
    exit 2
  fi
fi


# Checked here, and the value deliberately discarded: `render_unit` resolves git
# again when it builds the unit's PATH. What this line buys is the precondition —
# a host with no git fails now rather than at its first `deploy.sh`, which is the
# run that has already done `git reset --hard` by the time it would find out.
resolve_bin git "deploy/deploy.sh" >/dev/null

ENV_FILE=$(env_file "$SERVICE")
ENV_EXAMPLE=$(env_example "$SERVICE")
ENV_IS_NEW=0

if [ -f "$ENV_FILE" ]; then
  echo "  environment:  $ENV_FILE (existing, left alone)"
else
  ENV_DIR=$(dirname -- "$ENV_FILE")
  # 0700 on the directory, not merely 0600 on the file — the same discipline the
  # databases beside it are held to, and for the same reason: what protects a
  # secret is the directory, because anything writing a temporary file next to it
  # does so under its own umask.
  #
  # **Only a directory this script created.** `REEMOAT_ENV_FILE` is a documented
  # override, so an unconditional `chmod 700 "$(dirname …)"` is `chmod 700 /etc`
  # when somebody points it at `/etc/reemoat.env` — silently swallowed as an
  # ordinary user by the `2>/dev/null || true` it used to carry, and succeeding
  # under the sudo that a system-wide install invites. A directory that was already
  # there belongs to somebody else, so it is reported rather than re-permissioned.
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
  ENV_IS_NEW=1
fi


# Where a unit goes when it is rendered but deliberately not installed.
#
# **Outside the directory the supervisor scans.** `launchd.plist(5)` says a plist
# is "expected" to have a name ending in `.plist` — a documented convention, not a
# promise — so a `<label>.plist.pending` sitting in `~/Library/LaunchAgents` is one
# launchd change away from being loaded, and the entire point of staging is that
# nothing can start it. This directory is ours and nothing scans it.
# Only a unit-backed service has one. **A container needs no decoy**, and that is
# not a gap: the thing that would crash-loop is a container, and a container that
# was never created cannot be started by anything. The hazard the staging
# defends against does have a twin — `restart: unless-stopped` means the docker
# daemon brings the stack back at boot, exactly as launchd bootstraps every plist
# at login — so the rule is unchanged in substance ("never start a stack whose
# env file is still the example"); it simply no longer needs a file to enforce it.
#
# What is genuinely lost is that the staged unit was *inspectable*. The
# equivalent is `deploy/compose.sh config`, which is better because it is the
# real thing fully interpolated, and worse because you have to know to run it —
# so the unconfigured branch below prints it.
STAGED_UNIT=""
if [ "$(service_backend "$SERVICE")" = unit ]; then
  STAGED_UNIT="$(dirname -- "$ENV_FILE")/$(basename -- "$(unit_target "$SERVICE")").pending"
fi

# ---------------------------------------------------------------------------
# The interview
# ---------------------------------------------------------------------------
#
# Only on a fresh environment file. Re-running against a configured machine is a
# way to re-render a unit, and re-asking settled questions there would invite
# somebody to change one by accident.

# Which address a listener is published on, chosen from what this host actually
# has.
#
# **`0.0.0.0` is on the menu, last among the addresses and labelled with what it
# does.** It was briefly removed on the reasoning that a wildcard offered as a
# menu item is a wildcard somebody picks; it is a legitimate answer — a host
# behind its own firewall, a VPS where the operator wants every interface — and
# hiding a supported configuration behind "type it yourself" is a worse trade
# than showing it plainly and saying the cost. Choosing it prints that cost.
#
# What it is *not* is the second option, which is where it used to sit: ahead of
# every real address, one keystroke from the default, on the port carrying
# `/v1/admin/*` and behind it the key that mints every token in the fleet.
#
# The list is built from `host_addresses` rather than from one guess, because the
# guess was wrong on the machine this was written on — `lan_address` answers with
# the default-route interface, and the address this fleet is reached on belongs
# to a ZeroTier `feth`. A server may have any number of interfaces and the
# operator is the only one who knows which one is meant.
#
# Manual entry is last and always present: an address may simply not be up yet.
# ZeroTier and Tailscale attach late, which is exactly why the ztproxy unit on
# this machine carries `KeepAlive` — so a picker that could only offer what is
# up right now would be unusable on the hosts that need it most.
pick_address() {
  _pa_prompt="$1"
  _pa_default="${2:-}"

  # Two parallel lists, index-aligned: labels for `choose`, values to return.
  # Built as newline-separated strings because POSIX sh has no arrays, and read
  # back with `sed -n "<n>p"` rather than with `set --`, which would replace this
  # script's own positional parameters.
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
  # **The web UI is not a question any more.** It is built inside the image, on
  # every build, unconditionally — which removes the longest step of this
  # interview, removes pnpm from a control-plane host's requirements, and removes
  # the entire class of "it serves the API alone and from a phone that looks
  # broken" report this block existed to prevent.

  echo
  echo "the control plane holds the key that signs every token in the fleet,"
  echo "so who can reach it is the first question."
  echo

  _host=$(pick_address "reachable from")
  # **`_PUBLISH`, not `_HOST`.** The question and its answer are unchanged; the
  # layer that enforces them moved. Inside a container a loopback bind means
  # "reachable by nobody", so the bind is pinned to 0.0.0.0 and the decision
  # lives on the host side of the published port. A separate key rather than an
  # overloaded one, because `REEMOAT_CP_HOST` still means "bind" to `pnpm cp` —
  # and one name meaning two things depending on how the process was started is
  # the failure `main.ts` already avoids by resolving its web root from its own
  # URL rather than from the working directory.
  set_env REEMOAT_CP_PUBLISH "$_host" "$ENV_FILE"
  # Keyed on the address, not on which menu row was picked. It used to be the
  # latter, and the picker becoming dynamic left the test comparing against a
  # row number that no longer means anything — `set -u` caught it as an unbound
  # variable rather than as a warning that quietly stopped firing, which is the
  # luckier of the two outcomes.
  #
  # Reachable only by typing it at the manual entry, since the menu no longer
  # offers a wildcard.
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

  # **Asked rather than inferred from the bind address**, because publishing on
  # loopback is evidence of an intention and not of a running proxy — somebody
  # reaching this over a Tailnet, or through `ssh -L`, has the same answer and no
  # proxy at all.
  #
  # What it decides is what every rate limiter here keys on. Zero ignores
  # `x-forwarded-for` outright, which is right when nothing is in front and
  # wrong behind a proxy, where it collapses every caller into one bucket and one
  # person's failed sign-ins refuse everybody else's. One is right behind a proxy
  # and wrong without one, where the header is a string the caller types: reading
  # it then hands anybody their own bucket, and lets them spell somebody else's
  # and lock that address out of signing in.
  #
  # Defaulted from the answer above because that is the likelier shape rather
  # than a derivation — the operator can say otherwise, and the runtime warns
  # either way.
  _hops_default=0
  case "$_host" in 127.0.0.1 | ::1 | localhost) _hops_default=1 ;; esac
  echo
  echo "  a reverse proxy in front of this service (nginx, Caddy, Cloudflare) is"
  echo "  what makes x-forwarded-for trustworthy. Answer 0 if nothing is in"
  echo "  front: the header is then a value the caller writes, and believing it"
  echo "  lets anybody choose — or forge — the address every rate limit counts."
  _hops=$(ask "reverse proxies of your own in front (0 = none)" "$_hops_default")
  set_env REEMOAT_CP_TRUSTED_PROXY_HOPS "$_hops" "$ENV_FILE"

  # **Not a question any more.** The relay used to be optional and this block
  # asked whether to enable it; every request to every machine goes through it
  # now, so a control plane without one is a fleet nobody can reach — and `main.ts`
  # refuses to start rather than pretend otherwise.
  echo
  echo "the relay is how every browser reaches every daemon: they dial out to it"
  echo "and hold one connection, so a machine behind NAT needs no inbound port."
  _rport=$(ask "relay port" 7889)

  # **Asked, and always written.** `REEMOAT_CP_RELAY_HOST` defaults to `0.0.0.0`
  # in `main.ts`, and this block used to write only the port and the URL — so an
  # operator who had just chosen "this machine only (127.0.0.1) — safest" for the
  # API ended the wizard with a second listener on every interface, and no line in
  # their environment file recording it. That file is the only artifact they will
  # ever re-read.
  echo
  echo "  the relay is a second listener, separate from the API above."
  if [ "$_host" = "127.0.0.1" ]; then
    echo "  the API is on 127.0.0.1; publishing this wider would undo that."
  fi
  _rhost_default=$_host
  echo "  daemons dial in to it, so loopback reaches only daemons on this host."
  _rhost=$(pick_address "relay reachable from" "$_rhost_default")

  # This is the address *daemons dial*, and it is the one value that cannot be
  # derived from a bind address alone: a wildcard bind yields http://0.0.0.0:7889,
  # which works nowhere. What it *can* be derived from is the answer to the
  # question directly above — the operator has just said which address the relay
  # is reachable on, and that is the address daemons have to dial.
  #
  # **It used to read `${_lan:-$_host}` and `_lan` is assigned nowhere in this
  # tree**, so the default was always built from `$_host` — the *API* publish
  # address — and the relay answer one prompt earlier was ignored. That is the
  # combination this interview actively steers towards: it offers "this machine
  # only (127.0.0.1) — safest" first for the API and then says the relay's
  # loopback "reaches only daemons on this host", so taking the safe default and
  # then a real interface for the relay offered `http://127.0.0.1:7889` and one
  # Enter wrote it. The relay is the only way in and `/v1/enroll` hands this URL
  # to every daemon that enrolls, which persists it — so each one dials its own
  # loopback for ever, and the remedy is not an edit here but a freshly minted
  # enrollment code per machine, codes being single-use.
  _rurl_host=$_rhost
  case "$_rhost" in
    0.0.0.0 | '*' | '::')
      # The one branch that still has to guess, because a wildcard bind is not an
      # address anybody can dial. The default-route address is the best guess this
      # host offers; `$_host` behind it, since on a single-address machine that is
      # the address the operator has already confirmed once.
      _rurl_host=$(lan_address)
      _rurl_host=${_rurl_host:-$_host}
      ;;
  esac
  # **The default offered here is the one value in this wizard that cannot be
  # taken back**, and until now it offered the worst answer available.
  #
  # `deploy/RELAYS.md` opens by saying this must be a name you control, over
  # `https://`, because it is written into every daemon's `identity.relay_url` at
  # enrollment and changing it costs a fresh single-use code typed on every
  # machine in the fleet. This prompt offered `http://<ip>:<port>` and one Enter
  # took it — and `deploycheck` *pinned* that default, so the repository's own
  # driver held the answer its own document forbids.
  #
  # Two costs, both permanent until somebody visits every host. An IP cannot be
  # re-pointed, so there is no load balancer, no second relay and no move to
  # another box without re-enrolling. And `http` is not merely unencrypted: the
  # browser derives the socket scheme from this value, so anything that is not
  # `https:` becomes a plaintext `ws:` carrying `?token=` — the credential, in
  # the clear, on the one listener that must face the internet.
  #
  # So the default is `https://` and a *name* wherever this host has one, and the
  # note below says what it is for. The IP is still offered when there is nothing
  # else to offer, because a wizard that refuses to complete on a host with no
  # DNS name is a wizard nobody can finish — but it is offered while saying what
  # it costs, which is the part that was missing.
  #
  # ⚠ **On stderr, with `ask`.** Only `ask`'s return value goes to stdout — that
  # is what makes `install.sh … | tee` work and what the `-t 1` fix was about —
  # and prompt copy on stdout would put these paragraphs inside `$(ask …)` for
  # anybody extracting it, which is exactly how `deploycheck` reads this block.
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

  # **The one product decision this wizard makes**, and it is here because it is a
  # deploy-time question: everything else on this screen is about listeners.
  #
  # SMTP is deliberately *not* asked. Its variables exist and are documented, but
  # the admin screen is the intended home — which keeps this interview short and
  # keeps a provider-chosen password out of a file `compose.sh config` prints and
  # `set_env` refuses apostrophes in.
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

  # **Generating is the recommended path, and it is recommended for a reason
  # about this file rather than about passwords.** A typed one has to be written
  # here so the container can read it on its first start — there is no other
  # channel that does not put it in `ps` — and then it stays: compose reads this
  # file on every command, `compose config` prints it, and it sits in the
  # container's environment for the life of the process, to be used once. A
  # generated one is printed to the log, scraped by the capture block below, shown
  # to the operator, and never written down.
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

  # The local control plane is offered first and only when it is actually here,
  # because that is the case where enrolling costs nothing: minting a code is an
  # admin call, and on this machine the admin key is at hand.
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
    # Renumber onto the same three branches as above, so the code below has one
    # shape rather than two.
    case "$_pick" in
      1) _pick=3 ;;
      2) _pick=2 ;;
    esac
  fi

  case "$_pick" in
    3)
      # The same 16 bytes of hex that `.env.example` and daemon.ts both tell you
      # to make with `openssl rand -hex 16`, generated through node instead —
      # node is already a hard requirement here and openssl is not, so this is
      # one fewer thing that has to be present on a host being set up.
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
      # ⚠ **The provisioning key is deliberately not asked for here**, and this
      #   branch used to ask. It is a fleet-wide credential that creates a
      #   machine for *any* user, and this is the host an agent will later run
      #   on as its owner — with their uid, their files, and `/proc/<pid>/environ`
      #   of anything this script spawns. `agentEnv`'s strip is hygiene, not a
      #   fence, and CLAUDE.md says so.
      #
      #   So the rule is: the key lives on the machine you provision *from*, and
      #   never on the machine being provisioned. What travels here is an
      #   enrollment code, which is single-use and lives an hour — the blast
      #   radius of one host rather than of the fleet.
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
      # Everything this branch does could be done by hand with two cpctl calls;
      # doing it here is the difference between a wizard and a checklist.
      #
      # **Read and validated before anything irreversible happens.**
      # `$REEMOAT_CP_URL` used to be dereferenced with no default *after*
      # `addmachine` had registered the machine and `enroll` had minted a
      # single-use code — so a hand-edited or truncated cpctl.env aborted on
      # `set -u` with the code already spent and unrecoverable, and
      # `REEMOAT_AUTH=signed` already written one line above. The admin key itself
      # is never read here: `cpctl` sources that file in its own subshell.
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

      # **One route, so nothing to ask.** This used to offer "directly, at an
      # address on this network" against "only through the relay", because a
      # machine's `baseUrl` was its whole routing policy. There is no `baseUrl`
      # any more and no direct path to choose, so the defect that block was
      # written to fix — a wizard registering a machine as relay-only while
      # `.env.example` left the daemon listening on every interface — is
      # unreachable rather than fixed. `.env.example` binds loopback by default
      # and there is no other value that would make sense.
      # **Who this machine belongs to, asked before anything irreversible.**
      #
      # A machine has an owner now, and one registered without one is the failure
      # this whole change removes: it enrolls, dials the relay, holds a tunnel, and
      # appears in nobody's list, because nothing granted it to anybody. The old
      # wizard printed `cpctl admin grant …` as a closing hint and ran it never.
      #
      # Asked *before* `addmachine`, keeping the ordering the block above fought
      # for: everything read and validated first, the single-use code minted last.
      # An admin registering a machine for somebody grants nothing new — an admin
      # can already mint an API key for any user and act as them.
      _owner=""
      _users=$(cpctl admin users --ids 2>/dev/null) || _users=""
      if [ -z "$_users" ]; then
        echo "  no users yet on that control plane."
        _person=$(ask "create one now, named" "$(id -un)")
        # **Captured once, then read field by field — never piped straight into
        # `json_field`.** `cpctl admin adduser … --json | json_field id` consumed
        # the whole object to pull one scalar out of it, and the object's other
        # field is the one-time password: minted by the control plane, stored
        # only as a hash, and destroyed here before anything could show it. The
        # line under it then said "its password was printed above", which was
        # never true on this path — `--json` prints the object and nothing else,
        # and the object went into the pipe. So the wizard created somebody with
        # no way to sign in and told the operator they had one.
        #
        # The end of this file already does it correctly (`_created` captured,
        # then `json_field` per field); this is that shape, and there is now one
        # way of reading this response rather than two.
        _created=$(cpctl admin adduser "$_person" --json) || _created=""
        _owner=$(printf '%s' "$_created" | json_field id)
        _opw=$(printf '%s' "$_created" | json_field password)
        if [ -n "$_owner" ]; then
          echo
          echo "  user:     $_owner"
          echo "  password: $_opw"
          echo "  Shown once — only hashes are stored."
          # **How they get in, said rather than implied.** `admin adduser` stopped
          # minting an API key by default, so this person has exactly one
          # credential and it is the line above: a name and a password, at the web
          # UI the control plane serves at `/`. That is the whole sign-in story,
          # and leaving it implied here is what made the old wording plausible.
          echo "  They sign in at ${_cp_url} as '$_person' with that password,"
          echo "  and change it there under Settings → Account."
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

# **"Still the example" rather than "created by this run", and the answers land
# atomically.** `ENV_IS_NEW` was set at copy time, so a Ctrl-C at any `ask` left the
# raw example in place and the *next* run took the "existing, left alone" branch,
# skipping the interview and with it the do-not-start guard below.
#
# `cmp` alone was not enough, and saying it was is what the first version of this
# comment got wrong: `ask_control_plane` writes `REEMOAT_CP_HOST` and *then* asks
# for the port, and `ask_daemon` writes three keys in a row — so an interrupt in any
# of those windows left a file that differs from the example, and the next run
# skipped everything again, this time starting a half-configured service. The
# interview therefore writes to a copy and the copy is moved into place only after
# the last question is answered, which is what makes `cmp` mean what it says.
ENV_PARTIAL="$ENV_FILE.partial"
rm -f "$ENV_PARTIAL"
# Two traps, not one list. A POSIX INT handler that merely returns lets the script
# carry on, which for a Ctrl-C in the middle of an interview is the opposite of what
# was asked for; the EXIT arm then runs a second, harmless `rm`.
# `restore_tty` first in both, because `ask_secret` turns terminal echo off and an
# interrupt taken between its two prompts would otherwise leave the operator with
# a shell that does not echo what they type — and no clue why.
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

# The "the web UI is not built" warning that used to sit here is gone with the
# question that produced it: the bundle is built inside the image, on every
# build, so there is no state in which this service starts without one.

# **Carried forward, because the interview only runs on a file that is still the
# example.** An environment file written by an older wizard says
# `REEMOAT_CP_HOST=<lan address>` and knows nothing of `REEMOAT_CP_PUBLISH`.
# Under the container the first key is inert — compose pins the bind — so the
# publish address falls back to its `127.0.0.1` default and the API and web UI
# quietly become reachable from this host only. The health probe reads the same
# defaulted key, so it probes loopback, gets a 200 and prints `health: ok`: the
# mistake is agreed with rather than caught, and the operator's phone simply
# stops connecting.
#
# The relay half is the mirror image and worse in the other direction: an
# operator who deliberately narrowed `REEMOAT_CP_RELAY_HOST` to loopback would
# find the relay published on every interface, which on Linux is a DNAT rule ufw
# cannot take back.
carry_publish() {
  # `$1` the old bind key, `$2` the new publish key. A function rather than a
  # loop over pairs, because splitting a pair with `set --` would replace this
  # script's own positional parameters.
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

# ---------------------------------------------------------------------------
# The unit, or the stack
# ---------------------------------------------------------------------------

# A container has no unit and no launchd log directory, and `unit_label` /
# `log_dir` would answer for an init system this service does not use. `NAME` is
# what the messages below say either way.
if [ "$(service_backend "$SERVICE")" = unit ]; then
  LABEL=$(unit_label "$SERVICE")
  LOG_DIR=$(log_dir)
  NAME="$LABEL"
else
  LABEL=""
  LOG_DIR=""
  NAME="the control-plane stack"
fi

# Whether the supervisor already holds a definition decides between *starting*
# this service and making it *re-read* one. Written as an `if` and not as
# `svc_installed "$SERVICE" && UNIT_EXISTED=1`, because under `set -e` an AND-list
# whose test fails is itself a failing command — the fresh-install case would kill
# the script.
UNIT_EXISTED=0
if svc_installed "$SERVICE"; then UNIT_EXISTED=1; fi

# **A unit that is not going to be started is not written where the supervisor
# looks.** launchd bootstraps every plist in `~/Library/LaunchAgents` at login, and
# the template carries `RunAtLoad`, `KeepAlive` and `ThrottleInterval 10` — so
# rendering it there and then printing "Not starting" produced exactly the
# ten-second crash-loop that message says it is avoiding, beginning at the next
# reboot, silently. systemd does not autostart an un-enabled unit, so one code path
# behaved oppositely on its two halves. Staged, the unit is still rendered and still
# inspectable, which is all the non-interactive contract promises; it is just not
# armed.
#
# The render itself lives in lib.sh so `deploy.sh` can do it too: a changed template
# used to be checked out and then take effect never, because this was the only
# renderer and nothing on the update path calls it.

if [ "$ENV_ANSWERED" = "0" ] && cmp -s "$ENV_FILE" "$ENV_EXAMPLE"; then
  echo
  case "$SERVICE" in
    daemon)
      render_unit "$SERVICE" "$STAGED_UNIT"
      echo "  unit:         $STAGED_UNIT"
      echo "                (staged, not installed — nothing will try to start it)"
      ;;
    control-plane)
      # Nothing is rendered and nothing is staged, because nothing was created:
      # a container that does not exist cannot be started by the docker daemon at
      # boot the way an armed plist can. What replaces the staged unit as the
      # thing an operator can *read* is the interpolated compose file.
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
  # A staged unit from an earlier, unconfigured run has served its purpose. Left
  # behind it is a unit frozen at the repository path and PATH of the day it was
  # written, sitting under the name "pending" beside a live one, which reads as an
  # invitation to move it into place.
  rm -f "$STAGED_UNIT"
  echo "  unit:         $TARGET"
else
  # **Refused, because the alternative is losing the fleet silently.**
  #
  # The unit read `~/.reemoat/control-plane.db`; the container reads a named
  # volume, and nothing moves one to the other. On a host that has been running
  # this service, an unguarded `up -d` therefore creates an *empty* volume,
  # `store.ts` makes a fresh database and `ensureSigningKey` mints a **new
  # Ed25519 key** — and every enrolled daemon recorded the old public key at
  # enrollment and never refreshes it. The service comes up, answers `/health`,
  # and every token in the fleet stops verifying.
  #
  # Nothing about that is loud. This is.
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

  # The image is the unit's analogue and it has to exist before anything can be
  # started. Built here rather than left to the first `deploy.sh`, so that the
  # health probe and the admin-key capture below have something to run against.
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
# The relay's own, and it is separate for one reason that is worth the variable.
#
# `START_FAILED` gates the one-time admin key capture below, and that gate reads
# "the control plane never came up, so there is no key line to wait for". A relay
# that failed to start says nothing about the control plane: the API is up, it
# minted the admin user, and it printed the key once into a log that is bounded
# (10m × 5 in compose.yml) and deleted outright by `compose down`. Folding the
# relay into `START_FAILED` therefore skipped the capture over a container that
# is not the one holding the credential — and the rerun cannot recover it,
# because `users` is no longer empty and no key is ever printed again.
#
# It still decides the exit status at the end, and it names its own logs there.
RELAY_FAILED=0

# Starting a unit and making an already-loaded one re-read itself are different
# acts, and the supervisor does not do the second for us. Without this branch the
# "re-running re-renders the unit, which is how a moved repository or a changed
# node install is picked up" promise at the top of this file was false: the new
# ExecStart landed on disk and launchd kept the definition it bootstrapped.
if [ "$UNIT_EXISTED" = "1" ]; then
  # Said before it happens, not after, exactly as `deploy.sh` does. Making a
  # supervisor re-read a unit means restarting the service, so re-running this
  # against an installed daemon is not the free idempotent act the header makes it
  # sound like: every live session comes back `interrupted` and every pending
  # approval is gone, because a permission holds a live `resolve` closure that
  # cannot be serialized.
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

# Guarded, not a plain statement. `wait_healthy` returns 1, so under `set -e` a
# 30s health timeout used to abort this script here — and everything worth doing
# comes *after* it, above all the control plane's one-time admin key, which is
# printed once, stored only as a hash, and unrecoverable if nobody reads it back.
# The failure is carried to the end instead and decides the exit status there.
if [ "$START_FAILED" = "0" ]; then
  wait_healthy "$SERVICE" || HEALTH_FAILED=1
fi

# ---------------------------------------------------------------------------
# The relay, which is the same deployment's second container
# ---------------------------------------------------------------------------
#
# Not a service this script installs on its own, and deliberately not a fourth
# question in the interview: it shares the control plane's image, its env file,
# its database and its compose project, and every value it reads was already
# asked for. What it does not share is a restart — that is the entire reason it
# is a second container, and it is `deploy.sh` that keeps them apart afterwards.
#
# Started *after* the API and probed separately, so "the relay did not come up"
# is its own line rather than a control plane that looks half-working — and it
# reports into `RELAY_FAILED` rather than `START_FAILED` for the reason written
# at that variable: `START_FAILED` is what the admin-key capture below reads as
# "there is no key line coming", and a relay that will not bind is not evidence
# about a control plane that has already printed one.
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

# ---------------------------------------------------------------------------
# The one-time admin key, and what it unlocks
# ---------------------------------------------------------------------------
#
# The control plane mints an admin user on its first start with no users, prints
# the key once, and stores only a hash. Under a supervisor that "once" goes to a
# log file — so a wizard that did not go and read it would have converted the
# documented one-time print into a credential nobody ever sees, recoverable only
# by deleting the database.

# `START_FAILED` is consulted, because neither loop exit condition below can
# fire against a container that never came up: there is no `API key:` line and no
# `listening on` line, so this burned sixty seconds of `docker compose logs` and
# then printed the hedged "if this really was that start, the key is gone"
# paragraph about a database that was never written. The bound exists so nobody
# waits a minute for something that is not coming; this is the case it missed.
if [ "$SERVICE" = control-plane ] && [ ! -f "$CPCTL_ENV" ] && [ "$START_FAILED" = "0" ]; then
  # One reader for every supervisor — `svc_log_lines` is where launchd's file,
  # systemd's journal and `docker compose logs` stop being three code paths here.
  # `$NF` works for all of them: the line is `  API key: <key>` on one,
  # journal-prefixed on another, and `--no-log-prefix` keeps it last on the third.
  #
  # **Polled, with a bound, because `up -d` returns before node has printed
  # anything.** Today's single read happens to work only because `wait_healthy`
  # burns up to 30 seconds first, and relying on that is relying on an accident.
  # The second exit condition matters as much as the first: a start against a
  # database that already has users never prints a key, and waiting the full
  # minute for one that is not coming is a minute of an operator's attention.
  #
  # **Both patterns are anchored, and the existing one was not.** `$NF` on a line
  # matching `/API key: /` takes the last field of *any* line containing that
  # substring — and `REEMOAT_CP_BOOTSTRAP_ADMIN` is operator-controlled and
  # printed one line above, so a user named `x API key: rk_evil` fed this scrape
  # whatever it liked. Anchoring to the start of the line is one character and
  # closes it.
  #
  # **And both now require a *value*, which is the half that actually broke.**
  # The old argument here was that the two markers share no substring, so neither
  # can pick up the other's value. That was true, and it was the wrong thing to
  # be arguing about: what went wrong is that a marker collided with **itself**.
  # `main.ts`'s second arm used to print `admin password: taken from
  # …_PASSWORD (not printed)` — the marker, on a line carrying no password — and
  # `$NF` duly scraped the literal `printed)`, which the block below then showed
  # the operator as their admin password. That arm is option 2 of this script's
  # own interview and `imagecheck` drives only the generated one, so nothing
  # anywhere saw it.
  #
  # It is fixed on the other side (that line reads `admin password source: ` now,
  # a different *prefix* rather than a different suffix, which a scrape anchored
  # on the old marker cannot match however it is reworded). `[^ ]+$` here is the
  # brace to that belt, and it holds because a value is one field with no spaces:
  # `generatePassword` is `randomBytes(24).toString("base64url")` and an API key
  # is `rk_` plus the same alphabet. So a marker line carrying a *sentence*
  # matches nothing at all and this scrape comes back empty — which is a case the
  # report below handles out loud, where a confidently wrong value is not.
  _key=""
  _pw=""
  _pw_src=""
  _n=0
  while [ "$_n" -lt 60 ]; do
    _log=$(svc_log_lines control-plane 400)
    _key=$(printf '%s\n' "$_log" | awk '/^ *API key: [^ ]+$/{ print $NF }' | tail -1)
    _pw=$(printf '%s\n' "$_log" | awk '/^ *admin password: [^ ]+$/{ print $NF }' | tail -1)
    # Anchored for the same reason as the two scrapes, and it is the marker that
    # says a password exists and will never be printed here.
    _pw_src=$(printf '%s\n' "$_log" | awk '/^ *admin password source: /{ print "1"; exit }')
    # **Never the key alone, which is what this used to break on.** `main.ts`
    # writes the key line and *then* the password line, so a read landing between
    # those two `console.log` calls broke out holding a key and an empty `$_pw`.
    # The window is not the microsecond between the two calls, either: it is
    # however long the container's log transport takes to make the second line
    # readable. Nothing recovers from it, because the password is
    # written *nowhere* else, not to `cpctl.env`, not to the environment file,
    # and the report below is gated on `[ -n "$_pw" ]`, so the fleet's admin
    # password was lost with no message printed at all. One more second of
    # polling is the entire cost of not doing that.
    #
    # `$_pw_src` is the other way this is satisfied and it is not a hedge: with
    # `REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD` set, that line is printed *instead*
    # of a password, so there is nothing to wait for and requiring `$_pw` would
    # spend the full minute waiting for a line that is never coming.
    if [ -n "$_key" ] && { [ -n "$_pw" ] || [ -n "$_pw_src" ]; }; then break; fi
    # The other exit: no bootstrap at all, which is every re-run. `serve`'s
    # callback fires long after the bootstrap block has finished printing, so
    # seeing this line means everything above it is already in the log.
    case "$_log" in *'listening on'*) break ;; esac
    _n=$((_n + 1))
    sleep 1
  done

  if [ -n "$_key" ]; then
    # The origin this host actually reaches the API on, not a hardcoded loopback.
    # This said "the API answers on the loopback of whatever it bound", which is
    # true for 0.0.0.0 and false for the interview's own second option — one LAN
    # address, after which cpctl talked to a port nothing was listening on.
    # `service_origin` is the one implementation of that rule now.
    # **Guarded, and this is the one call site where it is load-bearing.**
    # `service_origin` `.`-sources the env file in a subshell, so a file compose
    # accepts but `sh` will not parse — an apostrophe in a value, a UTF-8 BOM —
    # makes it exit non-zero, and a bare assignment under `set -e` would
    # terminate the script *here*: after the one-time admin key has been scraped
    # into `$_key` and before `cpctl.env` is written. The key is minted once and
    # only its hash is kept. `wait_healthy` guards the same call for the same
    # reason and deliberately returns 0, which is what lets control reach this
    # line at all.
    _cp_port=$(file_value "$ENV_FILE" REEMOAT_CP_PORT)
    _cp_port=${_cp_port:-7888}
    _cp_origin=$(service_origin control-plane) || _cp_origin=""
    _cp_origin=${_cp_origin:-http://127.0.0.1:7888}
    # `umask 077` around the write, not `chmod 600` after it: the redirect would
    # otherwise create the file at 0644 with the fleet's admin key already in it.
    # Single-quoted for the same reason set_env quotes — this file is `. `-sourced,
    # by this script and by whoever follows the hint below.
    (
      umask 077
      printf 'REEMOAT_CP_URL=%s\nREEMOAT_CP_KEY=%s\n' \
        "$(sq "$_cp_origin")" "$(sq "$_key")" >"$CPCTL_ENV"
    )
    chmod 600 "$CPCTL_ENV"
    echo
    echo "  admin API key saved to $CPCTL_ENV"
    echo
    # **A password is never written to disk here**, unlike the key beside it.
    #
    # `cpctl.env` exists because an API key printed once and lost means deleting
    # the volume — the fleet's signing key with it.
    #
    # The password used to be called "recoverable" here because the key in that
    # file could reset it. **That was never true** — `POST /v1/me/password` has
    # always required the current password whenever there is one, whichever
    # credential is presenting — and it is now visibly untrue, since no admin can
    # set anybody's password at all. What makes a lost password recoverable is a
    # confirmed address and `POST /v1/forgot`; where there is no mail, nothing
    # does. Writing it to disk would still be the wrong trade: a second durable
    # secret in a file that is `.`-sourced and exported into a container on every
    # cpctl call.
    _cp_ui=$(service_origin control-plane) || _cp_ui=""
    # **`${x:-admin}`, not `sed "s/^$/admin/"`.** That fallback could never fire:
    # `file_value` ends with `printf '%s'` and writes no trailing newline, so an
    # unset key hands sed *zero lines* rather than one empty one, sed has nothing
    # to substitute, and the message read `Sign in … as ''`. Reachable on any
    # environment file that never had the key — it is commented out in
    # `.env.example`, and `main.ts` defaults it to `admin` — i.e. exactly the case
    # the fallback was written for.
    _admin_name=$(file_value "$ENV_FILE" REEMOAT_CP_BOOTSTRAP_ADMIN)
    _admin_name=${_admin_name:-admin}
    # **Three outcomes, and the two that are not a password still say something.**
    # This block used to be one `if [ -n "$_pw" ]`, so the other two printed
    # nothing whatsoever: an operator who supplied a password was told nothing
    # about it, and an operator whose password was raced away by the loop above
    # was told nothing *at all* — no line, no warning, exit 0.
    #
    # The marker discipline `main.ts` documents applies to what this script prints
    # too, and that is why the wording below is awkward: `admin password: ` appears
    # on exactly one line here, the one carrying the password. The other two arms
    # use a different prefix rather than a different suffix, for the same reason
    # `main.ts` does — so that anything grepping this output, including a future
    # version of this file, cannot scrape a sentence and call it a credential.
    if [ -n "$_pw" ]; then
      echo "  admin password: $_pw"
      echo "    Written nowhere. Sign in at ${_cp_ui:-the control plane} as"
      echo "    '$_admin_name' and change it under Settings → Account."
      echo "    Lost it? Add an address under Settings → Account first — a"
      echo "    forgotten password is recovered by mail and by nothing else."
      echo "    No admin, including this one, can set somebody's password."
      echo
    elif [ -n "$_pw_src" ]; then
      echo "  admin password source: REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD — the"
      echo "    value you set there. It was not printed and is not shown here."
      echo "    Sign in at ${_cp_ui:-the control plane} as '$_admin_name'."
      echo "    It is only read on the very first start, and compose reads"
      echo "    $ENV_FILE on every command — remove that line once you are in."
      echo
    else
      # The key was captured and the password line never appeared. Said out loud
      # because the alternative is what this block did before: print the key,
      # print nothing about the password, and exit 0 — leaving an operator to find
      # out at the sign-in screen, with the log that held it possibly already gone
      # (`compose down` deletes it; see the note below).
      echo "  the admin password did not appear in this service's log."
      echo "    It is printed once and only its hash is stored, so if it was"
      echo "    printed at all, it is gone — and an API key cannot set a password,"
      echo "    which is a thing this installer used to claim and never could."
      echo "    Configure mail under Settings → Server settings, add an address"
      echo "    to the account, and use the reset link. Where there is no mail"
      echo "    there is no recovery: delete the account and create it again."
      echo
    fi
    # The container form first, because this host may have no workspace: the
    # control plane needs no `pnpm install`, and `pnpm cpctl` on such a host
    # silently performs one (measured: an empty node_modules went from 0 to 7
    # entries) and needs pnpm on PATH, which this role does not otherwise require.
    #
    # Both `-e` flags are load-bearing and neither is decoration. The key has to
    # cross into the container, and it is passed by *name* so it never appears in
    # `ps`. The URL has to be overridden because cpctl.env holds the address this
    # host reaches the API on — which may be a LAN address that resolves to
    # nothing from inside the namespace, where the listener is on loopback.
    echo "  use it with:"
    echo "    set -a; . $CPCTL_ENV; set +a"
    echo "    REEMOAT_CP_URL=http://127.0.0.1:${_cp_port:-7888} \\"
    echo "      $DEPLOY_DIR/compose.sh exec -T -e REEMOAT_CP_KEY -e REEMOAT_CP_URL \\"
    echo "      control-plane node --import tsx scripts/cpctl.ts admin users"
    echo "  or, on a host that also has the workspace installed:"
    echo "    set -a; . $CPCTL_ENV; set +a; pnpm cpctl admin users"
    # Said plainly, because the previous wording — "this is the copy" — was wrong
    # in the direction that matters. Reading the key back out of a log proves the
    # log holds it: on launchd that is a file this script now creates 0700 and
    # chmods 0600, and on systemd it is the journal, which most distributions also
    # forward to syslog. `log_hint` hands out a `tail` of exactly that file, which
    # is what somebody pastes into a bug report.
    #
    # **And the container's log is not a file that outlives it**, which is the
    # one way this path is worse than the launchd one it replaces. `compose down`
    # deletes the log while the volume keeps the user that makes the key
    # unmintable — so an operator who planned to go and read it later, which is
    # what the failure branch below tells them to do, can destroy the fleet's only
    # admin credential with one ordinary command. This file is the durable copy,
    # not a second one.
    echo
    echo "  note: the key is also in this container's log, which does NOT survive"
    echo "        the container. '$DEPLOY_DIR/compose.sh down' deletes it while the"
    echo "        volume keeps the user — after which the key is gone and the only"
    echo "        way back is deleting the volume. Redact it before sharing a log."
  else
    # **Said loudly, because the alternative is exit 0 with the fleet's only admin
    # credential gone.** This block used to fall through in silence, and the
    # first-person block below is gated on `$CPCTL_ENV` existing, so it fell
    # through too — install.sh printed "done." and returned success. Two realistic
    # ways in: on systemd the key is printed only on the very first start ever and
    # a 400-line window may not reach it; on launchd the log file may have been
    # rotated or removed.
    # **"No key" has two causes and only one of them is bad.** A start against a
    # database that already has users never prints one — which is every migrated
    # host, and every re-run of this script — and the existing admin key is
    # perfectly valid there. Reporting that as "the key is gone, delete the
    # volume" is not merely noise: the remedy it names destroys the fleet's
    # signing key to fix a problem that does not exist. So the service is asked
    # which case this is, rather than guessed at from the absence of a line.
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
      # Two plain lines rather than one nested printf: the escaping needed to
      # print a printf that prints newlines is exactly the kind of thing that
      # renders wrong and then cannot be copied, which is what this hint is for.
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
    # Printed rather than pointed at. Under a supervisor "where to look" was a
    # file that would still be there tomorrow; here it is a command the operator
    # may not have and a log they can destroy without meaning to, so the tail
    # goes on screen now while it still exists.
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

# The first person: **one** call, `cpctl admin adduser`, which returns a user id and
# an API key. Not a grant — a grant needs a machine, which a control plane installed
# thirty seconds ago does not have. Offered at all because a control plane with no
# users is not yet a thing anybody can log in to.
if [ "$SERVICE" = control-plane ] && interactive && [ -f "$CPCTL_ENV" ]; then
  echo
  if confirm "create the first person now" y; then
    _person=$(ask "their name" "$(id -un)")
    # No sourcing here: `cpctl` reads $CPCTL_ENV in its own subshell, so the admin
    # key never enters this script's environment or that of anything it spawns.
    # One call, two fields. The API key is the half that matters and the half
    # that is unrecoverable: like the admin key above, it is returned once and
    # only its hash is kept, and it is what this person pastes into the web UI.
    # Guarded like every other command substitution on this path: a bare
    # assignment under `set -e` would skip the deliberate diagnosis block at the
    # end of this file, which exists to say that everything above still happened
    # — including the admin key, which is captured by then.
    # **No API key, and no question about one.** `--with-key` was offered here
    # and is deleted with the route behind it: an admin may take a credential
    # away and may never issue one, and a flag that quietly kept issuing them
    # would have made that sentence true in the documentation and false in the
    # code — on the one path this installer actually drives. What it existed for
    # — a credential surviving a rollback past passwords — is now `cpctl key`,
    # which this person runs themselves once they are in.
    _created=$(cpctl admin adduser "$_person" --json) || _created=""
    _uid=$(printf '%s' "$_created" | json_field id)
    _upw=$(printf '%s' "$_created" | json_field password)
    if [ -n "$_uid" ]; then
      echo
      echo "  user:     $_uid"
      echo "  password: $_upw"
      echo "  Shown once — only hashes are stored."
      echo "  They sign in at the web UI with the name '$_person' and that password,"
      echo "  and change it there under Settings → Account."
      echo
      # No grant hint any more, and its absence is the feature: they add their own
      # machine from the web UI, which mints the enrollment code with it. The old
      # two-line hint named a command nobody ran, which is why a daemon could
      # enroll and appear in nobody's list.
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
  echo "they will see it in the web UI as soon as this daemon dials the relay."
  echo
  echo "share it with somebody else:"
  echo "  pnpm cpctl admin adduser <name>   # prints a user id and a password"
  echo "  pnpm cpctl admin grant <userId> $MACHINE_ID"
fi

# **Both of these are about a *user* unit, so neither applies to a container.**
# Printed unconditionally they were plain misinformation on the control-plane
# path: a stack under `restart: unless-stopped` is supervised by the system
# docker daemon, which is precisely why lingering and automatic login stop being
# things an operator has to know about. That is one of the few unambiguous wins
# in moving this service into an image, and saying the opposite here would have
# thrown it away.
if [ "$(service_backend "$SERVICE")" = unit ]; then
  case "$INIT_SYSTEM" in
    systemd)
      # The one genuine gap in a --user unit, and it is silent: without lingering
      # the service stops when the operator's last session ends, which on a
      # headless box is the moment they disconnect after installing it.
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

# Deferred from the start block rather than exiting there, so that a service which
# came up unhealthy still leaves behind everything this run captured — the unit,
# the admin key, the first person. The exit status is the honest part; the work
# above is not undone by it.
#
# **Two containers, two verdicts, and the logs named per verdict.** One `$SERVICE`
# line covering both sent an operator whose *relay* would not bind to read the
# control plane's log, which is answering perfectly — the same "distinct outcomes
# must not collapse into one message" rule `deploy.sh` states three times.
if [ "$START_FAILED" != "0" ] || [ "$HEALTH_FAILED" != "0" ] || [ "$RELAY_FAILED" != "0" ]; then
  echo >&2
  if [ "$START_FAILED" != "0" ] || [ "$HEALTH_FAILED" != "0" ]; then
    echo "$SERVICE is installed but is not answering." >&2
    echo "  Everything above still happened, including any credential captured." >&2
    echo "  Fix the cause, then: $DEPLOY_DIR/deploy.sh --service $SERVICE --force" >&2
    echo "  logs: $(log_hint "$SERVICE")" >&2
  fi
  if [ "$RELAY_FAILED" != "0" ]; then
    # Its own paragraph, saying what is down — the only way into any machine in
    # the fleet — and **nothing about the control plane**. Claiming "the API
    # itself is up" here reads well and is false in a state that is reachable:
    # the relay block above runs whenever the API *started*, so an API that
    # started and then failed its health probe sets HEALTH_FAILED beside this.
    # What answers that question is whether the paragraph above printed at all,
    # which is the whole reason these are two paragraphs and not one line.
    echo "the relay is not answering, so no machine in the fleet is reachable." >&2
    echo "  Everything above still happened, including any credential captured." >&2
    echo "  Fix the cause, then: $DEPLOY_DIR/compose.sh up -d --no-deps relay" >&2
    echo "  logs: $(log_hint relay)" >&2
  fi
  exit 1
fi
