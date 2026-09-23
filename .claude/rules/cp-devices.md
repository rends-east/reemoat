---
paths:
  - packages/control-plane/src/devices.ts
  - packages/control-plane/src/sessions.ts
  - packages/web/src/ui/settings/DevicesSection.tsx
  - packages/web/src/device.ts
  - packages/native/src-tauri/src/config.rs
  - scripts/relaycheck.ts
---

## Commands

```bash
pnpm cpctl devices                   # the apps signed in to this account, live and recently retired
pnpm cpctl devices --revoke <id>     # retire one; its sign-ins end and no other device is touched
#   ⚠ There is no `cpctl` verb that *registers* one, deliberately: the route refuses an
#     API key, because a device is a signed-in installation and a key has no session for
#     one to hang off. This command is the thing that holds keys
```

## What a device is

**Not a session and not a credential.** A session is a bearer token with an
expiry; a device is the computer or phone that keeps producing them, and it
outlives every one of them. That is the whole feature — *sign this laptop out and
leave my phone alone* had nothing to act on before, because the only per-sign-in
record there was is `user_session_origins`, whose two fields are a caller's own
claim about itself and are documented as **recognition, never identification**.

**Holding a device id authorizes nothing.** It is an identifier this service hands
back, stored unhashed and returned in full — unlike everything in `keys.ts` —
because every request still carries the session token and the id is read only
*after* that token has resolved, and only to ask whether the installation has been
retired. That is why the client keeps it in ordinary configuration rather than an
OS keyring.

**Not an authorization subject.** A grant is `(user_id, machine_id)` and stays
that way, so two devices of one person reach exactly the same fleet;
`relay/authorize.ts` reads no device row and must not learn to. Permissions belong
to the person.

## Invariants

- **An id we will not bind is *ignored*, never refused — on both doors.** This is
  what stops a sign-in loop. A client keeps the id it was given, so a retired id
  answered with an error means: sign in, be refused on the very next request, sign
  out, sign in again with the same id, for ever, with no exit but deleting a file
  by hand. `adoptDevice` registers a fresh row instead, which terminates and gives
  up nothing — the retired row stays retired and its sessions stay ended.
  Revocation retires *that installation's access*, not the computer's right to ask
  again with a password.
- **Every lookup carries `user_id`, on both statements of both routes.** A device
  id is a short opaque string a client chooses to send. Without the owner clause,
  `DELETE /v1/me/devices/:id` is a cross-account revocation primitive and a
  device-existence oracle, and `POST /v1/login`'s device block lets one account
  bind to another's row — after which the victim's Revoke signs the attacker out
  (harmless) and the attacker's session inherits the victim's `revoked_at`, so the
  victim can be signed out at will by a stranger.
- **`404 device_not_found` covers "no such device" and "not yours" alike**, which
  is `DELETE /v1/machines/:id/grants/me`'s anti-mapping rule.
- **The cap refuses; it does not evict.** `MAX_SESSIONS_PER_USER` evicts because
  *"being unable to sign in on a new device because of an old one is the wrong
  failure"* — right about sessions, because a session *is* the thing you are
  trying to get. It does not transfer: a sign-in succeeds with no device bound, so
  refusing the registration costs a sentence rather than the sign-in. And eviction
  here would be a weapon — anybody holding **one** live session could register
  twenty times and evict, revoke and sign out every real device the owner has,
  while their own newest session survived.
- **The two caps are different numbers and the relationship is stated**: 20
  devices against 10 sessions. At most ten devices hold a live session at once;
  the eleventh sign-in retires the oldest *session* and leaves its device
  registered, which is right — that installation asks for a password again and
  keeps its identity.
- **The device is checked *before* the session's own refusals**, and asking last
  made `device_revoked` unreachable. `revokeDevice` retires the device and its
  sessions in one transaction, so by the time anything reads the row `revoked_at`
  is already set — a check below that one answers `revoked` every time, for a code
  nothing could then produce. The session's revocation is the *consequence*; the
  device is the *cause*, and reporting the consequence leaves the client holding a
  dead id. The cost is that an expired session on a retired device reports the
  device, which is the better of the two answers.
- **`device_revoked` and `session_revoked` are separate codes and the client does
  different things with them.** A session retired by the per-user cap leaves the
  device valid, so the app signs in again and re-binds the same row; a retired
  device means the stored id is finished. Folding them picks one behaviour and is
  wrong about the other half the time. `handleSignedOut` clears the id on the
  first and **must not** on the second.
- **`mintSession` takes `deviceId` as a required argument.** Three routes mint a
  session and only one can carry a device; an optional parameter would let the
  other two — and every sign-in path added later — silently produce sessions
  outside per-device revocation. Two call sites legitimately pass `null`; the
  point is that they say so.

## The join that is not there

⚠ **`resolveSession`'s cached statement stays single-table, and this is the
sharpest trap in the feature.** `devices` shares `id` and `revoked_at` with
`user_sessions`, and that query selects unqualified and reads the row by **bare
key**. Joined, `row["revoked_at"]` becomes the *device's* — NULL for a live device
and NULL for a session with no device at all — and **session revocation silently
stops working for everybody**: signing out, sign-out-everywhere, a password change
and both admin sweeps keep answering 200 while the revoked token goes on
authenticating. Written with bare names instead it throws at `prepare`, which is
lazy, so the service starts green and then 500s every signed-in request.

`deviceRevoked` is a **second statement**, run only when the row carries a
`device_id`: nothing for a browser, an API key or a pre-migration session, one
primary-key lookup for a native one. Cheaper than the join it replaces, and the
trap is structurally impossible rather than something to remember.

`relaycheck` asserts **session revocation still bites on a session that has a live
device**, which is the case a join would break while every other assertion in the
file stayed green.

## Where the id is kept on the client

⚠ **Not the keyring**, and `config.rs`'s own header is the argument: *"Not a
secret, and deliberately not in the keyring. A server address is a preference; the
credential for it is the secret."* A device id is an identifier, not a secret, and
the cost of getting this wrong lands exactly on the machines `credential::probe`
exists to detect — a Linux box with no unlocked collection silently discards every
keyring write, so that installation would register a new device on **every launch**
and burn the account's limit without ever reading one back. It would also put a
second keychain read on the first-paint path.

So: `config.rs`'s `Stored.devices`, a `BTreeMap` keyed on origin, beside `server`.
A map rather than one current value because `host_set_server` **erases nothing
here** — the row on the old server still exists, so forgetting the id leaves an
installation nobody can recognise in their own list and spends a second slot on
the way back. The credential is kept across a change too since Q7.148, so the two
no longer differ there; each is given up only by its own act.

`credential.rs` is untouched: `CREDENTIAL` stays a set of one, `read`/`write` keep
carrying a `String`, there is still no `list()`. **Q7.136 is reversed only in its
narrowest half** — *"no first-run generated device id"* — and the keyring seam
stays reserved for the device **key**, which cannot use a `String` interface at
all. `webcheck.devices.ts` asserts all of it off disk.

## Two things called "device", and neither is renamed away

- `packages/web/src/device.ts` reads a `User-Agent` into "Chrome on macOS". It is
  **recognition of a browser string** and is the fallback on a sign-in row.
- `devices.ts` on the control plane is **an entity somebody registered**.

The sign-in list in `AccountSection.tsx` was called `Devices` and is `SignIns`
now, headed *"Signed in"*. **Decision 1B stands and only the name moved**: that
argument is about a session list whose only verb is sign-out, while a device
survives a sign-out and carries retired rows and a limit. Settings → Devices is
the new section.

## Two honest limits, stated on the screen

1. **An API-key caller has no device.** A key is not a sign-in, so nothing holding
   one appears in the list and nothing in the list revokes one. The remedy is the
   API keys screen.
2. **A machine token already minted keeps working.** Nothing in the token-verifying
   half of the system reads a device, deliberately, so per-device revocation is a
   grouping key over sessions plus a bind refusal — which is genuinely useful and
   is not a new boundary.

| Path | When a retired device stops |
|---|---|
| Any control-plane request | **Next request** |
| Minting a machine token | Next request |
| A machine token already minted | ≤ 300 s + 60 s leeway, from the last mint |
| A WebSocket already open | + one 20 s ping tick on top of that |
| Loopback to a local daemon | The same ≤ 360 s, with no control-plane hop at all |

## Layout

| File | Holds |
|---|---|
| `packages/control-plane/src/devices.ts` | The entity and every rule about it: `adoptDevice`'s ignore-rather-than-refuse, the owner clause, the cap that refuses, `deviceRevoked` and why it is a second statement |
| `packages/control-plane/src/sessions.ts` | `mintSession`'s required `deviceId`, the device check placed *first*, and the docblock refusing the join |
| `packages/web/src/cp.ts` | `currentDevice`/`rememberDevice`/`forgetDevice`, and the rule that `clearSession` keeps the device while `device_revoked` gives it up |
| `packages/web/src/ui/settings/DevicesSection.tsx` | The list, the retired rows, and the two limits as sentences. The one `TwoStep` in this app offered on your **own** row |
| `packages/native/src-tauri/src/config.rs` | Where the id lives, and the argument for it not being in the keyring |

## Bounds

| | |
|---|---|
| Devices | **20 live per account**, and the cap **refuses** rather than evicting. A retired row is kept 30 days — longer than a session's seven, because the list is read *after* something went wrong rather than as a live inventory — then swept by `pruneDevices` at startup |
| Names | 128 chars for a name, 32 for a platform, clamped at ingest. `POST /v1/login` is above THE LINE with a 64 KiB body, so an unclamped name is 64 KiB into the file that holds the fleet's signing key |
