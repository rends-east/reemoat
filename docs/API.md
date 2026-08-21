# HTTP API

Two services, two surfaces, and they are not the same shape. The **control
plane** issues identity and holds accounts; the **daemon** owns sessions and runs
on your machine. A browser talks to both — the control plane directly, the daemon
through the relay.

This file is a map, not a specification. Every route's actual rules — what a
refusal means, what may be replayed, what a 409 carries — are in
`.claude/rules/http-and-routes.md`, and the reasoning behind them is in
`docs/DECISIONS.md`. `scripts/client.ts` is the reference client and the fastest
way to see a call made properly.

## Conventions

**Errors.** Every non-2xx answers one envelope:

```json
{ "error": { "code": "machine_over_limit", "message": "…", "detail": null } }
```

Read the **code**, never the status. Two refusals sharing a status can need
opposite remedies, and two sharing a remedy can have different statuses.

**Not every non-2xx is an error envelope.** The daemon answers a repeated
permission answer with `409` carrying a *success*-shaped body
(`{recorded: true, repeat: true, outcome, session}`), because the answer already
landed. A client reading only `error.code` reports a successful approval as a
failure.

**Retries.** Only `GET` and `DELETE` may be replayed. A transport failure says
nothing about whether the daemon acted.

**Auth.** The daemon takes a bearer token whose `aud` is its own machine id, and
stops asking who the subject is — see `.claude/rules/auth-and-tokens.md`. The
control plane takes a session token (`rs_`) or an API key (`rk_`), resolved by
prefix. The web UI never sends its control-plane credential to a daemon or to the
relay.

**Bodies** are capped: 1 MiB on the daemon (uploads excepted, which stream against
their own 100 MiB bound), 64 KiB on the control plane's public routes and 256 KiB
below the auth gate.

---

## The daemon — 37 routes

Runs on your machine, reachable through the relay. `pnpm client` drives all of it.

### Liveness

| | |
|---|---|
| `GET /health` | The one route with no credential |

### Agents and their credentials

| | |
|---|---|
| `GET /agents` | What is installed, and which are signed in |
| `GET /agent-auth` | Where each agent's credentials go |
| `PUT /agent-auth/:agent` · `DELETE /agent-auth/:agent` | Set or clear a pasted credential |
| `POST /agent-auth/:agent/login` | Start a device-code login on a pty |
| `POST /agent-auth/:agent/logout` | Clears the pasted credential **first**, then runs the CLI's own logout |
| `GET /agent-auth/login/:loginId` | What the pty has printed so far |
| `POST /agent-auth/login/:loginId/input` | Type into it |
| `DELETE /agent-auth/login/:loginId` | Abandon it |

### The filesystem the picker sees

| | |
|---|---|
| `GET /fs/roots` | `REEMOAT_ROOTS` narrows this picker **and nothing else** |
| `GET /fs/list` · `POST /fs/mkdir` | Browse and create, for the directory picker |
| `POST /fs/import` | Unpack a `.zip`/`.tar.gz` of a project into one new folder under `?path=`. Streams its body past the 1 MiB bound like the upload route, and cancels it on every refusal. Answers the created path, which is what the picker moves to |
| `GET /worktrees` | Every worktree this daemon has made, and which session owns it |

### Sessions

| | |
|---|---|
| `POST /sessions` · `GET /sessions` | Create, list |
| `GET /sessions/:id` · `DELETE /sessions/:id` | One session's snapshot; stop it and drop its worktree |
| `POST /sessions/:id/resume` | Reattach an agent to a session that ended |
| `POST /sessions/:id/prompt` | Answers 202; the turn runs on the daemon |
| `POST /sessions/:id/cancel` | Stop the turn. The conversation stays loaded |
| `POST /sessions/:id/config` | The agent's own controls — mode, model, effort |
| `POST /sessions/:id/meta` | Title, pin |

### Being asked something

| | |
|---|---|
| `POST /sessions/:id/permissions/:permissionId` | Approve or refuse |
| `GET` · `POST /sessions/:id/elicitations/:elicitationId` | A question with a form |

### Reading what happened

| | |
|---|---|
| `GET /sessions/:id/events` | History, paged backwards |
| `GET /sessions/:id/stream` | WebSocket. **Read-only** — everything that mutates is an HTTP request |
| `GET /sessions/:id/commands` | The agent's slash commands. Refetched when `commandsRevision` differs |
| `GET /sessions/:id/changes` · `GET /sessions/:id/changes/diff` | git's own numbers |
| `GET /sessions/:id/workspace` · `DELETE /sessions/:id/workspace` | The worktree's path and branch; the delete removes the worktree, not the session |

### Files

| | |
|---|---|
| `POST /sessions/:id/uploads` | Streams to disk against a 100 MiB bound, a 1 GiB per-session budget and a 300 MiB / 5 min rate window (`429 upload_rate_limited`, with `Retry-After`) |
| `GET /sessions/:id/uploads/:uploadId` | Read an upload back, by the id the prompt named it with |
| `GET /sessions/:id/files` | Read a file back out of the workspace |

---

## The control plane — 59 routes

Holds the accounts, the machines, the grants and the fleet's signing key.
`pnpm cpctl` drives it.

### Public — above THE LINE

The auth gate is **positional**: one `app.use("/v1/*", callerAuth(db))` sits after
these, so a new route is private by doing nothing. "Public" is not
"unauthenticated" — `/v1/enroll` and `/v1/provision` carry a credential in the
*body*, which is why each brings its own throttle namespace.

| | |
|---|---|
| `GET /health` · `GET /v1/jwks` | Liveness, and the public keys every daemon verifies tokens against |
| `GET /v1/instance` | What this instance allows, and its AGPL §13 source offer |
| `POST /v1/login` | Name and password for a session cookie. Throttled on the pair |
| `POST /v1/enroll` | A daemon's one and only control-plane request, ever |
| `POST /v1/provision` | Add a daemon for somebody else. Takes a `pk_`, not an account |
| `POST /v1/register` · `POST /v1/register/confirm` | Sign up, then prove the address. A taken name answers 409; a taken address does not |
| `POST /v1/forgot` · `POST /v1/reset` | Mailed recovery. `forgot` answers identically for known, unknown and unverified |

### Your own account

| | |
|---|---|
| `GET /v1/me` | Who this credential is, and what it may reach |
| `POST /v1/me/password` | Requires the current one, even under a valid session |
| `GET` · `DELETE /v1/me/sessions` · `DELETE /v1/me/sessions/:id` · `DELETE /v1/me/sessions/current` | Where you are signed in |
| `GET` · `POST /v1/me/keys` · `DELETE /v1/me/keys/:keyId` | API keys |
| `PUT /v1/me/email` · `POST /v1/me/email/verify` | The address is the recovery channel, so changing it proves the password |

### Machines and tokens

| | |
|---|---|
| `GET` · `POST /v1/machines` · `PATCH /v1/machines/:id` | The machines you own: list, add, rename |
| `POST /v1/machines/:id/enrollments` | Mint a single-use code; minting burns the previous |
| `POST /v1/machines/:id/revoke` | Retire one, which gives its slot back to the limit |
| `POST /v1/tokens` | The short-lived token a browser uses. Quota is checked **after** the grant is proved |

### Admin

Everything below `/v1/admin` requires an admin, and an account that owes a
password change is refused all of it by a second positional gate.

| | |
|---|---|
| `GET` · `POST /v1/admin/users` · `DELETE /v1/admin/users/:id` | Delete is irreversible; disable is not |
| `POST /v1/admin/users/:id/disable` · `/enable` · `/invite` | Suspend and restore an account, or mail an invitation |
| `GET` · `DELETE /v1/admin/users/:id/keys[/:keyId]` | Somebody else's API keys, and retiring one |
| `PUT` · `DELETE /v1/admin/users/:id/machine-limit` | The commercial limit, per person |
| `GET` · `POST · PATCH /v1/admin/machines[/:id]` | Every machine in the fleet, whoever owns it |
| `POST /v1/admin/machines/:id/enrollments` · `/revoke` · `PUT /v1/admin/machines/:id/owner` | Mint a single-use enrollment code, revoke a machine, hand one to somebody else |
| `GET` · `PUT` · `DELETE /v1/admin/grants` | A grant is **full access** to the machine |
| `GET` · `PUT /v1/admin/settings` · `POST /v1/admin/settings/test` | Env-seeded, database-owned; the answer says which side won |
| `GET /v1/admin/mail` · `POST /v1/admin/mail/:id/retry` | The outbox, and pushing a stuck message again |
| `GET` · `POST /v1/admin/signing-keys` · `DELETE /v1/admin/signing-keys/:kid` | Rotate publishes **both**; retire once the fleet has re-enrolled |
| `GET` · `POST /v1/admin/provisioning-key` | Minting is the only verb; nothing ever draws the key |
| `GET /v1/admin/relay` | Which tunnels are up, and how long an offline machine has been that way |
| `GET /v1/admin/fleet` | What every machine is *running*, connected or not — the inventory a protocol change is planned from |

### The web UI

`GET *` serves `packages/web/dist` with an SPA fallback, from disk, per request.
`REEMOAT_CP_WEB=0` turns it off — and takes the security headers with it, which
you then have to send yourself. See `packages/control-plane/.env.example`.
