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
pnpm cpctl admin machines            # needs REEMOAT_CP_KEY
pnpm cpctl admin setmachine <id> --name <n>  # rename; there is no address to set
pnpm cpctl login <name|email>        # password sign-in; prints a REEMOAT_CP_KEY
pnpm cpctl passwd                    # your own; nobody else's
pnpm cpctl key | keys --revoke <id>  # mint yourself an API key; retire one of yours
pnpm cpctl email [<address>]         # your address, the only thing that makes recovery work
pnpm cpctl admin settings [<k> <v> | --clear <k>]  # registration, machine limits, SMTP, and which
                                     #   side each value came from
pnpm cpctl admin settings <secret k> # no <v>: prompted with echo off, or one stdin line without a
                                     #   tty. `SECRET_SETTING_KEYS` is imported, not transcribed. Q1.300
pnpm cpctl admin mail | testmail [<addr>]   # what went out and failed; queue a test
pnpm cpctl sessions [--all]          # where you are signed in; --all signs them all out
pnpm cpctl addmachine <name>         # a machine of your own, enrolled in one step
pnpm cpctl shares <machineId> | share <machineId> <userId> | unshare <machineId> <userId>
                                     # the owner's verbs, through ownership. No `admin grant`: a grant
                                     #   is full access, so only the owner writes one. Ids from `me`
pnpm cpctl leave <machineId>         # the grantee's one verb: give up a share (written without asking)
pnpm cpctl provision <user> <machine> # REEMOAT_CP_PROVISION_KEY and no account at all: creates the
                                     #   machine, raises their limit to fit, prints an enrollment code
pnpm cpctl admin provisionkey [--new]  # whether one exists; --new mints and retires the old (shown once)
pnpm cpctl admin machinelimit <id> [<n>|default]  # lowering switches off the newest, deletes nothing;
                                     #   default is `admin settings machines.per_user`, unset means 50
pnpm cpctl admin deluser <id> | disable <id>  # delete is irreversible; disable is undoable
pnpm cpctl admin invite <id>         # resend an invitation, the only way back for one never received
pnpm cpctl admin relay               # tunnels up, traffic, offline since (`machine_last_seen`). Q1.311
pnpm cpctl admin signingkeys | rotatekey | retirekey <kid>
                                     # the **oldest** active key signs: rotate publishes, retire is the
                                     #   switch, once the fleet has been offered the statement naming the
                                     #   new one (`machinesBehind`). The last active key is refused
pnpm cpctl admin root [adopt <jwk>] | admin keyset draft | install   # the root that vouches for the key set
pnpm cpctl root new | sign --key <file> | handover   # local, no server: an off-host root's own verbs
```

**No route issues a credential for an account other than the caller's**: no
`admin passwd`, no `admin key`; `db.prepare("INSERT INTO api_keys` appears in `app.ts` once,
not on a route reading `c.req.param("id")`, which `relaycheck` asserts. Q1.301. An admin
has **no verb over anybody's keys**, not even a count (Q1.631); the admin's remedy is
the account (`disable`, `DELETE /v1/admin/users/:id`). Giving an ownerless machine an
owner has no cpctl verb (`PUT /v1/admin/machines/:id/owner`).

## Settings

**The keys in `SETTING_KEYS` (machine limit, registration, SMTP) are seeded by env and
owned by the database**: a row in `instance_settings` wins, `REEMOAT_CP_*` is the
fallback, neither is unset. Everything else (listeners, relay URL, paths, signing key,
`REEMOAT_CP_TRUSTED_PROXY_HOPS`) is env only and needs a restart. An env file is not
evidence of what runs, so `GET /v1/admin/settings` reports which side won per field. The
count is `SETTING_KEYS.length`, read by `relaycheck`, never a literal. Q1.302. **Nothing
seeds the table at startup**: `schema.sql` is re-applied on every open and a seed would
overwrite an admin's change.

**`REEMOAT_CP_MACHINES_PER_USER` is also read by the relay** from its own environment
(`quota.ts` runs in both); `compose.yml` gives both one `env_file` (a relay elsewhere has
its own `environment:` and can disagree), and a row wins in both.

**Two browser-facing values are env only**: `REEMOAT_CP_PLUGIN_CATALOGUE_URL`, because
`createControlPlaneApp` builds the `Content-Security-Policy` from it once; and
`REEMOAT_CP_APP_DOWNLOAD_URL`, because `SETTING_KEYS` is drawn on every instance's
Server settings and it names one deployment's build. Both read in `main.ts`, checked
with `isBrowserReachable`, warned-and-ignored, passed as constructor options, published
on `GET /v1/instance` as **an address, not a boolean**, with no compiled-in default
(forks run their own); `deploycheck` asserts both are in `.env.example`.
`REEMOAT_CP_MACHINES_OFFER_URL` is deleted (Q1.650): passed to nothing, `main.ts` warns
once if set, `deploycheck` asserts it is not read by name.

**One compiled-in value breaks the rule on purpose**: `OPERATOR` (`legal/operator.ts`),
the party the legal documents name on every instance's sign-up screen. The prose is true
of any deployment and the party is not, so a fork replaces that one field. Q1.638;
`legal-pages.md`.

## Accounts

**Sign-in is a name or a confirmed address, plus a password.** The name resolves first,
then the address through `verifiedOwnerOf` — **verified only**, since
`idx_user_emails_verified` is partial and an unverified claim from the anonymous
`/v1/register` reserves nothing. `USER_NAME` has no `@`; the fixed order settles a
legacy collision without a new status code (an existence oracle). One account named two
ways spends **two** throttle counters (`loginKey` is built from what was submitted;
keying on the account is the lockout weapon); `addressKey` bounds the doubling. One
password per user (scrypt, `user_passwords`). The session token is a bearer, **never** a
cookie (`src/cors.ts` answers `*`, no credentials). **`SignIn` takes no key**: a
key-only account sets a first password with `cpctl passwd`, which needs no current
password when there is no `user_passwords` row; a key already in `localStorage` is
adopted. `callerAuth` resolves either by its three-character prefix. No OAuth. Q1.303.

**API keys are retired by their holder alone**, `DELETE /v1/me/keys/:keyId` through
`revokeApiKey`, and listed by `GET /v1/me/keys` (`apiKeyRows`: prefix, created, last
presented, never the key or hash). `POST /v1/me/password` revokes sessions and leaves
keys alone. `/v1/me` reports `passwordChangedAt` (`NULL` for an admin-issued password).
Q1.304, Q1.629; code-level rules in `cp-credentials.md`.

**Disable is reversible, delete is not.** `DELETE /v1/admin/users/:id` removes, in one
transaction, every credential that authenticates as them — password, keys, sessions and
origins, grants, **and their unredeemed enrollment codes** (`burnUserCodes`,
`used_from = 'user_deleted'`) — frees the name (`users.name` is UNIQUE; a disabled row holds it for
ever) and **revokes their machines** (`machinesRevoked`). `enrollment_codes.created_by`
is left dangling on purpose. Deleting *yourself* is refused, so an enabled admin always
remains. Q1.307. **`disable` does not revoke machines but burns their codes**:
`burnUserCodes(db, userId, "user_disabled", now)` beside `revokeAllSessions`, reporting
`enrollmentCodesInvalidated`; `enable` does not restore them. The reason is a
**required** `UserCodeBurnReason`, keeping the two apart in the only forensic column.
`POST /v1/enroll` sits above THE LINE, out of reach of `callerAuth`'s live
`disabled_at` read. Q1.308.

**Recovery is `POST /v1/forgot` alone, to a confirmed address.** An API key is not a way
back (`cp-credentials.md` has which routes ask the current password; Q1.630, amended).
**Without SMTP a forgotten password has no remedy** but deleting and recreating the
account; `GET /v1/admin/users` reports `emailVerified` per row to show who is exposed.
Q7.76, Q1.310.

**An invitation is re-sendable.** An invited account has no password and a deliberately
**unverified** address, so `POST /v1/forgot` mails nothing.
`POST /v1/admin/users/:id/invite` (`cpctl admin invite`, Settings → Users on those rows)
re-mints and re-sends to the account's address and **issues nothing to the caller**.
Q1.309.

**Registration is off by default.** Modes: off → admin only · on without SMTP → name and
password, nothing verified · on with SMTP → an address is mandatory and **the account
does not exist until the link is opened** (`pending_registrations`, so an expired
sign-up releases the name). **Closing it closes links in flight**:
`POST /v1/register/confirm` re-asks `registrationMode(db).enabled` before writing a `users` row
and answers `403 registration_disabled`. The domain allowlist is deliberately not
re-checked.

**An admin-created account must replace its password first**, enforced by a **second
positional gate** below THE LINE. Above it stay `GET /v1/me`, `POST /v1/me/password` and
both session deletes; everything else, admin routes included, answers
`403 password_change_required` — not 401, which `cpFetch` and `cpctl` read as "credential
finished" and would loop. **Credential-blind**, safe because `withKey` is deleted (such
an account holds no key). **Not a security boundary**: `relay/authorize.ts` reads no such
row, so a minted token keeps working.

**A grant is full access to the machine**: the whole authorization model. **Revocation
is immediate**: the relay reads live user, machine and grant rows before a byte enters
the tunnel. A token lifetime bounds only an open WebSocket, which the daemon closes
`4401` on its ping tick at `exp + leeway`.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/cp.ts` | The only place the browser's credential is sent, only to this origin — never a daemon or the relay. Sign-in/out, passwords, API keys, the one `Bearer` header, every gate and server-screen call. Five hold **no credential**: `instanceConfig` is a bare `fetch`, four use `publicPost`, not `cpFetch` (which refuses without one). `confirmRegistration` answers `{user: {name}}` and `requestPasswordReset` `void`, so no mailed link becomes a session and `/forgot` is no enumeration oracle |
| `packages/web/src/ui/SignIn.tsx` | Two fields, no API-key field. A real `<form>`; the secondary links `showsGateLink` decides, `gateNotice` for whichever is missing. Calls `gateOffer` **nowhere** (`webcheck` reads the file) |
| `packages/web/src/ui/gate/` | Register, confirm, forgot, reset, verify in **one** file: one card, one fragment token, two error mappers. **Nothing submits on mount** but `/verify` (idempotent while signed in, `gateNeedsSession`), since prefetchers and mail gateways `GET` every URL. `GateCard`, shared with `SignIn`, is `min-h-full`, not `h-dvh`: outside the shell |
| `packages/web/src/ui/ForcedPasswordChange.tsx` | Reached by state, not URL (so beside `SignIn.tsx`), returned before `<AppShell>` in `App.tsx`, so a typed `/settings/account` renders it too. **Not a `Sheet`**: Escape must not reveal the app while `requirePasswordCurrent` holds. The current password is not waived; Sign out stays reachable, the only exit after losing the temporary password |
| `packages/control-plane/src/app.ts` | All routes. **The `/v1/*` gate is positional** (`cp-credentials.md` lists the public ten); **THE SECOND LINE** below it refuses an account owing a password, bar the four routes between. `/v1/me/keys` takes the session alone |
| `packages/control-plane/src/settings.ts` | **A row wins, env is the fallback, neither is unset**; no row *is* "read the env", hence key/value. No cache, no seed |
| `packages/control-plane/src/registration.ts` | An unconfirmed sign-up, **not a `users` row**, so expiry releases the name |
| `packages/web/src/gate.ts` | URL rules for pre-credential screens. **The fail-open is `showsGateLink`** (`!== "closed"` over `gateOffer`'s `link`/`closed`/`unknown`); `gateNotice` is `null` **iff** both links are drawn. Fails open where `visibleSections` fails closed. Q1.312 |
| `packages/web/src/instance.ts` | On a `null` config, `adminMayInvite` fails **closed** (`config?.email === true`) and `mailUsable` fails **open** (`config === null \|\| config.email`), since hiding the address form removes the only route to recovery |
| `packages/control-plane/src/main.ts` | The API entry: env, listener, gate directory, and `REEMOAT_CP_RELAY_MODE` |
| `packages/control-plane/src/store.ts` | Its own SQLite, 0700/0600; holds the private key |

## Bounds

| | |
|---|---|
| Control-plane bodies | 64 KiB above THE LINE on its seven body routes (`cp-credentials.md`), 256 KiB below, both `413 payload_too_large` in the envelope. `currentPassword`/`newPassword` refused over 512 chars |
| Registration | Closed by default. A sign-up holds its name **24h** and releases it by expiring; `pending_registrations` is swept at startup |
