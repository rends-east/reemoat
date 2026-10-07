---
paths:
  - src/relay/*
  - src/server.ts
  - packages/control-plane/src/relay/*
  - packages/web/src/stream.ts
  - packages/web/src/machine.ts
  - packages/web/src/localRoute.ts
  - src/announce.ts
  - scripts/relaycheck.ts
---

## Reachability

The control plane's **relay**, on its own port, **is the only way in.** A daemon dials
out over WSS and holds one connection; it binds `127.0.0.1` and the registry records no
address. HTTP/2 over the WebSocket, one `CONNECT` per browser connection, spliced
daemon-side to fresh loopback. The tunnel carries **opaque bytes, never parsed HTTP**,
so `server.ts`, `session.ts` and `registry.ts` know nothing of it. Q1.25.

The direct path is **deleted, not disabled**; **loopback binding is the lever**
(`REEMOAT_HOST` defaults to `127.0.0.1`, no `baseUrl` column). Q1.21. `REEMOAT_PORT`
stays 7887 for `pnpm client` and the deploy `/health` probe. The app reads the port from
the announcement, so `REEMOAT_PORT=0` works and is what it gives every daemon it runs for
a server other than `~/.reemoat/daemon.env`'s; that one keeps 7887. Q1.22, Q7.148.

**One exception: the desktop app reaches a daemon on the same computer over
loopback.** Nothing a server names is dialled, nothing is discovered, and
`localRoute.ts` answers `null` outside the shell. Q7.137. Four rules:

- **Loopback or nothing**, in `local.rs` beside `proxy.rs`; `LOOPBACK` is two literals,
  never `localhost`.
- **`aud` establishes the machine**: `proveLocal` spends one authenticated
  `GET /fs/roots`, and **any status but 401 is proof** (`403 insufficient_scope` or a
  404 comes from below the auth gate). `/health`, unauthenticated, is asked after, never before.
- **A daemon says where it is.** `src/announce.ts` writes `daemon.json` 0600 into its
  state root (`~/.reemoat`, `servers/<server>/` or `servers/<server>@<user id>/`, each
  level 0700), removed on a clean stop only if its `instanceId` is in it. The host reads
  the calling account's file, then `~/.reemoat`'s only for a server's owner or a legacy
  seat. **Never probe a port**: the probe would hand a 300s bearer to whoever won it; a
  file another uid cannot write cannot be planted. Q7.148, Q7.149.
- **`meansWrongMachine` is for the local route only** (`settleAnswer` guards
  `route.kind === "local"`): it calls `denyLocal`, **never `forgetRoute`** (back to
  loopback for ever) nor `refetchRoute` (a wasted mint). Cleared in `update()`, per
  wake.

**Cost, stated under the machine's *Direct connection* switch (Q3.686):** loopback skips
the relay's live-row reads, so a revoked grant, disabled owner or switched-off machine
works for the token's remaining life (300s + 60s). Only the uid owning `~/.reemoat` can
take it. **A Unix socket would not remove the TCP port** (`tunnel.ts`, `pnpm client`,
`deploy/lib.sh` use `127.0.0.1:<port>`) and would move the daemon leg into Rust, which
`native-shell.md` refuses. Q7.137.

## The relay process

**`REEMOAT_CP_RELAY_URL` is required** (`main.ts` refuses without it): the name daemons
dial, stored in `identity.relay_url` at enrollment, so a name, not an address; changing
it re-enrolls every machine. `REEMOAT_CP_RELAY_URLS` maps `relay_id → URL` for
**browsers**; read `deploy/RELAYS.md` before the first enrollment. `REEMOAT_RELAY=0` is
gone. Both warned about in an old env file. Q1.23, Q7.92.

**Two relays may not share `REEMOAT_CP_RELAY_ID`** (refused: `sweep` deletes rows of
this name its flush did not stamp). The slot in `relay_instances` is claimed with a
**heartbeat**, not a pid; `releaseRelayId` runs on `SIGTERM`, a hard kill waits
`RELAY_CLAIM_STALE_MS`. An id missing from the map shows as `unmapped` in
`GET /v1/admin/relay`. Q7.93.

**`new URL` says nothing about a scheme**: `RelayTunnel.dial` checks it and emits
`rejected` (`target.protocol = "ws:"` is a silent no-op on a non-special scheme);
`ws`/`wss` allowed beside `http`/`https`. Q1.47.

**Authorization is the point** (user X may reach machine Y); the cost is the control
plane permanently on the data path. Q1.24. **The relay is its own process for restart
cost**: `REEMOAT_CP_RELAY_MODE` `embedded` (default, `pnpm cp`, offline drivers) or
`external` (`compose.yml`), one relay either way, two containers sharing SQLite under
WAL on one host and a real filesystem; a remote relay was rejected. Q4.33.

**A live tunnel cannot move between processes** (no zero-downtime relay restart); only
presence can: `relay_tunnels` via `dbRelayView`, the second `RelayView`, whose staleness
**errs toward present** (a stale `true` costs a probe and a `503 no_tunnel` the client
turns into `forgetRoute()`; a stale `false` cannot be corrected). `relay_id` is a slot;
a replacement clears a dead relay's rows at boot. Q4.35.

## When a connection is down

What the client draws, and the facts it draws from, are `reach.md`'s: one pill, a body
that names what was not reached, and three facts where `cpError` stood alone (Q3.659,
Q3.707).

**One request's dead link ends no other request** (Q3.712). `forgetRoute` drops the memo
and what redials at no cost (`MachineChannel.dropRedialable`: the idle connections). A
request in flight keeps its own answer or timeout: ended, nobody could say whether a POST
arrived. Only a wake ends requests (`store.wake`, from `resume.ts` alone), and only those
dialled before its absence (`absentSince`, `abandonRoute`, `closeDialledBefore`); any
other `resume` ends none. `abandonRoute` forgets before it closes. An expired token still
closes the channel whole.

**A stream is ended by its own silence** (Q3.715). A browser socket reports a dead link
in minutes, if at all, so a stream suspected with its route is on probation: closed only
if nothing arrives within `STREAM_PROBATION_MS` (`heardAt`), then resumed from its
cursor. The poll's re-probe leaves a live one alone.

- **That close is `CLOSE_REDIAL`, this client's own code, never 1006.** Taken for a dead
  link it made the stream suspect the route in turn, and idle conversations on one
  machine redialled each other for ever. The stream dials again and asks nothing of the
  route.
- **A socket that dies after `REDIAL_NOW_AFTER_MS` live is redialled at once on the
  route it rode.** `suspectRoute` drops the idle connections only, keeps the memo, and
  does nothing to a route already forgotten. One that dies sooner, or before its hello,
  drops the memo and waits out the backoff: a hello resets the attempt count, so nothing
  else stops a daemon that greets and closes from being dialled without end.

## Invariants

**Relay**

- **The machine id comes from the credential, never a request field**, Q5.7; **routing
  is by verified `aud`, not URL**, Q5.8; **authorization precedes the stream**, and a
  refusal never increments `requestsProxied`, Q5.9.
- **Relay metadata never enters a request**: `reemoat-*` headers ride the CONNECT and
  stop at the daemon's tunnel code; `forwardHeaders` is deleted. Q5.10, Q7.143.
- **An upgrade socket gets an `error` listener first** (Node drops `socketOnError`
  before `upgrade`): first statement of `handleChannel`, before `authorize`; `main.ts`
  backstops with `uncaughtException`. Q5.11.
- **A target `new URL` rejects is answered, not held**: `listener.ts`'s `pathOf`
  answers `"/"`, reaching the retired handler's `426` before reading anything;
  `relaycheck` drives it on a raw `node:net` socket. Q1.46, Q7.143.
- **Log a path, never a URL** (`?token=`); `pathOf` exists for this. Q5.12.
- **Backoff resets on a connection that survived, not one that opened**, Q5.20; **no
  daemon is a 503, never a queue**, Q5.21 (waiting is the sending daemon's,
  `agent-messaging.md`).
- **A link capability is authorized on its row**, every refusal being the unknown
  machine's 404. `parseClaims` takes `lnk`, `src`, `srcl` all or none
  (`401 malformed_token`); `linkIsLive` needs the row live, target `aud`, source `src`, source
  live, within limit, not owner-disabled — before user and grant checks on `sub`/`aud`.
  Deleting the row is a 90-day capability's only revocation. Q1.652, Q5.121.
- **A link's streams are its own budget**: `RelayAuth.limiter` keys `sub` or
  `lnk:<id>`; `STREAM_SUBJECT_HEADER` stays the owner; past a cap is `503 no_tunnel`.
  `LinkConnectBudget` spends a token per link channel **before** tunnel lookup
  (`429 link_rate_limited`), in memory, per relay. Q5.121.
- **`421 wrong_relay`** only after authorize, only when `dbRelayView.relayFor` names
  another mapped slot, with `RELAY_URL_HEADER`; else 503. A malformed map warns in
  `relay/main.ts`, never exits. Only a linked daemon sees it and follows once. Q1.653.
- **Six tables read, two written, never on the request path.** Per request `machines`,
  `users`, `grants`, a ≤1/s-cached `signing_keys.public_jwk`; per link channel
  `machine_links` (`linkById`); on dial `machine_tunnel_keys`; `relay_tunnels` only for
  a tunnel held elsewhere while `REEMOAT_CP_RELAY_URLS` is set. Writes: `relay_tunnels`
  (register, unregister, 5s flush stamping one timestamp then sweeping this relay's older
  rows) and `machines`' four `daemon_*` columns **on dial only** (`recordDaemonBuild`,
  read by `cpctl admin fleet`); `daemon_agents` via `readAgentClisHeader` off
  `AGENT_CLIS_HEADER`, refused **whole** to `null` where `readDaemonVersionHeader` cuts
  a label, neither costing the dial. Every statement **best-effort and wrapped**: a
  `SQLITE_BUSY` on the shared 250ms timeout costs a stale row, never a tunnel. No private
  key. `reconnectDelayMs` packs a fleet's dials into a second, which `store.ts`'s
  `synchronous = FULL` docblock must say. Q4.35.
- **Newest tunnel wins; unregister is identity-checked** in map **and** row;
  `presence.down` below the guard; `closeAll` deletes explicitly. Q5.22, Q1.101.
- **CORS is `*` because there are no cookies**; `Access-Control-Allow-Credentials` is
  never sent. Preflights answered before `authorize`, never touching `requestsProxied`.
  Q5.25.

**The socket**

- **The WS is read-only**; all mutation is HTTP (`ws.send()` into a half-open socket
  succeeds silently), **a login included**. Q5.75.
- **`?token=` is the handshake's only**: `readCredential` reads it only with
  `upgrade: websocket`, keyed on the header, not the path. The relay's `readToken` reads it on both
  paths, so the daemon refuses a relayed non-upgrade query token. Q1.45.
- **Token-bounded lifetime, client rotates first**: daemon closes `4401` past
  `exp + leeway`; relay authorizes at CONNECT only; browser opens a replacement at `exp − 60s`,
  waits for `hello`, closes the old. No second timer, no re-auth over the socket. Q5.24.
  **Expiry re-checked on the ping tick**; `expiresAt` is `null` under the shared secret.
  Q5.26.
- **Rotation never rewinds the cursor**: `frame.since` takes `Math.max`.
  **`reattachSince` answers the held tail, not `lastSeq`**, when ahead of a stale row —
  in the pure function, not `openSession`. Q5.13.
- **A reconnect closes an orphaned rotation before bumping the generation**:
  `successor` cleared in three places, two behind the guard; `connect()` only with a
  dead or absent primary. Q5.92.
- **No stream without the row** (`since=0` is the largest attach): `openSession`
  declines, `attachWanted` opens it later. Q5.14.
- **Attach is one synchronous block**: no `await` between `log.read(since)` and
  `log.subscribe(...)`; `seq <= cursor` alone will not save you. Q5.52.

## Layout

| File | Holds |
|---|---|
| `src/relay/protocol.ts` | Tunnel vocabulary and `parseAgentClis`/`formatAgentClis`. Imported by the control plane, so imports nothing of the daemon's (`announcedAgentClis` lives in `tunnel.ts`) |
| `src/relay/tunnel.ts` | Daemon end: dial, h2 *server* on the dialled socket, CONNECT to loopback |
| `packages/web/src/localRoute.ts` | The only compare of an announced machine id to a wanted one; composes no URL |
| `packages/web/src/machine.ts` | One machine's token and reachability; `forgetRoute` never on an HTTP status, and never ending a request in flight; `missingRowReason` |
| `packages/web/src/stream.ts` | One session's socket: rotation, the close-code table, the cursor |
| `packages/control-plane/src/relay/main.ts` | Relay entry: mints no key, bootstraps nobody, sends no mail, does not wait for the API |
| `packages/control-plane/src/relay/listener.ts` | Tunnel path, `/__relay/channel`, `/__relay/health` (**not** `/health`); rest refused. `RELAY_CHANNEL_PATH` mirrored in `packages/web/src/e2ee.ts`, literals compared by both drivers |
| `packages/control-plane/src/relay/presence.ts` | `relay_id`, `dbRelayView`. A flush writes only a row already this relay's or a tunnel no older, because `stats()` does not test `isClosed` |
| `packages/control-plane/src/relay/authorize.ts` | Verify, then read `aud`, then check live user/machine/grant rows |
| `packages/control-plane/src/relay/registry.ts` | The authority on tunnels; mirrors into `presence.ts`, never waits. `RelayView.relayFor`: "me or nobody" |
| `packages/control-plane/src/relay/tunnel-endpoint.ts` | Authenticates *before* the WS handshake completes |
| `packages/control-plane/src/relay/proxy.ts` | Authorize, splice as **raw bytes**, parse nothing; `handleRequest`/`handleUpgrade` are `426` (`e2ee.md`) |

## Bounds

| | |
|---|---|
| Relay streams | `STREAM_WINDOW_BYTES` 1 MiB per stream, **the flow control**, granted on consumption (Q6.104). 256 per tunnel, **64 per caller** (`MAX_STREAMS_PER_SUBJECT`, verified `sub`; Q1.100), `CONNECTION_WINDOW_BYTES` 8 MiB. **4 per link**, 32 across links per tunnel (`MAX_STREAMS_PER_LINK`, `MAX_LINK_STREAMS_PER_TUNNEL`), not the owner's; 20 link channels at once then one a second (`LINK_CONNECT_BURST`, `LINK_CONNECT_REFILL_MS`). Q5.121 |
| Tunnel | `MAX_TUNNEL_BUFFERED_BYTES` 8 MiB (should be unreachable), 20s ping / 2 misses, reconnect 1s→30s **full** jitter, reset after 60s up (`TUNNEL_STABLE_AFTER_MS`) |

## Known gotchas

- **`yamux-js` has no real flow control** (window refilled on arrival); h2's
  `WINDOW_UPDATE` follows consumption. Q6.36.
- **h2 over a WebSocket needs no shim** (`http2.connect(url, {createConnection})`,
  `server.emit("connection", duplex)`); the hand-written part is replaying a 101. Q6.37.
- **`server.address()` is `null` synchronously after `serve()`**: `RelayTunnel.start`
  runs in the listening callback; `port: 0` refuses to dial. Q6.38.
- **The h2 connection window defaults to 64 KiB**: both ends call
  `setLocalWindowSize`. Q6.39.
- **A response over one stream window can wedge** (Node withholds an unread stream's
  window): `STREAM_WINDOW_BYTES` and `EVENTS_PAGE_BYTES` (768 KiB pre-gzip) are a
  **coupled pair**. Q6.104. Relayed downloads come in `DOWNLOAD_PIECE_BYTES` ranges, each
  on its own connection (`ChannelRequest.alone`); loopback is one request. Q6.120.
- **`ClientRequest.destroy()` emits no `'error'`** and `pipe` forwards no premature
  close: destroy *with* an error and check `upRes.complete` on `close`. Q6.103.
