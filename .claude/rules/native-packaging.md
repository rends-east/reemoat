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

What a build produces and a release publishes (Q4.123); what the app *is* is `native-shell.md`.

## Two profiles, and the difference is one JSON file

**`full` carries a Node runtime and a copy of `src/`; `client` carries neither.** macOS is
the only full profile.

| | Client | Daemon host |
|---|---|---|
| macOS | shipping | shipping |
| Linux | declared; no CI leg or asset | not bundled: `deploy/install.sh` |
| Windows | declared; no CI leg or asset | refused: it cannot be stopped cleanly |
| Android | declared, `gen/android` committed; no CI leg or asset | impossible |
| iOS | **refused at compile time** (no store arm, no `gen/apple`) | impossible |

**A client build is `tauri.<platform>.conf.json` and nothing else.** Tauri merges overlays
over the base through `json_patch::merge` (RFC 7386: an array replaces, `null` deletes), so a
client is `externalBin: null` and `resources: null`. The runtime is `bundle.macOS.files`,
read only by the macOS bundler; `externalBin: null` stays in each overlay because
`ci-release.sh`'s `app_profile` reads it as the client marker. `tauri-build` reads overlays
at **compile** time (measured 2026-09-19), which is why a profile is a config file and not a
cargo feature.

A desktop client needs no code change: `Payload::locate` answers `None`, `host_daemon_state`
answers `"unsupported"`, and `store.ts` takes its missing-bridge return. `host_local_daemon` is not part of it: it reads the calling
account's `daemon.json`, then `~/.reemoat/daemon.json` (what `src/announce.ts` wrote; a
server's first account only), so a client still reaches an `install.sh` daemon over loopback
(Q7.148, Q7.149). A client gives up *starting* a daemon, not *finding* one.

## What an overlay may say

**Only `bundle.targets`, `bundle.externalBin`, `bundle.resources` and `$schema`**, an exact
allowlist over the flattened keys: `nativecheck` reads one config where Tauri reads five, and
this keeps its other assertions (CSP, permissions, `signingIdentity: null`,
`dragDropEnabled: false`, `createUpdaterArtifacts`, the licence) true of every build. **No
`tauri.macos.conf.json`**, asserted: the base is the macOS shape. Only desktop overlays name a
bundler; the mobile builds read no `bundle.targets`.

## The staging script

- **`build-daemon.mjs` refuses a Windows triple by name**, a decision: no Windows bundle reads
  a payload. The refusal keeps the three differences (a `zip`, `node.exe` at the archive root,
  an `.exe` suffix); `nativecheck` asserts the file it names exists.
- `applyPatches` applies pnpm's `patchedDependencies` to npm's tree by hand, refuses a
  version other than the patched one, and runs `git apply` under `GIT_CEILING_DIRECTORIES` (in the checkout git
  skips every path, exit 0); else the daemon loses `_reemoat/effort` (Q6.121).
- Every desktop triple stays in `TARGETS`; `nativecheck` counts it and asserts each row names
  an esbuild binary.
- **The shim in `node_modules/.bin/node` ends in a refusal (exit 127), never a PATH lookup**:
  `daemon.rs`'s `daemon_path` puts that directory first on PATH (so `deploy/agents.sh` finds
  the node beside npm), and a PATH fallback re-execs the shim for ever. `nativecheck` asserts
  the old line absent and the new present, against code rather than text.

## The runtime is a helper app, and the Dock is why

On macOS the runtime is `Contents/Helpers/Reemoat Runtime.app`, its `Info.plist`
(`src-tauri/runtime/Info.plist`, `com.reemoat.app.runtime`) carrying `LSUIElement`: a node in
`Contents/MacOS` setting `process.title` (npm does, per `npx` MCP server) drew a blank Dock
tile (`docs/NATIVE.md`).

- `pnpm native:stage` puts it at `src-tauri/target/Helpers`, so the shim's
  `../../../../Helpers/…` and `daemon.rs`'s `<exe>/../../Helpers/…` resolve in a bundle and in
  `tauri dev`. `bundle.macOS.files` copies it; only the app is in `Contents/MacOS`.
- `build.rs` refuses a missing helper or the wrong Mach-O CPU type on any macOS target, and
  copies it beside a profile directory outside `src-tauri/target` (`--target`, `CARGO_TARGET_DIR`).
- **Staging signs it**, because tauri-bundler 2.11 copies `bundle.macOS.files` unsigned and
  `codesign --verify --deep --strict` then fails the app. `build-daemon.mjs` signs with
  `entitlements-node.plist` under the hardened runtime (`APPLE_SIGNING_IDENTITY` with a
  timestamp, else ad-hoc) and refuses `APPLE_CERTIFICATE` alone.
- No double hyphen in a plist comment: codesign refuses it (*"AMFIUnserializeXML"*) while
  `plutil -lint` passes. `nativecheck` sweeps every plist, and pins the layout, the four copies
  of the helper's name, the four LaunchServices keys, the signing step and the CPU table.

## The two mobile platforms are in different states

**`keyring`'s `v1` feature has no store on iOS or Android and refuses at run time, having
compiled** (`keyring-4.2.0/src/v1.rs:109-128`): the one gap no build gate catches.

- **Android**: `credential.rs` names `keyring-core` with `android-native-keyring-store`
  (SharedPreferences, key in the Keystore), which needs `ndk-context`, initialised by nothing
  in the tree but `credential.rs`'s `Java_com_reemoat_app_MainActivity_initNdkContext`, called
  in `MainActivity.kt`'s `onCreate`. `Store::new()` is a JNI round trip, so a `OnceLock`
  caches the **success only**, a `Mutex` behind it for the retry; a cached `Err` is permanent.
- The slot may be set once (`initialize_android_context` asserts it), and the `.so` also
  exports the store crate's `Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext`
  (uncalled). The JNI body is a `catch_unwind`, and a null `context` is refused before caching
  (`jni` 0.21's `new_global_ref` answers `Ok` for null).
- **"Before Tauri's `setup`" is the invariant.** Only `MainActivity`'s companion and the
  generated `Rust` object call `System.loadLibrary`, and there is no `JNI_OnLoad`;
  `nativecheck` compares the two indices in `MainActivity.kt`. A `Service`, receiver or
  provider of our own breaks that: **move** the call, never add a second.
- **iOS is refused at compile time**, a tripwire: the `apple-native-keyring-store` arm and the
  refusal's deletion land in one change, asserted as a pair. `probe()` says whether it works.

## Android's TLS is not what the plan said it was

**No vendored OpenSSL, asserted.** `reqwest` 0.13 resolves to `rustls` with
`rustls-platform-verifier` (Android's `X509TrustManager` over JNI), so `/v1` honours
`network_security_config`, user CAs included (Q7.144). It costs:

- The Kotlin half, `org.rustls.platformverifier.CertificateVerifier`, in the APK through
  `gen/android`'s `build.gradle.kts`, or TLS fails at run time.
- **A call**: `reqwest` never initialises the verifier, which panics on the first `/v1`
  request. `init_with_env` sits in `credential.rs`'s JNI export beside the `ndk-context` one
  (a different handle; `host_cp` is the only `reqwest` caller). `nativecheck` asserts both calls there and one copy of the crate.
- A second `jni`: the verifier is on `jni = "0.22"` (`Env`), Tauri, tao, wry and
  `android-native-keyring-store` on 0.21 (`JNIEnv`). `jni22 = { package = "jni", … }` sits
  beside `jni`; `nativecheck` reads its version off `Cargo.lock`'s `rustls-platform-verifier`
  block.

## `tauri android init` does not use this project's icons

It writes Tauri's own into `gen/android/app/src/main/res/mipmap-*`, ignoring
`src-tauri/icons/android/`, and drops `mipmap-anydpi-v26/ic_launcher.xml`. An adaptive foreground is **the mark alone on transparency**, the 72dp
viewport treated as the badge, so its share is the Dock's (51dp tall, ~26dp of the 33dp safe
radius; inside the safe zone is a ceiling, not a size). Background `#1c1a16`, the colour
`packages/web/public/favicon.svg` knocks the mark out of; `<monochrome>` reuses the
foreground. Both trees are written byte for byte: `gen/android` builds (`tauri android build`
copies nothing into `res/`), `src-tauri/icons/android` is diffed against. **A `tauri android
init` overwrites the first**; `pnpm --dir packages/native icon` restores it. Q4.128.

## The macOS inset, and which surfaces carry it

Apple's grid is an **824×824 squircle in a 1024×1024 canvas**. Re-measuring a system icon,
threshold past its drop shadow (854 otherwise); this icon has none, deliberately. Q4.124.

| Surface | Geometry |
|---|---|
| `icons/icon.icns`, `icon.png`, the sized PNGs, `icon.ico` | **inset** to 824/1024 |
| `icons/android/`, `gen/android/` foreground | the mark alone, the 72dp viewport as the badge |
| `icons/android/`, `gen/android/` legacy rasters | the Dock's tile, `_round` a circle (unmasked on API 24–25) |
| `icons/ios/*`, `packages/web/public/apple-touch-icon.png` | full bleed: iOS masks its own |
| `packages/web/public/favicon.svg` | full bleed, and the **source** |
| `Square*Logo.png`, `StoreLogo.png` | unchanged and **unmeasured**, a stated gap |

**`tauri icon` is retired; `packages/native/scripts/icons.mjs` replaced it**, writing the
macOS, Windows and Android rasters and **no XML** (the launcher XMLs are hand-authored), which
`nativecheck` asserts by reading the script. Platform numbers: `MARGIN` `100 / 1024`,
`RADIUS` `185.4 / 824`, `ADAPTIVE_MARGIN` `(108 - 72) / 2 / 108`; the mark's six numbers are
parsed from `favicon.svg`, so the icon is a transform of it. `rx` does not scale (25% against
22.5%), and the corner is a circular arc, not a continuous-curvature squircle.

`nativecheck` decodes PNG and pins: every `bundle.icon` path; the `.icns` members (the eight
PNG types a macOS 13 floor reads); `ic10` 824×824 at (100,100), equal to `icon.png`; each
raster's inset and the mark's favicon `scale`; identical Android trees; `favicon.svg` against
`Mark.tsx`; the full-bleed rows; the `@color` in `mipmap-anydpi-v26/ic_launcher.xml` and
`values/ic_launcher_background.xml`, comment-stripped; and **every file a
`packages/native/package.json` script names exists**.

## The release APK carries v1 beside v2, and the v1 half is not for Android

**`enableV1Signing = true` and `enableV2Signing = true`** in `app/build.gradle.kts`'s release
signing config: AGP adds v1 itself only below `minSdk` 24, and a v2-only 0.10.1 was refused by
OxygenOS's tapped installer (*"package appears to be invalid"*) while `adb install` took it.
That v1 fixes it is **a weak hypothesis** (AOSP's `install_failed_invalid_apk` words); the test
is one APK signed with and without v1, tapped on that phone, under `adb logcat`. **v3 stays
off** (Android 9+ would verify it instead of v2, confounding the test); v4 is a separate `.idsig`.

`apksigner verify --verbose` prints `v1 … false` for a valid v1 at `minSdk` 24, so
`ci-release.sh` verifies again at `--min-sdk-version 23` after the plain `verify`.
`deploycheck`'s stub answers `false` for v1 unless asked below 24; `nativecheck` pins the pair.

## What a clone cannot build, and the one file that is this machine's

**`gen/android/tauri.settings.gradle`** names the Tauri crates by absolute cargo-home path, so
`gen/android/.gitignore` ignores it and a clone fails at `settings.gradle`'s `apply from`.
`app/tauri.build.gradle.kts`, `app/tauri.properties`, `app/proguard-tauri.pro` stay ignored;
`tauri.properties` would be a seventh, unchecked version site.

**So every new machine runs `tauri android init`, which reverts every hand-edit here:**

| File | What a re-run takes out |
|---|---|
| `app/src/main/java/com/reemoat/app/MainActivity.kt` | the `Context` import, the `System.loadLibrary` companion, `external fun initNdkContext`, its call **before** `super.onCreate` |
| `app/build.gradle.kts` | `signingConfigs`, the conditional `signingConfig`, the v1/v2 pair, the `repositories { maven … }` block for the verifier's `.aar`, that dependency |
| `app/proguard-rules.pro` | the `-keep` rule for `org.rustls.platformverifier.**` |
| `app/src/main/AndroidManifest.xml` | `networkSecurityConfig`, `dataExtractionRules`, `allowBackup="false"`, `fullBackupContent="false"` |
| `app/src/main/res/mipmap-*` | this project's rasters |

`tauri icon` also rewrites `res/mipmap-anydpi-v26/ic_launcher.xml` and
`res/values/ic_launcher_background.xml` (`#fff`); `init` strips the manifest attributes that
reach `res/xml/network_security_config.xml` and `res/xml/data_extraction_rules.xml`.

```bash
pnpm --dir packages/native exec tauri android init
git checkout -- packages/native/src-tauri/gen/android   # only with no other changes there
```

Every file in that table carries a banner, so `nativecheck` asserts each edit against
**comment-stripped** source (the banners quote the asserted lines). It also sweeps committed
`gen/android` files, banners included, for an absolute path; the `maven` block asks `cargo
metadata` instead.
