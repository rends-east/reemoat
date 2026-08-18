---
paths:
  - src/auth.ts
  - src/token.ts
  - src/enroll.ts
  - packages/control-plane/src/keys.ts
  - scripts/authcheck.ts
---

## Identity

`REEMOAT_AUTH` picks how the daemon decides who is asking: `shared_secret`
(default, no control plane anywhere), `signed`, or `both`.

Under `signed` the daemon verifies Ed25519-signed tokens against a public key it
obtained **once**, at enrollment, and **never contacts the control plane again**.
That is load-bearing: an outage there cannot stop a session, cannot stop a daemon
starting, and cannot stop a token verifying. Q1.9. **The control plane is on the
data path, always** — every request goes down the tunnel the daemon dialled out
(see **Reachability**) — but the daemon is never *asked* anything: no key
fetched, no revocation list polled, no token validated over the tunnel. Q1.10.

## Invariants

**Auth and tokens**

- **No claim is read before the signature verifies.** `decodeToken` hands back the
  payload as an *unparsed string* so that writing the other order is awkward
  rather than natural.
- **`aud` is checked against the enrolled `machineId`.** Every daemon trusts the
  same public key, so a token for machine A verifies at machine B on signature
  alone. Without this, one grant is a grant to every machine. The single most
  consequential line in `auth.ts`.
- **`alg` is compared to the exact string `EdDSA`, before anything else**, and the
  key is found by `kid` in a set we already hold. That combination makes
  `alg: "none"` and HMAC-with-the-public-key *structurally* impossible. Do not
  turn it into a table lookup.
- **base64url decoding is strict.** `Buffer.from(s, "base64url")` silently skips
  unrecognised characters, so `"ab!cd"` and `"abcd"` decode identically — turning
  a token into a family of tokens and `jti` into nothing. `b64uDecode` re-encodes
  and compares.
- **Enrollment single-use is one conditional `UPDATE`, then `changes === 1`.**
  Read-then-mark leaves a window in which two daemons both pass the read.
- **A restart with the same enrollment code makes no network call.** Codes are
  single-use, so a daemon that re-exchanged would fail to start the second time.
- **The daemon makes exactly one control-plane *request*, ever** — at enrollment,
  in `enroll.ts`. The relay tunnel is a **connection, not a request**: it is never
  *asked* anything. What must never appear is code that *reads something it needs*
  from the control plane. Key rotation costs a re-enrollment instead, which is why
  the key set is plural.

## Layout

| File | Holds |
|---|---|
| `src/token.ts` | The token wire format: compact JWS over Ed25519. Answers only "did the holder of this key produce these bytes" — no policy |
| `src/auth.ts` | `Principal`, `TokenVerifier`, the three implementations, `AUTH_LEEWAY_MS`. Decides what a verified token entitles anyone to |
| `src/enroll.ts` | The single control-plane call this daemon ever makes |
| `packages/control-plane/src/keys.ts` | Signing keys, key ids, and every opaque credential this service mints, each with its own prefix: API keys, enrollment codes, tunnel keys, session tokens (`rs_`), `newEmailToken` (`et_`, verify/reset/invite) and `newRegistrationToken` (`pr_`) — the last two storing only a hash and putting the plaintext in exactly one place, the body of one message. Also how a code stops being one: `burnMachineCodes` on a revoke, `burnUserCodes` on a delete **or a disable**, with `usedFrom: UserCodeBurnReason` a required argument rather than a literal inside the function, so the wrong reason is not the easy one to write |
| `scripts/authcheck.ts` | Offline driver for `token.ts`/`auth.ts`/`enroll.ts` |

## Bounds

| | |
|---|---|
| Tokens | 300s lifetime (floor 120s), 60s clock leeway either side. Bounds only a WebSocket already open |
| Enrollment codes | single-use, 1 hour — and burned early by **four** things, each recording *which* in `used_from`: minting the next one for that machine (`superseded`), revoking the machine (`revoked`), deleting the user who minted it (`user_deleted`), and **disabling** them (`user_disabled`, which `enable` does not undo) |

## Known gotchas

- **`jose` is in the lockfile but unimportable**, so the JWS in `token.ts` is
  hand-rolled on `node:crypto`. Q1.200.
- **Clock skew is reported in both directions, deliberately.** `reportSkew` logs a
  rejection inside `SKEW_DIAGNOSTIC_LIMIT_MS` (5× the leeway) and the verifier
  returns `detail: {skewMs, daemonTime, leewayMs}`; `/health` carries `time`
  unauthenticated. Silent skew is the classic failure here. Q1.201.
- **A present-but-malformed `Authorization` header is a failure, not a
  fallthrough** — `bearerToken` tells a malformed header from an absent one, and a
  header that does not start with exactly `Bearer ` must not fall through to
  `?token=`. Q1.202.
- **`enroll` must not swallow an abort while reading the body.** `fetch` resolves
  as soon as headers arrive, so the timeout is cleared *after* `response.json()`,
  and there is no blanket `.catch(() => null)` anywhere on that path. Q1.203.
- **Redeeming an enrollment code retires the machine's tunnel key**
  (`issueTunnelKey`), which makes enrollment destructive to any live tunnel for
  that machine — which is why `relaycheck` redeems against its own machine. Q1.204.
