---
paths:
  - packages/control-plane/src/password.ts
  - packages/control-plane/src/sessions.ts
  - packages/control-plane/src/throttle.ts
  - packages/control-plane/src/net.ts
  - packages/control-plane/src/app.ts
  - packages/web/src/account.ts
  - packages/web/src/device.ts
  - packages/web/src/ui/settings/UsersSection.tsx
  - packages/web/src/ui/settings/AccountSection.tsx
---

## Invariants

- **The `/v1` gate is positional: the public set is the routes above THE LINE.** One
  `app.use("/v1/*", callerAuth(db))` after them fails closed: a new public route goes
  above deliberately, a private one goes below by doing nothing. **Ten**, in order:
  `/health`, `/v1/jwks`, `POST /v1/login`, `POST /v1/enroll`, `GET /v1/instance`,
  `POST /v1/register`, `POST /v1/register/confirm`, `POST /v1/forgot`, `POST /v1/reset`,
  `POST /v1/provision`. The **seven** taking a body carry `PUBLIC_BODY_LIMIT_BYTES` on
  the route, since the `app.use("/v1/*")` raising the limit to 256 KiB is below them.
  **Above is not unauthenticated**: `/v1/enroll` and `/v1/provision` carry an
  enrollment code or the provisioning key in the body (`callerAuth` resolves only a
  person's credential), each with its own throttle namespace. Q1.400.
- **A password never goes through `hashCredential`**, which `.trim()`s. `password.ts`
  normalizes NFKC and never trims.
- **Every login branch spends a verification**: an unknown name, no password row and a
  disabled account verify against a decoy in the same concurrency slot, or timing is a
  user oracle. Q1.401.
- **Login answers one thing**: unknown name, unknown or *unverified* address, wrong
  password, no password row are all `401 invalid_login`, and the client's sentence names
  no half. `403 user_disabled` only after the password verified. The body field `name`
  takes either, bounded at `MAX_EMAIL_CHARS`.
- **What must prove the current password is decided per route, and on one per
  credential.** `POST /v1/me/password` asks **always**. `PUT /v1/me/email` asks **only
  an API-key caller with a password** (`caller.via`): a session changes the address
  alone by the owner's decision, the cost written at the route, while a key can leak
  with no person in the chain (Q1.630, amended 2026-09-05). `POST /v1/me/keys` asks
  **never**. Both askers use `verifyCurrentPassword`, which takes the stored hash, so the
  exception — **no password row**, where the key is the proof and may set a first
  password — is written at each route, never carried by the helper (Q7.81). The email
  arm verifies before any write or mail, spending only `passwordChangeKey`. The browser
  never sends a password on the email leaf: a browser presenting a key is the legacy
  adoption and draws the server's `400` sentence. **There is no admin password reset.**
  Q1.403.
- **A guessing counter is keyed on a composed key, never a name alone.** The builders —
  `loginKey(name, address)`, `addressKey(address)`, `passwordChangeKey(userId)`,
  `registerKey`, `mailKey`, `resetMailKey`, `confirmKey`, `resetKey`, `mailTestKey`,
  `enrollKey`, `provisionKey`; the list is the count — are the only spelling, each
  namespaced because the address half is caller-supplied (a login naming `pwchg` must
  not write a password-change key). Keyed on the bare name it is a **lockout weapon**.
  `passwordChangeKey` is on the user id, out of any anonymous caller's reach;
  `addressKey` is the backstop under the looser `ADDRESS_THROTTLE`; a many-address
  sprayer is bounded by `password.ts`'s public lane. Q1.404, Q1.305.
- **The address half is only as good as `REEMOAT_CP_TRUSTED_PROXY_HOPS`**: default **0**
  ignores `x-forwarded-for`; entries count **from the right**; fewer entries than hops
  falls back to the socket. `install.sh` asks; `main.ts` warns once when the header
  arrives while ignored. Q1.306.
- **The attempt is recorded before the `await` and un-recorded on success**: `check` is
  synchronous, and `succeed` runs as soon as the password verifies, before the disabled
  check. Q1.405.
- **`scryptSync` is never on a live path** (this process carries the API, every tunnel
  and `serveStatic`); the one exception is the decoy hash at module load. Q1.406.
- **`HashLane` has no default**; the lane is the route's side of THE LINE.
  `POST /v1/me/password` and `POST /v1/admin/users` are authenticated; **`POST /v1/reset` is
  `"public"`** with `/v1/login` and `/v1/register` (a spray can delay a reset, bounded
  by the public wait list). `release` wakes an authenticated waiter first. The decoy
  takes the **same** lane as a real verification. Q1.407.
- **One `UPDATE api_keys` changes what a key is, on one route**: `revokeApiKey` behind
  `DELETE /v1/me/keys/:keyId`, the holder's own; its `user_id` clause makes a listed key
  id worthless to anybody else. The other `UPDATE` is `touchKey`: `last_used_at` on an
  accepted bearer, at most once per `KEY_TOUCH_INTERVAL_MS`, never on a revoked row
  (Q1.629). **No password change retires a key**; an admin's remedy is the account.
  As with `sessionOf`: a property the code appears to have and nothing enforces is worse
  than one it visibly lacks. Q1.408, Q1.631.
- **A credential does not outlive the person who minted it**: `burnUserCodes` runs
  inside the delete's `BEGIN`/`COMMIT`, synchronously, and `disable` burns too, because
  `/v1/enroll` reads neither `created_by` nor `users.disabled_at` (`cp-accounts.md`).
  `POST /v1/reset` leaves codes alone: proving your address is not evidence a daemon is
  compromised. Q1.409.
- **Revoking a machine gives back its label and one of `MAX_MACHINES_PER_USER`**:
  `releaseOwner` runs in the same transaction as the `UPDATE` and the code burn, on
  **both** revoke routes, no `return` between `BEGIN` and `COMMIT`. The inverse,
  `PUT /v1/admin/machines/:id/owner`, exists because `INSERT INTO machine_owners` is only in
  `createOwnedMachine` (always a fresh id), and writes the grant with the ownership row.
  Q1.410.
- **The client decides on the code, never the status**: `authFailure` returns `null`
  for `403 forbidden` (`requireAdmin`'s answer to every non-admin) and for
  `401 invalid_password`, a 401 about the body from `/v1/me/password` and the API-key arm of
  `PUT /v1/me/email`. Q1.411.
- **A 401 signs you out only about the credential it was sent with**: `cpFetch` captures
  `const sent = credential` and tears down only while `credential === sent`;
  `setSession` always allocates. `CP_TIMEOUT_MS` is ten seconds. Q1.412.
- **A `429` says the real number**: `tooManyAttempts` sends `Retry-After` *and*
  `detail.retryAfterSeconds`; only the body reaches an `ApiError` (`parseBody` takes no
  `Response`). `retryAfter`/`waitText` in `account.ts`.
- **A session records what it said about itself; recognition, not evidence.**
  `user_session_origins` (a table, not columns, for the `migrate()` reason) holds each
  sign-in's `User-Agent` and address, both caller-supplied: the list exists to **end**
  sessions, and nothing authorizes on either. Older sessions list with nulls.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/account.ts` | `authFailure` on the **code**, `retryAfter`/`waitText`/`tooManyAttemptsText` off the **body**; the password and gate-error vocabulary (`PASSWORD_MIN`/`PASSWORD_MAX`, `passwordProblem`, `signInError`, `linkError`, `registerError`, `changePasswordError`, `userState`/`userStateText`), shared by `SignIn`, `Gate`, `ForcedPasswordChange`, `AccountSection`, `UsersSection` |
| `packages/web/src/device.ts` | A `User-Agent` as two words. The table is **ordered** (agents are subsets of each other). Recognition, never identification; *nothing recorded* differs from *nothing readable* |
| `packages/control-plane/src/password.ts` | Async scrypt, a self-describing hash, a decoy, a memory-bounded semaphore |
| `packages/control-plane/src/sessions.ts` | `rs_` tokens, absolute and idle expiry, the two statements on the auth path, origins |
| `packages/control-plane/src/net.ts` | The apparent caller address, and why it is not evidence. Pure, so `relaycheck` reaches every branch |
| `packages/control-plane/src/throttle.ts` | Composed, namespaced keys. Four instances: login, per-address, mail, reset mail (so the reset budget cannot be spent by whoever wants it gone). In memory, self-bounded |

## Bounds

| | |
|---|---|
| Passwords | scrypt N=2^15 r=8 p=1, ~51ms and 32 MiB; `maxmem` **128 MiB** explicit (above N=2^14 the default **throws**; a stored row over the ceiling is a refusal). 12–256 chars, NFKC, never trimmed. **4 concurrent hashes, at most 2 `"public"`**. Wait lists **per lane**: 32 authenticated, 16 public, then `503 overloaded` with `Retry-After: 1` |
| Sessions | 30 days absolute, 14 idle, `last_seen_at` at most every 15 min. 10 per user, oldest revoked. Origins clamped at 256 chars of `User-Agent`, 64 of address. Revoked rows kept **7 days**, then swept at startup with their origins |
| Authenticated writes | **60 per minute per `<user, route>`**, then a flat 10s: bounds cost, not guessing. `writeKey(userId, what)`, `what` a fixed literal per route. Q1.413 |
| Login throttle | **5 failures per 15 min per `<name, address>`**, then 30s doubling (exponent clamped at 30) to 15 min. `ADDRESS_THROTTLE` **30 per address** (shared by NATs and offices); a `429` reports the longer. 10 000 keys per instance; `MAX_KEY_CHARS` is computed as the longest key any builder writes (325, `loginKey`; `relaycheck` asserts every builder fits); 254 per login identifier, 120 per name half elsewhere, addresses 64, mail keys 254. In memory: a restart clears it |
| API keys | **10 live per account** |
