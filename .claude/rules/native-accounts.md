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

**Shell only**: the desktop and Android app hold several accounts, switched from the menu
drawer; the browser stays one sign-in, and `CREDENTIAL_STORAGE`, `DEVICE_STORAGE`,
`LEGACY_STORAGE` are unchanged. Q7.149 the feature, Q1.651 the identity, Q5.120 the document
binding, Q3.642 and Q3.643 the screens.

## What an account is, and what is keyed on it

**A (normalized origin, user id) pair, keyed `<origin>#<user id>`**: the keyring scope
(`credential#<origin>#<user id>`, `device_key#<origin>#<user id>`, via
`credential::account_for`; still no `list()`) and the key of `server.json`'s
`devices`/`device_keys` and `machine.json`'s claims. A **legacy** entry (pre-accounts,
unattributed) is scoped on the bare origin. `accounts::is_user_id` is `[A-Za-z0-9_-]{1,64}`:
no `#`, no `@`, nothing that walks a path, so a bare origin never equals an account scope. The
user id, never the name, which can be changed and then taken by somebody else.

**The list lives in `server.json`, because the keyring cannot be listed**: `accounts` (origin,
user, `name`, `bound`, `signed_in`, `seen`, `pending_proof`, `inherited`), `current`, `roots`
(origin → the user owning that server's own daemon root, `""` for nobody without proof),
`legacy_root_holder`. Losing it orphans every entry until expiry. `MAX_ACCOUNTS` is ten:
`bind_account` refuses `account_limit` and the drawer draws no *Add account*.

A webview is a **seat**: `Slot::Pending` (no account yet; no scope, nothing read or written),
`Slot::Legacy`, or `Slot::Account` with `owner := roots[origin] == user`, recomputed on every
bind. `accounts.rs` also holds `clamp_name`, `gather` (the proofs), `bind`, `follow_claim`.

## The host decides, and the page never names an account

A seat-scoped command takes the calling `tauri::Webview` and its `tauri::ipc::Request`;
`Host::seat` resolves the account from the label and the `reemoat-generation` header. **No
credential, device, daemon or `host_cp` command takes an account, origin or scope**
(`nativecheck` sweeps every signature); the one exception is `host_account_switch`'s
`account`, a key `host_accounts` listed. Nothing naming another account returns a credential.

`host_cp`'s base is the seat's origin; it refuses `authorization` (`proxy::carries_credential`)
on a probe override and from a pending seat, as defence in depth against a wrong page.
**Several credentials in one page was refused**: `cpFetch`'s 401-by-identity rule (Q1.412),
the store singleton and every screen assume one.

## The bridge contract

`Boot` keeps its thirteen keys and adds six **flat** ones (the serde-rename census reads
top-level fields only). `server` is the seat's origin; `credential` comes at most once per load.

| Field | Meaning |
|---|---|
| `account` | this seat's key; `null` while pending or legacy |
| `name` | the cached account name |
| `legacy` | a legacy seat, **or** an account whose server's bare items await a proof: call `host_account_confirm` |
| `deviceBound` | `false` makes the bootstrap register the device |
| `generation` | this document's; `null` only while `rebinding` |
| `rebinding` | new page load not seen yet; retry `host_boot` for `REBIND_PATIENCE_MS` |

| Command | Args → returns |
|---|---|
| `host_credential_set` | `{value}` → `Bound{outcome: bound\|adopted\|existing\|refused, account, name, deviceId, devicePublicKey, deviceKeyAtRest}` |
| `host_credential_clear` | records the account signed out |
| `host_account_confirm` | → `Bound`, `bound\|existing\|unchanged` |
| `host_accounts` | → `AccountList{accounts: AccountSummary{key, origin, name, current, signedIn}[], canAdd, back}` |
| `host_account_switch` | `{account: string\|null}` (`null` = `back`) → `AccountMove{reload}` |
| `host_account_add`, `host_account_forget` | → `AccountMove{reload}` |
| `host_set_server` | `{url}` → the address; `pending_seat` unless the seat is pending |
| `host_set_theme` | `{theme}`; shown seat only; writes `server.json`, applies only a change (Q3.671) |

Refusal prefixes: `stale_document` (reload), `not_shown`, `pending_seat`, `account_limit`.
`AccountMove`'s Rust field `reload_page` is renamed `reload`, so the census bites.
`host_accounts` reads **no keyring** (a prompt per row unsigned): `signedIn` is the persisted
flag, corrected by `host_boot`. `back` is read live, never carried on `Boot`.

## A document, not a label

`host_boot` issues a random generation per page load; `on_page_load(Started)`
(`Host::page_loaded`) and every rebind (`Host::move_seat`) retire it. `invoke` sends it on every
command but `host_boot` (`withGeneration`) and answers the first `stale_document` with
`location.replace("/")`, once; otherwise a rebound label answers the old document (a late
bearer to the new server, a late clear, Back reviving it). Account moves use
`location.replace`, never `assign`. Q5.120. **`switchAccount` has no `detachSession`**
(`webcheck` asserts it): a document is one account for life; only `ChooseServer`'s `submit`
detaches, its server moving under the same document.

## A webview per account on macOS, a rebind everywhere else

`seats.rs` is **the only file that builds a webview**, each with
`from_config(..).on_navigation(is_our_own)`; no `initialization_script`, and `nativecheck`
refuses `WebviewBuilder::new`.

- **macOS, `MULTI_WEBVIEW`:** window `main`, a child per account labelled `seat-<n>`. Launch
  builds the window hidden, adds the shown account full size, shows it, then adds the rest at
  zero size, hidden. A switch is `present` (hide others, reset bounds, show, focus); nothing
  reloads; a cancelled add's webview is closed. Tauri's `unstable` for the macOS target only;
  `nativecheck` pins `tauri` and `tauri-runtime-wry` to `MEASURED_TAURI`: a bump means
  re-running the hand checks.
- **Elsewhere, or `MULTI_WEBVIEW` false:** one `WebviewWindow` rebound, `AccountMove.reload`
  `true`. Linux on purpose: tao ignores child bounds.

Nothing but `host_boot` is sent before the boot answers, and a closed seat's page is ended
with WebKit's `_close` (`end_page`), as `Webview::close` leaves it running (Q7.149). The page
never branches on the arm. **A hidden webview cannot reach the screen**: switch, add,
`host_save_file`, `host_pick_folder`, `host_open_external`, `host_copy_text`, `host_set_theme`
are refused `not_shown` from any label but `Host.shown`.

## Signing in: the host proves whose it is

`cp.login` sends `{name, password}`, **no device**, then awaits `bindNativeCredential(token)`;
the host calls `GET /v1/me` on the seat's origin (`accounts::me`) and `accounts::decide`s:

| Outcome | When | Host | Page |
|---|---|---|---|
| `bound` | new account, or the seat's own | binds, writes the keyring | `setSession` |
| `adopted` | here, signed out | writes the token in, reloads its webview | `AccountAlreadyOpen`, switches |
| `existing` | here, signed in | **revokes** the new session | `AccountAlreadyOpen`, switches |
| `refused` | another person on a signed-out seat | **revokes** | `WrongAccount`, a sentence |

Any rejection (`/v1/me` unreachable or not 2xx) **adopts nothing**, or one account's device
would be registered for another person. A keyring that keeps nothing is `durable: false` and
still binds. Then `ensureDevice` registers (`POST /v1/me/devices`, single-flight
`registerDevice`) whenever the id is missing or `!deviceBound`, before any capability; a
sign-in cannot offer the stored device, which is an account's.

## Adding, switching and taking an account off

- **Add** (`host_account_add`): a pending seat, shown; the server step opens locked on
  `defaultServer`. A **‹** naming the account before (`switchAccount(null)`) returns, nothing
  written. **No Cancel in this flow**: one chevron per screen naming where it goes, none on a
  first run. `host_set_server` writes `server.json` only on a first run. Q3.643.
- **Switch**: shown caller only; stops nothing; records `current` after the switch.
- **Forget** (Sign out, *Remove account*), caller only, in order: erase its credential;
  `config::forget_account` under `daemon::lock_roots`, **keeping the device id, the key and
  `roots`** so a later sign-in reuses them; **stop its root's supervisor** unless another
  listed account shares the root (the launch thread and `host_daemon_start` both ask
  `Host::lists_root` under that lock); show the most recent other account (a hidden caller
  closes itself) or rebind to a pending seat on the same origin. A pending caller with no
  account anywhere is refused. `nativecheck` asserts the stop here and its absence in switch,
  add, confirm and sign-in.
- **Signed out involuntarily**: still listed, `signed_in` false; SignIn offers **‹** (live
  `back`) and *Remove account*, never `‹ Server` (`signInExits` in `slot.ts`, beside `slotOf`,
  `confirmDue`, `serverLabel`).

## A daemon per account, owned by the host

- **Which root**: the server's owner keeps `daemon::owner_root`, Q7.148's `state_root`
  (`~/.reemoat` for one origin, `legacy_root_holder`; else `servers/<server>`). Every other
  account gets `servers/<server>@<user id>` (`daemon::guest_root`): never legacy, always
  `REEMOAT_PORT=0`, injective because `@` is in no slug and no user id. Roots are `0700`.
- **When**: `daemon::start_configured_at_launch` starts every listed root whose env names its
  server, on its own thread, **whether or not its page is alive** (macOS suspends a hidden
  `WKWebView`). No code, no machine created.
- **Serialized**: `ROOT_LOCK` from `state_root` through `Supervisor::start`; `CLAIM_LOCK` and an
  atomic write (`move_claim`) for `machine.json`. Supervisors are keyed by root directory.
- **`announce_roots`** answers a guest `[own]`, an owner or legacy seat `[own, legacy]`: a guest
  given `~/.reemoat`'s machine id would adopt another person's machine.

## The first launch after the update

Nothing is written at startup (asserted, `seats.rs` included). `read_accounts` is pure: it
derives a pre-accounts list in memory (`server` only on evidence: a `devices` entry, a bare
claim, or `credential#<server>` read once by `lib.rs`; else `Roster.pending`), materialized by
the first changing act. A legacy page calls `host_account_confirm`: the host moves the bare
credential (write → read back → erase) after `/v1/me`, and **inherits nothing else without
proof**: the device only if `/v1/me/devices` lists it (`device::copy_key`), the root and claim
(`claim_bare`) only if the machine is among the user's *owned* `/v1/machines`. Unreachable →
`pending_proof`. The page runs **confirm, `ensureDevice`, `beginSetUp`**, asserted as source
order; a confirm answering `existing` calls `cp.detachSession()` and forgets the seat, never
`cp.logout()` (the host already adopted or revoked the token).

## The lock rule

No `Host` mutex but `changing` is held across a `Window` or `Webview` call, and nothing on the
main thread takes `changing`. Webview creation, show, hide and close run on the main thread and
are waited for; `on_page_load` runs there and takes `seats`. `seats.rs` copies `labels`,
`label_of`, `shown` and holds no lock across a call, asserted. `host_boot` is `(async)`.

## What is not built

Notifications or badges for off-screen accounts (Q7.149). Per-account `localStorage`: one
sign-out's `forgetAllConfig` clears every account's controls. A multi-webview arm off macOS;
several accounts in a browser. A proof that waits for the root's daemon: an unannounced
`install.sh` root with no bare claim is bound a guest at the first confirm (Q7.149). A protected
`release` environment for the default-server variable (Q4.127).

`UseAnotherAccount.tsx` (with `backAccount.ts`'s live `back`) is the forced password change's
way out, the one screen with no drawer (Q3.643); `webcheck.accounts-on-this-computer.ts`
drives it over every `useBackAccount` value, plus the table, the bootstrap order and the
adoption rule.
