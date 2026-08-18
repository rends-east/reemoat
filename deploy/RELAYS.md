# Running more than one relay

`deploy/README.md` describes the fleet as three services, one of which is *"one
relay, beside the API"*. This is what changes when that stops being true, and —
more importantly — **what has to be decided before the first daemon enrolls**,
because one of those decisions cannot be redone without visiting every machine.

## Read this before you open the service to anybody

Two values are written into every daemon's own database at enrollment and never
asked about again. The daemon makes exactly one request to the control plane,
ever; there is no env override on the daemon side and no route that re-issues
them.

| Baked at enrollment | Where it lands | Changing it later costs |
|---|---|---|
| `REEMOAT_CP_RELAY_URL` | `identity.relay_url` | re-enrolling **every** machine |
| `REEMOAT_CP_ISSUER` | `identity.issuer` | re-enrolling **every** machine |

Re-enrolling is a single-use code typed on the host by whoever owns it. For one
machine that is a minute. For a hundred it is a hundred conversations.

So, before opening access:

- **`REEMOAT_CP_RELAY_URL` must be a name you control, over `https://`.** Not an
  IP, not the host's own name. A name can be re-pointed at a load balancer, at a
  different box, at ten boxes; an IP cannot. TLS is not optional either — the
  relay is `node:http` with no TLS of its own, and the tunnel carries every
  request including each caller's `Authorization` header. Put a TLS proxy in
  front and give it that name.

  **`https://`, never `wss://`, even though the tunnel is a WebSocket.** The
  browser is handed this value and probes it with `fetch(new URL("/health",
  base))`, which rejects a `wss:` URL outright — and `streamUrl` derives the
  socket scheme itself, turning anything that is not `https:` into a
  **plaintext** `ws:` connection carrying `?token=`. So the scheme that looks
  more secure is the one that both breaks reachability and downgrades the
  stream. `.env.example` says `https://relay.example` and it is right.
- **Never change `REEMOAT_CP_ISSUER`.** The default is fine. It is compared
  against `iss` on every token by every daemon.

Everything else in this document is a change you can make on a Tuesday.

## The shape

One name for daemons, and **one extra name per relay you add** — not one per
relay, which is the difference that decides how much of this costs anything.

Daemons and browsers do not use the same paths. A daemon dials exactly
`TUNNEL_PATH`, which is the literal `/__relay/tunnel` and is sent by nothing else
in this system; browsers use every other path. So the shared name can be split by
path, and the relay that is already there keeps the browser-facing origin it
already has:

```
   https://relay.example/__relay/tunnel   ──►  relay-1 │ relay-2   (daemons; balanced)
   https://relay.example/*                ──►  relay-1            (browsers on relay-1)
   https://r2.example/*                   ──►  relay-2            (browsers on relay-2)
                             │
                    the same SQLite file
```

```
REEMOAT_CP_RELAY_URLS=relay=https://relay.example,relay-2=https://r2.example
```

The rule on the proxy is the **exact path** `/__relay/tunnel`, not the prefix
`/__relay/` — `/__relay/health` lives under it and belongs to whichever relay you
are asking about.

Why it is worth arranging that way rather than giving both relays fresh names:
every machine already on relay-1 keeps answering at the origin its browsers
already hold, so the only new origin in the fleet is `r2.example`, and it can be
put in front of the browser before any machine is on it (see step 1). A plain
balancer in front of everything works too, and costs one extra name plus the
transition below.

**Daemons never learn there is more than one.** They dial `relay.example`,
whichever relay accepts them records its own `REEMOAT_CP_RELAY_ID` in
`relay_tunnels.relay_id`, and that is the whole of their involvement. Adding a
relay costs the fleet nothing and no daemon reconnects because of it.

⚠ **A load balancer here holds long-lived WebSockets.** The tunnel pings every
20 s and gives up after two misses, so an idle timeout below ~40 s will cut
tunnels that are perfectly healthy, and the daemon will redial into the same
timeout for ever.

**Browsers must reach the relay that actually holds the machine.** The map of
live tunnels is in-memory per process: a request that lands on relay B for a
machine held by relay A answers `503 no_tunnel`. The client drops its route
belief on that code and re-probes, so it recovers — but **not transparently**:
only `token_expired` is retried in place, and `isReplayable` gates transport
retry to `GET`/`DELETE`, so a prompt or a permission answer fails outright and
the machine flips offline for a retry interval. With N relays behind one name
that is one request in N. `REEMOAT_CP_RELAY_URLS` is what stops it being a coin
flip, and it is why the map has to exist before the second relay does.

## What each relay needs

**The API** switches to `external`, which is what makes it read presence from
the table instead of from its own memory. This is the API's setting and no relay
reads it — leave it `embedded` and the map below is silently inert, because an
embedded API holds the tunnels itself and can only ever route to itself. It
warns at startup if you do.

```
REEMOAT_CP_RELAY_MODE=external      # on the API
```

**Each relay** needs one value of its own:

```
REEMOAT_CP_RELAY_ID=relay-2         # unique per relay, and stable
```

⚠ **This cannot come from the shared `env_file`**, or every relay reads the same
id. **A relay that finds its id already held by a live process refuses to
start** — so this is a mistake you cannot make quietly, but it is still a
mistake that stops a relay coming up. Put the id in a per-service
`environment:` block.

```
another relay already owns the id "relay" on this database (last seen 2s ago).
  Two relays under one id delete each other's presence rows every 5s, so the
  fleet flaps between reachable and offline. Give this one its own
  REEMOAT_CP_RELAY_ID — and its own entry in REEMOAT_CP_RELAY_URLS, or the
  machines it holds fall back to the shared relay name. See deploy/RELAYS.md.
  If that relay is gone rather than running, this clears itself 20s after its
  last heartbeat.
```

`REEMOAT_CP_RELAY_ID` is a **slot**, not a process. A relay restarted under the
same id clears its own rows at boot and reclaims them; a relay that dies leaves
rows behind that go stale after 20 s and read as absent from then on.

The claim is released on `SIGTERM`, so an ordinary deploy reclaims the name with
no wait — measured. Only a *hard* kill costs the 20 s window, and the refusal
says how long is left.

And the API needs to know where browsers reach each of them:

```
REEMOAT_CP_RELAY_URL=https://relay.example
REEMOAT_CP_RELAY_URLS=relay-1=https://r1.example,relay-2=https://r2.example
```

`http://` or `https://` only — refused at startup otherwise, for the reason
given at the top.

An id with no entry falls back to `REEMOAT_CP_RELAY_URL` — the same coin flip it
had before, rather than a missing field a client is not typed for. That is a
degradation, not a design; fill the map.

## The order of operations

The routing must exist **before** the second relay, not after. A second relay
with an unconfigured map makes the fleet slower and nothing else.

1. **Write the whole map first, while there is still one relay**, and restart the
   API. Map the existing relay's id — `relay`, the default — to the name its
   browsers already use, and add the second relay's future name beside it:

   ```
   REEMOAT_CP_RELAY_URLS=relay=https://relay.example,relay-2=https://r2.example
   ```

   Nothing about routing changes: every machine is on slot `relay` and therefore
   still answers with `https://relay.example`. What *does* change is the
   `Content-Security-Policy` on the document, which `connectOrigins` builds from
   `relayUrl` plus **every** value in the map — including slots no tunnel is on.

   ⚠ **That is the whole reason this is step 1 rather than part of step 3.** The
   CSP is computed once and travels with the HTML, so a tab loaded before the map
   existed carries a policy naming only the old origin. The moment `POST
   /v1/tokens` hands that tab `https://r2.example`, the browser refuses its own
   request — and a CSP violation has **no HTTP status**, so `meansMachineGone`
   never fires, `forgetRoute` never runs, and the machine reads offline until
   somebody reloads. Naming `r2.example` before any machine can be on it means
   every tab has already been served a policy that admits it.

   ⚠ **`deploy.sh` will not do this.** It reads no environment file at all — its
   restart decision comes from the git diff and the image fingerprint — so a run
   after an env-only change prints `control-plane: pid … (unchanged)`, which
   reads exactly like success. Restart it the way `deploy.sh` itself would:

   ```
   deploy/compose.sh up -d --force-recreate --no-deps control-plane
   ```

   Not a bare `up -d`, which recreates the relay too and drops every tunnel.

   The API is already `external` in the tracked `compose.yml`, so there is
   nothing to switch. If yours is not, this is the step to do it in.

2. **Point the name at the split.** `/__relay/tunnel` to both relays, everything
   else to relay-1, and `r2.example` to relay-2. Nothing is on relay-2 yet, so
   this changes nothing for anybody and is a step you can undo by editing the
   proxy back.

3. **Add the second relay.** Same image, its own `REEMOAT_CP_RELAY_ID=relay-2` in
   its own `environment:` block — *not* the shared `env_file` — and its own
   published port, since `compose.yml` pins 7889 on the host. The API needs no
   restart: the map already names it. The existing relay is untouched, and
   daemons begin landing on the new one as they reconnect.

   ⚠ **`deploy.sh` will never touch it.** `SERVICES` is the literal
   `daemon control-plane relay` and both `valid_service` and `compose_service`
   refuse anything else, so relay-2 is outside the restart loop, outside
   `wait_healthy`, and outside the image-fingerprint recreate. **It will go on
   running the old image after every deploy** — including one that migrates
   `schema.sql`, which `deploy.sh`'s own comments call out as the skew that fails
   at runtime rather than at start. Recreating it belongs in your runbook beside
   `deploy.sh`, not instead of it. Every deploy will also print
   `Found orphan containers`; nothing in `deploy/` passes `--remove-orphans`, so
   that is noise rather than a threat.

   ⚠ `deploy/docker/compose.yml` ships exactly two services and `deploy/lib.sh`'s
   `compose_service` refuses any other name, so there is nowhere in the tracked
   compose file for a third. Editing it also makes `deploy/deploy.sh` refuse to
   run, because it requires a clean tree — and `.gitignore` does not cover
   `compose.override.yml`, so an override *inside* the checkout is an untracked
   file that stops every deploy. It has to live outside the repository (or in a
   second compose project), and `deploy/compose.sh` will not find it by itself:
   it passes an explicit `-f`, which suppresses compose's own override discovery.
   A second `-f` before the subcommand reaches docker
   (`deploy/compose.sh -f /abs/relay-2.yml up -d relay-2`), and that is a
   hand-typed command rather than anything `deploy.sh` will run for you.

   ⚠ The YAML anchor `x-cp-common` does not cross files, so an override must
   either re-declare image, build, `env_file`, volumes, `read_only`, `tmpfs`,
   `cap_drop`, `security_opt`, `logging`, `command` and `healthcheck`, or use
   compose `extends` against the tracked `relay` service.

   ⚠ **A relay's own `environment:` block is a place it can disagree with the
   API.** `REEMOAT_CP_MACHINES_PER_USER` is read by `quota.ts`, which runs in
   both processes — the relay refuses a machine over its owner's limit before a
   byte enters the tunnel — so a relay whose block sets it differently, or omits
   it while the API's `env_file` has it, enforces a different number. The shared
   `env_file` in the tracked compose file makes that impossible; an override that
   replaces rather than extends it does not. The remedy is not a mechanism:
   setting the value from Settings → Server settings writes a row in
   `instance_settings`, and a row beats the environment in **both** processes out
   of the one database. Set it there and the question does not arise.
4. **Let daemons drift onto it.** They will as they reconnect — a deploy, a
   laptop lid, a network change. Nothing forces them and nothing needs to.

Verify after step 3:

```bash
pnpm cpctl admin relay      # each tunnel with the relay id reporting it
```

```
relay https://relay.example
warning: relay "relay-2" holds tunnels and is not in REEMOAT_CP_RELAY_URLS —
  those machines fall back to the shared relay name, which reaches them
  only when they happen to be on the relay it points at.
m_ffeaf8c7   relay-1    up   1204s  0 active  318 proxied
m_a91b22c0   relay-2    up    331s  2 active   47 proxied
```

That warning is the whole detection story for a wrong map, and it is why the
relay id is on the listing at all. Nothing cross-checks the map against the
relays that exist — a missing entry keeps working, one request in N slowly, with
no error anywhere — so this line and the map the API prints at startup are the
two places it becomes visible.

## Where the boundary is

**Several relays on one host: supported by what is here.** They share the SQLite
file, WAL makes concurrent readers safe, and the only table a relay writes is
`relay_tunnels`.

**Several relays on several hosts: a different design, and not this one.** Every
relay reads `machines`, `users`, `grants` and the signing key's public half from
that local file on every proxied request. Spreading them across machines needs
either a replicated authorization path or asking the API per request — and the
second puts the API back on the data path, which is strictly worse than one
relay. Do not reach for a network filesystem here; SQLite over NFS is how you
corrupt the database that holds the fleet's signing key.

So the honest ceiling of this document is **one host, several processes**, and
what that buys is **fault isolation and file-descriptor headroom rather than
throughput**. The per-request cost at the relay is one Ed25519 verification and
three indexed reads, which is orders of magnitude above what a fleet of this
shape generates — the browser polls once every four seconds per machine.
Capacity is not why you would do this; measure before assuming otherwise, and
raise `ulimit -n` first, since a relay holds one socket per tunnel plus up to
three per attached browser.

## What it costs the fleet

| Action | Who notices |
|---|---|
| Adding a relay | nobody |
| Restarting the API (to read a new map) | nobody holding a session; browsers re-poll within 4 s |
| Restarting **a** relay | the daemons on that relay: ~10–45 s of reconnecting, in-flight requests fail, approvals tapped during the window are lost |
| Restarting **all** relays | the whole fleet, the same way |
| A machine **moving** between relays | that machine's browsers, once: `503 no_tunnel`, then a re-resolve |
| Introducing a **new browser origin** | every tab loaded before it, until they reload — see step 1 |

The last two are the ones this table used to omit, and they are the two that only
exist once there is more than one relay.

A move is what happens whenever a daemon redials — a deploy, a lid, a network
change — and it lands wherever the balancer sends it. The browser is holding the
*old* relay's URL, so the next request is refused; `settleAnswer` reads
`no_tunnel`, drops the route memo **and re-asks the control plane where the
machine is**, which is what makes the recovery one round trip rather than "until
the token happens to need renewing". (Before that re-ask it was up to 210 s of a
machine drawn offline whose daemon was fine, with the 15 s retry loop aimed at
the relay that had already said no.)

`deploy/deploy.sh` already keeps the API and the relay apart — it recreates the
relay only when the image moved **and** `RELAY_INPUTS` matched the diff. With
several relays, restart them one at a time; there is no coordination between
them and nothing to drain, because a daemon that loses its tunnel simply redials
the shared name and lands wherever.

## One thing that is deliberately not solved

**Supersede is per relay.** "Newest tunnel wins" is enforced inside a
`TunnelRegistry`, which is one process. If a daemon reconnects and lands on a
different relay than the one that still holds its previous tunnel, the old relay
keeps that dead socket until its ping tick notices — 20 s × 2 misses.

What stops that mattering is a rule on the row rather than a signal between the
processes: `relay_tunnels.machine_id` is a primary key, and the heartbeat may
only write a row that is **already its own or older than the tunnel it is
describing**. A stale relay carries the earlier `connected_at` and loses; a
genuine redial carries a later one and wins, which is also how a lost
registration write repairs itself.

That predicate is load-bearing and was not always there. Without it the old
relay's five-second flush reclaimed the row from the relay that actually held
the machine, for up to forty seconds, and then its own `down` — scoped to a
`relay_id` it had just re-stamped — deleted the live relay's row. Invisible while
there was one relay, which is why it survived until the column acquired a
reader.

What is genuinely unsolved is only the dead socket itself, which costs one file
descriptor on the old relay until its ping tick. If that ever needs solving, the
place is a cross-relay signal on registration.
