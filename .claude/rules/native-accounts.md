---
paths:
  - packages/native/src-tauri/src/accounts.rs
  - packages/native/src-tauri/src/seats.rs
  - packages/native/src-tauri/src/commands.rs
  - packages/native/src-tauri/src/config.rs
  - packages/native/src-tauri/src/credential.rs
  - packages/native/src-tauri/src/device.rs
  - packages/native/src-tauri/src/daemon.rs
  - packages/native/src-tauri/src/lib.rs
  - packages/native/src-tauri/Cargo.toml
  - packages/web/src/native.ts
  - packages/web/src/slot.ts
  - packages/web/src/cp.ts
  - packages/web/src/store.ts
  - packages/web/src/ui/backAccount.ts
  - packages/web/src/ui/UseAnotherAccount.tsx
  - packages/web/src/ui/MenuDrawer.tsx
  - packages/web/src/ui/ChooseServer.tsx
  - packages/web/src/ui/SignIn.tsx
  - packages/web/src/ui/settings/AccountSection.tsx
  - scripts/nativecheck.ts
  - packages/web/scripts/webcheck.accounts-on-this-computer.ts
  - packages/web/scripts/webcheck.native-bridge.ts
---

# Several accounts on one computer

**Shell only.** The desktop and Android app hold several accounts — on one server
or several — switched from the menu drawer. The browser stays one origin, one
sign-in: the web arm and `CREDENTIAL_STORAGE`, `DEVICE_STORAGE` and `LEGACY_STORAGE`
are byte-identical, and nothing here draws in a browser. Q7.149 is the feature,
Q1.651 the identity, Q5.120 the document binding, Q3.642 and Q3.643 the screens.

## Commands

```bash
security dump-keychain | grep -E '"acct"<blob>="(credential|device_key)#'   # every account's entries, by name
cat ~/Library/Application\ Support/com.reemoat.app/server.json              # accounts, current, roots, legacy_root_holder
ls -la ~/.reemoat/servers                                                   # <server>/ and <server>@<user id>/ roots, 0700
ps -o pid,ppid,command -ax | grep scripts/daemon.ts                         # one child per set-up account
```

## What an account is, and what is keyed on it

**A (normalized origin, control-plane user id) pair; its key is
`<origin>#<user id>`.** That key is the keyring scope — `credential#<origin>#<user
id>` and `device_key#<origin>#<user id>`, through `credential::account_for`, the
extension that function's docblock reserved; no new `pub const`, still no `list()` —
and the key of `server.json`'s `devices`/`device_keys` and of `machine.json`'s
claims. A **legacy** entry, from before accounts and not yet attributed, is scoped
on the bare origin. `accounts::is_user_id` is `[A-Za-z0-9_-]{1,64}`, so a user id
carries no `#`, no `@` and nothing that walks a path; a normalized origin carries no
`#`, so a bare origin never equals an account's scope. The user id and not the name,
because a name can be changed and then taken by somebody else.

**The list lives in `server.json`, because the keyring cannot be listed** —
`accounts` (origin, user, cached `name`, `bound`, `signed_in`, `seen`,
`pending_proof`, `inherited`), `current`, `roots` (origin → the user owning that
server's own daemon root, `""` for nobody-without-proof) and `legacy_root_holder`.
Losing the file orphans every entry until it expires (Q7.149). `MAX_ACCOUNTS` is
ten: `bind_account` refuses `account_limit` past it and the drawer draws no *Add
account*.

A webview is a **seat**: `Slot::Pending` (a sign-in with no account yet — first
run, or an add; no scope, nothing read or written), `Slot::Legacy`, or
`Slot::Account` with `owner := roots[origin] == user`, recomputed on every bind and
never remembered.

## The host decides, and the page never names an account

A seat-scoped command takes the calling `tauri::Webview` **and** its
`tauri::ipc::Request`; `Host::seat` resolves the account from the label and the
generation the document presents in the `reemoat-generation` header. **No
credential, device, daemon or `host_cp` command takes an account, an origin or a
scope** — `nativecheck` sweeps every signature for one. The single exception is
`host_account_switch`'s `account`, a key `host_accounts` listed. Nothing that names
another account returns a credential.

`host_cp`'s base is the seat's origin. It refuses `authorization`
(`proxy::carries_credential`, the same case-folding `send` forwards by) on a probe
override **and from a pending seat**. ⚠ Defence in depth, not structure: the CSP
lets the page `fetch` anywhere, so this guards against a page that is wrong, and
`script-src 'self'` is still what keeps a hostile one out.

**Several credentials in one page was refused**, not deferred: `cpFetch`'s
401-by-identity rule (Q1.412), the store singleton and every screen assume one. Each
webview is a single-account app instead.

## The bridge contract

`Boot` keeps its thirteen keys and adds six flat ones, each with its serde rename
where one is needed — `nativecheck`'s census reads top-level fields only, so a nested
struct would hide a missing rename:

| Field | Meaning |
|---|---|
| `account` | this seat's key; `null` while pending or legacy |
| `name` | the cached account name |
| `legacy` | a legacy seat, **or** an account whose server's bare items still wait for a proof — the page calls `host_account_confirm` |
| `deviceBound` | this account's device id is bound to its current sign-in; `false` makes the bootstrap register |
| `generation` | this document's; `null` only while `rebinding` |
| `rebinding` | the label was rebound and its new page load not seen yet; the page retries `host_boot` for `REBIND_PATIENCE_MS` |

`server` is the seat's origin; `credential` is handed at most once per page load.

| Command | Args | Returns |
|---|---|---|
| `host_credential_set` | `{value}` | `Bound{outcome: bound\|adopted\|existing\|refused, account, name, deviceId, devicePublicKey, deviceKeyAtRest}` |
| `host_credential_clear` | — | — (also records the account signed out) |
| `host_account_confirm` | — | `Bound`, outcome `bound\|existing\|unchanged` |
| `host_accounts` | — | `AccountList{accounts: AccountSummary{key, origin, name, current, signedIn}[], canAdd, back}` |
| `host_account_switch` | `{account: string\|null}` (`null` = `back`) | `AccountMove{reload}` |
| `host_account_add` | — | `AccountMove{reload}` |
| `host_account_forget` | — | `AccountMove{reload}` |
| `host_set_server` | `{url}` | the address; refused `pending_seat` unless the seat is pending |

Refusal prefixes the page may match: `stale_document` (reload), `not_shown`,
`pending_seat`, `account_limit`. `AccountMove`'s Rust field is `reload_page`, renamed
`reload`, so the payload census is not vacuous. `host_accounts` reads **no keyring**:
`signedIn` is the persisted flag, which `host_boot` corrects when the keyring
disagrees — a keychain read per drawer row is a prompt per row on an unsigned build.
`back` is read live, never carried on `Boot`: a desktop webview's snapshot outlives
every add and remove after it.

## A document, not a label

`host_boot` issues a random generation per page load; `on_page_load(Started)`
(`Host::page_loaded`) and every rebind (`Host::move_seat`) retire it. `invoke` in
`native.ts` sends it on every command but `host_boot` (`withGeneration`) and answers
the first `stale_document` with `location.replace("/")`, once. Without it a label
rebound to another account answers the previous document — a late poll's bearer to
the new server, a late clear erasing the new account's sign-in, Android's Back
reviving the old page. Account moves use `location.replace`, never `assign`, so Back
cannot bring a left document back. Q5.120.

⚠ **`switchAccount` has no `detachSession`, and `webcheck` asserts the absence.** A
document is one account for its whole life: a hidden webview keeps its session, and a
rebound one is refused by the generation. Only `ChooseServer`'s `submit` detaches,
because a pending window's server moves under the same document.

## A webview per account on macOS, a rebind everywhere else

`seats.rs` is **the only file that builds a webview**, and every one is built with
`from_config(..).on_navigation(is_our_own)` — `from_config` is what carries
`dragDropEnabled: false` into each child. There is no `initialization_script`, and
`nativecheck` refuses a `WebviewBuilder::new`.

- **macOS, `MULTI_WEBVIEW`:** one window `main`, a child per account labelled
  `seat-<n>` (an account key is outside Tauri's label alphabet). Launch builds the
  window hidden, adds the shown account at full size, shows the window, then adds the
  rest at zero size and hides them — a webview has no visible flag. A switch is
  `present`: hide every other, reset the target's bounds, show, focus. Nothing
  reloads; a cancelled add's pending webview is closed. Needs Tauri's `unstable`,
  which `Cargo.toml` enables for the macOS target alone; `nativecheck` pins
  `Cargo.lock`'s `tauri` and `tauri-runtime-wry` to `MEASURED_TAURI`, so a bump is a
  re-run of the hand checks, not a routine update.
- **Everywhere else, and macOS with `MULTI_WEBVIEW` false:** one `WebviewWindow`,
  `main`, rebound; `AccountMove.reload` is `true` and the page reloads. Linux on
  purpose — tao packs children into a `GtkBox` and ignores their bounds.

**Measured before it shipped** (Q7.149): a switch is 9–22 ms tap to `visible`, a
hidden page keeps its heap and sockets, WebKit suspends one after about eight
minutes hidden and delivers its queue on show. ⚠ Two things that measurement found
are now rules: nothing but `host_boot` is sent before the boot answers, and a
closed seat's page is ended with WebKit's `_close` (`end_page`) — `Webview::close`
alone left it running. The page never branches on the arm.

**A hidden webview cannot reach the screen.** Switch, add, `host_save_file`,
`host_pick_folder`, `host_open_external` and `host_copy_text` are refused
`not_shown` from any label but `Host.shown`.

## Signing in: the host proves whose it is

`cp.login` sends `{name, password}` — **no device** — then, in the shell, awaits
`bindNativeCredential(token)`. The host calls `GET /v1/me` with the token against the
seat's origin (`accounts::me`) and decides (`accounts::decide`):

| Outcome | When | Host | Page |
|---|---|---|---|
| `bound` | new account, or the seat's own again | binds, writes the keyring | `setSession` |
| `adopted` | account here, signed out | writes the token into it, reloads its webview | throws `AccountAlreadyOpen`, switches there |
| `existing` | account here, signed in | **revokes** the new session itself | throws `AccountAlreadyOpen`, switches there |
| `refused` | a different person on a signed-out account's seat | **revokes** | throws `WrongAccount`, a sentence |

Any rejection — `/v1/me` unreachable or not 2xx — **adopts nothing**. The old
setter's "memory is a degraded mode" posture does not apply: a failed bind is a
session nobody attributed, and adopting it would register one account's device for
another person. A keyring that keeps nothing is still `durable: false` and still
binds.

**Registration follows in the same document**: `ensureDevice` registers whenever the
id is missing or `!deviceBound`, through `POST /v1/me/devices`, before anything mints
a capability. `registerDevice` is single-flight. A sign-in cannot offer the stored
device because the stored device is an account's, and the account is what the sign-in
finds out.

## Adding, switching and taking an account off

- **Add** (`host_account_add`): a pending seat, shown. The server step opens locked
  on `defaultServer` with a pencil and nothing under the field; a **‹** naming the
  account before (`switchAccount(null)`) returns to it from either arrival, and
  nothing was written. **No Cancel anywhere in this flow** — one way back per
  screen, a chevron that names where it goes, and none on a first run (sign-in
  included). `host_set_server` then moves the pending seat's origin and writes
  `server.json` only on a first run. Q3.643.
- **Switch** (`host_account_switch`): shown caller only; stops nothing; records
  `current` after the switch, never before.
- **Forget** (`host_account_forget`) — Sign out, and *Remove account*: caller only,
  in order: erase its credential; **stop its root's supervisor** unless another
  listed account shares the root; `config::forget_account`, which **keeps the device
  id, the key and the `roots` record** so signing in again reuses the device row and
  the root; show the most recent other account (a hidden caller closes itself), or
  rebind to a pending seat on the same origin. A pending caller with no account
  anywhere is refused — a first run stays uncancellable. `nativecheck` asserts the
  stop here and its absence in switch, add, confirm and sign-in.
- **Signed out involuntarily**: the account stays listed, `signed_in` goes false, and
  SignIn offers **‹** *the account before* (live `back`) and *Remove account* —
  never `‹ Server`, which is for a pending seat with an account to return to
  (`signInExits`).

## A daemon per account, owned by the host

- **Which root**: the server's owner keeps `daemon::owner_root` — Q7.148's
  `state_root`, with `~/.reemoat` handed for being empty to one origin only
  (`legacy_root_holder`). Every other account on that server gets
  `servers/<server>@<user id>` (`daemon::guest_root`): never legacy, always
  `REEMOAT_PORT=0`, injective because `@` is in no slug and no user id.
- **When**: `daemon::start_configured_at_launch` starts every listed account's root
  whose env file names its server, on a thread of its own, **whether or not its page
  is alive** — the single arm has one page, and macOS suspends a hidden `WKWebView`.
  Adoption only: no code, no machine created; pages still create and enroll.
- **Serialized**: `ROOT_LOCK` (`daemon::lock_roots`) from `state_root` through
  `Supervisor::start`; `CLAIM_LOCK` and an atomic write for `machine.json`.
- **Supervisors** are keyed by the root's directory, so a legacy seat and the account
  it becomes share one.
- **`announce_roots`** answers a guest `[own]` alone, an owner or legacy seat `[own,
  legacy]`: a guest handed `~/.reemoat`'s machine id would adopt another person's
  machine.

## The first launch after the update

Nothing is written at startup — `nativecheck` extends that to `seats.rs`.
`read_accounts` is pure; for a pre-accounts file it derives a list in memory
(`server` only on evidence — a `devices` entry, a bare claim, or `credential#<server>`,
read once by `lib.rs`; otherwise `Roster.pending`, which keeps `‹ Server`), and the
first changing act materializes it. A legacy seat's page calls `host_account_confirm`:
the host reads the bare credential itself, asks `/v1/me`, moves it write → read back →
erase, and **inherits nothing else without proof** — the device only if
`/v1/me/devices` lists it (`device::copy_key`, proven moves only), the root and its
claim only if the claimed or announced machine is among the user's *owned*
`/v1/machines`. Unreachable → `pending_proof`, asked again next bootstrap. The page
runs **confirm, then `ensureDevice`, then `beginSetUp`**, asserted as source order,
and a confirm answering `existing` logs this seat out and forgets it without
`forgetAllConfig`.

## The lock rule

No `Host` mutex but `changing` is held across a `Window` or `Webview` call, and
nothing on the main thread takes `changing`. Webview creation, show, hide and close
run on the main thread and are waited for; `on_page_load` runs there and takes
`seats`. `seats.rs` copies what it needs (`labels`, `label_of`, `shown`) and holds
no lock across a call — asserted. `host_boot` is `(async)`: every webview boots at
launch.

## What is not built

- **Notifications or badges for accounts not on screen** — a deliberate non-goal
  (Q7.149).
- **Per-account `localStorage`.** Every webview shares one data store, so one sign-out's
  `forgetAllConfig` clears every account's remembered controls.
- **A multi-webview arm off macOS**, and **several accounts in the browser**.
- **A protected `release` environment** for the default-server variable (Q4.127).

## Layout

| File | Holds |
|---|---|
| `src-tauri/src/accounts.rs` | `Slot`, the scope and root of each, `is_user_id`, `clamp_name`, `MAX_ACCOUNTS`, `me`, `gather` (the proofs), `decide`, `bind`, `follow_claim` |
| `src-tauri/src/seats.rs` | every webview built, both arms, `present`, the launch plan |
| `src-tauri/src/commands.rs` | `Host` (seats, generation, shown, `changing`), the contract above, `host_cp`'s refusals |
| `src-tauri/src/config.rs` | the list, its derivation, `bind_account`, `claim_bare`, `forget_account`, the per-account quarantine |
| `src-tauri/src/daemon.rs` | `owner_root`, `guest_root`, `announce_roots`, `ROOT_LOCK`, `CLAIM_LOCK`, `move_claim`, `start_configured_at_launch` |
| `web/src/native.ts` | the Boot fields, the header, the wrappers, the stale reload |
| `web/src/slot.ts` | `slotOf`, `signInExits`, `confirmDue`, `serverLabel` — pure, driven |
| `web/src/ui/backAccount.ts`, `UseAnotherAccount.tsx` | the live `back`, and the way out of the forced password change — the one screen left with no drawer, since an unreachable server draws the shell (Q3.643) |
| `web/scripts/webcheck.accounts-on-this-computer.ts` | the table, the bootstrap order, no detach on a switch, the sign-in's adoption rule |
