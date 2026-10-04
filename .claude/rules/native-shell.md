---
paths:
  - packages/native/src-tauri/src
  - packages/native/src-tauri/tauri.conf.json
  - packages/native/src-tauri/Cargo.toml
  - packages/native/src-tauri/capabilities
  - packages/native/scripts
  - packages/web/src/native.ts
  - packages/web/src/cp.ts
  - packages/web/src/ui/ChooseServer.tsx
  - packages/web/src/ui/SignIn.tsx
  - packages/web/src/platform.ts
  - scripts/nativecheck.ts
  - packages/web/scripts/webcheck.native-bridge.ts
---

# The native shell

`packages/native` is a Tauri 2 window around `packages/web`, **embedded in the binary**, so
the server it supervises cannot replace the code running in it. `native.ts` is hand-written,
no vendor SDK, after the gone Telegram bridge (Q1.649). Rust: `cargo test`, `cargo clippy -- -D
warnings` in `src-tauri`; `pnpm nativecheck` runs no cargo.

## Two transports, and the split is a count

**Exactly one leg leaves the webview: `/v1/*`, through the host**, because the control plane
mounts no CORS, deliberately (`vite.config.ts` proxies `/v1` in dev). Daemon and relay answer
`access-control-allow-origin: *` (`src/cors.ts`) and stay, for four reasons, any one enough:

- `machine.ts`'s `sendWithProgress` is `XMLHttpRequest` for upload progress; Rust has none.
- `withTimeout` composes an outer `AbortSignal` that `request` threads; an `invoke` cannot abort.
- `isTransportFailure` is a negation (anything not an `ApiError`); a second decider would
  disagree, and either every tunnel signs the fleet out or nobody ever is.
- The Noise handshake runs in the page; a Rust leg would mean two decryptors. The device key
  stays in the keyring and `host_device_dh` answers a shared secret (`e2ee.md`).

`nativecheck` asserts the control plane is **not** in the shell's `connect-src`.

## A path crosses the bridge, never a URL

`host_cp` takes `{path, method, headers, body, origin?}` and joins the path onto a base held
in the **host process**, so `cp.ts`'s one-origin rule for the credential holds where the page
cannot reach. **`Url::join` is not the check**: it replaces the origin for `//evil.example`
or `https://evil.example`. Comparing origins afterwards holds; the `/v1/` prefix test keeps
the host from being a general proxy. `proxy.rs`'s tests drive every escape shape.

- Only `authorization` and `content-type` are forwarded (all `cp.ts`'s four call sites send).
- Redirects are never followed (`Policy::none()`).
- A status outside `200..=599` is an `Err`: `new Response(…)` throws a `RangeError` there.
- **A failure is a rejection, never a status**: re-thrown as a `TypeError`, because
  `isTransportFailure` is a negation and `errorText` narrows on `instanceof Error`.

## The credential is keyed on the server and the account

A custom scheme has one origin for every server and account, so the keyring account is the
account: `credential#<origin>#<user id>` (`#` because an origin cannot contain one). A
credential cannot be read for another server or person, structurally; the host decides which
account a call is about (`native-accounts.md`, Q1.651). The web arm keeps the unscoped
`reemoat.credential` and the two pre-rename names `cp.ts` sweeps: an origin already scopes
them, and a rename would sign the fleet out.

**Never stored:** the password (no "remember me"; `POST /v1/me/password` asks for the
current one), and any daemon credential (`REEMOAT_TOKEN`; a 300 s machine token belongs at
`machine.ts`'s `ensureToken`). **Durability is a probe, never a `cfg!`**: `credential::probe`
round-trips and erases a canary, since a store that accepts and loses a write reads as
working (Linux with no D-Bus). `false` draws `cp.ts`'s sentence for disabled browser storage.

## The synchronous read, and the two answers that were refused

`cp.ts` reads its credential synchronously in the module body; a keyring is async. The native
arm starts `null`, `store.bootstrap()` fills it through `adoptHydratedCredential` after
awaiting `hostReady`, and `nativeHydrating()` stops the sign-in screen drawing first.

- **Not an `await` gate in `main.tsx`**: it would move `installWakeDetection()` and
  `store.bootstrap()` out of the module body. `main.tsx` is untouched by the native shell.
- **Not Tauri's `initialization_script`**: fixed at window creation, so `store.signOut()`'s
  reload would re-inject what `clearSession()` deleted (the defect `setSession`'s docblock
  records), and it puts a blocking keychain read on window creation.
- **Not in Rust alone**: `cpFetch` attributes a 401 by `credential === sent` identity;
  `webcheck.native-bridge.ts` drives that race over the native transport.

## The server picker is a phase, not a route

`ChooseServer.tsx` sits beside `SignIn.tsx`, reached by `state.host` (`null` in a browser).

- **The first screen is a welcome**: one field holding the build's suggestion, locked, with a
  pencil; **Continue** adopts it, then sign-in. Never the address as a *Change* line under the
  sign-in form (owner's call, 2026-09-16).
- **Sign-in carries a leading `‹ Server`** (a `web-shell.md` back control naming its
  destination, never the address) only on a pending sign-in with an account to return to
  (Q5.120); not on a first run, which knowingly leaves a wrong address a one-way door (Q3.643).
- Entrances: `state.host.server === null` (the welcome: first run, or an add) and
  `state.pickingServer` (`‹ Server`). Another server is another account.
- **`cp.detachSession()` runs before `setNativeServer`**, or a poll or in-flight `cpFetch`
  hands server A's token to the new base. `host_set_server` refuses all but a pending seat
  (Q5.120), so this is the belt. Never `clearSession()`. `webcheck` asserts the two indices.
- Adopting the origin already held returns early: nothing written, erased or reloaded.
- **A way back exists iff there is an account to go back to**, which keeps the first run
  uncancellable and `signInReady` server-free. The screen says adding costs others nothing.
- Not a `Route` arm: `parseGateScreen` is shared with the router (the web build would draw
  `/server`), and eight `Route` switches (`depthOf`, `screenOf`, `isSheet`, …) would need an arm.
- Above the `legal` arm: a document route waits on `state.config` from `GET /v1/instance`,
  which needs a server, so below it `/terms` spins while the picker is open.
- **The page validates no address.** The host normalizes (scheme filled in, host lowercased,
  default port dropped, path and query discarded) to one spelling or a sentence; two
  normalizers would be two credential keys. `http://` and `https://` are never folded.
- It probes `GET /v1/instance` then `GET /v1/jwks` (both above the auth gate; a 404 on the
  first is a rolled-back control plane) before adopting, which ends in `location.assign("/")`.

## The default server, and why this repository names none

`option_env!("REEMOAT_DEFAULT_SERVER")` in `config.rs` is the only build-time input and **no
file here gives it a value**: releases forward a repository variable a fork does not inherit,
and `nativecheck` allows that one `release.yml` line and refuses every other setter, as it
asserts `signingIdentity: null` (Q4.127). Read in Rust, not via `import.meta.env`, so
`host_cp`'s base stays in the host; at compile time, since a bundle has no environment. `build.rs` carries
`cargo:rerun-if-env-changed`, or a cached object keeps the old value.

**A suggestion for a form field, never written down** (Q4.121). `read_server` (*which fleet is
this installation on*) is the only reader `lib.rs` calls; `default_server` reaches the page as
`defaultServer`; **Continue** adopts. `nativecheck` holds the two apart. A malformed default
is no default, and a fork's typo fails its own `cargo test`.

## The gate is the browser's, and this bundle carries none of it

`/register`, `/confirm`, `/forgot`, `/reset`, `/verify` are served by the control plane from
`dist-gate`. `SignIn`'s two links are anchors at `controlPlaneOrigin()`: **absolute** (a
relative href answers `null` from `openableHref`) and **`target="_blank"`** (Q3.606).
`ui/gate/GateCard.tsx` is the named exception (`ForcedPasswordChange` renders one);
`webcheck` walks both entry points' import closures, dynamic imports included. `Route` keeps
its `gate` arm and `screenOf` its case (keeping `parseGateScreen` and `parseLegalDoc`
disjoint); a typed `/register` falls through to `SignIn`.

## Facts about the platform

- **`dragDropEnabled: false` is load-bearing**: otherwise Tauri takes OS drops and
  `Composer.tsx`'s and `ImportCode.tsx`'s drops die while the paperclip works. `nativecheck`
  asserts it; a child webview gets it only through `from_config` (`seats.rs`).
- WebKit rewrites keystrokes (`"` to `“`, `--` to `—`). `leave_typing_alone` registers
  `VERBATIM_TYPING` off before the first webview, never sets it, so the person's
  Substitutions toggle wins; `autocorrect="off"` does nothing on macOS. Q3.647.
- The window's theme is the switch's, set in Rust, never declared; app-wide on macOS, where
  `prefers-color-scheme` follows it. Q3.671.
- `tauri://localhost` is a secure context on macOS; the clipboard still takes a native arm first.
- **Two platform vocabularies share one word, `linux`.** `NativeBoot.platform` is
  `std::env::consts::OS` (`macos`; this client; `hostPlatform`, `platform.ts`); `SystemInfo.os`
  is `process.platform` (`darwin`; that machine; `osName`, `ui/agentCard.ts`). `webcheck` keeps the two
  modules apart.
- **A sentence naming an OS comes from `localNetworkDetail`**, total over `HostPlatform` with
  a `never` arm; only its macOS arm names one (the only measured case). `webcheck` sweeps
  for `macOS`/`Windows`/`Linux` against an exact five-file allowlist.
- `AGENT_HOST_OS` is about the other computer, never this one; held against
  `deploy/bootstrap.sh`'s `detect_platform` (`Darwin`, `Linux`; no Windows installer).
- PATH: `env::join_paths`/`env::split_paths`, never `join(":")`; the user's PATH is split
  before joining. Homebrew on the macOS fallback only; no Linuxbrew. `login_shell_path` is
  Unix by decision (Git Bash and MSYS2 set `SHELL` on Windows).
- **The close button puts the app away on macOS and Windows; only a Quit quits** (`away.rs`):
  daemons run on, back from the Dock (`Reopen`) or the Windows tray or a second launch
  (single-instance, the first plugin). ⌘Q, menus and the tray's Quit reach `RunEvent::Exit`.
  Linux quits on close (Q6.108). Q3.697.
- The origin is `tauri://localhost` (macOS, Linux) or `http://tauri.localhost` (Windows,
  Android): use `controlPlaneOrigin()`, not `location.origin`; `is_our_own` in `lib.rs` names all.
- The asset protocol falls back to `index.html`, so deep links and `location.reload()` work.
- The CSP is static and the relay origin arrives per machine from `POST /v1/tokens`, so
  `connect-src` is bounded by scheme; `script-src 'self'` holds (no inline script; nothing
  else can define `window.__TAURI__`).
- The save and folder panels are `native-panels.md`.

## The capability surface is `commands.rs`

An app-defined `#[tauri::command]` is **not** ACL-gated, so `commands.rs` is the whole surface
and `capabilities/default.json` grants nothing. `host_local_daemon` answers a finished origin
from the daemon's file, and `local.rs` refuses all but `127.0.0.1` and `::1`. Neither it nor
`host_daemon_log` (the supervisor's 200-line ring for Settings → Logs, kept off
`host_daemon_state`'s one-second poll) opens a socket (Q7.140). The
plugins `opener`, `dialog`, `clipboard-manager` are driven **from Rust**; `nativecheck` pins
the permission list empty as an exact set, with those prefixes named out.

**The daemon commands answer about the calling webview's account**, on `native-accounts.md`'s
roots; the root, the origin and, off the legacy root, `REEMOAT_PORT=0` go on the spawn, so
`OWNED_KEYS` stays three. Q7.149.

Three censuses: declared against registered (`nativecheck`), registered against called and
called against registered (`webcheck.native-bridge.ts`). A command name built from a variable
is refused.

## One rule, three copies, compared

Openable schemes are `OPENABLE` in `ui/links.ts` (`http`/`https`/`mailto`). `native.ts`'s click
interceptor reuses `openableHref`; `commands.rs` carries the backstop; `nativecheck` asserts the
two lists are one set, since a wider backstop is a bigger door than the web build.

`on_navigation` allows **only this app's own document**, on every account's webview.
`localhost` and `127.0.0.1` only under `cfg!(debug_assertions)` (a loopback control plane
serves its own `index.html`); `tauri.localhost` stays, being the bundle's origin on Windows
and Android. No CSP directive constrains navigation. `webcheck.native-bridge.ts` asserts
every `location.assign`/`location.replace` is a root-relative literal.

## Where this package sits, and what depends on that

**`packages/native` is excluded from the pnpm workspace** (`- '!packages/native'`). As a member:

1. `deploy/bootstrap.sh`'s and `deploy/deploy.sh`'s unfiltered root install (`INSTALL_DEPS`
   matches `^packages/[^/]+/package\.json$`) would put the Tauri CLI on every daemon host (Q4.114).
2. `RELAY_INPUTS` matches `^pnpm-lock\.yaml$`: every Tauri bump would recreate the relay and
   drop every tunnel.
3. `deploy/docker/Dockerfile`'s `--frozen-lockfile` checks every importer in a deny-first
   context: the image would stop building, seen only by `imagecheck`.

`packages/native/pnpm-workspace.yaml` stops pnpm's upward root search (else `pnpm install`
here installs nothing, exit 0). **No TypeScript here**, asserted: the root `tsconfig.json`
would compile a `.ts` without DOM and a `.tsx` not at all. `docscheck`'s `SKIP_DIR` skips
`target` (its fingerprints would resolve stale symbols); `rs` is a source extension, `toml`
is not (Q4.117). `pnpm native:build` rewrites `packages/web/dist` under a running `pnpm cp` (Q5.15).

## What is not built, and where the seam is

- **The local-daemon route is built** (`relay.md`, Q7.137): a file `src/announce.ts` wrote,
  never a port probe, which would hand a bearer to whatever answered.
- **`SecretStore`** has no `list()`, and `read`/`write` carry *a string this process will
  see*, so a private key cannot use them; no device id is generated at first run. Q7.136.
- **No updater**, configured absent. Generate its keypair before a first public build: a build
  with no public key can never be updated in place.
- **No menu bar, no notifications, a tray on Windows alone** (Q3.697).

## Known gotchas

- `create: false` on the window: `seats.rs` builds it to attach `on_navigation`; `true` adds a
  second, unguarded window.
- `reqwest` 0.13: no `rustls-tls-native-roots`; `default-tls` uses the OS trust store (private CAs).
- `keyring` 4's default features are named explicitly; a memory-store default would forget.
- No universal binary: no `rustup` here, so desktop builds are arm64-only (`docs/NATIVE.md`).
