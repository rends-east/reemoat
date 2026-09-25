# HTTP API

Two services, two surfaces, and they are not the same shape. The **control
plane** issues identity and holds accounts; the **daemon** owns sessions and runs
on your machine.

A client talks to both, and how it reaches the second depends on where it is. The
control plane is always addressed directly.

**A daemon is reached over an encrypted channel, and there is no other way in.**
The app opens a WebSocket to the relay at **`/__relay/channel`**, the relay
authorizes it — verify the capability, take the machine from `aud`, read the live
user, machine and grant rows, and for a link capability the link's row as well — and
then splices it to that machine's tunnel as raw bytes. Inside it the app and the daemon run
`Noise_IK_25519_ChaChaPoly_BLAKE2s` between themselves, and every route below
travels as frames in that session. The relay carries bytes it holds no key for.

⚠ **The plaintext proxy is deleted.** The relay used to serialize each request onto
the tunnel and copy the answer back, so a daemon had an ordinary HTTPS base URL and
this document could say *"one base URL instead of another and nothing else"*. Both
handlers now answer **`426 upgrade_required`** — every request, and every upgrade
that is not a channel. There is nothing to point an HTTP client at.

The one path that is still plain is the desktop app reaching a daemon on the **same
computer**, over loopback: no relay, no channel, and there the capability is a
bearer token for its remaining life, which `.claude/rules/relay.md` bounds and
`SECURITY.md` states. Every route below, every header and every refusal is identical
on both paths — the channel is a transport under them, not a different API — which
is why this document does not mention it again.

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
prefix. The app never sends its control-plane credential to a daemon or to the
relay.

A machine capability also names the **device** it was minted for, in RFC 7800's
`cnf.jkt`. The daemon compares that against the static key the Noise handshake
authenticated and does it **offline**, which is what keeps *"the daemon makes
exactly one control-plane request, ever"* literally true — so a capability copied
off the wire or out of a log is worth nothing from any other installation.

**Bodies** are capped: 1 MiB on the daemon, except the three routes that stream
their own — `POST /sessions/:id/uploads` (100 MiB), `POST /fs/import` (50 MiB) and
`POST /plugins` (2 MiB), each of which counts its own bytes and cancels the body on
every refusal. 64 KiB on the control plane's public routes and 256 KiB below the
auth gate.

---

## The daemon — 67 routes

Runs on your machine, reachable through the relay's encrypted channel.

⚠ **`pnpm client` no longer drives all of it, and this line used to say it did.**
Its relay arm is deleted: opening a channel needs an X25519 device key and a
capability the Authority bound to it in `cnf.jkt`, and `REEMOAT_TOKEN` is a
long-lived bearer capability with neither — which is exactly what the binding exists
to make worthless. The client refuses with a sentence naming the remedy rather than
downgrading. What it still drives, unchanged, is every route below against a daemon
on **this** computer, through `REEMOAT_URL`; for a machine anywhere else the client
is the app.

### Liveness

| | |
|---|---|
| `GET /health` | The one route with no credential |

### Agents and their credentials

| | |
|---|---|
| `GET /agents` | What is installed, which are signed in, and which have a sign-in at all. **Every harness this machine offers**, which is the five this repository ships plus any a plugin added and has not been switched off. `installable` says which of the absent ones this daemon can fetch |
| `GET /agent-auth` | Where each agent's credentials go |
| `PUT /agent-auth/:agent` · `DELETE /agent-auth/:agent` | Set or clear a pasted credential |
| `POST /agent-auth/:agent/login` | Start a device-code login on a pty |
| `POST /agent-auth/:agent/logout` | Clears the pasted credential **first**, then runs the CLI's own logout |
| `POST /agent-auth/:agent/recheck` | Forget that this harness refused to open a session, and answer the fresh row — the **same shape** `GET /agents` answers, `login` included, since `availability()` does not carry that field and a row without it reads as *cannot check* everywhere. **Refuses nothing** where `login` and `logout` answer `503`, because a harness with no sign-in is exactly what it is for: its remedy is to run the CLI once on the machine, which reaches this daemon in no other way |
| `GET /agent-auth/login/:loginId` | What the pty has printed so far |
| `POST /agent-auth/login/:loginId/input` | Type into it |
| `DELETE /agent-auth/login/:loginId` | Abandon it |

### Installing a harness

**Nothing puts a coding-agent CLI on a machine but a press here.** The bootstrap
installs none, and the daemon's daily run is a *refresh* — it moves the copies
that are already there and fetches nothing new. A harness added to this
repository therefore does not arrive on every machine in the fleet by itself.

The writes are **`machine:admin`**, not `session:write`: putting new programs on
somebody's computer is an act on the machine, which is the rule `POST /plugins`
already follows. The poll is `session:read` — unlike a login transcript, this one
carries no one-time code.

| Route | What it is |
|---|---|
| `GET /agent-install` | Whether this daemon installs at all, and the one run it is holding — for a client that reloaded and has no id |
| `POST /agent-install/:agent` | Start one. `409 install_busy` while another run or the daily refresh holds the machine, naming which; `503 install_unsupported` where the daemon installs nothing |
| `GET /agent-install/runs/:installId` | The transcript from a cursor, plus `phase` and `outcome` |
| `DELETE /agent-install/runs/:installId` | Stop it |

⚠ **`outcome` is never derived from `exit`, on either side.** `deploy/agents.sh`
exits 0 having printed that an install failed — it must, because three of its
four callers contract that it never fails — so the daemon decides by asking the
machine again afterwards. A client reading `exit.code === 0` as success would
draw *installed* over a harness that is not there.

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
| `GET /agents/capabilities` | What each harness offers and what it can be pointed at. **Starts an agent per harness**, cached up to ten minutes and read again on the first request after the CLI build that published it changes. Each row carries `cli` — which build of the harness's own CLI published `models` (`version` may be `null`; `source` is `override` or `path`) — `null` where nothing was spawned, absent from daemons older than this field, and never the path it was resolved from |
| `GET /custom-agents` · `POST /custom-agents` · `PATCH /custom-agents/:id` · `DELETE /custom-agents/:id` | The harness+system+model presets on this machine. A `PATCH` carries all four fields — an edit is a replace, so the pairing is never weighed against a merge |
| `GET /settings` · `PATCH /settings` | This machine's own preferences — today one: how many minutes a conversation may sit untouched before its agent is shut down, `0` never. **Not the daemon's configuration**, which is env only; this is the narrow class whose owner is the person using the machine. A stored value **overrides** `REEMOAT_IDLE_PARK_MINUTES`, which is the default for a machine nobody has set. `PATCH` rather than `PUT` because the body names only what is changing, so an older client cannot erase a key it has never heard of. Applied to the running daemon before the route answers. Without a durable store the `GET` still answers and the `PATCH` is `503` |
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
| `POST /sessions/:id/prompt` | Answers 202; the turn runs on the daemon. Sent while a turn is already running it is still 202, carrying `steered` where the agent took it into that turn, `queued` (with `id` and `position`) where the daemon is holding it until the turn ends, or neither where the turn ended under the request and it became an ordinary send. `429 prompt_queue_full` carries the `limit` past which nothing more is held; `409 turn_in_flight` survives and now names only the `/clear`-and-restart window, where the agent's session id is being replaced and nothing may address it. Whether a mid-turn message is taken at all is `midTurnDelivery` on the snapshot — `"steer"`, `"queue"`, or `null` while no agent is up — and an **absent** field names a daemon that still refuses, which is what a client must branch on rather than on a version |
| `POST /sessions/:id/cancel` | Stop the turn. The conversation stays loaded |
| `POST /sessions/:id/async-tasks/:taskId/stop` | Stop one background task the agent left running. Not the turn — background work outlives a prompt by design. `{stopped: false}` is a 200: it had already finished |
| `POST /sessions/:id/config` | The agent's own controls — mode, model, effort |
| `POST /sessions/:id/meta` | Title, pin, and where the row sits in the list. `rank` is a position clock — a millisecond, `null` for "follows its age" — and it is **always** on the snapshot, so an absent field names a daemon that cannot store an order. A drop into the pinned group carries `pinned` and `rank` in one request, which is why this is not a route of its own |

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

### Another machine's agents

A **link capability** reaches these and nothing else: its one scope, `session:message`,
is refused by every other route, and a person's capability — which never carries it —
is refused by these. Minted by this machine's own Authority for the other machine's
key, and delivered to that machine by its owner's app. `.claude/rules/agent-messaging.md`.

| | |
|---|---|
| `GET /peer/agents` | The sessions here another machine's agents may reach, as the rows `list_agents` shows: a folder's name, never its path. `403 not_a_link` for a capability that is not one, `403 messaging_off` under `REEMOAT_PEER_MESSAGES=off` |
| `POST /peer/messages` | `{id, from: {ref, name, harness, hops}, to, message, notify}`. **A refusal rides a `200`** as `{ok: false, code, message}`, because the sending agent reads it: the codes are the ones `send_message` answers with. The sending machine is the one the capability names, never the body; the same `id` from one link is delivered once |
| `POST /peer/notices` | That a session there went idle or ended without answering, for a message this machine sent with `notify`. `202`, or `409 unexpected_notice` for one nothing here asked for — a link cannot wake a session by claiming to answer it |
| `GET /peers/links` · `PUT /peers/links` | `machine:admin`. The link capabilities this machine holds for reaching others, written whole by the owner's app exactly as the control plane minted them, and read back with the last error each met |

---

## The control plane — 67 routes

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
| `GET /v1/instance` | What this instance allows, its plugin catalogue address (`plugins.catalogue`, `null` on an instance with no market), where it publishes a build of the app (`app.download`, `null` on one that publishes none), whether it publishes the built-in legal documents as its own (`legal.documents`, `false` on an instance that has not claimed them **and** on one predating the field) and its AGPL §13 source offer |
| `POST /v1/login` | A name **or a confirmed email address**, plus a password, for a bearer session token — not a cookie; nothing here is ambient. Throttled on the submitted identifier and the caller's address |
| `POST /v1/enroll` | A daemon's one and only control-plane request, ever |
| `POST /v1/provision` | Add a daemon for somebody else. Takes a `pk_`, not an account |
| `POST /v1/register` · `POST /v1/register/confirm` | Sign up, then prove the address. A taken name answers 409; a taken address does not. Where the instance publishes legal documents (`legal.documents`), `acceptedTerms: true` is required and its absence answers `400 terms_not_accepted`; nothing about the acceptance is stored |
| `POST /v1/forgot` · `POST /v1/reset` | Mailed recovery. `forgot` answers identically for known, unknown and unverified |

### Your own account

| | |
|---|---|
| `GET /v1/me` | Who this credential is, and what it may reach |
| `POST /v1/me/password` | Requires the current one, even under a valid session |
| `GET` · `DELETE /v1/me/sessions` · `DELETE /v1/me/sessions/:id` · `DELETE /v1/me/sessions/current` | Where you are signed in. Each row names the **device** it belongs to where there is one, and falls back to what the `User-Agent` says where there is not |
| `GET` · `POST /v1/me/devices` · `DELETE /v1/me/devices/:id` | The installations registered on this account. A **device** is not a session and not a credential: a session is one bearer token with an expiry, a device is the computer or phone that keeps producing them, and holding its id proves nothing — it is read only after a session token has already resolved. Registering binds the caller's current session, adopts an id it already holds, and **ignores one it does not** rather than refusing (an id that was retired would otherwise close a sign-in loop with no exit); it refuses an API key with `409 device_needs_session`, because a key has no session for a device to hang off, and `409 device_limit` at the cap — a **refusal** rather than an eviction, so that somebody holding one live session cannot sign every device of the owner out. `POST /v1/login` carries the same block optionally and answers `deviceId`. The listing includes **recently retired** rows, because the question it exists to answer is usually asked after something has gone wrong. Retiring one ends every session bound to it and **no other device's**; `404 device_not_found` covers "no such device" and "not yours" alike. Devices are **not** an authorization subject — a grant is `(user, machine)`, so every device of one person reaches the same fleet — and `relay/authorize.ts` reads no device row, so a revocation stops that installation here on the next request and leaves a machine token already minted alone for its remaining ~300s. `SECURITY.md` carries the windows |
| `GET` · `POST /v1/me/keys` · `DELETE /v1/me/keys/:keyId` | API keys |
| `PUT /v1/me/email` · `POST /v1/me/email/verify` | The address is the recovery channel: a session changes it alone, an API key proves the password first |

### Machines and tokens

| | |
|---|---|
| `GET` · `POST /v1/machines` · `PATCH /v1/machines/:id` | The machines you own: list, add, rename. Each listed machine carries **`enrolledBy`**, whose enrollment code it enrolled with where that was not yours: a display name, or `"a provisioning key"` (`POST /v1/provision` needs no account, only `REEMOAT_CP_PROVISION_KEY`, so it is the most alarming answer rather than the absent one), or `"a deleted account"` where the enroller's account has gone since, or `"somebody this control plane did not record"` for a machine that enrolled before the column existed — which on an upgraded instance is every machine, and is named rather than folded into the absent case. **Absent or `null`** is your own code, a machine that has never enrolled, or a control plane too old to send the field. It names who **minted** the code, never who redeemed it: `POST /v1/enroll` is public and a daemon presents no account, so a leaked code of your own reports you. It is the disclosure for a substitution no refusal closes; `SECURITY.md` carries the argument and the limits |
| `POST /v1/machines/:id/enrollments` | Mint a single-use code; minting burns the previous |
| `POST /v1/machines/:id/revoke` | Retire one, which gives its slot back to the limit |
| `GET` · `PUT` · `DELETE /v1/machines/:id/grants` | Share a machine **you own**, and take it back. A grant is **full access** to the machine, so this is the owner's verb: the admin routes that wrote one are deleted. Addressed by user id — there is no directory an ordinary account may read, so the other person reads theirs off `GET /v1/me`. `404 machine_not_found` for one you do not own, which is the anti-mapping rule rather than a lie; `409 grant_is_owner` for your own grant on both writes (narrowing it would take `machine:admin` off your own hardware, removing it would hide the machine from its owner — retiring it is the verb for that); `404 user_not_found`; `409 user_disabled` for a suspended account, which would otherwise become live the moment somebody re-enabled them; `400 bad_request` for a `userId` that is missing on either verb; `404 grant_not_found` on an unshare that removed nothing |
| `DELETE /v1/machines/:id/grants/me` | **Give up a share somebody made to you.** The three routes above all resolve through ownership, so a grantee could reach none of them — and a share is written for any `userId` with no consent asked, so what somebody can do to you unasked now has something you can do about it. Your own grant only, and there is no `userId` parameter: the caller is the subject, and a route that took an id would be `DELETE /v1/admin/grants` under another name. `409 grant_is_owner` on a machine you own, because `GET /v1/machines` joins `grants` and an owner without one owns a machine in no list — retiring it is the verb for that; `404 grant_not_found` for both "no such grant" and "no such machine", which is the same anti-mapping rule |
| `POST /v1/tokens` | The short-lived capability the app spends on one machine. Quota is checked **after** the grant is proved. The answer is also **how a client learns where that machine is and what it will answer as**: `machine.relayUrl`, `machine.relayOnline`, and `machine.key` — the machine's X25519 static, which is IK's precondition and therefore the thing without which no channel can be opened at all. `null` there means a machine that has not dialled since it learned to announce one, and the client turns that into a sentence about updating it rather than into a session without it: there is no mode to fall back to. A route and a key are the same kind of fact — *how to reach this thing* — so they are minted together rather than fetched twice and left to disagree. **`409 device_key_required`** refuses a signed-in installation that has registered no device key: a capability minted for it could not open a channel, so the answer is a refusal with a remedy rather than a credential that fails later about the wrong thing. An **API key** is the deliberate exception and is minted **without** a binding, because a key is no sign-in and has no device to bind to — such a capability works over loopback and is refused by any daemon it reaches on a channel, which is the honest shape rather than a let-off |
| `POST` · `GET /v1/machines/:id/links` · `DELETE /v1/links/:id` | **Let one of your machines' agents message another's.** `POST` is asked of the **source**, which must be yours (`404 machine_not_found` otherwise, grantee or not), enrolled (`409 machine_not_enrolled`), keyed (`409 machine_key_missing` — the link is bound to that key) and switched on (`403 machine_over_limit` / `owner_disabled`). It answers one link per **other** machine you own that is enrolled, keyed, live, granted to you and within your limit — `{links: [{id, token, expiresAt, target: {id, name, key, relayUrl}}]}`, an empty list when there is none — finding the live `lk_` row or writing one, and minting each a fresh capability every time: `aud` the target, `sub` you, `scp` exactly `["session:message"]`, `cnf.jkt` the **source machine's** key from this service's own pin, `lnk`/`src`/`srcl` naming the link, the source and your label for it, and **90 days** of life, since revocation is the relay reading the row on every channel rather than expiry. Nothing about it is a grant, and no grant ever carries that scope. The app hands the answer to the source's daemon; the Authority holds no message. `GET` lists the live links a machine of yours is either end of, while both ends are live. `DELETE` is yours if you own either end, answers `204` — again on a repeat, so a retried `DELETE` is safe — and `404 link_not_found` for "no such link" and "not yours" alike. The relay refuses a removed link's next channel as `404 machine_not_found`. Q7.150 |

### Admin

Everything below `/v1/admin` requires an admin, and an account that owes a
password change is refused all of it by a second positional gate.

| | |
|---|---|
| `GET` · `POST /v1/admin/users` · `DELETE /v1/admin/users/:id` | Delete is irreversible; disable is not |
| `POST /v1/admin/users/:id/disable` · `/enable` · `/invite` | Suspend and restore an account, or mail an invitation |
| `PUT` · `DELETE /v1/admin/users/:id/machine-limit` | The commercial limit, per person |
| `GET` · `POST · PATCH /v1/admin/machines[/:id]` | Every machine in the fleet, whoever owns it |
| `POST /v1/admin/machines/:id/enrollments` · `/revoke` · `PUT /v1/admin/machines/:id/owner` | Mint a code, revoke a machine, adopt an ownerless one. **The enrollment mint refuses a machine that is enrolled and has an owner *or grantees*** (`409 machine_enrolled`) — redeeming a code retires the running daemon's tunnel key, so it would replace somebody's machine rather than read it; its owner mints their own. **The owner route refuses a transfer away from a live owner** (`403 machine_owned`), and refuses adopting an ownerless machine somebody holds a grant on unless they are the one being handed it (`403 machine_granted`) — so what it adopts is a row nobody depends on, and what it re-labels is a machine for the owner it already has. Adopting burns that machine's outstanding codes and says how many |
| `DELETE /v1/admin/machines/:id/machine-key` | **Unpin a machine's static key.** A machine's X25519 key is pinned on first sight and a *different* one on a later dial is refused, which is the right answer for a substituted machine and the wrong one for a daemon whose database was legitimately rebuilt — so this is the operator's undo, and the only one. Idempotent, with `cleared` saying whether a row actually changed rather than turning the second attempt into an error. It returns `previousKey`, deliberately: it is a public key, this route is admin-only, and this is the only moment anybody can write down what *was* pinned, so refusing it would mean repairing a mismatch also destroys the evidence of what the mismatch was. `403 machine_revoked` for a revoked machine, which dials nothing and therefore has no pin to repair |
| `GET /v1/admin/grants` | Who holds what, paged. **The `PUT` and `DELETE` are deleted** — a grant is full access to a machine that runs agents as its owner, and an admin writing one for a machine they do not own was one request from that. Sharing is `PUT /v1/machines/:id/grants`; the read is kept, because an operator who cannot see this table cannot answer "why can this person reach that machine" |
| `GET` · `PUT /v1/admin/settings` · `POST /v1/admin/settings/test` | Env-seeded, database-owned; the answer says which side won |
| `GET /v1/admin/mail` · `POST /v1/admin/mail/:id/retry` | The outbox, and pushing a stuck message again |
| `GET` · `POST /v1/admin/signing-keys` · `DELETE /v1/admin/signing-keys/:kid` | Rotate publishes **both**; retire once the fleet has re-enrolled |
| `GET` · `POST /v1/admin/provisioning-key` | Minting is the only verb; nothing ever draws the key |
| `GET /v1/admin/relay` | Which tunnels are up, and how long an offline machine has been that way |
| `GET /v1/admin/fleet` | What every machine is *running*, connected or not — the daemon build, the protocol it agreed, and which build of each agent CLI it would launch (`agents`, harness → version, as of its last dial; `null` from a daemon older than the field). The inventory a protocol change or an agent rollout is planned from |

### Outside `/v1`

| Route | What it is |
|---|---|
| `GET /install.sh` | The one-line installer — `deploy/bootstrap.sh` with **this instance's own origin** substituted in and shell-quoted, so a self-hosted control plane hands out a script that points at itself. Unauthenticated by path rather than by position: `callerAuth` is mounted on `/v1/*` and has never seen anything outside it. `text/plain`, so it can be read in a browser before it is piped into a shell; `no-store`, because the body varies by `Host`. A missing file is a 404, not a 500. `REEMOAT_CP_INSTALL=0` turns it off |

**`GET /register` · `/confirm` · `/forgot` · `/reset` · `/verify` · `/terms` ·
`/acceptable-use` · `/privacy` · `/app`** serve the **gate** — a page each, from
`packages/web/dist-gate`, which is in the image and served by this same process.
Not an SPA fallback: the list is closed, and every other path answers the error
envelope. That is what makes these nine addresses the whole of what a browser can
reach.

The gate exists because its flows have nowhere else to land: `/confirm`, `/reset`
and `/verify` are opened by a **mail client**, in a browser, and `POST /v1/forgot`
is the only remedy this service has for a forgotten password. `/app` is where every
one of them ends — the page that says the product is an app and, where
`REEMOAT_CP_APP_DOWNLOAD_URL` names one, offers the build.

⚠ **Nothing serves the app, and there is no variable that would.** A browser holds
no device key, so it cannot open the encrypted channel a daemon is reached through —
it could load the app and reach no machine at all. The gate's list above is closed:
an address outside it answers the error envelope, whatever the method. Q1.649.

## What is served to a browser

| | Serves | Reached by |
|---|---|---|
| **Every deployment** | the API, the relay, and the **gate** at nine addresses | the Reemoat app; a browser for sign-up and recovery |

**One row, and that is the change.** There was a second — a checkout naming a built
app bundle — and it is deleted with `REEMOAT_CP_WEB`. The desktop app carries its own
copy of the interface, compiled into the binary, and **never downloads one**;
`docs/NATIVE.md` records how that invariant is held and what asserts it.

⚠ **`mail.public_url` must point at whatever serves the gate.** The confirmation,
reset, verify and invitation links are built from it, and they are opened in a
browser — so pointed at something that does not serve those nine addresses they
land on the error envelope. `GET /v1/admin/settings` reports it as a problem when
it points at a control plane serving none, and the gate itself takes a **pasted
link or code** for the case a mail client rewrites the URL and drops the fragment
the token rides on.

`REEMOAT_CP_INSTALL=0` switches off `/install.sh`, the route the next machine joins
through. It is the only variable of its shape left — *either* a boolean *or* a path —
and `=1` means the built-in default, because `deploy/bootstrap.sh` really is in the
image. (A second one shared that shape without a default to mean, so `=1` resolved to
a directory called `1` and 404ed for ever. It is deleted.)
