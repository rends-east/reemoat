---
paths:
  - packages/control-plane/src/app.ts
  - packages/control-plane/src/settings.ts
  - packages/control-plane/src/registration.ts
  - packages/control-plane/src/main.ts
  - packages/control-plane/src/store.ts
  - packages/control-plane/src/schema.sql
  - packages/control-plane/scripts/cpctl.ts
  - packages/web/src/cp.ts
  - packages/web/src/gate.ts
  - packages/web/src/instance.ts
  - packages/web/src/ui/SignIn.tsx
  - packages/web/src/ui/ForcedPasswordChange.tsx
  - packages/web/src/ui/gate/*
  - packages/web/src/ui/settings/ServerSection.tsx
---

## Commands

```bash
pnpm cpctl admin machines            # drive it; needs REEMOAT_CP_KEY
pnpm cpctl admin setmachine <id> --name <n>  # rename it; there is no address to set
pnpm cpctl login <name>              # sign in with a password; prints a REEMOAT_CP_KEY
pnpm cpctl passwd                    # change your own. There is no way to change anybody else's
pnpm cpctl key                       # mint yourself an API key; `keys --revoke <id>` retires one
pnpm cpctl email [<address>]         # your address, the only thing that makes recovery work
pnpm cpctl admin settings [<k> <v> | --clear <k>]  # registration, machine limits and SMTP, with
                                     #   where each value came from; no key prints them all
pnpm cpctl admin settings <secret k> # a secret takes **no** `<v>` — prompted with echo off, or one
                                     #   line off stdin when there is no tty. `SECRET_SETTING_KEYS`
                                     #   is the refused set, imported and not transcribed. Q1.300
pnpm cpctl admin mail                # what went out, and what failed
pnpm cpctl admin testmail [<addr>]   # queue a test message
pnpm cpctl sessions [--all]          # where you are signed in; --all signs them all out
pnpm cpctl addmachine <name>         # a machine of your own, enrolled in one step
pnpm cpctl provision <user> <machine> # add a daemon for somebody else. Needs
                                     #   REEMOAT_CP_PROVISION_KEY and **no account at all** — the one
                                     #   verb here taking no REEMOAT_CP_KEY. Creates the machine,
                                     #   raises their limit to fit, prints a single-use enrollment code
pnpm cpctl admin provisionkey [--new]  # whether a key exists; --new mints one, retiring the previous
                                     #   in the same act (shown once — only its hash is kept)
pnpm cpctl admin machinelimit <id> [<n>|default]  # how many machines they may own; no value reads it.
                                     #   Lowering switches off the ones added most recently and deletes
                                     #   nothing; raising brings them back. Fleet-wide default is
                                     #   `admin settings machines.per_user`, and unset means 50
pnpm cpctl admin deluser <id>        # irreversible; disable <id> is the one you can undo
pnpm cpctl admin invite <id>         # send an invitation again — the only way back for an invited
                                     #   account whose link never arrived
pnpm cpctl admin relay               # which tunnels are up, how much each carried, and how long an
                                     #   offline machine has been that way (`machine_last_seen`). Q1.311
pnpm cpctl admin signingkeys         # the fleet's signing keys, and which one signs
pnpm cpctl admin rotatekey           # mint a new one; **both stay published** — a daemon captured the
                                     #   key set at enrollment and never asks again, so a swap darks
                                     #   the fleet
pnpm cpctl admin retirekey <kid>     # once every daemon has re-enrolled. The last active key is
                                     #   refused: with none this service can neither sign nor mint a
                                     #   replacement, `ensureSigningKey` running at startup
#   ⚠ There is no `admin passwd` and no `admin key`. **No route in this service issues a
#     credential for an account other than the caller's own** — greppable:
#     `db.prepare("INSERT INTO api_keys` appears in `app.ts` exactly once, and not on a
#     route reading `c.req.param("id")`, which `relaycheck` asserts by reading the source.
#     What that does *not* buy is Q1.301.
#   ⚠ **Retiring somebody *else's* key has no cpctl verb** — `keys --revoke` retires only your
#     own, and `DELETE /v1/admin/users/:id/keys/:keyId` is reachable from the web UI alone —
#     and neither has **giving an ownerless machine an owner**
#     (`PUT /v1/admin/machines/:id/owner`).
```

**The control plane's config is not env only.** The keys in `SETTING_KEYS` — the
machine limit, registration and SMTP — are **seeded by env and owned by the database
after that**: a row in `instance_settings` wins, `REEMOAT_CP_*` is the fallback,
absence of both is unset. Everything else — the listeners, the relay URL, the paths,
the signing key, `REEMOAT_CP_TRUSTED_PROXY_HOPS` — is env only and needs a restart.
An env file is therefore not evidence of what the running instance uses —
`REEMOAT_CP_SMTP_HOST` sitting in `packages/control-plane/.env.example` says
nothing about where the running instance actually sends mail — which is why `GET
/v1/admin/settings` reports which side won per field. **The count is not
written down here on purpose**: `SETTING_KEYS.length` is the number and `relaycheck`
reads it rather than a literal. Q1.302.

**`REEMOAT_CP_MACHINES_PER_USER` is the one of those the *relay* also reads**, out of
its own environment, because `quota.ts` runs in both processes. `compose.yml` gives
them one `env_file` so the standard deployment cannot disagree; a relay on another
host has its own `environment:` block and can. Setting it from Settings → Server
settings writes a row, and a row wins in both processes out of the one database.

**A person signs in with a name and a password.** One password per user (scrypt, in
`user_passwords`); the session token is sent as a bearer and **never** a cookie,
because `src/cors.ts` answers `*` and never sends
`Access-Control-Allow-Credentials`. API keys survive for everything that is not a
browser, but **`SignIn` takes no key**: an account holding only one reaches the app
through `cpctl passwd`, which sets the first password an account with no
`user_passwords` row needs no current password to set. A key already in
`localStorage` is still adopted. Both are full authority and `callerAuth` resolves
either by its three-character prefix. There is no OAuth and that stays deliberate.
Q1.303.

**An API key can be retired, by exactly two routes.** `DELETE /v1/me/keys/:keyId` and
`DELETE /v1/admin/users/:id/keys/:keyId` write `api_keys.revoked_at` through
`revokeApiKey`. **A self-service password change retires nothing**: `POST
/v1/me/password` revokes sessions and leaves keys alone, deliberately — a separate
credential with a separate lifecycle, and `cpctl` is holding one. Two routes list them
(`apiKeyRows` — the prefix, never the key and never the hash), and `GET
/v1/admin/users` counts the unrevoked ones. Q1.304.

**Guessing is counted against the guesser, never against the name they typed.**
`throttle.ts` builds every key from exported pure builders: `loginKey` is `<name,
address>`, `addressKey` is the per-address backstop under the looser
`ADDRESS_THROTTLE`, and `passwordChangeKey` is namespaced on the *user id* so nothing
an anonymous caller records can reach an authenticated route. What bounds a
many-address sprayer is `password.ts`'s public lane, not this file. Q1.305.

**The address half is only as trustworthy as a proxy somebody configured.**
`REEMOAT_CP_TRUSTED_PROXY_HOPS` says how many hops are yours and defaults to **0**,
which ignores `x-forwarded-for` outright. Entries are counted **from the right**,
because that is the end a proxy appends to, and a header carrying fewer entries than
hops falls back to the socket. `install.sh` asks, and `main.ts` warns once at runtime
when the header arrives while it is being ignored. Q1.306.

**A session records what it said about itself, and that is recognition rather than
evidence.** `user_session_origins` — a table, not two columns, for the `migrate()`
reason every other table in that file gives — holds the `User-Agent` and the address
each sign-in arrived with. Both are caller-supplied, so somebody holding a stolen
token can write both: the list is a way to **end** sessions, not to judge them, and
nothing anywhere authorizes on either field. An older session lists with nulls.

**Disabling a person is reversible and deleting one is not, and both exist.** `DELETE
/v1/admin/users/:id` removes every credential that authenticates as them — password,
keys, sessions and their origins, grants, **and every unredeemed enrollment code they
minted** (`burnUserCodes`, `used_from = 'user_deleted'`) — in one transaction, frees
the name (`users.name` is UNIQUE, so a disabled row holds it for ever), and **revokes
their machines**, reporting `machinesRevoked`. `enrollment_codes.created_by` may name
a user who is gone, left dangling on purpose. `disable` does **not** revoke machines.
Deleting *yourself* is refused, which is what makes "there is always an enabled admin
left" true by construction. Q1.307.

**Disabling burns their enrollment codes too, and `enable` does not give them back.**
`disable` calls `burnUserCodes(db, userId, "user_disabled", now)` beside
`revokeAllSessions` and reports `enrollmentCodesInvalidated`; the reason is a
**required** `UserCodeBurnReason` argument rather than a literal inside the function,
so `user_deleted` and `user_disabled` stay apart in the only forensic column there
is. `POST /v1/enroll` sits above THE LINE and has no caller, so `callerAuth`'s live
`disabled_at` read cannot reach it. Q1.308.

**Getting back in, and the hole where there is no mail.** A forgotten password is
recovered by `POST /v1/forgot` and by nothing else, and it needs an address the
account has **confirmed**. An API key is *not* a way back: `POST /v1/me/password`
requires the current password whenever there is one, whichever credential is
presenting. **Where SMTP is unconfigured a forgotten password has no remedy at all**
but deleting the account and creating it again; `GET /v1/admin/users` reports
`emailVerified` per row so an admin can see who is exposed to it. Q7.76 records what
closing it would take; Q1.310.

**An invitation is re-sendable.** An invited account holds no password and an address
that is deliberately **unverified** — clicking the link is what proves it — so `POST
/v1/forgot` mails nothing, `verifiedOwnerOf` being what it looks an address up by.
`POST /v1/admin/users/:id/invite` re-mints and re-sends, and **it issues nothing to
the caller**: no token, no password, the link goes to the address on the account. It
is `cpctl admin invite`, and Settings → Users draws it on exactly the rows in that
state. Q1.309.

**Closing registration closes it for links already in flight.** A pending sign-up
lives 24 hours, so `POST /v1/register/confirm` asks `registrationMode(db).enabled`
again before it writes a `users` row and answers `403 registration_disabled` when the
answer changed underneath it. The domain allowlist is deliberately *not* re-checked:
narrowing it is housekeeping, and nobody allowed at sign-up is refused for it.

**Registration is off by default, seeded by env and owned by the database after
that.** A row in `instance_settings` beats `REEMOAT_CP_*`, the admin screen shows
which side won per field, and clearing the override hands it back. Nothing seeds the
table at startup, deliberately — `schema.sql` is re-applied on **every** open, so a
seed would overwrite an admin's change at each restart. The mode matrix is
mechanical: off → admin only · on + no SMTP → name and password, nothing verified ·
on + SMTP → an address is mandatory and **the account does not exist until the link
is opened** (`pending_registrations`, not a `users` row, so an expired sign-up
releases the name).

**An account an admin created must replace its password before it can do anything**,
enforced by a **second positional gate** below THE LINE. Four routes stay reachable
above it — `GET /v1/me`, `POST /v1/me/password`, and both session deletes; everything
else, including every admin route, answers `403 password_change_required` — a 403 and
not a 401, because `cpFetch` and `cpctl` both read a 401 as "this credential is
finished" and would loop. It is **credential-blind**, safe only because `withKey` was
deleted in the same change: such an account cannot hold a key. It is **not** a
security boundary — `relay/authorize.ts` reads no such row, so a token already minted
keeps working for its remaining life.

**A grant is full access to the machine.** There is one person's work on a machine,
and anybody granted it sees all of it. This is the whole authorization model, not a
footnote.

**Revocation is immediate.** The relay reads live user, machine and grant rows before
a byte enters the tunnel, so revoking a grant takes effect on the *next request*.
What a token lifetime still bounds is one thing: a WebSocket already open, which the
daemon closes `4401` on its own ping tick at `exp + leeway`.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/cp.ts` | The only place the browser's credential is sent, and only to this origin — never to a daemon and never to the relay. Signing in and out, changing a password, minting and listing and retiring API keys, the one `Bearer` header, and every gate and server-screen call: `instanceConfig`, `register`/`confirmRegistration`, `requestPasswordReset`/`consumePasswordReset`, `setMyEmail`/`verifyMyEmail`, `adminInviteUser`, `adminSettings`/`adminSaveSettings`, `adminTestMail`. Five hold **no credential at all**: `instanceConfig` is a bare `fetch`, and the other four go through `publicPost` rather than `cpFetch`, whose first act is to refuse without one. Two are typed to refuse a credential *back* — `confirmRegistration` answers `{user: {name}}` and `requestPasswordReset` answers `void` — so no call site can turn a mailed link into a session, and `/forgot` cannot become an enumeration oracle |
| `packages/web/src/ui/SignIn.tsx` | Two fields, once, and no API-key field — that door is `cpctl passwd`. A real `<form>` so Enter submits natively and a password manager can see it, plus the two secondary links `showsGateLink` decides and the `gateNotice` sentence standing in for whichever is missing. It calls `gateOffer` **nowhere**, and `webcheck` reads the file off disk to assert that |
| `packages/web/src/ui/gate/` | Register, confirm, forgot, reset and verify — the five screens reached before there is a credential, in **one** file: the same card, the same token out of the same fragment, the same two error mappers. **Nothing here submits on mount** bar `/verify`, which is idempotent on an account you are already signed in to (`gateNeedsSession`); the rest render a button, because a prefetcher or a mail gateway `GET`s every URL in an inbound message and would spend the link before the human saw it. `GateCard` is the box, shared with `SignIn`, sized `min-h-full` rather than `AppShell`'s `h-dvh` because these render **outside** the shell |
| `packages/web/src/ui/ForcedPasswordChange.tsx` | The wall an admin-created account lands on. **Reached by state, not by a URL**, which is why it is filed beside `SignIn.tsx` and not in `ui/gate/`, and returned before `<AppShell>` in `App.tsx` so a typed `/settings/account` renders it too. **Not a `Sheet`**: Escape must not reveal the app behind an obligation `requirePasswordCurrent` is still enforcing. The current password is *not* waived, and Sign out stays reachable — the only way off this screen for somebody who lost the temporary password |
| `packages/control-plane/src/app.ts` | Routes: login, sessions, passwords, API keys, tokens, machines and their owners, grants, enrollment, admin — plus `GET /v1/instance`, `POST /v1/register` and `/register/confirm`, `/v1/forgot`, `/v1/reset`, `PUT /v1/me/email` and `/v1/me/email/verify`, `POST /v1/admin/users/:id/invite`, `GET` and `PUT /v1/admin/settings`, `POST /v1/admin/settings/test`, `GET /v1/admin/mail` and `POST /v1/admin/mail/:id/retry`. **The `/v1/*` gate is positional** — the public set is the **nine** routes registered above it — and **THE SECOND LINE** below it refuses everything to an account that owes a password, bar the four routes registered between the two. `proveCurrentPassword` carries the `400 bad_request` "currentPassword is required" for two of the three routes that are one; `/v1/me/password` asks inline, because it is also the route that must let an account with no password row set a first one |
| `packages/control-plane/src/settings.ts` | What an admin may change without a redeploy. **A row wins, the environment is the fallback, absence of both is unset** — and absence of a row *is* "read the environment", which is why the table is key/value. No cache and no seed, each for a stated reason |
| `packages/control-plane/src/registration.ts` | A sign-up nobody has confirmed. **Not a `users` row** — a half-created one would hold the login name for ever, and an expired sign-up releases it by doing nothing |
| `packages/web/src/gate.ts` | Every URL rule for the screens reached before there is a credential, and the three exports deciding what a signed-out screen offers. **The fail-open is `showsGateLink`, not `gateOffer`**: `gateOffer` answers three ways (`link`/`closed`/`unknown`) and every caller wants two, so `showsGateLink` is `!== "closed"` — only a definite no hides a door — and `gateNotice` goes through it too, the property being that it is `null` **iff** both links are drawn. Fails open where `visibleSections` fails closed. Q1.312 |
| `packages/web/src/instance.ts` | What the instance allows, and where each setting's value came from. Two predicates on a `null` config answering **oppositely, on purpose**: `adminMayInvite` fails **closed** (`config?.email === true`), the cost being one admin control missing until reload; `mailUsable` fails **open** (`config === null \|\| config.email`) with `showsGateLink`, because hiding the address form takes away the only route to a recovery channel and a `null` config is not evidence about SMTP |
| `packages/control-plane/src/main.ts` | The API's entry point: env, the listener, where the built web client is served from — and `REEMOAT_CP_RELAY_MODE`, which decides whether it also holds the relay or reads presence from the table |
| `packages/control-plane/src/store.ts` | Its own SQLite, same 0700/0600 discipline — this one holds the private key |
| `packages/control-plane/scripts/cpctl.ts` | Terminal client for the control plane |

## Bounds

| | |
|---|---|
| Control-plane bodies | 64 KiB above THE LINE, on the **seven** routes there that take one — `/v1/login`, `/v1/enroll`, `/v1/register`, `/v1/register/confirm`, `/v1/forgot`, `/v1/reset`, `/v1/provision`, the only places somebody whose credential the gate cannot resolve decides how many bytes are read — 256 KiB below it, both answering `413 payload_too_large` in the envelope every client parses. `currentPassword`/`newPassword` are refused over 512 chars |
| Registration | Closed by default. A sign-up holds its login name for **24h** and releases it by expiring — `pending_registrations`, swept at startup, which is what makes a name reusable at all |
