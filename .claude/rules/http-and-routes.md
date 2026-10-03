---
paths:
  - src/server.ts
  - src/http.ts
  - src/cors.ts
  - packages/web/src/http.ts
  - packages/web/src/daemon.ts
  - packages/control-plane/src/app.ts
  - scripts/client.ts
---

## Commands

```bash
pnpm client agents                   # what's installed on the server, and signed in
pnpm client agents recheck <agent>   # forget that one refused to start, and ask again
pnpm client agentauth [<agent>]      # where each agent's credentials go
pnpm client agentauth <agent> --set <env> [token] | --clear <env>
pnpm client dirs [path]              # browse the server's filesystem
pnpm client mkdir <parent> <name>
pnpm client new --agent kimi         # no --cwd → interactive directory picker; --nickname <name>
pnpm client attach <id> [--since N] [--json]
pnpm client prompt <id> "text"
pnpm client config <id> [<optionId> <value>] [--mode <id>]   # the agent's own controls
pnpm client allow <id> <permId> | deny <id> <permId>
pnpm client elicit <id> <qId> <key>=<value>...   # answer a question the agent asked
pnpm client elicit <id> <qId> --decline | --cancel
pnpm client resume <id>              # reattach an agent to a session that ended
pnpm client cancel <id>              # stop the turn; the agent and the conversation stay
pnpm client title <id> [text]        # name a session; no text clears it
pnpm client nickname <id> <name>     # its handle, the one @ and other agents use
pnpm client pin <id> | unpin <id>    # keep it at the top of the list
pnpm client stop <id>

pnpm client changes <id> [--base head] [--ignored]
pnpm client diff <id> <path>         # patch on stdout, header on stderr
pnpm client workspace <id>
pnpm client rmworkspace <id> [--force] [--delete-branch]

pnpm client plugins                  # what is installed, and what each may reach
pnpm client plugin install <archive> # install or update one; a .tar.gz or a .zip
pnpm client plugin remove <id>       # uninstall it, and everything it kept
pnpm client plugin enable <id> | disable <id>
pnpm client plugin view <id> [screen|settings]
```

## Invariants

**Errors and routes**

- **An unknown session id is a 404**, and that never depended on tenancy. The helper
  is called `sessionOf` rather than `owned`: **a helper whose name asserts a property
  nobody enforces is how the property gets "restored" by somebody who believes it is
  still there.** Q5.27.
- **A check-then-act guard that loses the race must map its constraint, not
  rethrow.** `POST /v1/admin/users` sits ~51ms of scrypt between its
  `SELECT id FROM users WHERE name = ?` and its INSERT, so the loser trips
  `users.name UNIQUE` and answers `409 user_exists` through `isUniqueViolation` —
  exported from `machines.ts` rather than copied, because `createOwnedMachine`
  already does this one file over. The `ROLLBACK` in front of the 409 is the half a
  409 cannot show: what an un-rolled-back `BEGIN` takes out is the *next* writer on
  the shared connection. Deliberately not an `app.onError` envelope renderer — that
  is a service-wide contract change and it would mask the next unmapped throw. Q1.50.
- **⚠ The two services answer an unrouted path differently, on purpose, and the
  daemon's bareness is load-bearing.** The control plane registers
  `app.notFound(… "not_found" …)`, so every path it does not serve answers the
  envelope whatever the method — which is what lets `relaycheck` tell a *deleted*
  route from a live one that is refusing (`vanished`, and the `PUT`/`DELETE
  /v1/admin/grants` pins). **The daemon deliberately has none.** Nothing sends a
  version to a daemon and nothing reads one, so a route added in a release has
  exactly one signature on an older host: Hono's own bare 404 with no envelope,
  which `parseBody` turns into `code: "http_404"`. Six places read that —
  `meansRouteAbsent` in `packages/web/src/http.ts` and five sites that still
  transcribe it (`daemon.ts`, `plugins.ts`, `ImportCode.tsx`, `NewSession.tsx`,
  `MachineAgentsSection.tsx`) — and they need it because an absent route and a
  refusing one want opposite screens: a sentence naming the remedy and **no**
  retry, against the triangle and a way to ask again. So "every non-2xx answers one
  envelope" reads as a rule about the *control plane*; applying it to `src/server.ts`
  would turn every "this machine's daemon is too old" screen into a generic refusal
  with a retry button that asks the same daemon the same question. No driver
  catches it — `webcheck.plugin-protocol.ts` synthesizes the error rather than
  observing a daemon produce it — so this paragraph is the whole of the guard. A
  global `notFound` on the daemon is a breaking change and needs a discriminator
  that survives it first.
- **Not every non-2xx is an error envelope.** The daemon answers a repeated
  permission answer with `409` carrying a *success*-shaped body — `{recorded: true,
  repeat: true, outcome, session}`, no `error` key. A client reading only
  `error.code` reports a successful approval as a failure. `ApiError` keeps the
  parsed `body`. **Both ends are pinned**: `webcheck` asserts the client copes,
  `daemoncheck` asserts the daemon still sends it — including that the outcome is
  the answer that **won**, not the one just sent.
- **A route retry only replays an idempotent request.** A transport failure says
  nothing about whether the daemon *acted* — the timeout that triggers it is the
  client's own, fired long after the daemon started the turn. `isReplayable` gates
  the retry to `GET` and `DELETE`. Q5.18.
- **`POST /agent-auth/:agent/recheck` refuses nothing where its two neighbours
  answer `503`.** `login` and `logout` refuse a harness with no such verb — and a
  harness with no such verb is precisely what this route is for. It asks the agent
  nothing and takes nothing away: it drops what the daemon remembered about a
  refused start and answers the fresh row, which is `DELETE /systems/:system`'s
  shape and is why a screen redrawing from this response cannot disagree with one
  redrawing from `GET /agents`. ⚠ **Its placement is load-bearing**: it calls
  `availability()`, so it spawns a CLI per harness, and `slowRoute` matches
  `/agent-auth` by prefix while matching `/agents` on `GET` only — named anywhere
  else this `POST` would take the ordinary 15s, and an abort there is a transport
  failure that draws a healthy machine as unreachable. Q3.538.
- **A relay `503 no_tunnel` is the only answered request that means the machine is
  gone.** `meansMachineGone` keys on the **code and never the status**, because the
  daemon answers its own `503 unresponsive` when a browse path sits on a stalled
  mount — a reachable machine saying one directory did not answer.
- **The SPA fallback serves the same `index.html` `/` does, from disk, per
  request.** A cached copy goes stale, because `pnpm web:build` rewrites `dist/`
  under a running control plane and nothing restarts it: `/` streams the new HTML
  while every client-side route serves chunks Vite has deleted, so reloading on a
  session gives a blank white page that restarting "fixes". Q5.15.

## Layout

| File | Holds |
|---|---|
| `src/server.ts` | Hono app, auth, routes, the WS stream connection |
| `src/cors.ts` | The one CORS vocabulary, shared with the relay. Why the origin is `*` |
| `src/http.ts` | The HTTP vocabulary both services answer in: the error envelope, the `Bearer` parse (`""` for malformed, `null` for absent — the distinction is the point), the JSON-object body read, `boundedInt`, `describeError` — and `gzipResponses`, the one compression in this system, registered first in **both** apps. `compressible` keys on the **content type**, so a download (`application/octet-stream`) is structurally excluded — see the bound below. Imported downhill by the control plane, so it is on the Dockerfile COPY line **and** in `.dockerignore` |
| `packages/web/src/http.ts` | `ApiError` and the one error envelope every service in this system answers with. Also `errorText` — the one faithful extraction 23 screens were each writing out — and the two predicates that read a refusal's **code, never its status**: `meansMachineGone` (stop believing this route) and `meansLater` (ask again in a moment). `no_tunnel` is in both, deliberately: they are different questions about one answer. What `meansLater` refuses is a state only an admin can change |
| `packages/web/src/daemon.ts` | The daemon's HTTP surface, mirrored: sessions, prompts, stopping a turn, permission answers |
| `scripts/client.ts` | Terminal client. The reference implementation of the token and replay logic `packages/web` mirrors |

## Bounds

| | |
|---|---|
| Compression | **gzip over 8 KiB, in both services, keyed on the content type** (`gzipResponses` in `src/http.ts`, first middleware in each app). The relay compresses nothing on purpose — it carries h2 frames. A **download is excluded**, because the client's own 100 MiB guard reads `content-length` — or, for a relayed download in pieces, the total in the first piece's `content-range` — before the body is resident. Q3.115, Q6.120 |
| Ranges | `serveFile` answers one `bytes=a-b` with 206, a past-the-end start with `416 range_not_satisfiable`, and anything else with the whole file; every answer carries `accept-ranges` and an `etag`. Only the relay arm asks: `range` is not in `CORS_ALLOW_HEADERS` and `content-range` is not exposed, so loopback stays one request. Q6.120 |
