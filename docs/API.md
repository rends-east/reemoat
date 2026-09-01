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

**Bodies** are capped: 1 MiB on the daemon, except the three routes that stream
their own — `POST /sessions/:id/uploads` (100 MiB), `POST /fs/import` (50 MiB) and
`POST /plugins` (2 MiB), each of which counts its own bytes and cancels the body on
every refusal. 64 KiB on the control plane's public routes and 256 KiB below the
auth gate.

---

## The daemon — 55 routes

Runs on your machine, reachable through the relay. `pnpm client` drives all of it.

### Liveness

| | |
|---|---|
| `GET /health` | The one route with no credential |

### Agents and their credentials

| | |
|---|---|
| `GET /agents` | What is installed, which are signed in, and which have a sign-in at all. **Every harness this machine offers**, which is the four this repository ships plus any a plugin added and has not been switched off |
| `GET /agent-auth` | Where each agent's credentials go |
| `PUT /agent-auth/:agent` · `DELETE /agent-auth/:agent` | Set or clear a pasted credential |
| `POST /agent-auth/:agent/login` | Start a device-code login on a pty |
| `POST /agent-auth/:agent/logout` | Clears the pasted credential **first**, then runs the CLI's own logout |
| `POST /agent-auth/:agent/recheck` | Forget that this harness refused to open a session, and answer the fresh row — the **same shape** `GET /agents` answers, `login` included, since `availability()` does not carry that field and a row without it reads as *cannot check* everywhere. **Refuses nothing** where `login` and `logout` answer `503`, because a harness with no sign-in is exactly what it is for: its remedy is to run the CLI once on the machine, which reaches this daemon in no other way |
| `GET /agent-auth/login/:loginId` | What the pty has printed so far |
| `POST /agent-auth/login/:loginId/input` | Type into it |
| `DELETE /agent-auth/login/:loginId` | Abandon it |

### Systems, and the agents assembled out of them

A *system* is who serves a model and who you sign in to; a *harness* is the CLI
that runs the loop. No request here accepts a URL, a header name or a variable
name — a request names a system id and the machine's catalogue resolves it. A
plugin *manifest* does name all three, disclosed in `consent.adds` on
`POST /plugins/source` below.

| | |
|---|---|
| `GET /systems` | Every system, and whether a key is saved. Spawns nothing. The built-ins in their own order, then any a plugin added — each carrying `contributedBy` |
| `PUT /systems/:system` · `DELETE /systems/:system` | Set or clear that system's key |
| `GET /agents/capabilities` | What each harness offers and what it can be pointed at. **Starts an agent per harness**, cached ten minutes |
| `GET /custom-agents` · `POST /custom-agents` · `PATCH /custom-agents/:id` · `DELETE /custom-agents/:id` | The harness+system+model presets on this machine. A `PATCH` carries all four fields — an edit is a replace, so the pairing is never weighed against a merge |
| `GET /agent-strip` · `PUT /agent-strip` | Which agents this machine's New session strip offers, and in what order. A **partial** record — a position and a hidden flag for what somebody moved or hid — merged by the client against the two listings above, so a `ref` naming something that is gone keeps its place and is simply not drawn. The `PUT` carries the whole list and replaces it; no `ref` is validated against anything |

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

### Plugins

Installed per machine, and they run there. What a *caller* may do is the scope on
the route; what the *plugin* may do is `scopes` in its manifest, which applies
inside a hook where there is no caller at all. Neither implies the other. See
`docs/PLUGINS.md`.

| | |
|---|---|
| `GET /plugins` | What is installed, what each may reach, and the plugin API this daemon speaks |
| `POST /plugins` | Install **or update** — one verb, because the manifest says which. The archive is the body and `?name=` is the filename it arrived as, sanitized like an upload's and recorded as the row's `source`; it is the sole cause of `400 invalid_name`, and omitting it is one. Streams its body past the 1 MiB bound and cancels it on every refusal; `409 plugin_start_failed` means the tree is unchanged and the old version is still running |
| `POST /plugins/source` | The same act, for a plugin this daemon fetches itself: `{source: {kind: "github", repo, commit}, consent?}`. The address is **built here** from `repo` and `commit` and is never taken from the caller, the commit must be a full 40-character sha (a tag moves; the pin has to be content-addressed), and redirects are refused. `consent` is what the installer was shown — `{scopes, net, hooks, adds}` — and a manifest exceeding it is `409 plugin_consent_broken`, refused *before the plugin is started*. `adds` is one line per contributed harness or provider, carrying the argv and the whole base URL, and a caller that omits it is refused a commit that adds either — which is what makes a client too old to draw those rows safe. Answers exactly as `POST /plugins` does, `replaced` included |
| `DELETE /plugins/:pluginId` | Uninstall, and drop everything it kept. An update keeps that; this does not |
| `POST /plugins/:pluginId/state` | `{enabled}`. The state a caller wants rather than the transition, so a lost answer is safe to send again |
| `GET /plugins/:pluginId/views/:viewId` | `screen` or `settings`. A **read** by contract — `isReplayable` lets the transport repeat it |
| `POST /plugins/:pluginId/actions/:actionId` | Press something. Refused unless the manifest declared that action |

All seven answer `503 plugins_unavailable` where the daemon was built without a plugin
host or started with `REEMOAT_PLUGINS=0`, and the four that mutate — both installs,
remove and the state switch — answer `409 plugin_busy` while another one is in flight,
since one mutation at a time is a property of the whole daemon rather than of a plugin.
A first install answers `201` and an update answers `200`; `replaced` on the body is
which of the two it was.

`POST /plugins/source` is the **only** route on this daemon that reaches the network on
its own behalf, and it does so to one hardcoded host. Its refusals from the far end are
`502 plugin_source_not_found` (that repository and commit are not there, or it is
private) and `502 plugin_source_unavailable` (anything else, including a redirect) —
`502` rather than `400` because nothing about the request was wrong, and rather than
`503` because this daemon is not the thing that is unwell. A malformed `repo` or
`commit` is `400 plugin_source_invalid` and never opens a socket.

Both of the last two answer through one plugin, so both carry its failures:
`503 plugin_unavailable` (not running), `504 plugin_timeout` (did not answer inside the
invoke deadline), `503 plugin_overloaded` (already answering as many calls as the channel
holds in flight), `413 plugin_request_too_large` (what was sent does not fit one IPC
message — the remedy is to send less, which is why it is neither a timeout nor a
`502`: nothing downstream answered, because nothing reached the child) and `502
plugin_failed` for anything the plugin's own code raised.

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
| `GET /v1/instance` | What this instance allows, its plugin catalogue address (`plugins.catalogue`, `null` on an instance with no market) and its AGPL §13 source offer |
| `POST /v1/login` | A name **or a confirmed email address**, plus a password, for a bearer session token — not a cookie; nothing here is ambient. Throttled on the submitted identifier and the caller's address |
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
