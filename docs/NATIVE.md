# The native app

`packages/native` is a [Tauri 2](https://v2.tauri.app) window around
`packages/web`, built once and **embedded in the binary**. That sentence is the
point of it: the control plane this app supervises serves no JavaScript to it and
cannot replace any.

It is a **fourth client of the same API** and not a fourth deployment. Nothing
installs it, it has no unit, it holds no data `deploy/backup.sh` must take, it is
not in `RELAY_INPUTS`, and `deploy/deploy.sh` never touches it. `deploy/README.md`
is the operator's document and this is not in it for that reason.

`.claude/rules/native-shell.md` is the document for *changing* this. This one is for
building and shipping it.

## What runs where

**This app is two things, and conflating them is the main source of confusion
here.** It is a **client** — it talks to a control plane, a relay and daemons —
and it is a **daemon host**, carrying a Node runtime and a copy of `src/` so it
can run a daemon on the computer it is installed on.

**Which of the two a build is, is now a decision written down per platform**, in
`tauri.<platform>.conf.json` — see `.claude/rules/native-packaging.md`, which owns
this subject. macOS is the only full profile; every other platform ships a client.

| | Client | Daemon host |
|---|---|---|
| macOS | built, measured, shipping | built, measured, shipping |
| Linux | profile declared; no CI leg and no asset yet | **not in the bundle**, by decision — see below |
| Windows | profile declared; no CI leg and no asset yet | **refused**, and the refusal is in `build-daemon.mjs` by name |
| Android | profile declared; `gen/android` committed; **two CI legs** (`native-android` clippy, `android-apk` assemble+dex census); no asset yet | impossible |
| iOS | profile declared; **refused at compile time** by `credential.rs`; `gen/apple` not generated | impossible |

Windows is refused as a *host* rather than merely unwritten: there is no way to
stop a bundled daemon cleanly there — `TerminateProcess` gives `scripts/daemon.ts`
no chance at its 20-second close, so every turn in flight is interrupted and every
pending approval dropped — and `deploy/install.sh` is a shell script with no
supervisor to install into. `deploy/bootstrap.sh`'s `detect_platform` draws the
same line for the shell installer and is the authority `AGENT_HOST_OS` is held
against.

**Linux is a different answer to a different question.** Nothing there is refused:
a daemon runs on Linux, and most of the fleet is Linux. What is not in the
*bundle* is a second copy of one. `deploy/install.sh` already installs a daemon
under systemd on that box, and `host_local_daemon` reaches it over loopback
whether or not this app brought its own — so a payload there would be 200 MB
duplicating a thing the machine already has, on the one platform where the
ordinary way to get a daemon is the shell installer. ⚠ It also sidesteps the
bundle-layout measurement below, which is *why* it is worth saying that it does
rather than letting that read as a coincidence.

## What it adds, and what it deliberately does not

Five things a webview cannot do for itself:

| | |
|---|---|
| the `/v1/*` leg | the control plane mounts **no CORS at all**, so that one request goes through the host process. Everything else — the relay, the daemons, the WebSocket — is the same webview `fetch`/`XMLHttpRequest`/`WebSocket` the browser client uses |
| the credential | in the operating system's credential store, keyed on the server's origin, never in `localStorage` |
| a link | opened in the real browser, through `ui/links.ts`'s own three-scheme allowlist |
| a download | written through the platform's save panel |
| a daemon on this computer | read out of the current server's `daemon.json` (`~/.reemoat/`, or `~/.reemoat/servers/<server>/` for a daemon the app runs for a second server) and then `~/.reemoat`'s, which a webview cannot open. The host answers a finished loopback origin and refuses any other |

The fifth is what makes the app more than a window: a daemon on the same machine is
reached over loopback rather than out to the relay and back. ⚠ **It changes what a
revocation costs, and only here.** The relay reads live user, machine and grant rows
before each request; loopback does not, so on this path a revoked grant keeps
working for the token's remaining life — 300 s plus 60 s of leeway either way.
Everywhere else it stops at once. Settings → Machines → *This device* says so beside
the switch, and switches it off per machine. What makes that trade defensible is
*who* can take it: only a process running as the uid that owns `~/.reemoat`, which
already holds the daemon's database, its signing keys and every transcript.
`docs/DECISIONS.md` Q7.137.

Not built, on purpose: no device identity, no updater, no menu bar, no tray, no
notifications.

## Developing

```bash
pnpm --dir packages/native install    # once. The ROOT install does not do this
pnpm native                           # Vite on 5173 with the window over it
pnpm native:build                     # a .app — not a .dmg, see below
pnpm nativecheck                      # offline, no cargo, part of `pnpm check`
cd packages/native/src-tauri && cargo test && cargo clippy -- -D warnings
```

### Pointing a build at a server by default

```bash
REEMOAT_DEFAULT_SERVER=https://app.example pnpm native:build
```

**Unset in this repository, deliberately** — a fork inherits no address, which is
`signingIdentity: null`'s rule applied to the question *which fleet does this
binary join*. `nativecheck` asserts no file here sets it.

It is baked in by `option_env!` and is therefore **not a secret**: it ends up in
the binary as a string. `build.rs` carries `cargo:rerun-if-env-changed` for the
name, without which cargo has no reason to recompile when the value moves.

⚠ **It is a suggestion for the welcome screen's field and is written down by
nothing.** The first screen is a welcome either way; with a default compiled in,
its address box opens already holding it, and **Continue** is what adopts it.
Setting this variable therefore changes what somebody confirms, never what they
skip — a build cannot decide which fleet an installation joins. A malformed value
is no default: the box opens empty and the screen asks. A fork's typo fails its
own `cargo test` rather than shipping.

⚠ **The separate install is not a mistake.** `packages/native` sits under
`packages/` and is **excluded from the pnpm workspace** — the three things that
depend on that one line are in `pnpm-workspace.yaml` beside it, and the shortest of
them is that the Tauri CLI would otherwise install on every daemon host in the
fleet. It carries its own `pnpm-workspace.yaml` so that `pnpm install` run inside it
does not walk up and silently install the repository's three projects instead.

⚠ `pnpm native:build` rewrites `packages/web/dist`, which is the tree a locally
running `pnpm cp` serves from disk per request. Reload any open browser tab
afterwards — the same hazard `pnpm web:build` has (Q5.15).

### The daemon inside it, and the loop for changing it

The app carries a daemon — a Node runtime in `Contents/MacOS/node` and a snapshot of
`src/`, `scripts/` and `deploy/` in `Contents/Resources/daemon/`, staged by
`pnpm native:stage`.

⚠ **That snapshot is not your working tree, and it is not your working tree in
`tauri dev` either.** `bundle.resources` is copied by `build.rs` into
`target/<profile>/`, and `resource_dir()` answers that copy in a development build
exactly as it answers `Contents/Resources` in a bundle. So editing `src/session.ts`
and reloading the window shows the *old* code, with nothing anywhere saying why —
measured, and the reason this paragraph exists.

For daemon work there are two loops and they are not interchangeable:

```bash
# Changing the daemon: point the app at a checkout. Development builds only.
REEMOAT_DAEMON_PAYLOAD=/path/to/reemoat/app pnpm native

# Changing what ships: re-stage, then rebuild.
pnpm native:stage && pnpm native:build
```

The override swaps the **code** and never the runtime: the daemon still runs under
the bundled `node`, so a checkout is exercised against the binary that will ship. It
is `cfg!(debug_assertions)`-gated, for `lib.rs`'s navigation-guard reason — a
variable naming a directory this process executes as you is fine on a developer's
machine and is not fine in an application people install.

⚠ **The override runs whatever that checkout says, including about where its state
lives.** The app starts every daemon with `REEMOAT_HOME` naming the root it chose for
the server — `~/.reemoat` for the one `~/.reemoat/daemon.env` names,
`~/.reemoat/servers/<server>/` for every other (Q7.148). A checkout older than that
change ignores the variable, so pointed at a second server with the launchd daemon
stopped it would enroll `~/.reemoat/reemoat.db` — the first server's identity — with
the second server's code. Keep the override on a checkout that reads `REEMOAT_HOME`.

**And the third loop is the one that needs no app at all.** A daemon started the
ordinary way — `pnpm daemon`, or the launchd unit — runs your working tree and
announces itself, and the app *adopts* it (`host_daemon_state` answers `foreign` and
starts nothing). One enrolled with a control plane other than the server the app is
on is flagged `stranger` beside that status and passed over without a word — the
announcement names the control plane, because `~/.reemoat` is every such daemon's
root. That is the fastest loop for daemon work and it is what already
happens on a machine with a daemon installed. It holds for a daemon whose env file
is somewhere else, too: the store finds it through `~/.reemoat/daemon.json` and a
machine id it already has, and buys nothing.

### Prerequisites

| Platform | Needs |
|---|---|
| macOS (desktop) | Xcode **Command Line Tools** and a Rust toolchain. That is all: the linker, the SDK and `codesign` all ship in CLT, and `xcodebuild` is only needed for iOS |
| Windows | Rust, the MSVC build tools, and WebView2 (present on Windows 11). A **client** build; the daemon host is refused — see *What runs where* |
| Linux | Rust plus `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libsoup-3.0-dev`, `patchelf`, and — ⚠ missing from this table until 2026-09-16 — `libssl-dev` and `pkg-config`, because `reqwest` takes `default-tls`, which is Security.framework on macOS and **OpenSSL** here |
| iOS | full **Xcode** *and* `rustup` |
| Android | Android SDK + NDK (`ANDROID_HOME`, `NDK_HOME`) *and* `rustup` |

### Installing the Android toolchain beside an existing Rust

⚠ **Two traps, both hit on this machine on 2026-09-19, and neither announces
itself as what it is.**

**`rustup` shadows `cargo` subcommands even with `--no-modify-path`.** That flag
keeps `PATH` and the shell profile untouched, which is what it promises and does.
But cargo resolves `cargo <sub>` by looking in **`$CARGO_HOME/bin` before
`PATH`** — so a rustup installed into the default `~/.cargo` puts its shims there
and `cargo fmt` and `cargo clippy` start answering *"not installed for the
toolchain `stable-aarch64-apple-darwin`"* on a machine whose Rust is Homebrew's.
The build is unaffected; the two commands this document tells you to run are not.

The fix is to give rustup its own home rather than to delete its shims:

```bash
export RUSTUP_HOME="$HOME/.rustup-android" CARGO_HOME="$RUSTUP_HOME/cargo"
sh rustup-init.sh --no-modify-path -y --profile minimal
"$CARGO_HOME/bin/rustup" target add aarch64-linux-android armv7-linux-androideabi \
                                    i686-linux-android x86_64-linux-android
```

⚠ **And `rustup self uninstall` removes the whole `CARGO_HOME`**, registry cache
included — so undoing a default-location install costs every dependency a
re-download, which reads as a network problem rather than as something you did.

**The two variables travel together.** `CARGO_HOME` alone finds the shim and then
sends it looking for toolchains in `~/.rustup`, which has none: the message is
*"could not choose a version of cargo to run, no default is configured"*, and it
reads as a misconfigured default rather than as a missing `RUSTUP_HOME`. Set both,
always.

**What an Android build needs in its environment**, none of it in a shell profile:

| | |
|---|---|
| `JAVA_HOME` | a real JDK 17. ⚠ `command -v javac` finds `/usr/bin/javac` on a Mac with no JDK at all — it is a stub that fails with the same "unable to locate a Java Runtime". Test with `java -version`, never with `command -v` |
| `ANDROID_HOME` | the SDK root, with `platform-tools`, a `platforms;android-<compileSdk>` matching `gen/android/app/build.gradle.kts`, `build-tools`, and an `ndk;…` |
| `NDK_HOME` | `$ANDROID_HOME/ndk/<version>` |
| `CARGO_HOME`, `RUSTUP_HOME` | both, per above |
| `PATH` | `$CARGO_HOME/bin` and `$JAVA_HOME/bin` in front |

`adb` is under `$ANDROID_HOME/platform-tools` and is **not** put on `PATH` by any
of this; call it by path or add that directory yourself.

**And `tauri android init` has to run once per machine, even though
`gen/android` is committed.** `gen/android/tauri.settings.gradle` holds *that*
machine's cargo registry paths, so it is gitignored — and `settings.gradle`
applies it, during Gradle's *settings evaluation*. A fresh clone therefore fails
there, on a missing script, before any project is configured; nothing under
`app/` is reached and the error names the script rather than the step.

⚠ **`init` is also the command that reverts every hand-edit under
`gen/android`**, so it is two commands rather than one:

```bash
pnpm --dir packages/native exec tauri android init
git checkout -- packages/native/src-tauri/gen/android
```

`init` writes both halves; the checkout puts the committed half back and leaves
the ignored, machine-specific half, which is what was missing. Run it on a tree
with no other changes under `gen/android`, because the checkout does not ask.
`.claude/rules/native-packaging.md` has the census of what the second command
puts back — the JNI handover in `MainActivity.kt`, the signing and rustls blocks,
the R8 keep rule, four manifest attributes and the icons — and `nativecheck`
asserts every one of them, so forgetting the second command is a red driver.

## What is measured on this checkout, and what it costs

Measured 2026-09-14 on the machine this was written on: `rustc`/`cargo` 1.95 from
Homebrew, **no `rustup`**, the `aarch64-apple-darwin` target only, Xcode Command
Line Tools with no `xcodebuild`, and **zero code-signing identities**.

Three consequences, each stated rather than worked around:

1. **A development build works today and is arm64 only.** `--target
   universal-apple-darwin` needs `x86_64-apple-darwin`, which needs `rustup`; a
   Homebrew toolchain ships the host target and no way to add another.
2. **Android is buildable and iOS is not.** `tauri android init` has been run and
   `src-tauri/gen/android` is **committed** — see `.claude/rules/native-packaging.md`
   for why, and for what a future `init` would overwrite. `gen/apple` does not
   exist. The `SecretStore` boundary in `credential.rs` is the one thing mobile
   actually forces: Android's arm is written (`keyring-core` plus
   `android-native-keyring-store`, with the NDK context handed over from
   `MainActivity.kt`), and iOS is refused by a `compile_error!` until its
   `apple-native-keyring-store` arm is written in the same change that deletes
   the refusal. `native-android` compiles Android's arm (`cargo clippy
   --target aarch64-linux-android --lib`); no CI job compiles iOS's.
3. **A build with no identity is unsigned**, runs locally, and is blocked by
   Gatekeeper the moment it is *downloaded*. The gap is a certificate, not code.
   ⚠ Measured on the produced bundle: `codesign -dv` reports
   `flags=0x20002(adhoc,linker-signed)` and **no entitlements and no hardened
   runtime**. Both are applied when a real identity signs, not before — so a
   development build is not evidence that `entitlements.plist` is right, and the
   first signed build is where that gets tested.

**And three things a `.dmg` needs that a `.app` does not.** `bundle.targets` is
`["app"]` alone, because Tauri's `bundle_dmg.sh` drives **Finder over AppleScript**
to lay the disk image window out, and from a non-interactive shell that fails —
measured 2026-09-14: `execution error: Finder got an error: AppleEvent timed out.
(-1712)`, *after* the `.app` had been built correctly. So the default build would
fail on every CI runner and every machine nobody is logged into, having already
produced the artifact that matters. Run `pnpm --dir packages/native exec tauri build
--bundles dmg` from a logged-in session to get one.

## Signing, notarization and updates

None of this is switched on. `tauri.conf.json` carries
`macOS.hardenedRuntime: true` and an `entitlements.plist` naming one entitlement
(`com.apple.security.network.client`); `signingIdentity` and `providerShortName` are
`null`, and `nativecheck` asserts they stay that way — a value committed there would
be somebody's identity in a public repository.

**Three signatures, and conflating them is the classic error.**

| | What | Driven by |
|---|---|---|
| Apple code signature | a **Developer ID Application** certificate, with the hardened runtime | `APPLE_SIGNING_IDENTITY`, or `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` |
| Notarization | Apple's service; Tauri submits and staples during `tauri build` when the variables are present | `APPLE_ID` + `APPLE_PASSWORD` (an app-specific password) + `APPLE_TEAM_ID`, **or** `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` |
| Update signature | a **separate** minisign keypair from `tauri signer generate`, nothing to do with Apple | `TAURI_SIGNING_PRIVATE_KEY` |

All of it is environment, so **no file in this repository changes to sign a
build**. The steps, in order:

1. Enrol in the Apple Developer Program and create a *Developer ID Application*
   certificate. Install it; `security find-identity -v -p codesigning` should list
   it.
2. Export `APPLE_SIGNING_IDENTITY` and the notarization variables from one of the
   two rows above, then `pnpm native:build`. Tauri signs, submits, waits and
   staples.
3. `xcrun stapler validate` on the `.app`, and `spctl -a -vvv -t install` on the
   `.dmg`, to see what a downloader will see.

⚠ **If signed updates are ever wanted, generate the keypair before the first public
build.** A build shipped with no `pubkey` can never be updated in place by a later
one that has it — the updater refuses an unsigned predecessor by design. Turning it
on is then `tauri signer generate`, the *public* half into
`plugins.updater.pubkey`, `bundle.createUpdaterArtifacts: true`, and an `endpoints`
entry.

⚠ **The update endpoint must not be a control-plane origin.** *Where the software
comes from* and *which fleet it joins* are two questions, and conflating them is
what putting a hosted address in the README once did — `docscheck` asserts the
separation for the installer already. A release asset on the repository is the right
source; an instance's own origin is not.

⚠ **Shipping a binary is a distribution, so AGPL §6 applies and not only §13.** The
control plane's `SOURCE_URL` discharges §13 for the hosted client and says nothing
about a `.dmg`. `bundle.licenseFile` puts the licence in the bundle; the
corresponding source has to be offered with it.

## Continuous integration

`nativecheck` runs in the ordinary `check` job — it reads text and JSON, needs no
`cargo`, and finishes in milliseconds.

Everything that needs a Rust toolchain is the `native` job in
`.github/workflows/check.yml`: `cargo fmt --check`, `cargo clippy -- -D warnings`,
`cargo test`, and `tauri build --no-bundle`. That last one earns the job on its own —
`tauri-build` compiles `capabilities/*.json` into an ACL, so a permission that does
not exist fails there and nowhere else, and a `version` path that does not resolve
fails there too.

It is a **sibling** job with no `needs:`, for the reason the `image` job gives: it is
not offline-in-one-process, and gating it behind the others would only delay the one
signal nothing else gives.

⚠ **`native` is macOS and the host target only, and `native-android` is why that
is now said out loud.** `cargo clippy --all-targets` means every *crate* target —
lib, bin, tests, examples — on the runner's own platform; it never crosses to
another. So every `#[cfg(target_os = "android")]` arm in `credential.rs`, its JNI
export and `lib.rs`'s `#[cfg_attr(mobile, …)]` were compiled by nothing, and two
shipping-breaking defects lived in that gap at once: `rustls-platform-verifier`
was never initialised, so every HTTPS call would have panicked, and R8 had
stripped the verifier's Kotlin half out of the signed APK. Both compiled clean.

⚠ **Measured 2026-09-20, and it is the first time either half was ever
compiled.** `cargo clippy --target aarch64-linux-android --lib -- -D warnings`
is clean, which settles the two things that could only be settled by a
compiler: `EnvUnowned` *is* reachable at the `jni` 0.22 crate root, and the
`&mut Env` handed to `init_with_env` reborrows for `JObject::from_raw` as
written. The negative control is the half worth keeping: an error introduced
inside `cfg(target_os = "android")` fails that command and leaves
`cargo clippy --all-targets` on the host **green**, which is the gap in one
line. Reproducing it needs `rustup target add aarch64-linux-android`, an NDK,
and `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER`/`CC_aarch64_linux_android`/
`AR_aarch64_linux_android` pointed at `aarch64-linux-android24-clang` and
`llvm-ar` — `24` because that is `minSdk`. iOS still cannot be compiled here:
it stops in `aws-lc-sys`'s and `objc2-exception-helper`'s build scripts, which
want full Xcode, so `credential.rs`'s `compile_error!` is never reached and
remains asserted rather than measured.

`native-android` closes the Rust half on `ubuntu-latest` — the macOS images carry
no NDK — with `cargo clippy --target aarch64-linux-android --lib`. It stages no
payload, and that is an assertion rather than an omission: a client build is
`tauri.android.conf.json` and nothing else, so `build.rs` has no resources to copy
and the `ResourcePathNotFound` that forces `pnpm native:stage` in the `native` job
cannot happen. **It is a compile gate and not a bundle leg** — publishing an APK
needs `tauri android build`, a Gradle run and an SDK — so it deliberately carries
no matrix entry naming the platform. `android-apk` is the job that does: it runs
Gradle, assembles an unsigned release APK and then **reads the artifact** —
`classes.dex` must contain `org.rustls.platformverifier` and the native library
must still resolve it by name. That is the one assertion no text can stand in
for, because a keep rule that is present and ineffective looks identical to a
regex. It is also why `deploycheck`'s release gate now recognises `android` as
built, while `RELEASE_APP_TARGETS` staying empty keeps publishing a separate,
deliberate act.

⚠ **`android-apk` needs `gen/android` committed.** It is a checked-in project
and `settings.gradle` is the first file Gradle reads, so a checkout without it
fails at configuration. The one file it does regenerate is
`tauri.settings.gradle`, which carries the machine's own `CARGO_HOME` and is
gitignored for that reason.

iOS has no leg at all: nothing on a Linux runner can compile it, and
`credential.rs` refuses it outright.

**Nothing about the native app deploys, publishes or notarizes on a push.** That is
this repository's stance rather than an omission — the control plane's own deploy is
`workflow_dispatch` only, and a release is a tag. If a distributable is ever
automated it rides the existing `v*` tag with the gates in a `deploy/ci-*.sh` script
where `deploycheck` can drive them, because a second entry point would be a second
way to answer *which commit is v0.1.0*.

## Verifying a build by hand

The parts that need a window, a fleet or an agent, and therefore no driver:

1. `pnpm cp`, then `pnpm web` — sign in at `127.0.0.1:5173` first, so a native
   regression is distinguishable from a broken control plane.
2. `pnpm native:build`, run the app. The first screen is the **welcome** — a
   greeting, one sentence about what a server is, and an address box. This build
   compiles no default, so the box is empty; a typo is refused with a sentence and
   leaves you here, and there is no Cancel, there being nothing to go back to.
   Build once more with `REEMOAT_DEFAULT_SERVER` set: the same screen, with the
   box already holding that address. **Continue**, and the sign-in form is next —
   which names no server, that question having just been answered.
3. Sign in. Then, in the webview inspector: `localStorage.length === 0`. **That is
   the one property no offline assertion can reach.**
4. The empty-fleet screen's install command names **the server you chose**, not
   `tauri://localhost`.
5. Enrol a daemon, `pnpm daemon`. The row goes online — which is the one assumption
   nothing offline checks: that the daemon leg really does work from a `tauri://`
   origin against `access-control-allow-origin: *`.
6. Refresh the browser tab from step 1: still signed in, machine still online. Two
   clients, two credentials, neither disturbing the other.
7. Run a turn. Text arrives incrementally and the transcript has no duplicated and
   no dropped rows.
8. Approve something — with `kimi`, or `claude` under an isolated
   `CLAUDE_CONFIG_DIR`, since a blanket allow in `~/.claude/settings.json` bypasses
   the permission machinery entirely.
9. The three seams: copy an enrollment code; download a file from a transcript (a
   **save panel**, not a navigation, and the file is not rendered); tap an `https://`
   link in agent output (the **system browser**), and check that a `file:` link is
   still drawn as plain text.
10. Drag a file onto the composer. This is the `dragDropEnabled` check.
11. Wifi off for ~30 s mid-turn, then on: it reattaches, the turn continues, and
    **you are not signed out**.
12. Zero CSP violations in the inspector console throughout.
13. Quit and relaunch: still signed in, same server, machine reconnects. Then sign
    out, relaunch, and confirm
    `security find-generic-password -s com.reemoat.app -a 'credential#<origin>'`
    answers *item could not be found*.
14. Point the picker at a second control plane, sign in, quit, relaunch, switch
    back. Each server keeps its own credential.
15. On the sign-in screen, tap **‹ Server**. The welcome screen comes back with
    the current address in the box and a **Cancel** that returns here — this is
    the only route back for somebody who confirmed a reachable but wrong address,
    Settings needing a session they cannot get. Then tap **Create one**. The **system browser** opens
    `<server>/register` — not a window inside the app, and the app's own window is
    unchanged behind it. Same for **Forgot password?**.
16. Signed in: Settings → Account → **Server address** → Change. The screen
    replaces the whole sheet, opens on the current address and offers **Cancel**,
    which returns to the settings sheet still open at the same section. Submit the
    address unchanged: nothing reloads and nothing is signed out. Then change it
    for real and confirm the app reloads onto the second server (signed out there
    the first time), and that
    `security find-generic-password -s com.reemoat.app -a 'credential#<the first origin>'`
    still finds the first server's entry — a switch keeps it (Q7.148). Switch back:
    the first server opens signed in. Sign out there: only its entry is gone.
17. The app carries no sign-up form at all:
    `grep -c "Create an account" packages/web/dist/assets/*.js` answers `0`.

**One computer, two servers** (Q7.148), with the launchd dev daemon running on
`~/.reemoat` — both from `REEMOAT_DAEMON_PAYLOAD=$PWD pnpm native` and from a
`pnpm native:build` bundle opened from Finder, which has no `NODE_EXTRA_CA_CERTS`:

18. Sign in to the second server. The setup finishes, where it used to answer
    *This computer could not be set up*.
19. `ls -la ~/.reemoat/servers/<server>` shows `0700` at every level —
    `~/.reemoat`, `servers/` and the folder — and `daemon.env`, `daemon.json` and
    `reemoat.db` at `0600`.
    `sqlite3 -readonly ~/.reemoat/servers/<server>/reemoat.db 'select machine_id,
    control_plane from identity'` names the second server.
20. The first server was not touched:
    `sqlite3 -readonly ~/.reemoat/reemoat.db 'select machine_id, control_plane from
    identity'` still names it, and `~/.reemoat/daemon.json` has the same mtime and
    `instanceId` as before step 18.
21. `lsof -nP -iTCP -sTCP:LISTEN | grep node`: the app's child on an ephemeral port,
    launchd's daemon still on 7887. A child the app starts on `~/.reemoat` itself
    keeps 7887 too.
22. *this device* appears on the second server's machine, and Settings → Logs shows
    that child's ring.
23. Start a long turn on the second server, then switch the server back to the
    first. The launchd machine is adopted with no notice, and
    `ps -o pid,ppid,command -ax | grep scripts/daemon.ts` shows the second server's
    child with the same pid. Switch back: the turn was not interrupted, and neither
    switch asked for a sign-in — each server kept its own.
24. Quit with ⌘Q, and separately with ⌘W: every child the app started is gone
    within seconds, and launchd's daemon is still running.
25. `kill -9` the app while both children run, relaunch, and check `ps`: the
    orphans are adopted silently as `foreign`, and no third daemon starts.
26. Stop the launchd daemon, move `~/.reemoat/daemon.env` elsewhere, and run
    `REEMOAT_ENV_FILE=<the moved file> deploy/run-daemon.sh` — or `set -a;
    . <the moved file>; set +a; pnpm daemon`, since `pnpm daemon` reads no env file
    of its own — so it runs on `~/.reemoat`'s database with no env file there. The
    app adopts it for its server and creates no machine.
27. Sign in to the first server as a second account with no grant on the launchd
    machine. The setup notice says *A Reemoat daemon for this server is already
    running on this computer, as a machine this account cannot see* — checked in
    WebKit, not Chromium.
28. With the launchd daemon up, run `pnpm daemon` from a checkout with no
    `REEMOAT_HOME`, its own `REEMOAT_DB` and `REEMOAT_PORT`, enrolled with a local
    `pnpm cp`, and open the app on the launchd daemon's server. No setup notice
    appears, `~/.reemoat/daemon.json` names the local control plane as
    `controlPlane`, and Settings → Logs says the daemon it found here is for a
    different server.

## Open measurements

Recorded here rather than discovered, in the column this repository keeps them in:

- **The Linux bundle layout, and whether it reaches the staged runtime.** ⚠ **Off
  the shipping path now and still open**, which is two statements rather than one.
  Linux ships a *client* build (*What runs where*), so no released `.deb` or
  AppImage carries a payload for this to get wrong — but a full-profile Linux
  build is still a thing somebody can ask for, and this is what it would cost.
  Read off `tauri-utils`: a `.deb` or AppImage puts resources at
  `/usr/lib/<productName>/` while the executable is at `/usr/bin/<productName>`.
  `Payload::locate` takes `node` from `exe.parent()?.join("node")`, which there is
  `/usr/bin/node` — the distribution's, a different version with a different
  module set, and the daemon would run under it with nothing saying so. That half
  is unfixed, deliberately: fixing it blind on a macOS checkout is how a guess
  becomes a measurement.
  ⚠ **The second half was half wrong and is now fixed.** This entry used to say
  that neither of `placeRuntime`'s two probes resolves from
  `/usr/lib/Reemoat/daemon/node_modules/.bin`. Counting from `.bin`,
  `../../../node` is `/usr/lib/Reemoat/node` — the resource directory's own
  sibling — so it plausibly *does*, and the open question narrows to which
  directory the bundler puts an `externalBin` in. What was unambiguously wrong was
  the fallback under it: `exec node "$@"`, with `daemon_path` putting that same
  `.bin` first on PATH, is a shim that re-execs itself for ever. It says what
  happened and exits 127 now; `nativecheck` asserts both halves.
  The instrument for what is left: `tauri build --bundles deb` on a Linux box with
  the payload staged, install it, `ls -l /usr/bin/node`, then
  `node_modules/.bin/node --version` from inside the installed payload.
- **What Windows staging costs, when it is wanted.** Five items, not the three the
  refusal used to name: a `zip` rather than a tarball (`tar -xf` reads both, so
  not a new dependency); `node.exe` at the archive root rather than under `bin/`;
  `npm-cli.js` at the root rather than under `lib/node_modules`; an `.exe` suffix
  on the staged external binary; and `.cmd` shims — npm writes real files rather
  than symlinks there, so `regenerateShims`' symlink loop finds nothing to
  rewrite, and `deploy/agents.sh`'s `$(dirname -- "$(command -v npm)")/node` is a
  shell idiom with no Windows meaning. None of it is worth doing before a daemon
  can be stopped cleanly there.
- **A graceful stop with no `SIGTERM`.** Four options were weighed and the shape
  that wins is an **in-band request over a channel the parent already owns**:
  `daemon.rs` spawns with `.stdin(Stdio::null())`, so make it a pipe, have the
  supervisor write a line, and have `scripts/daemon.ts` treat it as the shutdown
  it already knows how to do. No signal, no port, no auth, no new route, and the
  channel is private to the parent by construction. It must act on the **line**
  rather than on EOF, because `pnpm daemon < /dev/null` is also EOF. Rejected:
  `GenerateConsoleCtrlEvent` (the shipped app sets `windows_subsystem = "windows"`
  and therefore has no console, and it delivers `SIGBREAK` rather than `SIGTERM`);
  a job object (`TerminateProcess` for every member — it solves orphaning, not
  gracefulness); and an HTTP route (every daemon route needs a token whose `aud`
  is the machine, and at `RunEvent::Exit` there is no page left to mint one).
- **A Linux CI leg**, which is cheap and is deliberately not here yet. `cargo fmt`,
  `clippy`, `cargo test` and `tauri build --no-bundle` on `ubuntu-latest` would be
  the first time five things are compiled at all: `keyring`'s secret-service
  backend and its zbus tree, `reqwest`'s native-tls against OpenSSL, wry against
  WebKitGTK, the capability ACL on a second platform, and `build-daemon.mjs`'s
  Linux staging path end to end. It would **not** catch the bundle layout above.
  It is held with the rest of the build work rather than because it is hard.
- **An `http://` control plane with a `ws://` relay.** `tauri://localhost` is a
  secure context, so mixed-content rules may refuse the relay legs — which are
  direct webview calls, not proxied. The failure would be a signed-in app whose
  machines are all unreachable, with the reason only in a console. One LAN fleet
  settles it.
- **A 100 MiB save through raw IPC.** The download bound is 100 MiB and
  `host_save_file` takes bytes; nobody has timed the round trip.
- **An intermediary in front of a real relay meeting `Origin: tauri://localhost`.**
  The relay itself answers `*` and never `Access-Control-Allow-Credentials`; a CDN
  in front of it may not.
- **Loopback from a packaged webview, per platform.** macOS is settled by the
  `lsof` step in the checklist: App Transport Security exempts loopback, the
  entitlement is already `com.apple.security.network.client`, and the App Sandbox is
  off. The other two are not. Windows runs WebView2, which is Chromium and applies
  **Private Network Access** preflights, and Linux runs WebKitGTK. A platform that
  refuses costs nothing visible — `proveLocal` fails and the relay answers, which is
  the same path every other client takes — so the failure to watch for is the silent
  one: the feature never engaging on a machine where it should. `lsof` on the app is
  the instrument; a WebSocket to `127.0.0.1:<port>` rather than to the relay's origin
  is the answer.
- **The keychain, end to end.** The key *shape* is unit-tested and the crate's Apple
  backend is the one that compiles, but writing a real entry needs an unlocked login
  keychain: from a non-interactive shell `security add-generic-password` answers
  `User interaction is not allowed`. A GUI app session has it unlocked, which is
  where step 13 above actually happens.

## What has been verified, and how

Recorded because *which* of these was measured and which was reasoned about is the
part that goes stale first.

| | |
|---|---|
| the frontend is inside the binary | `tauri build` produced `Reemoat.app` with `CFBundleShortVersionString 0.9.0` — **read through the `version` path** out of the root manifest, which is the field working rather than being asserted |
| the source maps do not ship | `dropped 29 source maps, 6.5 MB, before embedding` |
| the transport really is the host process | with a server configured, `lsof` on the running app shows **one** ESTABLISHED socket to it, held by `reemoat-native` itself and **not** by `com.apple.WebKit.Networking`. That is `cpSend` → `host_cp` → `reqwest` → the control plane, end to end |
| the app dials nothing it was not told to | with no server chosen it runs, draws the picker, opens **zero** sockets and writes **no** file |
| the webview loaded a document | a `com.apple.WebKit.WebContent` process appears beside the app's own within a second of launch |
| the Rust rules | `cargo test`: the origin-escape table, the normalization that makes one server one key, the keyring scope, and what this window may navigate to |
| everything else in the checklist above | **needs a person at a logged-in session.** `screencapture` from a non-interactive shell returns the desktop with no windows, and Automation is refused the same way the disk image's Finder step is — so nothing here has *seen* the server picker, only the process that drew it |
