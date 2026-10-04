---
paths:
  - packages/web/src/ui/NewSession.tsx
  - packages/web/src/ui/download.ts
  - packages/web/src/native.ts
  - packages/native/src-tauri/src/commands.rs
  - packages/web/scripts/webcheck.native-bridge.ts
  - packages/web/scripts/webcheck.local-route.ts
---

# The two platform panels

The OS **save** and **folder** panels, and their two mistakes: a dismissal drawn as a failure,
and a command waiting on the main thread. Q7.145 argues the folder panel.

## A cancel is not a failure, and neither is it an answer

Dismissed, `host_save_file` answers `Ok(false)` and `host_pick_folder` `Ok(None)`, a value, and
the caller **leaves what it had alone** (`if (picked !== null) setPath(picked)`, asserted).
`pickFolderNative` throws on a real failure, unlike `copyNative`: a lost folder is a dead
`Start` button. `webcheck.native-bridge.ts` asserts no `try` in that body.

## `(async)` is the rule, and it is now a mechanism

A command that waits on a platform panel **must** carry `#[tauri::command(async)]`: the
panel's result is delivered by the main event loop, so a main-thread command blocking on
`blocking_save_file` or `blocking_pick_folder` waits on the loop it holds (a frozen window, or
a deadlock). `nativecheck` splits `commands.rs` on the attribute and requires the argument form
on every block reaching `.dialog()` or a `blocking_` call, with a `report` naming what it found
so the sweep cannot go vacuous.

## The folder panel is per *machine*, and that is the only one of these that is

A panel sees only this computer's disk, so only the daemon on **this computer** gets one;
elsewhere `DirectoryPicker` walks the folder over `GET /fs/list`.

**The predicate is `nativeBoot()?.picksFolder === true && state.localMachineId === selected`**,
derived once at the mount site and passed down as one boolean.

- **`picksFolder` is a declared capability**, not `inNativeShell()` (Android has a shell and,
  in `tauri-plugin-dialog` 2.7.3, no `blocking_pick_folder`), nor `platform` (`hostPlatform`
  narrows `"android"` to `"other"`), nor luck about `localMachineId`. `host_save_file` keeps a
  mobile arm, writing a `content://` URI through `tauri-plugin-fs` (Q3.690).
- **The command exists on every platform; only its body is gated.** A `#[cfg]` on the
  declaration or the `generate_handler!` line would leave the three text censuses asserting a
  surface mobile lacks (`credential.rs` aliases its `Entry` types for the same reason). The
  mobile arm answers an error, never a panic.
- **`PICKS_FOLDER` and the `#[cfg]` on `pick_folder` are one condition written twice** (a
  `cfg!` and a `#[cfg]` cannot share a token); a mismatch compiles and draws a control the shell
  refuses, so `nativecheck` compares the two strings.
- **Never `route.kind === "local"`**: a preference (`setLocalOff`) about reachability, not
  identity, and unreachable from a screen (`MachineConnection` is pinned to four modules, no
  `ui/`). `AppState.localMachineId` answers identity, as for the `this device` badge.
- **`osDialog` is not part of `key={selected}`**: `localMachineId` can land at a `runResume`
  after first render, and a remount would discard a folder already walked to.
- **One component, two arms.** `DirectoryPicker` holds one `path`, one `roots` read and one
  report effect whose dependencies are `[path]` **alone**; `osDialog` there would re-fire the
  report, the two-writers defect `webcheck`'s ⭐ block guards.
- The panel arm draws the folder through `displayCwd` (falling back to `shortPath`), never
  `pathCrumbs`, which would need the listing this arm does not issue.
- **No "New folder here"**: every open panel has one, and a copy would `POST /fs/mkdir` against
  an unlisted parent. `.makeDir(` appears once in the file, asserted. **"Import code" stays.**
- No file manager is named in any string; `NewSession.tsx` is not on `webcheck`'s five-file
  OS-name allowlist (`native-shell.md`).

## What this loosens, and what it does not

`REEMOAT_ROOTS` does not narrow a panel, at no cost: it narrows only what `GET /fs/list` lists,
since `resolveCwd` is unconfined and `POST /sessions` takes any string. Only the uid owning
`~/.reemoat` takes this path. **No daemon, wire or route change.** One new failure mode,
recorded: `~/Desktop`, `~/Documents` or `~/Downloads` on macOS are TCC-protected, granted to
the *app*, not the daemon's child; measure before adding any `NS*UsageDescription` key.

## Two targets, one of them green

`pnpm check`, `cargo clippy` and `cargo test` never build `aarch64-linux-android`; only a mobile
build catches a missing mobile arm. `nativecheck` holds a measured list of desktop-only dialog
APIs, each behind a gate naming where it is missing, with a `report`. Q7.146.

## The browser arm, which is not a gap

In a browser the tree stays on every machine. `showDirectoryPicker()` answers a
`FileSystemDirectoryHandle` with **no real path**, and `cwd` is an absolute string on the
daemon's filesystem; there is nothing to convert.

## The save panel

`<a download>` is a request a custom-scheme webview may ignore, so `saveBlob` hands the bytes to
the shell's save panel. **Base64 in JSON arguments, never a raw body**: a raw body exists only
over `ipc://`, which the CSP does not name, so every call travels by `postMessage`, where raw
bytes arrive as a number array the raw arm refused (Q3.690). `nativecheck` refuses
`InvokeBody::Raw`.
