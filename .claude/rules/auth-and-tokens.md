---
paths:
  - src/auth.ts
  - src/token.ts
  - src/enroll.ts
  - packages/control-plane/src/keys.ts
  - scripts/authcheck.ts
---

## Identity

`REEMOAT_AUTH`: `shared_secret` (default, no control plane), `signed`, or `both`. Under
`signed` the daemon verifies Ed25519 tokens against a public key obtained **once**, at
enrollment, and **never contacts the control plane again**, so an outage there cannot
stop a session, a daemon start or a verification. Q1.9. The control plane is always on
the data path (the tunnel the daemon dialled), but the daemon is never *asked*
anything: no key fetched, no revocation list polled, no token validated over the
tunnel. Q1.10.

## Invariants

- **No claim is read before the signature verifies**: `decodeToken` returns the
  payload as an *unparsed string*.
- **`aud` is checked against the enrolled `machineId`.** Every daemon trusts the same
  key, so without it one grant is a grant to every machine. The most consequential line
  in `auth.ts`.
- **`alg` is compared to the exact string `EdDSA` first**, and the key is found by
  `kid` in a set already held, making `alg: "none"` and HMAC-with-the-public-key
  impossible. Never a table lookup.
- **base64url decoding is strict**: `Buffer.from(s, "base64url")` skips bad characters
  (one token becomes a family, `jti` nothing), so `b64uDecode` re-encodes and compares.
- **Enrollment single-use is one conditional `UPDATE`, then `changes === 1`**, never
  read-then-mark.
- **A restart with the same enrollment code makes no network call** (codes are
  single-use).
- **The daemon makes exactly one control-plane *request*, ever**: enrollment, in
  `enroll.ts`. The tunnel is a connection, never asked anything. No code may *read
  something it needs* from the control plane; key rotation costs a re-enrollment, which
  is why the key set is plural.

## Layout

| File | Holds |
|---|---|
| `src/token.ts` | Compact JWS over Ed25519: "did this key produce these bytes", no policy |
| `src/auth.ts` | `Principal`, `TokenVerifier`, the three implementations, `AUTH_LEEWAY_MS`; what a verified token entitles |
| `src/enroll.ts` | The single control-plane call |
| `packages/control-plane/src/keys.ts` | Signing keys, key ids, and every opaque credential, each with its prefix: API keys, enrollment codes, tunnel keys, session tokens (`rs_`), `newEmailToken` (`et_`, verify/reset/invite), `newRegistrationToken` (`pr_`) — the last two storing only a hash, the plaintext only in one message body. `burnMachineCodes` on a revoke, `burnUserCodes` on a delete **or a disable**, `usedFrom: UserCodeBurnReason` a required argument |
| `scripts/authcheck.ts` | Offline driver for `token.ts`/`auth.ts`/`enroll.ts` |

## Bounds

| | |
|---|---|
| Tokens | 300s lifetime (floor 120s), 60s clock leeway either side; bounds only a WebSocket already open |
| Enrollment codes | single-use, 1 hour, burned early four ways, recorded in `used_from`: the next mint for that machine (`superseded`), a machine revoke (`revoked`), deleting the minting user (`user_deleted`), **disabling** them (`user_disabled`, not undone by `enable`) |

## Known gotchas

- **`jose` is in the lockfile but unimportable**; the JWS is hand-rolled on
  `node:crypto`. Q1.200.
- **Clock skew is reported both ways**: `reportSkew` logs a rejection within
  `SKEW_DIAGNOSTIC_LIMIT_MS` (5× leeway), the verifier returns
  `detail: {skewMs, daemonTime, leewayMs}`, `/health` carries `time`. Q1.201.
- **A present-but-malformed `Authorization` header fails, never falls through**:
  `bearerToken` tells malformed from absent, and anything not starting exactly `Bearer `
  never reaches `?token=`. Q1.202.
- **`enroll` must not swallow an abort while reading the body**: the timeout is cleared
  *after* `response.json()`, and no blanket `.catch(() => null)` on that path. Q1.203.
- **Redeeming an enrollment code retires the machine's tunnel key** (`issueTunnelKey`),
  killing any live tunnel; `relaycheck` redeems against its own machine. Q1.204.
