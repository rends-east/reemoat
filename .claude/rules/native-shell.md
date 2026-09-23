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

`packages/native` is a Tauri 2 window around `packages/web`, built once and
**embedded in the binary**. The point of the exercise is that sentence: the server
this app supervises cannot replace the code running in it. Everything here is a
fact about a webview under a custom scheme rather than a decision of ours, and each
one was measured before it was written down.

`native.ts` is deliberately written to the pattern the Telegram mini app's bridge
used — somebody else's webview, hand-written, no vendor SDK — rather than to
Tauri's examples. That sibling is **gone** (Q1.649), rule file and all; the
pattern is what it left behind.

## Commands

```bash
pnpm --dir packages/native install    # its own node_modules; the root install does NOT do this
pnpm native                           # tauri dev: Vite on 5173, the window over it
pnpm native:build                     # builds packages/web, drops its source maps, bundles the .app.
                                      #   NOT the .dmg: Tauri's bundle_dmg.sh drives Finder over
                                      #   AppleScript and times out wherever nobody is logged in —
                                      #   `--bundles dmg` from a real session, see docs/NATIVE.md
pnpm nativecheck                      # offline, no cargo; joins `pnpm check`
cd packages/native/src-tauri && cargo test          # the Rust unit tests
cd packages/native/src-tauri && cargo clippy -- -D warnings
```

## Two transports, and the split is a count

**Exactly one leg of this client leaves the webview, and it is the one with no
CORS.** `src/cors.ts` is the *daemon's* and the *relay's* — both answer
`access-control-allow-origin: *`, so both are reachable from `tauri://localhost`
unchanged. The **control plane mounts no CORS middleware at all**
(`grep -rn "hono/cors" packages/control-plane/src/` returns nothing), deliberately:
`vite.config.ts` proxies `/v1` in dev *"instead of making dev the one place a CORS
rule has to exist for the control plane"*. So `/v1/*` goes through the host process
and nothing else does.

**Four reasons the relay and daemon legs must stay in the webview**, any one of
which is sufficient:

- `machine.ts`'s `sendWithProgress` is `XMLHttpRequest` because `fetch` reports no
  upload progress and a streamed request body is Chromium-only. A Rust client has
  no progress events at all.
- `withTimeout` composes an outer `AbortSignal`, which `request` threads through.
  An `invoke` cannot be aborted.
- `isTransportFailure` is a **negation** — anything that is not an `ApiError`. A
  second place deciding what a transport failure is will eventually disagree, and
  the two ways it can disagree are "every subway tunnel signs the fleet out" and
  "nobody is ever signed out".
- **The Noise handshake runs in the page**, and moving the daemon leg to Rust would
  give an encrypted stream two decryptors. The device key does *not* — the private
  half stays in the keyring and `host_device_dh` answers a shared secret, so the
  page holds a DH oracle scoped to itself and never the key.

`nativecheck` asserts the control plane does **not** appear in the shell's
`connect-src`: if it does, the split has quietly stopped being one.

## A path crosses the bridge, never a URL

`host_cp` takes `{path, method, headers, body, origin?}` and joins the path onto a
base that lives in the **host process**. So `cp.ts`'s oldest rule — *the credential
is sent to one origin and nowhere else* — is enforced somewhere the page cannot
reach, which is stronger than same-origin rather than weaker.

⚠ **`Url::join` is not the check.** It happily replaces the whole origin for
`//evil.example` or `https://evil.example`, both of which are things a string
starting with `/` can be made to look like. Comparing origins **afterwards** is
what holds, and the `/v1/` prefix test in front of it is what keeps the host from
being a general-purpose proxy for the page. `proxy.rs`'s own tests drive every
escape shape.

Three more rules at that boundary, each with a failure behind it:

- **Only `authorization` and `content-type` are forwarded.** The four call sites in
  `cp.ts` send those or nothing, so the allowlist is complete — and a complete
  allowlist means the page cannot smuggle a header into a request made with the
  fleet's credential.
- **Redirects are never followed** (`Policy::none()`). A redirect is how a request
  carrying the credential walks to a host nobody chose.
- **A status outside `200..=599` is an `Err`, not an answer.** `new Response(…)`
  throws a `RangeError` outside that range, and a throw inside the bridge would be
  reported as a *transport* failure about a request that was answered.

And the one that decides the rest: **a failure is a rejection, never a status.**
The bridge re-throws the host's error as a `TypeError`, because `isTransportFailure`
is a negation and `errorText` narrows on `instanceof Error`.

## The credential is keyed on the server's origin

A browser hands out one storage area per origin, so it scopes a credential to a
server for free. **A custom scheme does not: there is one webview origin for every
server somebody might point this app at.** So the keyring account *is* the origin —
`credential#<origin>` — which means a credential cannot be read for a server it was
not issued by, structurally rather than because a code path remembered to clear it.
`host_set_server` keeps the previous origin's entry, so switching back asks nothing
(Q7.148); signing out erases the current one. ⚠ What that widens: a script in this
window could move the origin and re-read `host_boot`, reaching every kept server's
credential rather than one — recorded in Q7.148 with its close.

`#` as the delimiter, chosen rather than defaulted: a URL origin cannot contain
one, so no escaping is needed, and a later `credential#<origin>#<account>` is an
extension of this shape rather than a migration away from it.

⚠ **The web arm keeps the unscoped name `reemoat.credential`, deliberately**, and
so do the two pre-rename names `cp.ts` reads once and sweeps. A browser origin
already scopes them, and renaming either would sign the fleet out for nothing —
which is the argument `cp.ts`'s own ⚠ block makes. The asymmetry looks like an
inconsistency and is not one.

**What is never stored.** The person's password: there is no "remember me", and
`POST /v1/me/password` asks for the current one whichever credential presents, so a
stored password would make that a formality. And any daemon credential:
`REEMOAT_TOKEN` reaches a daemon with no grant at all, and a machine token is 300
seconds long and derived — it belongs at `machine.ts`'s `ensureToken` and nowhere
near an OS keyring.

**Durability is a probe, never a `cfg!`.** `credential::probe` writes a canary,
reads it back, compares it and erases it, because a store that *accepts* a write and
loses it is the failure that reads as working — a Linux box with no D-Bus session or
no unlocked collection compiles and runs fine. A `false` draws **the sentence
`cp.ts` already has** for a browser with storage disabled; one state, one wording.

## The synchronous read, and the two answers that were refused

`cp.ts` reads its credential **synchronously in the module body**, and a keyring is
async. The native arm therefore starts `null` and `store.bootstrap()` fills it
through `adoptHydratedCredential` after awaiting `hostReady`;
`nativeHydrating()` is what stops the sign-in screen being drawn in the frame
before it lands.

⚠ **Not an `await` gate in `main.tsx`.** That moves `installWakeDetection()` and
`store.bootstrap()` out of the module body and into an async one. The Telegram
launch sequence was the other thing such a gate would have moved, and a driver
pinned its ordering off disk for exactly that reason; the mini app is **gone**
(Q1.649) and this rule outlived it. **`main.tsx` is untouched by the native
shell**, and that is a property: there is no chrome to configure and no readiness
to announce, so the bridge installs itself from its own module body.

⚠ **Not Tauri's `initialization_script`.** It is fixed at window creation, so the
reload in `store.signOut()` would re-inject the credential `clearSession()` had just
deleted — which is exactly the defect `setSession`'s own docblock records having
shipped once. It also puts a blocking keychain read on the window-creation path,
where an unsigned development build changes code identity on every `cargo build`.

⚠ **And the credential is not kept in Rust alone.** `cpFetch` attributes a 401 by
comparing `credential === sent` **by identity**; a handle the page cannot compare
would silently lose the rule that stops a late 401 signing you out of a session that
had just started. `webcheck.native-bridge.ts` drives that race over the native
transport for exactly this reason.

## The server picker is a phase, not a route

`ChooseServer.tsx` sits beside `SignIn.tsx` and is reached by `state.host`, which
is **`null` in a browser and for ever**. `ForcedPasswordChange` is the precedent:
*"reached by state, not by a URL, which is why it is filed beside `SignIn.tsx`"*.

**The first screen is a welcome, not a picker.** On a machine where nothing has
happened yet it greets, says what is about to happen, and asks one thing, with the
field already holding what the build suggests; **Continue** adopts it and the
sign-in form is next. ⚠ That ordering was briefly the other way round — the
default was written down at first launch and the address appeared instead as a
line with a *Change* link under the sign-in form's lead sentence. The argument for
it was real (a custom scheme has no address bar, so `cp.ts`'s "one origin" rule
has nowhere else to be stated) and the screen was still wrong: a login form is not
where somebody learns which fleet they are on, and a URL with a verb beside it
reads as a thing to deal with before typing a password. Owner's call, 2026-09-16,
on seeing it shipped.

⚠ **The sign-in form carries a leading `‹ Server`, and building the welcome
without one was a one-way door in a new place.** `Continue` adopts an address; a
reachable but *wrong* one then left somebody on a sign-in form with no route to
the screen that sets it — Settings → Account needs a session, and getting one
needs the right server. It names its destination and never the address, which is
the line that was rejected; it is shell-only, there being nowhere to go in a
browser; and it is `web-shell.md`'s kind of back control, a fixed destination
drawn as a chevron rather than `history.back()`.

**Two entrances, and the second closed a hole rather than adding a convenience.**
`state.host.server === null` is the welcome above; `state.pickingServer` is the
**Server address** row under Settings → Account. Before it, `setNativeServer` had
exactly one call site and `clearSession` leaves the server alone — so a server
once chosen **could not be changed from inside the app at all**, and the only
remedy was deleting the shell's config by hand.

⚠ **`cp.detachSession()` runs before `setNativeServer`, and the safe-looking order
is the wrong one.** `host_set_server` moves the base **in the host process**, so
from the instant it returns every `host_cp` call goes to the *new* origin while
the page still holds the old fleet's bearer — and the four-second poll,
`refreshConfig` or any `cpFetch` in flight would hand server A's session token to
a host somebody has just typed in. While the screen was only ever drawn at
`server === null` there was no credential and no window; as a settings screen
there is both. `detachSession()` is local, instant, cannot fail, and drops the
page's copy only — never `clearSession()`, which would sign out of the server
being left. What the other order costs is a credential disclosure. `webcheck` asserts the two
indices, because every other assertion stays green either way.

**Adopting an origin equal to the one already held reloads nothing.**
`host_set_server` returns early on a match — no file written, no credential
erased — so re-typing the address you are on would otherwise be a reload charged
for a spelling. Only reachable from the editing entrance, which is why it did not
have to exist before.

**Cancel exists if and only if there is a server to go back to**, and that is the
whole of what keeps the first-run state uncancellable. It is also why
`signInReady` did not have to learn about servers: there is no path to a sign-in
form with no server, so the guard is structural rather than a second predicate
answering a question `App.tsx` already answers.

**What changing servers costs is said on the screen, and each sentence is
load-bearing.** The first — *"stays signed in"* — is true because nothing erases
`credential#<old origin>` and **nothing here ends the session on the old
server**: no `DELETE /v1/me/sessions/current` is sent, deliberately, it being a
network call to a server somebody is leaving, which is often *why* they are
leaving. The row stays in that server's Settings → Devices. A second, where a
daemon can run: the old server's keeps running until quit, because
`host_set_server` stops none.

A `Route` arm would have been wrong twice. `parseGateScreen` is shared with the
router, so the web build would parse and draw `/server` — a screen that can do
nothing where the server is the origin that served the page. And `depthOf`,
`sheetKind`, `sheetTitle`, `screenOf` and `upFrom` switch over `Route` while
`isSheet`, `isOverlayPath` and `sheetUpLabel` take a new arm in silence: eight
edits and a case table, against none.

Above the `legal` arm, because `App` waits on `state.config` for a document route
and `config` comes from `GET /v1/instance`, which needs a server. Below it,
`/terms` spins for ever. ⚠ **That was a sentence about a freshly installed app and
is now a standing one**: with the picker reachable while signed in, "there is no
usable config" is every frame it is open rather than only the first ones after an
install. There is no gate arm left to be above — see below.

**Nothing in the page validates an address.** The host normalizes — scheme filled
in, host lowercased, a default port dropped, path and query discarded — and answers
the one canonical spelling or a sentence. One authority, because two normalizers is
two spellings of one origin, which is two credential keys, one of which a sign-out
would not reach. The scheme is never normalized away: `http://` and `https://` are
different trust boundaries.

**It probes before it adopts**, `GET /v1/instance` then `GET /v1/jwks` — both above
the control plane's auth gate, so neither needs a credential. A 404 on the first is
*not* an outage (a control plane rolled back past that release answers one), which
is why there is a second question rather than a refusal. Adopting ends in
`location.assign("/")`, because every connection, token, route memo and socket in
the process was derived from a credential for a different fleet.

## The default server, and why this repository has none

`option_env!("REEMOAT_DEFAULT_SERVER")` in `config.rs` is the only build-time
input this app has, and **it is empty here**. `nativecheck` asserts that the way
it asserts `signingIdentity: null`: this is AGPL software and forks run their own
control planes, so a value compiled in would be one deployment's address in
everybody's binary. `cp-accounts.md` makes the same argument for the two
`REEMOAT_CP_*` addresses that reach the browser.

**Read in Rust rather than on the page**, for two reasons pointing the same way:
`native.ts` refuses `import.meta.env`-style flags in that layer, and `host_cp`'s
base has to live in the host process where the page cannot reach it — the same
string the keyring account is built from. **Environment at compile time** rather
than run time is the one departure: a bundle has no environment to read when
Finder, Explorer or a desktop entry launches it.

⚠ **`build.rs` carries `cargo:rerun-if-env-changed` for the name**, without which
the value is baked into a cached object file and a fork that corrects its address
gets a binary silently keeping the previous one.

⚠ **It is a suggestion for a form field and never a value anything writes down.**
Both alternatives were built and taken back out — seeding it at first launch skips
the welcome and makes a keyring account for an origin nobody confirmed; a fallback
inside `read_server` silently repoints an installation when a later build ships a
different default. Q4.121 carries both at length.

So: **two functions, two questions.** `read_server` is *which fleet is this
installation on* and is the only reader `lib.rs` calls; `default_server` is *what
shall the box open on*, reaches the page as its own `defaultServer` field, and is
written down by nothing. **Continue is the act that adopts an address.**
`nativecheck` holds them apart, folding them being the edit that passes every
other assertion there. A malformed default is no default: the box opens empty and
the screen asks, and a fork's typo fails its own `cargo test`.

## The gate is the browser's, and this bundle carries none of it

`/register`, `/confirm`, `/forgot`, `/reset` and `/verify` are addresses the
**control plane** serves, from `dist-gate`, over a closed list checked before the
app's own fallback. So no HTTP request has ever rendered this bundle's copy of
them, and under the shell three of the five had no way in at all — a mail client
opens a link in a browser, and a Tauri window has no address bar. What `App.tsx`'s
gate arm actually drew was the two screens `SignIn` created client-side.

Both are **anchors** now, at `controlPlaneOrigin()` — **absolute** (a relative
href answers `null` from `openableHref`, so the interceptor never fires and the
webview quietly redraws the sign-in screen) and **`target="_blank"`** (a plain
anchor is a real navigation, which in a browser throws away whatever was typed on
the sign-in form behind it). Q3.606 carries both at length.

`ui/gate/GateCard.tsx` stays in the app bundle and is the **named exception**:
`ForcedPasswordChange` renders one. So the rule is *no gate screen*, not *nothing
from that directory*, and `webcheck` walks both entry points' import closures to
hold it — including dynamic imports, because a `lazy()` chunk is every bit as
present in `dist` as the entry.

`Route` keeps its `gate` arm and `screenOf` keeps its case: deleting those is the
eight-edits-and-a-case-table above, and the parse is what keeps `parseGateScreen`
and `parseLegalDoc` assertably disjoint. A typed `/register` falls through to
`SignIn`, which is the answer every unknown path already gets.

## Facts about the platform

- **`dragDropEnabled: false` is load-bearing, not styling.** Tauri intercepts OS
  file drops by default and `event.dataTransfer.files` then never arrives — which
  takes `Composer.tsx`'s attachment drop and `ImportCode.tsx`'s archive drop with
  it, while the paperclip beside them keeps working. So the failure reads as "drag
  and drop was never supported". `nativecheck` asserts it because nothing else can.
- **`tauri://localhost` is a secure context** on macOS, so `crypto.*` and
  `navigator.clipboard` are available. The clipboard still gets a native arm first:
  a webview that has the object and refuses it without focus would fall through to
  `execCommand`, which some webviews have removed.
- **There are two platform vocabularies and they agree on exactly one spelling.**
  `NativeBoot.platform` is Rust's `std::env::consts::OS` — `macos`, `windows`,
  `linux` — and is about **this client**; a daemon's `SystemInfo.os` is Node's
  `process.platform` — `darwin`, `win32`, `linux` — and is about **that machine**.
  `hostPlatform` in `platform.ts` reads the first, `osName` in `ui/agentCard.ts`
  the second. `linux` is the shared word, which is what makes a mixed-up call look
  right in review and answer "other" for every Mac in the fleet. `webcheck`
  asserts neither module reaches the other.
- **A sentence that names an operating system comes from one function, and there
  is a census.** `localNetworkDetail` is total over `HostPlatform` with a `never`
  arm, and **only its macOS arm names an OS** — Local Network Privacy is a
  measurement, and nothing equivalent has been measured on Windows or Linux, so
  those arms state the fact and point at the evidence rather than inventing a
  remedy. The defect it generalises: the string it replaces told everybody on
  every platform to open System Settings, while the classifier producing that
  state keys on an errno and fires on any Unix. `webcheck` sweeps the whole
  package for `macOS`/`Windows`/`Linux` against an **exact** five-file allowlist,
  and not one of the five is a screen describing the computer it is drawn on.
- **`AGENT_HOST_OS` is about the *other* computer and must never branch on this
  one.** A Windows client adding a Linux machine is the ordinary case. It is held
  against `deploy/bootstrap.sh`'s `detect_platform`, which accepts `Darwin` and
  `Linux` and refuses everything else — there is no Windows installer because
  `install.sh` is a shell script and there is no supervisor there to install into.
- **PATH is a list, joined with the platform's own separator.** `env::join_paths`
  and `env::split_paths`, never `join(":")` — which on Windows made the daemon's
  whole PATH one garbage entry, and on POSIX silently corrupted the list for a
  directory whose own name held a colon. The user's answer is *split* before it is
  joined, because a component may not contain the separator and their `PATH` is
  itself a list: pushing it whole made the join fail and collapsed the daemon's
  PATH to the payload's `.bin`, which `cargo test` caught. Homebrew is named on
  the macOS fallback only; Linuxbrew is deliberately absent, being a guess rather
  than a measurement.
- **`login_shell_path` is Unix by decision rather than by accident.** It answered
  `None` on Windows because `SHELL` is unset — luck that breaks under Git Bash and
  MSYS2, which set it to a POSIX shell that knows nothing of the Windows `PATH`.
- **Closing the last window quits, on every platform including macOS.** Measured
  in `tauri-runtime-wry`: destroying the last window emits `ExitRequested` and,
  with nothing calling `prevent_exit()`, sets `ControlFlow::Exit`. ⚠ `lib.rs` said
  *"closing the window on macOS is not quitting"* for four releases — a fact about
  **AppKit**, which Tauri does not implement. The code was right and the reason
  was not. The macOS convention (stay running, return from the dock) is a
  deliberate non-goal beside "no menu bar, no tray".
- **The origin is not the same string on every platform.** `tauri://localhost` on
  macOS and Linux, `http://tauri.localhost` on Windows and Android. Anything
  comparing an origin, or building a URL out of `location.origin`, is
  macOS-specific — which is why `controlPlaneOrigin()` exists and why `is_our_own`
  in `lib.rs` names all three.
- **The two platform panels are `native-panels.md`** — the save panel, the folder
  panel a local daemon gets, and the `(async)` rule both of them turn on.
- **Tauri's asset protocol already falls back to `index.html`**, so the pathname
  router, deep links and `location.reload()` on a deep path all work with no
  handler of our own.
- **The CSP is static where the browser client's is built.**
  `packages/control-plane/src/app.ts` composes `connect-src` from `relayUrl` at app
  construction; a bundled app has no such header and the relay's origin arrives per
  machine from `POST /v1/tokens`. So the bound is the **scheme**, stated rather than
  left to read as carelessness — and what actually holds is `script-src 'self'`,
  because the bundle carries no inline script and nothing else can define
  `window.__TAURI__`.

## The capability surface is `commands.rs`

An app-defined `#[tauri::command]` is **not** ACL-gated — it is callable from every
window without an entry — so `commands.rs` is the whole surface and
`capabilities/default.json` grants nothing. **Thirteen** of them — `nativecheck`
holds the two lists to each other rather than this file holding a number, which is
why the count here is prose and not a claim anything rests on. `host_local_daemon`
reads a file the *daemon* wrote and answers a finished
origin rather than the host and port it was built from — `local.rs` refuses
anything but `127.0.0.1` and `::1`, in the host process, for `host_cp`'s reason. It
opens no socket, so the leg count two sections up is unchanged; neither does
`host_daemon_log`, the newest, which hands the page the supervisor's own 200-line
ring for Settings → Logs. That is a **second** reader of that ring on purpose:
`host_daemon_state` is on the setup screen's one-second poll and its `detail` means
*what explains this failure*, so widening it would put a log on a poll. The three Tauri plugins here
(`opener`, `dialog`, `clipboard-manager`) are driven **from Rust**, so a JS
permission for any of them would be a door the webview could walk through on a page
that renders agent output. `nativecheck` pins the permission list empty as an exact
set and names those prefixes out of it.

**The daemon commands answer about the server the app is on.** `state_root` keeps
`~/.reemoat` for the server its `daemon.env` names, `~/.reemoat/servers/<server>/`
for every other; the root, the origin and, off the legacy root, `REEMOAT_PORT=0` go
on the spawn, never into the file, so `OWNED_KEYS` stays three. A `Supervisor` per
origin, all stopped at `RunEvent::Exit`. Q7.148.

Three censuses hold the command list, in three directions, and each catches a
different failure: declared against registered (`nativecheck` — a dead function),
registered against called (`webcheck.native-bridge.ts` — attack surface nobody
uses), and called against registered (the same file — a runtime `Command … not
found` nothing else sees). A command name assembled from a variable would make all
three vacuous, so it is refused.

## One rule, three copies, compared

The schemes a link may open are `OPENABLE` in `ui/links.ts`, and the argument is
there: everything outside `http`/`https`/`mailto` is *"launching a program named by
an agent-chosen string"*, on a page that renders agent output.

The click interceptor in `native.ts` **reuses `openableHref`** rather than
re-deriving it, so there is no second policy in the page. `commands.rs` carries a
third copy as the half that holds if the page is ever wrong, and `nativecheck` reads
both lists off disk and asserts they are the same set. A backstop that could be
*wider* than the policy would make the native build a bigger door than the web one.

Separately, `on_navigation` allows **only this app's own document** — not an
allowlist, a single rule — so a script assigning `location.href` cannot replace the
running app with somebody else's page inside a window holding the fleet's
credential.

⚠ **`localhost` and `127.0.0.1` were in that rule unconditionally, and it was a
hole rather than a loosening.** They are there for the Vite dev server — but a
Reemoat control plane on loopback is the ordinary self-hosted shape (`pnpm cp`, a
dev stand, a single-box install) and it serves its own `index.html` at `/`. So the
one navigation a bundled frontend exists to make impossible was reachable, on
precisely the deployments this client is for. They are `cfg!(debug_assertions)`
now; `tauri.localhost` stays in every build, being the *bundle's* origin on Windows
and Android rather than a server's. The CSP could not have helped: there is no
`navigate-to` directive, and neither `form-action` nor `base-uri` constrains a
navigation. `webcheck.native-bridge.ts` holds the caller-side half — every
`location.assign` in this client is a root-relative literal, today `"/"` at all
four sites.

## Where this package sits, and what depends on that

**`packages/native` is under `packages/` and excluded from the pnpm workspace**
(`- '!packages/native'`), and one line carries three consequences:

1. `deploy/bootstrap.sh` and `deploy/deploy.sh` both run an **unfiltered** root
   `pnpm install --frozen-lockfile` on every machine in the fleet, and
   `INSTALL_DEPS` matches `^packages/[^/]+/package\.json$`. As a member, the Tauri
   CLI and its platform binary would install on every daemon host to be run by
   none. Q4.114 is the same argument at 552 MB.
2. `RELAY_INPUTS` matches `^pnpm-lock\.yaml$`, because the lockfile decides which
   `tsx` the relay runs. As a member, every Tauri bump would recreate the relay
   container and **drop every tunnel in the fleet** for a change no relay contains.
3. `deploy/docker/Dockerfile`'s `--frozen-lockfile` verifies the lockfile against
   *every* importer before installing the filtered subset, and the build context is
   deny-first. As a member it would be an importer the context cannot see, and the
   image would stop building — caught only by `imagecheck`, a separate CI job.

Exclusion alone is not enough: pnpm resolves a root by searching **upwards**, so
`pnpm install` in here found the repository's root, installed the three projects it
lists and left this one with no `node_modules` — silently, exit 0, *"Already up to
date"*. `packages/native/pnpm-workspace.yaml` is the marker that stops the walk.

**This package holds no TypeScript**, and that is asserted rather than excluded. The
root `tsconfig.json` compiles `packages/*/src/**/*.ts` and
`packages/*/scripts/**/*.ts` under `lib: ["ES2023"]` with no DOM, so a `.ts` here
would be compiled by the daemon's config — and a `.tsx` by nothing at all. An
`exclude` would make the second case silent, so the driver names the absence
instead.

⚠ **`docscheck` walks the working tree, not `git ls-files`.** `target/` is 2.9 GB
after one `cargo check`, so `SKIP_DIR` had to grow `target` and `gen` — without
that, every `.json` fingerprint in there enters the symbol corpus and assertion 4
starts answering `true` for stale symbols, which is that driver switched off in the
direction that reads as passing. The extension list gained `rs` in the same edit and only
because of it. Not `toml`: `Cargo.toml` and `Cargo.lock` are manifests of dependency
names, which is the `pnpm-lock.yaml` hazard that driver already refuses. Q4.117.

⚠ `pnpm native:build` rewrites `packages/web/dist` under any locally running
`pnpm cp` — Q5.15's failure, the same hazard `pnpm web:build` already has.

## What is not built, and where the seam is

- ~~No local-daemon route.~~ **Built, and every condition this bullet set was met.**
  `probeRoute` returns two answers again; `Route` carries a `kind`, read by
  `settleAnswer` alone. Loopback is enforced in `local.rs` rather than in the page;
  the `aud` check on one authenticated `GET /fs/roots` establishes the machine, and
  ⚠ any status but 401 is proof, since a 403 about a scope and a bare 404 both come
  from below the auth gate; the ~360 s gap is the sentence beside the switch in
  Settings → Machines → *This device*; `meansWrongMachine` is the 401 rule, guarded
  on `route.kind` so the relay candidate cannot reach it; and the switch is per
  machine. `.claude/rules/relay.md` is the area and Q7.137 is the argument.

  Two things changed *under* the conditions rather than satisfying them, and both
  are in that entry. **On by default**, because who can take this path at all is the
  uid that already owns `~/.reemoat`. And a **file rather than a port probe** —
  `host_local_daemon` reads what `src/announce.ts` wrote — because a probe has to
  carry a machine token to prove anything, and that hands a 300-second bearer to
  whatever happened to answer.
- **No device identity.** `SecretStore` in Rust is a trait with one member and no
  `list()`, and `read`/`write` are documented as *a string this process will see* —
  which names, at the interface, why a private key cannot use them. **No first-run
  generated device id**, because that is device identity arriving by accident.
- **No updater.** Configured absent rather than half-wired. The step that must
  happen *before* a first public build is generating the keypair: a shipped build
  with no public key can never be updated in place by a later one that has it.
- **No menu bar, no tray, no notifications.** `packages/web` has never had a
  `Notification` call, and adding one is new product behaviour with its own
  settings rather than part of a client migration.

## Known gotchas

- **`create: false` on the window is deliberate.** `lib.rs` builds it from that same
  config in order to attach `on_navigation`; with `create` left true there would be
  two windows, one of them unguarded.
- **`reqwest` 0.13 renamed its TLS features.** There is no `rustls-tls-native-roots`
  any more; `default-tls` is what uses the operating system's trust store, which is
  what a self-hosted control plane behind a private CA needs.
- **`keyring` 4's default feature set is named explicitly.** A default that changed
  to a memory store would compile, run and forget — and the durability probe is the
  half that would catch it.
- **No universal binary here.** `--target universal-apple-darwin` needs
  `x86_64-apple-darwin`, and this machine has a Homebrew toolchain with no `rustup`,
  so desktop builds are arm64-only. `docs/NATIVE.md` carries the rest.
