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

**Identity**

- **The `/v1` gate is positional, and the public set is "the routes above the
  line".** One `app.use("/v1/*", callerAuth(db))` placed after the public set fails
  closed for everything future: a new **public** route goes above that line
  deliberately, a new private one goes below it by doing nothing. It is **ten** now,
  in registration order: `/health`, `/v1/jwks`, `POST /v1/login`, `POST /v1/enroll`,
  `GET /v1/instance`, `POST /v1/register`, `POST /v1/register/confirm`,
  `POST /v1/forgot`, `POST /v1/reset`, `POST /v1/provision`. The **seven** that take a
  body carry `PUBLIC_BODY_LIMIT_BYTES` on the route itself, because the
  `app.use("/v1/*")` raising the limit to 256 KiB is registered below and never reaches
  them. **"Above the line" is not "unauthenticated"**: `/v1/enroll` and `/v1/provision`
  carry a credential *in the body* — an enrollment code and the fleet provisioning key
  — and are up here because `callerAuth` resolves a *person's* credential and would
  refuse theirs, which is why both bring their own throttle namespace. Q1.400.
- **A password never goes through `hashCredential`.** That function calls `.trim()`,
  right for a token pasted out of a terminal and catastrophic for a password ending in
  a space — stored trimmed, compared trimmed, and appearing to work until it meets a
  field that does not. `password.ts` normalizes NFKC and never trims.
- **Every login branch spends what a verification spends.** An unknown name, a user
  with no password row and a disabled account all verify against a decoy and take the
  same concurrency slot — otherwise the difference is a user oracle measurable over
  the network. Q1.401.
- **Login answers one thing.** Unknown name, unknown or *unverified* address, wrong
  password and no-password-row are all `401 invalid_login`, and the client's sentence
  names no half of the form either. `403 user_disabled` comes *only after* the
  password verified, which leaks nothing to somebody who does not already hold it.
  The body field is still `name` and takes either, bounded at `MAX_EMAIL_CHARS`
  rather than 200 — a legal address refused as `bad_request` would be its own oracle.
- **Three self-service routes, and which of them asks for the current password is
  decided per route and, on one of them, per credential.** `POST /v1/me/password`
  asks **always**, even under a valid session. `PUT /v1/me/email` asks **only an
  API-key caller with a password**: a session adds or changes the address alone, by
  the owner's decision (Q1.630, 2026-09-04) — with the cost written at the route,
  since repointing the reset channel from a stolen session is a chain to a password
  the thief chose, bounded by every sign-in being listed and one tap to end — while
  a key is a machine credential that can leak from a disk with no person in the
  chain and no admin reset behind it, so the same chain is closed to it (the
  amendment of 2026-09-05; `caller.via` is what the route reads). `POST /v1/me/keys`
  asks **never**: cloning a key escalates nothing. `proveCurrentPassword` is deleted
  with its two callers; what the two routes that ask share is `verifyCurrentPassword`,
  which takes the stored hash rather than looking one up, so that the one exception —
  an account with **no password row**, whose API key is the proof, because it must be
  let set a first one — is written at each route and cannot become an exemption the
  helper carries on its own (Q7.81 is what that cost once). The email arm verifies
  before any write and before any mail, so a wrong guess spends `passwordChangeKey`
  and nothing else. The browser never sends a password on the email leaf, and does not
  need to: `SignIn` takes no key, so a browser presenting one is the legacy adoption
  and draws the server's `400` sentence. **There is no admin password reset** — an
  admin cannot enter anybody's account at all. Q1.403.
- **A guessing counter is keyed on a composed key and never on a name alone — and
  the address half is only as trustworthy as a proxy you configured.** The builders
  are `loginKey(name, address)`, `addressKey(address)`, `passwordChangeKey(userId)`,
  `registerKey`, `mailKey`, `resetMailKey`, `confirmKey`, `resetKey`, `mailTestKey`,
  `enrollKey` and `provisionKey` — the list is the count, because a numeral here said
  "ten" the day the eleventh arrived. They are the only way a key is spelled, and every
  one is namespaced, because the address half is caller-supplied: with a bare
  `<name>|<address>` a login naming `pwchg` and forwarding a user id writes exactly the
  key a password change reads. Keyed on the bare name it is a **lockout weapon**
  reachable from anywhere with no credential. Q1.404.
- **The attempt is recorded before the `await`, and un-recorded on success.** `check`
  is synchronous, so a `fail` running only *after* `await verifyPassword` lets every
  guess arriving inside one KDF window see a counter nothing has incremented yet — the
  throttle then measures the semaphore rather than the guesses. `succeed` is what makes
  recording optimistically free, and it is called as soon as the password verifies,
  deliberately *before* the disabled check. Q1.405.
- **`scryptSync` is never called on a live path.** That process carries the API
  listener, every relay tunnel and `serveStatic`, so the synchronous form makes a
  handful of logins a second a fleet-wide outage reachable by anyone who can POST. The
  one exception is the decoy hash, built at module load before any listener exists.
  Q1.406.
- **A hash names which side of the credential gate it is for, and `HashLane` has no
  default.** The lane is about which side of THE LINE the route sits on and not about
  how the caller feels: `POST /v1/me/password` and `POST /v1/admin/users` are
  authenticated, while **`POST /v1/reset` takes `"public"`**
  and shares that lane with `/v1/login` and `/v1/register`, so a login spray can still
  queue a mailed recovery behind it — bounded rather than closed, by the public lane's
  own wait list. `release` wakes an authenticated waiter first, unconditionally: a fair
  queue under a spray is always the sprayer. The decoy takes the **same** lane as a real
  verification, because a decoy waiting elsewhere rebuilds the user oracle out of the
  defence against flooding. Q1.407.
- **A credential the code can read is a credential something must be able to write.**
  There is **one `UPDATE api_keys` statement that changes what a key *is*, reached
  by two routes**: `revokeApiKey` behind `DELETE /v1/me/keys/:keyId` and
  `DELETE /v1/admin/users/:id/keys/:keyId`. The second `UPDATE` on that table is a
  bookkeeping one — `touchKey` writes `last_used_at` on an accepted bearer lookup,
  at most once per `KEY_TOUCH_INTERVAL_MS` and never on a revoked row, so a leaked
  key's row says when it was last presented (Q1.629). **No
  password change on this service retires a key** — revoking it is its own act, and it
  is the one an admin has. Same shape `sessionOf` is named for: **a property the code
  appears to have and nothing enforces is worse than one it visibly lacks.** Q1.408.
- **A credential does not outlive the person who minted it.** `burnUserCodes` runs
  inside the delete's existing `BEGIN`/`COMMIT` — synchronous, like everything else in
  that block, so there is no `await` on a shared connection — and **the invariant is
  about the code, not about the route**: `POST /v1/admin/users/:id/disable`, the
  *reversible* remedy, burns them too, because `/v1/enroll` reads neither `created_by`
  nor `users.disabled_at`. `used_from` records `'user_deleted'` or `'user_disabled'`
  as a **required** argument rather than a literal inside the function, because those
  are different events and that column is the only forensic trail there is;
  `created_by` is left dangling on purpose. `POST /v1/reset` deliberately leaves codes
  alone — proving control of your own address is not evidence that a daemon you
  enrolled is compromised. Q1.409.
- **Revoking a machine gives back what it consumed** — the label and one of
  `MAX_MACHINES_PER_USER`, neither released by `machine_owners` itself.
  `releaseOwner` runs inside the same transaction as the `UPDATE` and the code burn, on
  **both** revoke routes, with no `return` between `BEGIN` and `COMMIT`. The inverse is
  `PUT /v1/admin/machines/:id/owner`, which has to exist because `INSERT INTO
  machine_owners` happens only inside `createOwnedMachine` and that always mints a fresh
  id; it writes the grant with the ownership row, because an owner with no grant owns a
  machine that appears in no list. Q1.410.
- **The client decides on the code, never the status.** `authFailure` returns `null`
  for `403 forbidden`, because `requireAdmin` answers that to every non-admin — and in
  the other direction for `401 invalid_password`, a 401 about the request *body*,
  reachable from `/v1/me/password` and from the API-key arm of `PUT /v1/me/email`:
  mistyping your own password on the screen that fixes a suspected leak must not be
  what ends the tab. Q1.411.
- **A 401 signs you out only about the credential it was sent with.** `cpFetch`
  captures `const sent = credential` before building the header and tears down only
  while `credential === sent`; `setSession` always allocates, so identity is the whole
  comparison. `CP_TIMEOUT_MS` is ten seconds, ample for a request carrying an expired
  token to answer *after* a wake has signed out and a fresh sign-in has succeeded.
  Q1.412.
- **A `429` says the real number.** `tooManyAttempts` sends `Retry-After` *and*
  `detail.retryAfterSeconds`, and the body is the half a client can read: `parseBody`
  takes a status, a status text and a string, never a `Response`, so no header reaches
  an `ApiError` at all. `retryAfter`/`waitText` in `account.ts` are why somebody facing
  a fifteen-minute block is not told to "wait a moment".

## Layout

| File | Holds |
|---|---|
| `packages/web/src/account.ts` | What a credential is and what a refusal of one means: `authFailure` on the **code**, `retryAfter`/`waitText`/`tooManyAttemptsText` off the **body**. Also the whole password and gate-error vocabulary — `PASSWORD_MIN`/`PASSWORD_MAX`, `passwordProblem`, one named reader per refusal (`signInError`, `linkError`, `registerError`, `changePasswordError`), `userState`/`userStateText`. Five screens import it — `SignIn`, `Gate`, `ForcedPasswordChange`, `AccountSection`, `UsersSection` — which is why the wording of a refusal lives here rather than five times |
| `packages/web/src/device.ts` | A `User-Agent` as two words somebody can recognise. The table is **ordered**, because these agents are subsets of each other on purpose. Recognition, never identification — and *nothing recorded* is a different sentence from *nothing readable* |
| `packages/control-plane/src/password.ts` | The one credential a human chose: async scrypt, a self-describing hash, a decoy for the refusal path, and a semaphore bounded by memory |
| `packages/control-plane/src/sessions.ts` | Signed-in browsers: `rs_` tokens, absolute and idle expiry, the two statements on the authentication path, and what each sign-in said about itself |
| `packages/control-plane/src/net.ts` | What address a request appears to come from, and why that is not evidence. Pure, so `relaycheck` reaches branches no socket here can |
| `packages/control-plane/src/throttle.ts` | What stops somebody guessing. **A key is composed** — a namespaced builder per counter and no other way to spell one, the list being the count, and the header says what the address half is honestly worth. Four instances: login, per-address, mail, and reset mail — the fourth because the budget carrying a password reset must not be spendable by whoever wants it gone. In memory, bounded against itself |

## Bounds

| | |
|---|---|
| Passwords | scrypt N=2^15 r=8 p=1, ~51ms and 32 MiB each; `maxmem` passed explicitly at **128 MiB** (above N=2^14 the default 32 MiB ceiling **throws**, and a stored row naming parameters over the ceiling is a refusal rather than a throw). 12–256 characters, NFKC, never trimmed. **4 concurrent hashes, of which at most 2 are `"public"`** — an anonymous spray must not starve an authenticated one. Wait lists are **per lane**: 32 authenticated, 16 public, then `503 overloaded` with `Retry-After: 1` |
| Sessions | 30 days absolute, 14 idle, `last_seen_at` written at most once per 15 min. 10 per user, oldest revoked rather than newest refused. Each records what it said about itself, clamped at ingest: 256 chars of `User-Agent`, 64 of address. A revoked row is kept **7 days** and then swept at startup with its origin — non-zero because deleting on revoke makes the day something does read it unanswerable |
| Authenticated writes | **60 per minute per `<user, route>`**, then a flat 10s — the first counter that counts somebody signed in. Generous and non-escalating on purpose: this bounds cost rather than guessing, and the likely caller is a retry loop. `writeKey(userId, what)`, namespaced, `what` a fixed literal per route so hammering one cannot lock the other. Q1.413 |
| Login throttle | **5 failures per 15 min per `<name, address>` pair**, then 30s doubling (exponent clamped at 30) to 15 min — never per name alone, which is a lockout weapon. `ADDRESS_THROTTLE` counts **30 per address**, looser because that key is shared by a NAT, an office, a proxy that forwards nothing; a `429` reports the longer of the two. A password change is `passwordChangeKey(userId)` and `POST /v1/enroll` is `enrollKey(address)`, each its own namespace. 10 000 keys per instance, **320 chars per composed key**, **254 per login identifier** (it may be an address now, and at 120 a long one was cut at the point that throws the address half away) and 120 per name half elsewhere, addresses 64 — and mail keys 254, which is why the composed cap is 320 rather than 200: at 200 `MAX_EMAIL_KEY_CHARS` was unreachable and two addresses sharing 200 characters shared one counter. In memory: a restart clears it. **The address is the socket unless `REEMOAT_CP_TRUSTED_PROXY_HOPS` says otherwise** — read from the right, and every one of these counters is only as good as that setting |
| API keys | **10 live per account.** New with self-service minting: nothing bounded this table before, because only an admin could write to it |
