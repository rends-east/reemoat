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

Daemons sit behind NAT and the browser is outside, so the control plane also runs
a **relay**, on its own port, and **it is the only way in.** A daemon dials out
over WSS at startup and holds one connection; every request is spliced onto it.
The daemon binds `127.0.0.1`, the registry records no address, and there is
nothing else to address. One tunnel carries many streams: HTTP/2 over the
WebSocket, one `CONNECT` per browser connection, spliced daemon-side to a fresh
loopback connection. The tunnel carries **opaque bytes, not parsed HTTP** — which
is why tunneling a WebSocket inside a WebSocket needed no special case, and why
nothing in `server.ts`, `session.ts` or `registry.ts` changed for it. Q1.25.

The direct path is **deleted, not disabled**, and **loopback binding is the
lever** — `REEMOAT_HOST` defaults to `127.0.0.1` and the `baseUrl` column is gone
rather than left null. Q1.21. `REEMOAT_PORT` stays 7887 because what
addresses it is on the same machine: `pnpm client` under the shared secret and the
deploy script's `/health` probe. The desktop app reads the port out of the
announcement rather than addressing one, so `REEMOAT_PORT=0` still works for a
relay-only daemon, is announced like any other, and is what the app gives every
daemon it runs for a server other than the one `~/.reemoat/daemon.env` names —
the `~/.reemoat` daemon keeps 7887 for the two above. Q1.22, Q7.148.

**There is one exception and it is not that feature coming back.** The desktop app
reaches a daemon on the **same computer** over loopback. No address a server names
is ever dialled, nothing is discovered on a network, and a browser cannot take this
path at all — `localRoute.ts` answers `null` outside the shell, because a page
served over `https:` cannot reach `http://127.0.0.1` and an arm that is dead is
better than one that is merely unused. Q7.137. Four rules bound it and each closes
a way the old direct path went wrong:

- **Loopback or nothing**, enforced in `local.rs` where the page cannot reach it —
  the same place `proxy.rs` keeps the control-plane origin. `LOOPBACK` is two
  literals and `localhost` is deliberately not one of them: a name is whatever a
  resolver says.
- **The `aud` check establishes the machine and nothing else does.**
  `proveLocal` spends one authenticated `GET /fs/roots`, and ⚠ **any status but 401
  is proof** — a `403 insufficient_scope` and a bare 404 both come from *below* the
  auth gate. Requiring 200 would refuse a healthy daemon over a scope the probe
  never needed. `/health` is asked afterwards, never before: it is unauthenticated,
  so a 200 from it is a stranger's 200.
- **A daemon says where it is; nothing guesses.** `src/announce.ts` writes
  `daemon.json` at 0600 into its state root — `~/.reemoat`, or
  `~/.reemoat/servers/<server>/` for a daemon the app runs for a second server,
  every level 0700 — and a clean stop removes it only if its own `instanceId` is
  in it. The host reads the current server's file, then `~/.reemoat`'s. Q7.148.
  ⚠ **The file is the security argument, not a convenience.** Probing a well-known port was built and
  taken back out: the probe has to carry a machine token to prove anything, so it
  hands a 300-second bearer — spendable through the relay from anywhere — to
  whichever process won the race for that port. A file another uid cannot write
  cannot be planted. It also reaches a daemon on a custom `REEMOAT_PORT`, or on `0`.
- **One 401 rule the relay candidate must not get.** `meansWrongMachine` is keyed
  on the code, and `settleAnswer` guards on `route.kind === "local"` as well —
  down the tunnel the relay has already derived the machine from the same verified
  `aud` before a byte moved, so the same code there means two services disagreeing
  about one fact. It calls `denyLocal`, ⚠ **never `forgetRoute`**, which drops the
  memo and would send the next resolve straight back to loopback for ever, and
  never `refetchRoute`, which would spend a control-plane mint on a daemon
  answering about itself. The deny is cleared in `update()`, i.e. per wake.

**What it costs, and it is stated to the person who owns the machine rather than
buried here.** The relay reads live user, machine and grant rows before each
request; loopback does not. So on this one path a revoked grant, a disabled owner
or a machine switched off keeps working for the token's remaining life — 300s plus
60s of leeway either way. Settings → Machines → *This device* says so in the
sentence beside the switch. What makes the trade defensible rather than merely
disclosed is *who* can take it: only a process running as the uid that owns
`~/.reemoat`, which already holds the database, the signing keys and every
transcript.

⚠ **A Unix socket would not remove the TCP port.** `tunnel.ts` splices every
*relayed* stream to `127.0.0.1:<port>`, and so do `pnpm client` and
`deploy/lib.sh`'s `/health` probe. It would also move the whole daemon leg into
Rust, which `native-shell.md` refuses for four separate reasons. Q7.137.

`REEMOAT_CP_RELAY_URL` is therefore **required** and `main.ts` refuses to start
without it. It is the name **daemons** dial, written into each one's
`identity.relay_url` at enrollment and never asked about again, so it must be a
name rather than an address: changing it costs a re-enrollment of every machine.
`REEMOAT_CP_RELAY_URLS` is the *other* question — `relay_id → URL`, where a
**browser** reaches each relay — and `deploy/RELAYS.md` has to be read before the
first daemon enrolls rather than when a second relay is wanted. `REEMOAT_RELAY=0`
is gone for the mirror reason: opting out of the relay is opting out of being
reachable, which is not a configuration. Both are warned about when left in an
old env file. Q1.23, Q7.92.

**Two relays cannot share a `REEMOAT_CP_RELAY_ID`, and that is a refusal rather
than advice** — `sweep` deletes rows carrying this relay's name that its own
flush did not stamp. A relay claims its slot in `relay_instances` at boot and
refuses a name a live process holds, with a **heartbeat** rather than a pid
because a relay runs in a container where `pid` and `os.uptime()` mean nothing.
`releaseRelayId` runs on `SIGTERM`, so an ordinary deploy reclaims the name with
no wait and only a hard kill pays `RELAY_CLAIM_STALE_MS`. A relay id with no
entry in `REEMOAT_CP_RELAY_URLS` is silent rather than destructive and gets
visibility instead: `GET /v1/admin/relay` reports `unmapped`. Q7.93.

**A relay URL is *validated* by `new URL` in three places and that decides
nothing about its scheme**, so `RelayTunnel.dial` checks the scheme itself and
emits `rejected` rather than assigning over it — `target.protocol = "ws:"` is a
silent no-op for a scheme the URL spec does not call special. `ws`/`wss` are
allowed beside `http`/`https`, because a URL already stored that way must still
dial. Validating the scheme where it is *claimed* to be validated is still not
done. Q1.47.

**Authorization is the point** — what ngrok and Cloudflare Tunnel cannot do is
know that user X may reach machine Y. The cost, stated plainly: the control plane
is permanently on the data path, and an outage there costs *all* reachability.
Q1.24.

**The relay is its own process, and the reason is restart cost rather than
scale.** `REEMOAT_CP_RELAY_MODE` decides which process listens: `embedded` is one
process and stays the default (`pnpm cp`, every offline driver), `external` is
what `compose.yml` pins. There is still exactly one relay in both modes. **Two
containers then share one SQLite file, and WAL is what makes that safe** — the
same host and a real filesystem, which is why a relay on another machine is a
*different* design and was rejected. Q4.33.

**A live tunnel cannot be moved out of a process, and only its presence can** —
`child.send(socket)` passes the fd and none of the TLS keys, h2 stream tables,
flow-control windows or ws framing state, so there is no handoff and no
zero-downtime relay restart. What *is* writable is `relay_tunnels`, read through
`dbRelayView`, the second implementation of the `RelayView` interface `app.ts`
already took, with a **staleness window that errs toward *present***: a stale
`true` costs one probe and a `503 no_tunnel` every client turns into
`forgetRoute()`, while a stale `false` draws a reachable machine as offline with
nothing to correct it. `relay_id` is a slot rather than a process, so a dead
relay's rows are cleared by its replacement at boot. Q4.35.

## Invariants

**Relay**

- **The relay derives a machine id from the credential; it is never a request
  field.** No header, query parameter or handshake field names a machine, so this
  cannot be reopened by a convenience parameter. Q5.7.
- **The relay routes by the verified `aud` claim, not by the URL.** Q5.8.
- **Authorization happens before a stream is opened, never after.** A refused
  request must not increment `requestsProxied`. Q5.9.
- **The relay's own metadata never enters a request, and this is structural now
  rather than a strip.** `reemoat-*` headers ride the CONNECT handshake and stop at
  the daemon's tunnel code. There is no proxied request for one to enter:
  `forwardHeaders` is deleted with the plaintext path, and a client's bytes are
  ciphertext the relay cannot open let alone edit. Q5.10, Q7.143.
- **An upgrade socket gets an `error` listener before anything else.** Node
  removes its own `socketOnError` *before* emitting `upgrade`, so the raw socket
  starts with zero listeners. It is the first statement of `handleChannel`, before
  `authorize`, because the refusal paths write to that socket too; `main.ts`
  carries an `uncaughtException` backstop. Q5.11.
- **A request target the HTTP parser accepts and the WHATWG URL parser rejects is
  answered, not held.** An unguarded `new URL` throw escaped the `'request'` emit
  before anything wrote a response or destroyed the socket — one leaked fd per
  unauthenticated line, against the only ingress this system has. `listener.ts`'s
  own `pathOf` catches it and answers `"/"`, which now lands on the retired
  plaintext handler and its `426` **before reading anything at all** — a stronger
  guarantee than the `401 missing_token` it replaced, which had to run `readToken`
  on the way to its refusal. `relaycheck` drives it on a raw `node:net` socket,
  `fetch` and `ws` both normalizing the target away. Q1.46, Q7.143.
- **The relay logs a path, never a URL** — the credential arrives as `?token=`,
  and a *refusal* path leaks a cryptographically intact one. `pathOf` exists for
  this. Q5.12.
- **Reconnect backoff is reset by a connection that survived, not one that
  opened.** Q5.20.
- **A tunnel with no daemon is a 503, never a queue.** Q5.21.
- **The relay reads four tables and writes two, and never on the *request*
  path.** `machines`, `users`, `grants` and a ≤1/s-cached `signing_keys.public_jwk`
  per proxied request; `machine_tunnel_keys` on dial. The writes are
  `relay_tunnels`, on register, on unregister and on a 5s flush; and `machines`'
  four `daemon_*` columns, **on dial only** — `recordDaemonBuild`, which is what
  `cpctl admin fleet` reads back. The fourth is `daemon_agents`, the CLI
  inventory off `AGENT_CLIS_HEADER`, read by `readAgentClisHeader` under
  `readDaemonVersionHeader`'s rule with one difference: a list is refused
  **whole** to `null` where a label is cut, because a list cut mid-entry stores a
  version nothing reports. Neither refusal costs the dial. Both are **best-effort, every statement
  wrapped**, because a `SQLITE_BUSY` against the 250ms timeout the two processes
  share must cost one stale row rather than reach a tunnel's lifecycle. The flush
  stamps everything live with one timestamp and sweeps this relay's rows older
  than it. It holds no private key. Q4.35.
  ⚠ **"Never on the request path" is still true and is now the whole of the
  claim** — a dial is not a request, but it is not an administrative act either,
  and `reconnectDelayMs` puts a whole fleet's dials inside one second after a
  relay restart. That is what `store.ts`'s `synchronous = FULL` docblock has to
  say out loud rather than describing these writes as occasional.
- **Newest tunnel wins, and unregister is identity-checked** — in the map **and**
  in the row. `presence.down` is called *below* the guard, and `closeAll` deletes
  explicitly because clearing the map makes every later `unregister` a no-op.
  Q5.22, Q1.101.
- **CORS is `*` because there are no cookies**, and
  `Access-Control-Allow-Credentials` is never sent. The relay answers preflights
  *itself*, before `authorize` — a preflight carries no token and therefore no
  `aud`, and must never touch `requestsProxied`. Q5.25.

**The socket**

- **The WS is read-only.** Everything that mutates state is an HTTP request,
  because `ws.send()` into a half-open socket succeeds silently. This is also why
  **a login is driven over HTTP**. Q5.75.
- **`?token=` is the handshake's exception, and only the handshake's.**
  `readCredential` reads the query only when `upgrade: websocket` is present —
  keyed on the handshake header rather than on the stream route's path, because a
  route reader fails open the day it falls behind. **The relay is deliberately not
  narrowed the same way**: its `readToken` reads the query on both paths, so a
  relayed non-upgrade request with a query token is authorized at the relay and
  then refused by the daemon. Q1.45.
- **A socket's lifetime is bounded by its token, and the client rotates first.**
  The daemon closes `4401` past `exp + leeway`; the relay authorizes at CONNECT and
  never tears a live stream down; the browser opens a replacement at `exp − 60s`,
  waits for its `hello`, then closes the old one. Three parties, one rule, and it
  holds because nobody added a second timer. Re-authenticating over the socket must
  not be added. Q5.24.
- **The WS re-checks expiry on the ping tick**, or a 5-minute token buys an
  unbounded-lifetime connection. `expiresAt` is `null` under the shared secret.
  Q5.26.
- **A make-before-break rotation never rewinds the cursor.** `frame.since` takes
  `Math.max`, never assignment — the replacement captures `since` when *opened*
  while the old socket keeps delivering through the handshake, and a contiguous
  replay is invisible to the hole check. The same skip is why **`reattachSince`
  answers the held tail rather than the row's `lastSeq`** when the transcript is
  ahead of a poll-stale row; that correction belongs in the pure function, not in
  a `Math.max` at `openSession`. Q5.13.
- **A reconnect closes an orphaned rotation before it bumps the generation.**
  `successor` is cleared in three places, two behind the generation guard.
  `connect()` is only ever reached with a dead or absent primary, so it cannot
  cancel a healthy rotation. Q5.92.
- **A stream is never opened without the row that says where to attach.** Falling
  back to `since=0` is not a smaller attach, it is the largest there is.
  `openSession` declines with no row, and `attachWanted` opens it when the list
  lands. Q5.14.
- **Attach is one synchronous block.** No `await` between `log.read(since)` and
  `log.subscribe(...)`: an append lands strictly in the backlog or strictly
  through the listener, which is the entire reason resume has no gaps and no
  duplicates. The `seq <= cursor` filter alone will not save you. Q5.52.

## Layout

| File | Holds |
|---|---|
| `src/relay/protocol.ts` | The tunnel's shared vocabulary: version, handshake headers, close codes, bounds — and the one grammar of the CLI inventory, `parseAgentClis`/`formatAgentClis`, so the daemon's spelling and the relay's reading cannot drift. Imported by the control plane — the one-way rule still holds, which is why it may import nothing of the daemon's; `announcedAgentClis`, which needs `AGENT_IDS` and the runtime, lives in `tunnel.ts` |
| `src/relay/tunnel.ts` | The daemon's end: dial out, run an h2 *server* on the socket it dialled, splice each CONNECT to loopback, reconnect with full jitter |
| `packages/web/src/localRoute.ts` | Whether a daemon on *this computer* may be reached without the relay: the off list, and the one place an announced machine id is compared to a wanted one. Composes no URL — `base` arrives finished from the host |
| `packages/web/src/machine.ts` | One machine's token and reachability. `forgetRoute` drops the belief that it is up, never on an HTTP status. Also `missingRowReason` |
| `packages/web/src/stream.ts` | One session's socket: rotation before expiry, the close-code table, the cursor |
| `packages/control-plane/src/relay/main.ts` | The relay's entry point, the second deployment of this package. Mints no signing key, bootstraps nobody, sends no mail, does not wait for the API |
| `packages/control-plane/src/relay/listener.ts` | The dispatcher both entry points share: the tunnel path, `/__relay/channel`, `/__relay/health` — emphatically **not** `/health`, that being the daemon's on the far side of a tunnel — and everything else to a refusal. `RELAY_CHANNEL_PATH` is declared here and mirrored in `packages/web/src/e2ee.ts`, with both drivers comparing the literals |
| `packages/control-plane/src/relay/presence.ts` | The only writable part of a tunnel, including which relay holds it (`relay_id`, read by `relayFor`). Its heartbeat predicate is load-bearing: a flush may write a row only if it is already this relay's *or* describes a tunnel no older, because `stats()` does not test `isClosed`. Plus `dbRelayView` |
| `packages/control-plane/src/relay/authorize.ts` | May this caller reach this machine. Verify, then read `aud`, then check live user/machine/grant rows |
| `packages/control-plane/src/relay/registry.ts` | Which machines hold a tunnel, and how to open a stream down one. The authority; it mirrors transitions into `presence.ts` and never waits on one. `RelayView.relayFor` answers only "me or nobody" |
| `packages/control-plane/src/relay/tunnel-endpoint.ts` | Where daemons dial in. Authenticates *before* the WS handshake completes |
| `packages/control-plane/src/relay/proxy.ts` | The app-facing half: authorize, then splice a WebSocket to a CONNECT stream as **raw bytes**. It parses nothing — `handleRequest` and `handleUpgrade` are `426` refusals now, and the HTTP client, the 101 replay, `forwardHeaders` and the CORS preflight are deleted with the plaintext path. `.claude/rules/e2ee.md` |
| `scripts/relaycheck.ts` | Offline driver: framing, flow control, authorization ordering, CORS preflight, a WebSocket through the tunnel |

## Bounds

| | |
|---|---|
| Relay streams | `STREAM_WINDOW_BYTES` of h2 window per stream — 1 MiB, raised from 256 KiB as the coupled half of `EVENTS_PAGE_BYTES` (Q6.104), and **this is the flow control**, granted on consumption. 256 concurrent streams per tunnel, **64 per caller** on one tunnel (`MAX_STREAMS_PER_SUBJECT`), 8 MiB connection window (`CONNECTION_WINDOW_BYTES`). The per-caller share is keyed on the verified `sub` — the same value that rides `STREAM_SUBJECT_HEADER` and confers nothing there — because a grant is full access and the tunnel budget is shared. Q1.100 |
| Tunnel | 8 MiB socket-buffer valve (`MAX_TUNNEL_BUFFERED_BYTES`, should be unreachable), 20s ping / 2 misses, reconnect 1s→30s with **full** jitter, backoff resets only after 60s up (`TUNNEL_STABLE_AFTER_MS`) |

## Known gotchas

- **`yamux-js` advertises flow control and does not have it** — the receive window
  is replenished when bytes *arrive* rather than when they are *read*, so a slow
  consumer never throttles the sender and it looks perfect in dev. The tunnel is
  HTTP/2 instead, where `WINDOW_UPDATE` is granted on consumption, in core. Q6.36.
- **h2 over a WebSocket needs no socket shim.** `http2.connect(url,
  {createConnection})` and `server.emit("connection", duplex)` both take a plain
  `Duplex`, and `http.request({createConnection})` serializes an ordinary request
  *and* raises `upgrade` on a 101. What the relay *does* hand-write is the replay
  of that 101 onto the client socket — precisely the part no framework checks.
  Q6.37.
- **`server.address()` is `null` at every synchronous point after `serve()`
  returns**, on every host form, so `RelayTunnel.start` is called from inside the
  listening callback; outside it, `localAddress` silently takes its configured
  fallback. `port: 0` means "could not tell" and refuses to dial. Q6.38.
- **The h2 connection-level window defaults to 64 KiB and is shared by every
  stream.** Both ends call `setLocalWindowSize`; miss it on one side and
  throughput collapses in that direction only. Q6.39.
- **A relayed response bigger than one stream window can wedge, so a transcript
  page is kept smaller than one.** `STREAM_WINDOW_BYTES` and `EVENTS_PAGE_BYTES`
  are a **coupled pair** — 1 MiB against 768 KiB, the page bounded before gzip —
  and neither may be tuned alone. Node withholds the *stream* window (never the
  connection window) while a stream is not being read, and the resume that would
  grant it back is wired to nothing; the sender then stops at exactly `W` or
  `W + W/2` and nowhere else. Downloads are still exposed, because they are not
  compressed and not bounded. Q6.104.
- **`ClientRequest.destroy()` emits no `'error'`, so after `writeHead` the idle
  bound reaches nobody.** `pipe` forwards `end` and never a premature close, so
  every mid-body upstream death — the bound, a tunnel drop — left the browser
  holding an open response for ever. Destroy *with* an error, and check
  `upRes.complete` on `close`. Q6.103.
