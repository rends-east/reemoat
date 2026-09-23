---
paths:
  - packages/native/src-tauri/tauri.*.conf.json
  - packages/native/scripts/*
  - deploy/ci-release.sh
  # `gen/android` looks generated and is not: `tauri android init` writes it once
  # and then it is edited and committed, the way a checked-in Xcode project is.
  # Three of the sections below are *about* files in there and could not be
  # reached from them until `docscheck`'s walk stopped skipping `gen` by name —
  # the NDK-context call in `MainActivity.kt`, the `rustls-platform-verifier`
  # dependency and its R8 keep rule, and the launcher icons `init` overwrites. A
  # glob here is live because that walk enters `gen/android` and still refuses
  # `gen/schemas` and `gen/apple`; `SKIP_PATH` in that driver is the other half of
  # these five lines, and deleting it makes every one of them dead.
  - packages/native/src-tauri/gen/android/app/src/main/java/com/reemoat/app/MainActivity.kt
  - packages/native/src-tauri/gen/android/app/build.gradle.kts
  - packages/native/src-tauri/gen/android/app/proguard-rules.pro
  - packages/native/src-tauri/gen/android/app/src/main/res/xml/*
  - packages/native/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/*
  # The second icon tree. The icons section says both are written and why they
  # must agree, so opening either one has to summon it — this was in no rule's
  # globs at all, which is how three builds shipped somebody else's logo.
  - packages/native/src-tauri/icons/android/*
  # And the macOS/Windows tree beside it, plus the artwork both are derived from.
  # The inset section below is about the relationship between the three, and it
  # could be reached from none of them: `icons/*` was in no rule's globs, which is
  # the same gap that let the Android tree ship somebody else's logo.
  - packages/native/src-tauri/icons/*
  - packages/web/public/favicon.svg
  - packages/native/src-tauri/tauri.conf.json
  # The runtime helper's Info.plist and the two entitlements files that sign the
  # helper and the app around it. The section on the helper is about all three.
  - packages/native/src-tauri/runtime/*
  - packages/native/src-tauri/entitlements*.plist
---

# Packaging the native app

`native-shell.md` is the document for changing what the app *is*. This one is for
what comes out of a build: which platforms get a daemon inside them, which get a
client, how that is expressed, and what a release publishes.

It is a separate file rather than a section there for a reason that is itself a
rule: `docscheck` holds every rule to `MAX_RULE_CHARS`, and `native-shell.md` sits
within a few hundred bytes of it. A ceiling reached is a signal to split a
subject, never to compress somebody else's paragraph.

## Two profiles, and the difference is one JSON file

**`full` carries a Node runtime and a copy of `src/`, so the app can run a daemon
on the computer it is installed on. `client` carries neither.** macOS is the only
full profile; Windows, Linux, Android and iOS are clients.

| | Client | Daemon host |
|---|---|---|
| macOS | shipping | shipping |
| Linux | profile declared; no CI leg and no asset yet | **not in the bundle** — `deploy/install.sh` is how a Linux box gets a daemon, and it is how the whole fleet already gets one |
| Windows | profile declared; no CI leg and no asset yet | refused, and the refusal predates packaging: there is no way to stop a bundled daemon cleanly there |
| Android | profile declared, `gen/android` committed; no CI leg and no asset yet | impossible |
| iOS | **refused at compile time** — `credential.rs` has no store arm, and `gen/apple` is not generated | impossible |

**A client build is expressed as `tauri.<platform>.conf.json` and nothing else.**
Tauri merges those over the base — `linux`, `windows`, `macos`, `android`, `ios` —
through `json_patch::merge`, which is **RFC 7386**: an array replaces, and a
`null` deletes the key. So a client profile is `externalBin: null` and
`resources: null`, and the payload is gone. The runtime was never there on those
platforms: it is `bundle.macOS.files`, which only the macOS bundler reads, and the
base names no `externalBin` at all since the runtime became a helper (below).
`externalBin: null` stays in each overlay anyway — `ci-release.sh`'s `app_profile`
reads it as the client marker, and it is the guard if the base ever names one again.

⚠ **Measured, 2026-09-19, because the alternative was a cargo feature.** With
`target/daemon` and `binaries/` both moved aside, `cargo check` fails inside
`build.rs` with no overlay present and **succeeds** with a `tauri.macos.conf.json`
carrying those two deletions. `tauri-build` therefore reads the overlays at
**compile time**, not only at bundle time — which is what makes a client build a
configuration file with no Rust in it. A feature gate would have been the answer
if it did not.

**On the desktop a client build needs no code change at all**, and that is a
property rather than luck: `Payload::locate` answers `None` when nothing is
staged, `host_daemon_state` answers `"unsupported"`, and `store.ts` answers it
with the same early return it gives a missing bridge (`packages/web/src/store.ts`,
`state === null || state.status === "unsupported"`). The degraded path was written for a developer who forgot
`pnpm native:stage` and it is the same path.

⚠ **And `host_local_daemon` is not part of it.** It reads `~/.reemoat/daemon.json`
— what `src/announce.ts` wrote — and has never depended on the payload. So a
client build on Linux still reaches a daemon installed by `install.sh`, over
loopback, exactly as before. What a client build gives up is *starting* one, not
*finding* one.

## What an overlay may say

**Only `bundle.targets`, `bundle.externalBin`, `bundle.resources` and `$schema`.**
`nativecheck` asserts it as an exact allowlist over the flattened key set, and the
reason is the whole shape of that driver: it reads **one** configuration file and
Tauri reads five. Without this rule, the first overlay silently turns every
assertion there — the CSP, the empty permission set, `signingIdentity: null`,
`dragDropEnabled: false`, `createUpdaterArtifacts`, the licence path — into a
claim about the base file alone. Re-running all of them against five merged
configs is the other answer; this one is stronger, because there is nothing an
overlay *can* say that any of those is about.

**There is no `tauri.macos.conf.json`, and `nativecheck` asserts its absence.**
The base file *is* the macOS shape. A macOS overlay would leave every assertion
above describing a configuration no build ever uses, while staying green.

**The two desktop overlays name a bundler and the two mobile ones do not.**
`tauri android build` and `tauri ios build` take the artifact kind on the command
line and read `bundle.targets` for nothing, so a value there would be a setting
with no reader.

## The staging script

**`build-daemon.mjs` refuses a Windows triple by name, and that refusal is a
decision rather than an unfinished job.** Nothing in a Windows bundle would read a
payload staged for it. The three differences a Windows payload would have to
answer — a `zip`, `node.exe` at the archive root, an `.exe` suffix — are still
written into the refusal, so they survive the day somebody changes the decision.
`nativecheck` asserts the refusal names a file that exists, because a refusal
pointing at nothing reads as authoritative and is not.

**Every desktop triple stays in `TARGETS` even where nothing ships from it.**
`nativecheck` counts the table and asserts every row names an esbuild binary — an
assertion that goes vacuous the moment the table describes one platform, which is
how a cross-platform project quietly becomes a single-platform one.

⚠ **The shim in `node_modules/.bin/node` ends in a refusal, never a PATH lookup.**
It used to end `exec node "$@"`, with a comment calling PATH *"the honest last
word"*. It is not one: `daemon.rs`'s `daemon_path` puts that very directory
**first** on the daemon's `PATH` — deliberately, so `deploy/agents.sh` resolves
the node beside npm — so the fallback found the shim and re-execed it, for ever,
on any layout where both relative probes miss. A payload that cannot find its
runtime is a staging bug; it says so and exits 127. `nativecheck` asserts the
absence of the old line as well as the presence of the new one, and compares
against the file's **code** rather than its text, because the docblock explaining
this quotes the line it replaced.

## The runtime is a helper app, and the Dock is why

**On macOS the runtime is `Contents/Helpers/Reemoat Runtime.app`, a bundle of its
own whose `Info.plist` carries `LSUIElement`** — `src-tauri/runtime/Info.plist`,
identifier `com.reemoat.app.runtime`. It used to be `Contents/MacOS/node`, an
`externalBin`. libuv registers a process with LaunchServices when `process.title`
is set, npm sets one for every MCP server an agent starts through `npx`, and a
binary in `Contents/MacOS` belongs to Reemoat.app — so each became a Foreground
application of `com.reemoat.app` and drew a blank "exec" tile in the Dock.
Measured with `lsappinfo` on 0.10.1: `Foreground` from `Contents/MacOS`,
`UIElement` from the helper, same bytes; `docs/NATIVE.md` has the table and the
one-line check.

**One copy, one relative path.** `pnpm native:stage` puts the helper at
`src-tauri/target/Helpers`, because `target/` stands where `Contents/` stands: the
payload is `daemon` directly under `Contents/Resources` and under
`target/<profile>`, so the shim's `../../../../Helpers/…` from `.bin` and
`daemon.rs`'s `<exe>/../../Helpers/…` land on the helper in a bundle and in
`tauri dev` alike. `bundle.macOS.files` copies it into the bundle and
`externalBin` is gone, so nothing lands in `Contents/MacOS` but the app.

⚠ **`build.rs` makes the check the file name used to make.** `binaries/node-<triple>`
failed a build staged for the other architecture on a missing file; a fixed path
copies whatever is there, so `build.rs` reads the staged binary's Mach-O CPU type
and refuses a mismatch, or a missing helper, on any macOS target. It also copies
the helper beside a profile directory that is not `src-tauri/target` (`--target`,
`CARGO_TARGET_DIR`), which is what `tauri-build` did for an `externalBin`.

⚠ **Signed by staging, inside out, because the bundler will not.** tauri-bundler
2.11 signs the app, its frameworks and its `externalBin` entries — all with the
*app's* entitlements — and copies `bundle.macOS.files` unsigned before sealing.
An unsigned helper then fails `codesign --verify --deep --strict` on the whole
app (*"In subcomponent: …/Helpers/Reemoat Runtime.app"*), measured. So
`build-daemon.mjs` signs it with `entitlements-node.plist` under the hardened
runtime — `APPLE_SIGNING_IDENTITY` with a timestamp, else ad-hoc — and refuses
`APPLE_CERTIFICATE` alone, which the bundler imports only during `tauri build`.
That is the nested pass `entitlements-node.plist` was written for, and it now runs
on every build.

⚠ **Which found a file that could not have signed anything.** Its comment quoted
the measuring `codesign` command, flags and all; XML forbids a double hyphen in a
comment, codesign refused the file (*"AMFIUnserializeXML: syntax error"*) and
`plutil -lint` passed it. `nativecheck` sweeps every plist here for the rule.

**Rejected:** `LSUIElement` on the app (Reemoat's own Dock icon and menu bar go
too); the runtime in `Contents/Resources` (not nested code, not reliably signed);
the payload's `.bin` off the front of the daemon's `PATH` (`deploy/agents.sh` finds
the node beside npm); and changing somebody else's MCP server. `nativecheck` pins
the layout, the four copies of the helper's name, the four plist keys that decide
how LaunchServices files the process, the signing step and `build.rs`'s CPU table.

## The two mobile platforms are in different states

⚠ **`keyring`'s `v1` feature has no credential store on either iOS or Android: it
refuses at *run time* having compiled perfectly** (`keyring-4.2.0/src/v1.rs:109-128`).
Everything else a mobile build is missing — the generated project, the NDK, a
signing key — fails loudly at build or install time. This one passes every gate
and arrives at a person, who then retypes their password on every launch while the
app tells them their store is not durable.

**Android has a store.** `credential.rs` reaches past the `v1` façade to
`keyring-core` and names `android-native-keyring-store` — SharedPreferences with
the key held in the Android Keystore, reaching the application context through
`ndk-context`, which **nothing in this dependency tree initialises** — not Tauri,
not tao, not wry. `credential.rs` exports
`Java_com_reemoat_app_MainActivity_initNdkContext` and `gen/android`'s
`MainActivity.kt` calls it in `onCreate`, before Tauri's `setup`; without it the
first Android build panicked on launch. `Store::new()` is a JNI round trip and
the alternative is paying one on every credential read and **twice per Noise
handshake**, so it is still behind a `OnceLock` — but the cell holds the
*success* only, with a `Mutex` behind it for the retry. ⚠ **It held the whole
`Result` once, and that made one bad moment permanent**: an `Err` cached before
the context was adopted answered every later `read`, `write` and `probe` until
the app was force-stopped, while the cost argument was only ever an argument for
caching a success.

⚠ **Two things exported from that one `.so` may set `ndk-context`'s slot, and it
may be set once.** `initialize_android_context` ends in
`assert!(previous.is_none())`, and measured on this checkout the `.dynsym` of
`target/aarch64-linux-android/release/libreemoat_native_lib.so` carries
`Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext` beside our
own — the store crate's own initialiser, which its documentation tells authors to
declare from Kotlin. Nothing calls it today, the built APK's `classes.dex`
holding no such class. A panic crossing an `extern "system"` boundary aborts, so
the JNI body is a `catch_unwind` and a null `context` is refused before it is
cached: `jni` 0.21's `new_global_ref` answers `Ok` for a null `jobject`, and the
first call on that null is a JVM-side abort no `catch_unwind` can see.

**"Before Tauri's `setup`" is the invariant; "the earliest moment in the
process" is an assumption.** Android instantiates this package's two providers —
the manifest's `FileProvider` and `lifecycle-process`'s `InitializationProvider`
— before any activity, and neither loads the `.so`: the only two
`System.loadLibrary` calls are `MainActivity`'s companion and the generated
`Rust` object's, and that same `.dynsym` carries no `JNI_OnLoad`. `nativecheck`
compares the two indices in `MainActivity.kt`. A `Service`, a receiver or a
provider of this app's own would end it, and the repair is to **move** the call
rather than add a second one.

**iOS is refused at compile time**, and that is a tripwire on the way to its arm
rather than a decision against one. Nothing on this checkout can compile iOS —
that needs full Xcode — so the refusal is the only place the gap can be caught.
Whoever installs the toolchain writes the `apple-native-keyring-store` arm and
deletes the refusal in the same change. `nativecheck` asserts the two as a pair,
so narrowing one without writing the other is caught either way.

`probe()` is unchanged on every platform and is what says whether any of it
actually works: it writes a canary, reads it back, compares and erases.

## Android's TLS is not what the plan said it was

⚠ **There is no vendored OpenSSL, and the absence is asserted.** The plan was
`openssl` with `vendored`, reasoning that `reqwest`'s `default-tls` is native-tls
and native-tls is OpenSSL away from Apple and Windows. Measured instead:
`cargo tree --target aarch64-linux-android` carries **no `openssl-sys` at all**.
`reqwest` 0.13 resolves to `rustls` with `rustls-platform-verifier`, which calls
Android's own `X509TrustManager` over JNI.

That is better than the plan rather than merely different: the `/v1` leg then
honours the same `network_security_config` the webview legs do — **user-installed
CAs included** — instead of being blind to them. A self-hosted control plane
behind a private CA is the ordinary deployment for this software, and that is the
property `reqwest`'s feature list was chosen for in the first place.

⚠ **What it costs instead is a Gradle dependency.** `rustls-platform-verifier`'s
Kotlin half — `org.rustls.platformverifier.CertificateVerifier` — has to be in the
APK, or the verifier finds no class to call and every TLS connection fails at run
time. It belongs in `gen/android`'s `build.gradle.kts`, and it is the kind of
thing that compiles, links and ships before anybody notices.

⚠ **And a call, which is the half nothing in the tree makes for you.** The
crate's own `src/android.rs` opens *"On Android, initialization must be done
before any verification is attempted"*, and its `global()` is
`.expect("Expect rustls-platform-verifier to be initialized")`. `reqwest` builds
the `Verifier` and never initialises it — the crate's documented contract, not a
reqwest bug — so with no call the build compiles, links, installs, launches and
draws, and panics on the **first** `/v1` request. `credential.rs`'s JNI export is
where `init_with_env` goes, beside the `ndk-context` one, because
`MainActivity.onCreate` is where the JVM hands over a context and is still before
Tauri's `setup`; the only `reqwest` caller is `host_cp`, invoked by a webview
that does not exist yet. The two handles are **different things** — the verifier
reads nothing `ndk-context` holds — so *"the context is already initialised"* is
the reasonable and wrong answer to why TLS still fails. `nativecheck` asserts
both calls out of that one function body, and asserts the lock carries exactly
one copy of the crate: two would mean initialising a static the verifier doing
the work never reads.

⚠ **And a second `jni`, renamed rather than merged.** The verifier declares
`jni = "0.22"`, where the type `init_with_env` takes is `Env`; Tauri, tao, wry
and `android-native-keyring-store` are all on 0.21, where the same thing is
`JNIEnv` in a different crate. Both are in the build whatever the manifest pins,
so `jni22 = { package = "jni", … }` sits beside `jni` instead of replacing it —
and `nativecheck` reads the version it should name out of `Cargo.lock`'s own
`rustls-platform-verifier` block rather than restating a number.

## `tauri android init` does not use this project's icons

⚠ **It writes Tauri's own defaults into
`gen/android/app/src/main/res/mipmap-*` and never looks at
`src-tauri/icons/android/`.** Three builds shipped the Tauri logo before anybody
looked at the bytes rather than at the source tree — `#ffc131` and `#24c8db`,
which is a colourful mark this repository does not contain a single pixel of.

The symptom pointed somewhere else twice. With no `mipmap-anydpi-v26/ic_launcher.xml`
— which `init` also declines to copy — Android wraps the 73%-transparent legacy
PNG on a **white** plate, so it read as "our icon on a white circle" rather than
as "somebody else's icon". Restoring the adaptive icon and correcting its
background were both real repairs and neither touched the cause.

**What a correct adaptive foreground is, since `tauri icon` does not produce
one either.** Its `ic_launcher_foreground.png` is the whole badge, opaque edge to
edge — so it hides the background layer entirely and the launcher masks a square.
A foreground is the **mark alone on transparency**, inset to the adaptive safe
zone: the centre 66dp of 108 is all that survives every launcher mask, so the art
sits at 58% of the frame. The background layer carries `#1c1a16`, which is the
badge colour `packages/web/public/favicon.svg` already knocks the mark out of.

Both trees are written: `gen/android` because that is what builds, and
`src-tauri/icons/android` so the next person diffing them does not find them
disagreeing. **A future `tauri android init` overwrites the first**, which is one
more reason `gen/android` is committed rather than generated.

## The macOS inset, and why it is one platform's

⚠ **The badge was 100% of its canvas on every macOS raster in this tree**, opaque
corner to corner, and that is why the tile read about a quarter larger in linear
terms than everything beside it in the Dock. Apple's grid is an **824×824
squircle in a 1024×1024 canvas** — a 9.77% transparent margin per side — and the
difference between those two numbers was the whole of the defect.

⚠ **Verified against Apple's own icons, and the naive reading disagrees.** Pages,
Numbers, Keynote and GarageBand all measure **854** of 1024 at an alpha threshold of
8, which would say this icon is 30px too small. They carry a **soft drop shadow**:
across Pages' middle row alpha runs `75:1 80:4 85:9 90:16 95:29` and then jumps to
`100:201`. Past the ramp all four measure **824**, the same as this icon. So anybody
re-measuring a system icon to check this number must threshold past the shadow —
and this icon deliberately has none, a cosmetic difference left alone because the
defect was size and a shadow would move the bounding box the assertions read.

**The inset is macOS's, not the artwork's**, and the per-platform table is the
section rather than a footnote to it:

| Surface | Geometry | Why |
|---|---|---|
| `icons/icon.icns`, `icon.png`, the sized PNGs, `icon.ico` | **inset** to 824/1024 | macOS masks and expects the margin |
| `icons/android/`, `gen/android/` foreground | the mark alone at 58% | a different mask, a different safe zone — and hand-authored, above |
| `icons/android/`, `gen/android/` legacy rasters | full bleed | correct, and a `tauri icon` run is what breaks them |
| `icons/ios/*`, `packages/web/public/apple-touch-icon.png` | full bleed | iOS masks its own; this inset would double. That PNG is colour type 2 and has no alpha to inset *with* |
| `packages/web/public/favicon.svg` | full bleed | a tab strip does not mask, so a margin there is a smaller mark for nothing. It stays the **source** |
| `Square*Logo.png`, `StoreLogo.png` | unchanged, and **unmeasured** | a Windows tile sits on a coloured plate and wants a third geometry. No CI leg, no asset, no measurement — a stated gap rather than a guess |

**`tauri icon` is retired rather than re-run, and `packages/native/scripts/icons.mjs`
is what replaced it.** The reason is the section above: that command overwrites
`ic_launcher_foreground.png` with the whole badge and rewrites both launcher XMLs
back to `@mipmap/…` and `#fff`, so every run has to be followed by a hand-restore
of three files — which is the same shape as the `git checkout -- gen/android` that
already gets forgotten. The generator writes **only** the macOS and Windows files
and nothing under either Android tree, which `nativecheck` asserts from the other
side by reading the script.

It also replaced a script that could not run: `package.json` said `tauri icon
icon.png` and `packages/native/icon.png` **has never existed**. Nothing noticed,
because nothing looked at icons at all.

**Two numbers in that file are Apple's and the rest is read off `favicon.svg`.**
`MARGIN` is `100 / 1024` and `RADIUS` is `185.4 / 824`; the mark's six numbers are
parsed out of the SVG rather than retyped, so the app icon is a stated *transform*
of the favicon rather than a fourth copy of the drawing. `rx` is the one thing
that does not scale — the favicon's corner is 25% of its side and Apple's is 22.5%
of the squircle. The corner is still a **circular arc** rather than a
continuous-curvature squircle: the defect being fixed was size, and changing the
curvature in the same commit would make the before and after unreadable against
each other.

⚠ **Nothing in this repository asserted anything about an icon before this**, in
any of the twelve drivers — which is how both of the above shipped. `nativecheck`
now carries a PNG decoder (all five filter types, so it still bites on a raster
somebody replaces by hand) and pins: every path in `bundle.icon` exists; the
`.icns` member list is the eight PNG types a macOS 13 floor reads, with no legacy
RGB+mask members; `ic10` is 824×824 at (100,100) and is the same bytes as
`icon.png`; every generated raster is inset to the same grid; Android's foreground
is the mark and its legacy rasters are full bleed, across both trees and all five
densities; the mark agrees between `favicon.svg` and `Mark.tsx`; the favicon and
`apple-touch-icon.png` are still full bleed; and **every file a script in
`packages/native/package.json` names exists**, which is the line that would have
caught `tauri icon icon.png` years ago.

⚠ It also **writes the assertion two committed comments already claimed.**
`mipmap-anydpi-v26/ic_launcher.xml` and `values/ic_launcher_background.xml` each
say in their banner that `nativecheck` pins the `@color` form and the colour;
a grep for `ic_launcher` in that driver returned nothing. It is comment-stripped,
because both files quote the strings being looked for.

## The release APK carries v1 beside v2, and the v1 half is not for Android

**`enableV1Signing = true` and `enableV2Signing = true` sit in
`app/build.gradle.kts`'s release signing config, and AGP makes neither decision
by itself.** Left unset, it signs with the JAR scheme only when `minSdk` is below
24 — so 0.10.1, at 24, shipped an APK with no JAR signature at all: no
`MANIFEST.MF`, `.SF` or `.RSA` in `META-INF`, and a signing block holding v2,
AGP's dependency metadata and verity padding. Nothing else about it was
off-spec: `targetSdk` 36, native libraries stored uncompressed and 16 KB-aligned
under `extractNativeLibs="false"`, and no v3 block, which AGP leaves off unless
asked.

⚠ **Android accepts that APK, and one installer did not.** It installed on a
Pixel on Android 16 and over `adb install` on a OnePlus 13; tapped on that same
OnePlus, the phone's own installer — OxygenOS, Android 16 — refused it as
*"package appears to be invalid"*, with no earlier `com.reemoat.app` present to
conflict with. `adb install` hands the file to the package manager directly; a
tapped APK goes through the OEM's installer app, which parses it first. **That
this parse wants a JAR signature is a hypothesis and not a measurement, and a
weak one**: the words are AOSP's `install_failed_invalid_apk`, which the stock
installer shows when the *platform's* install session refuses the package, and
the platform never reads a JAR signature beside a v2 one. The next release
installing would not settle it — the download and the build change with it.
What does is the published APK signed twice with one key, with and without v1,
tapped on that phone: the v2-only copy has to reproduce the refusal. If the v1
copy is refused too, the pair has cost nothing, and `adb logcat` across the
refused install is what names the real reason.

**v3 is left off on purpose.** Android 9 and later verify v3 in place of v2
wherever both are present, so enabling it here would change what every current
phone checks, the Pixel that already worked included, and an install that then
succeeded would not say which half fixed it. v4 is a separate `.idsig` file for
incremental `adb` installs and is not in the APK.

⚠ **`apksigner verify --verbose` prints `v1 … false` for an APK with a valid v1
signature, so the obvious gate refuses every correct release.** apksig consults
the JAR signature only below API 24 or when no v2-or-newer block exists — the
rule Android 7 applies, written out in `ApkVerifier` — and it checks from the
manifest's `minSdk`, which is 24. So `ci-release.sh` asks again at
`--min-sdk-version 23`, where a missing JAR signature is an error rather than
something skipped; 23 rather than lower, because a lower floor also holds the
signature to algorithms older platforms lack. The plain `verify` before it is
unchanged and still answers *signed, as this app's devices check it*.
`deploycheck`'s stub answers `false` for v1 unless it is asked below 24, which
is what makes dropping the flag a red there rather than a pass on a stub that
said what the script wanted. `nativecheck` pins the pair against the Gradle
script's code.

## What a clone cannot build, and the one file that is this machine's

**`gen/android` is committed and a clone still cannot build it.** Exactly one
file is why. `gen/android/tauri.settings.gradle` names the Tauri crates' Android
projects by **absolute path** — four of them, each a
`new File("<CARGO_HOME>/registry/src/…/tauri-2.11.5/mobile/android")` — so it is
one computer's cargo home and one lock file's versions written into a build
script. `gen/android/.gitignore` ignores it, and has to: committed, it points
every other machine's Gradle at a directory only the committer has.

`settings.gradle`'s third line is `apply from: 'tauri.settings.gradle'`, and
Gradle reads `settings.gradle` during **settings evaluation** — before any
project is configured. So a clone's first failure is there, on a missing script,
and nothing under `app/` is ever reached. The three portable files behind it —
`app/tauri.build.gradle.kts`, `app/tauri.properties`, `app/proguard-tauri.pro` —
are ignored too, and committing them would buy nothing, because the build never
gets that far. `tauri.properties` would cost something: it carries a
`versionName` and a `versionCode`, which is a seventh version site nothing
compares, and Tauri's own schema says to un-ignore it only for
`autoIncrementVersionCode`, which this project does not use.

⚠ **So `tauri android init` is a step every new machine takes, and it is the
step that reverts every hand-edit in this tree.** Measured against the templates
embedded in `@tauri-apps/cli`, read out of the binary on 2026-09-19:

| File | What a re-run takes out |
|---|---|
| `app/src/main/java/com/reemoat/app/MainActivity.kt` | the `Context` import, the `System.loadLibrary` companion, the `external fun initNdkContext`, and the call to it **before** `super.onCreate` |
| `app/build.gradle.kts` | `signingConfigs` and the conditional `signingConfig`, the `enableV1Signing`/`enableV2Signing` pair in that signing config, the `repositories { maven … }` block that asks cargo for the `rustls-platform-verifier` `.aar`, and the dependency on it |
| `app/proguard-rules.pro` | the `-keep` rule for `org.rustls.platformverifier.**` |
| `app/src/main/AndroidManifest.xml` | `networkSecurityConfig`, `dataExtractionRules`, `allowBackup="false"`, `fullBackupContent="false"` |
| `app/src/main/res/mipmap-*` | this project's rasters, replaced by Tauri's own — the section above is the whole story |

Two more are `tauri icon`'s rather than `init`'s: `res/mipmap-anydpi-v26/ic_launcher.xml`,
whose background it points back at a mipmap, and `res/values/ic_launcher_background.xml`,
which it writes as `#fff`. And two are in no template at all —
`res/xml/network_security_config.xml` and `res/xml/data_extraction_rules.xml`.
Those two are the quietest shape of the four: an `init` does not touch them, it
removes the manifest attributes that are the only route to them, so they stay on
disk doing nothing.

**The recipe is two commands, and the second is the one that gets forgotten:**

```bash
pnpm --dir packages/native exec tauri android init
git checkout -- packages/native/src-tauri/gen/android
```

`init` writes both halves; the checkout puts the committed half back and leaves
the ignored half — the machine-specific one — which is exactly what was missing.
Run it on a tree with no other changes under `gen/android`, because the second
command does not ask.

**Every file in that table carries a banner saying so at its top**, and
`nativecheck` asserts each edit against **comment-stripped** source. That is not
tidiness: the banners name the very lines being asserted on, and measured on a
pristine `MainActivity.kt` carrying nothing but its banner, all three patterns
matched the prose and the driver said `ok` three times about a file with none of
them in it. It also sweeps every committed file under `gen/android` for an
absolute path — the rule `tauri.settings.gradle` is exempt from only by being
ignored, and the one the `maven` block already follows by asking `cargo
metadata` instead of writing a path down. A banner may not quote a measured path
either, and that sweep is what says so.
