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
pnpm cpctl devices                   # apps signed in to this account, live and recently retired
pnpm cpctl devices --revoke <id>     # retire one; its sign-ins end, no other device is touched
# No cpctl verb registers one: the route refuses an API key, which has no session to hang a device off
```

## What a device is

**Not a session and not a credential**: the computer or phone that keeps producing
sessions and outlives them, so *sign this laptop out, leave my phone* has something to
act on. (`user_session_origins` is a caller's claim: recognition, never identification.)

**Holding a device id authorizes nothing.** It is stored unhashed and returned in full,
unlike everything in `keys.ts`, because every request still carries the session token and
the id is read only after it resolves, only to ask whether the installation is retired.
Hence ordinary configuration on the client, not a keyring.

**Not an authorization subject**: a grant stays `(user_id, machine_id)`, so one person's
devices reach the same fleet; `relay/authorize.ts` reads no device row and must not learn
to.

## Invariants

- **An id we will not bind is *ignored*, never refused, on both doors** — refusing loops
  sign-in for ever, since the client keeps its id. `adoptDevice` registers a fresh row;
  the retired row and its sessions stay ended.
- **Every lookup carries `user_id`, on both statements of both routes.** Without it,
  `DELETE /v1/me/devices/:id` is a cross-account revocation primitive and oracle, and
  `POST /v1/login`'s device block can bind to a victim's row.
- **`404 device_not_found` for "no such device" and "not yours" alike** (the anti-mapping
  rule of `DELETE /v1/machines/:id/grants/me`).
- **The cap refuses; it does not evict**, unlike `MAX_SESSIONS_PER_USER`. A sign-in succeeds with no device bound, so a
  refusal costs a sentence; eviction would let one live session retire every real device.
  **20 devices against 10 sessions**: the eleventh sign-in retires the oldest *session*
  and leaves its device registered.
- **The device is checked *before* the session's own refusals**: `revokeDevice` retires
  device and sessions in one transaction, so a later check would always answer revoked
  and `device_revoked` would be unreachable. An expired session on a retired device
  reports the device.
- **`device_revoked` and `session_revoked` are separate codes**: a cap-retired session
  leaves the device valid (sign in again, re-bind the row); a retired device ends the
  stored id. `handleSignedOut` clears the id on the first and **must not** on the second.
- **`mintSession` takes `deviceId` as a required argument**, so no sign-in path silently
  mints sessions outside per-device revocation; the two that cannot carry one pass `null`.

## The join that is not there

**`resolveSession`'s cached statement stays single-table.** `devices` shares `id` and
`revoked_at` with `user_sessions`, and that query selects unqualified and reads by **bare
key**: joined, `row["revoked_at"]` becomes the device's and **session revocation silently
stops for everybody** (sign-out, password change and admin sweeps answer 200 while the
token authenticates); a join with bare column names throws at the lazy `prepare` and 500s
every signed-in request. `deviceRevoked` is a **second statement**, run only when the row has a
`device_id` (one primary-key lookup). `relaycheck` asserts **session revocation still
bites on a session with a live device**.

## Where the id is kept on the client

**Not the keyring** (`config.rs`'s header: an identifier, not a secret). A Linux box with
no unlocked collection silently discards keyring writes (`credential::probe`), so it would
register a new device every launch and burn the limit; it would also add a keychain read
to first paint. **`config.rs`'s `Stored.devices`, a `BTreeMap` keyed on the account**
(`<origin>#<user id>`, the credential's scope), **per account** because of the owner
clause (shared entries overwrote each other and spent the cap). A map because **nothing
but `device_revoked` forgets an id** — not a switch, a sign-out, or removing the account:
the server row still exists. Q1.651.

**In the shell a sign-in offers no device**: the stored id belongs to an account the
sign-in has not yet identified, and offering it would copy the last person's public key
onto the next person's fresh row. `login` sends `{name, password}`; the bootstrap then
registers the account's id and key through `POST /v1/me/devices` (`ensureDevice`), and
`Boot.deviceBound` (false from the moment a credential is written) retries a failed
registration. A browser registers none.

`credential.rs` gained a scope and nothing else: `CREDENTIAL` is a set of one,
`read`/`write` carry a `String`, no `list()` (`server.json` says which accounts exist).
**Q7.136 is reversed only in its narrowest half** (*"no first-run generated device id"*);
the keyring seam stays reserved for the device **key**. `webcheck.devices.ts` asserts all
of it off disk.

## Two things called "device"

`packages/web/src/device.ts` reads a `User-Agent` into "Chrome on macOS": recognition,
the fallback on a sign-in row. `devices.ts` on the control plane is a registered entity.
The sign-in list in `AccountSection.tsx` is `SignIns`, headed *"Signed in"* (Decision 1B
stands; only the name moved); Settings → Devices is the device section.

## Limits

Neither is stated on the screen at rest (Q3.686): the second is said in Retire's
confirmation, the first is the API keys screen's.

1. **An API-key caller has no device**; nothing in the list revokes one.
2. **A minted machine token keeps working**: nothing on the token-verifying side reads a
   device. Per-device revocation is a grouping key over sessions plus a bind refusal, not
   a new boundary.

| Path | When a retired device stops |
|---|---|
| Any control-plane request, minting a machine token | **Next request** |
| A machine token already minted | ≤ 300 s + 60 s leeway, from the last mint |
| A WebSocket already open | + one 20 s ping tick |
| Loopback to a local daemon | The same ≤ 360 s, no control-plane hop |

## Layout

| File | Holds |
|---|---|
| `packages/control-plane/src/devices.ts` | `adoptDevice`'s ignore-not-refuse, the owner clause, the refusing cap, `deviceRevoked` |
| `packages/control-plane/src/sessions.ts` | `mintSession`'s required `deviceId`, the device check first, the docblock refusing the join |
| `packages/web/src/cp.ts` | `currentDevice`/`rememberDevice`/`forgetDevice`; `clearSession` keeps the device, `device_revoked` gives it up |
| `packages/web/src/ui/settings/DevicesSection.tsx` | The list, retired rows, the open-work delay in Retire's confirmation; the one `TwoStep` offered on your **own** row |

## Bounds

| | |
|---|---|
| Devices | **20 live per account**, refusing. A retired row is kept 30 days (read after something went wrong), then swept by `pruneDevices` at startup |
| Names | 128 chars for a name, 32 for a platform, clamped at ingest (`POST /v1/login` takes a 64 KiB body above THE LINE) |
