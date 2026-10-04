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
pnpm client agents [recheck <agent>] # installed and signed in; recheck forgets a refused start
pnpm client agentauth [<agent>]      # where each agent's credentials go
pnpm client agentauth <agent> --set <env> [token] | --clear <env>
pnpm client dirs [path] | mkdir <parent> <name>
pnpm client new --agent kimi         # no --cwd → interactive picker; --nickname <name>
pnpm client attach <id> [--since N] [--json]
pnpm client prompt <id> "text"
pnpm client config <id> [<optionId> <value>] [--mode <id>]
pnpm client allow <id> <permId> | deny <id> <permId>
pnpm client elicit <id> <qId> <key>=<value>... | --decline | --cancel
pnpm client resume <id> | cancel <id> | stop <id>   # cancel: stop the turn, keep the agent
pnpm client title <id> [text] | nickname <id> <name> | pin <id> | unpin <id>
pnpm client changes <id> [--base head] [--ignored]
pnpm client diff <id> <path>         # patch on stdout, header on stderr
pnpm client workspace <id> | rmworkspace <id> [--force] [--delete-branch]
pnpm client plugins | plugin install <archive> | plugin remove <id>   # .tar.gz or .zip
pnpm client plugin enable <id> | disable <id> | view <id> [screen|settings]
```

## Invariants

- **An unknown session id is a 404**, never a tenancy question; the helper is
  `sessionOf`, not `owned`, a name asserting nothing unenforced. Q5.27.
- **A check-then-act guard that loses the race maps its constraint**:
  `POST /v1/admin/users` turns `users.name UNIQUE` into `409 user_exists` via
  `isUniqueViolation` (from `machines.ts`), after a `ROLLBACK` (an open `BEGIN` breaks
  the next writer). Never an `app.onError` renderer. Q1.50.
- **The two services answer an unrouted path differently, on purpose.** The control
  plane's `app.notFound(… "not_found" …)` answers the envelope for every path and
  method, which lets `relaycheck` tell a deleted route from a refusing one (`vanished`,
  the `PUT`/`DELETE /v1/admin/grants` pins). **The daemon deliberately has none**: a
  route newer than the host answers Hono's bare 404, which `parseBody` turns into
  `code: "http_404"`, read by `meansRouteAbsent` in `packages/web/src/http.ts` and five
  transcribing sites (`daemon.ts`, `plugins.ts`, `ImportCode.tsx`, `NewSession.tsx`,
  `MachineAgentsSection.tsx`): an absent route draws a remedy and **no** retry, a refusal
  a retry. No driver catches a regression (`webcheck.plugin-protocol.ts` synthesizes
  it); a daemon `notFound` is a breaking change needing a discriminator first.
- **Not every non-2xx is an error envelope**: a repeated permission answer is `409`
  with a success body `{recorded: true, repeat: true, outcome, session}`, no `error`
  key; `outcome` is the answer that **won**. `ApiError` keeps the parsed `body`.
  `webcheck` pins the client, `daemoncheck` the daemon.
- **A route retry replays only idempotent requests**: `isReplayable` allows `GET` and
  `DELETE`, since a transport failure says nothing about whether the daemon acted.
  Q5.18.
- **`POST /agent-auth/:agent/recheck` refuses nothing** where `login`/`logout` answer
  `503` for a harness lacking the verb. It drops the remembered refused start and answers
  the fresh row (`DELETE /systems/:system`'s shape, agreeing with `GET /agents`). **Its
  path is load-bearing**: it calls `availability()`, spawning a CLI per harness, and
  `slowRoute` matches `/agent-auth` by prefix but `/agents` on `GET` only; elsewhere it
  gets the 15s timeout and a healthy machine draws unreachable. Q3.538.
- **A relay `503 no_tunnel` is the only answer meaning the machine is gone**:
  `meansMachineGone` keys on the **code, never the status**, since the daemon answers
  `503 unresponsive` for a stalled mount.
- **The fallback HTML is read from disk per request**, never cached: `pnpm web:build`
  rewrites the bundle under a running control plane, and a cached copy points at chunks
  Vite deleted (a blank page until restart). Q5.15.

## Layout

| File | Holds |
|---|---|
| `src/server.ts` | Hono app, auth, routes, the WS stream |
| `src/cors.ts` | The one CORS vocabulary, shared with the relay (why `*`: `relay.md`) |
| `src/http.ts` | What both services answer in: the envelope, the `Bearer` parse (`""` malformed, `null` absent — the distinction is the point), the JSON-object body read, `boundedInt`, `describeError`, and `gzipResponses`, registered first in **both** apps, `compressible` keyed on **content type**. Imported by the control plane, so on the Dockerfile COPY line **and** in `.dockerignore` |
| `packages/web/src/http.ts` | `ApiError`, the envelope, `errorText`, and two predicates on the **code, never the status**: `meansMachineGone` (stop believing this route) and `meansLater` (ask again soon); `no_tunnel` is in both. `meansLater` refuses a state only an admin can change |
| `scripts/client.ts` | Terminal client; the reference token and replay logic `packages/web` mirrors |

## Bounds

| | |
|---|---|
| Compression | **gzip over 8 KiB in both services, by content type**; the relay compresses nothing (h2 frames). A **download is excluded** (`application/octet-stream`): the client's 100 MiB guard reads `content-length`, or the first piece's `content-range` total, before the body is resident. Q3.115, Q6.120 |
| Ranges | `serveFile` answers one `bytes=a-b` with 206, a past-the-end start with `416 range_not_satisfiable`, anything else with the whole file; always `accept-ranges` and an `etag`. Only the relay arm asks (`range` is not in `CORS_ALLOW_HEADERS`, `content-range` not exposed), so loopback is one request. Q6.120 |
