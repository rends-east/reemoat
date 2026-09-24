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

`native-shell.md` is the document for what this app *is*; this one is for the two
places it stops drawing its own control and asks the operating system for one — a
**save** panel and a **folder** panel. They are one subject because the mistakes
are the same two, and both have been made: a dismissal drawn as a failure, and a
command that waits on the main thread.

## A cancel is not a failure, and neither is it an answer

`host_save_file` answers `Ok(false)` for a dismissed panel and `host_pick_folder`
answers `Ok(None)`. Both reach the page as a value rather than a rejection, and
what the caller owes is to **leave what it already had alone**:
`if (picked !== null) setPath(picked)` is the whole of it, and it is asserted —
writing a cancel through would clear a folder somebody chose before they opened
the panel to look at it.

⚠ **`pickFolderNative` throws on a real failure and `copyNative` does not**, and
the asymmetry is deliberate. Losing a clipboard write costs the chrome; losing a
folder silently costs a `Start` button dead over nothing anybody can see is
missing. `webcheck.native-bridge.ts` asserts the absence of a `try` in that body,
because the swallow is the edit that looks like tidying.

## `(async)` is the rule, and it is now a mechanism

A command that waits on a platform panel **must** carry
`#[tauri::command(async)]`. The reason is mechanical rather than stylistic: the
panel's result is delivered *by* the main event loop, so a main-thread command
blocking on `blocking_save_file` or `blocking_pick_folder` is waiting on the loop
it is itself holding — a frozen window while the panel is open at best, and a
deadlock at worst.

`commands.rs` stated that at length and nothing held it to it; the attribute is
the whole fix and it is one token to lose in a refactor. `nativecheck` now splits
that file on the attribute and requires the argument form of every block whose
body reaches `.dialog()` or a `blocking_` call, with a `report` naming which
commands were found so the sweep cannot go vacuous.

## The folder panel is per *machine*, and that is the only one of these that is

The shell does five things (`native.ts`), and four of them are true wherever it
runs. This one is offered for the daemon running on **this same computer** and for
no other, because a panel can only ever see this computer's disk. Everywhere else
the folder is still walked over the wire, and the whole of what changes is which
body `DirectoryPicker` draws and whether `GET /fs/list` is issued at all.

**The predicate is `nativeBoot()?.picksFolder === true && state.localMachineId === selected`**,
derived once, at the mount site, and passed down as one boolean.

⚠ **`picksFolder` is a declared capability, and it replaced `inNativeShell()`
after an APK refused to compile.** A shell exists on Android too and has **no
folder panel there**: `tauri-plugin-dialog` 2.7.3 offers `blocking_pick_file` on
mobile and not `blocking_pick_folder`, because the platform's own answer to
"choose a folder" is `ACTION_OPEN_DOCUMENT_TREE` — a Storage Access Framework tree
*URI* rather than a path — which the plugin does not wrap. `host_save_file`
survives beside it only because a *file* panel does have a mobile arm.

Two guesses were available and both are wrong. Keying on `platform` reads
`"android"` through `hostPlatform`, which narrows it to `"other"` **along with
every future desktop target**. Leaning on a phone having no local daemon, and so
never matching `localMachineId`, is true today and is luck rather than a rule. So
the shell states what it can do and the page reads it.

**The command exists on every platform and only its body is gated.** `#[cfg]` on
the declaration or on the `generate_handler!` line would leave all three
text-based censuses — `nativecheck`'s declared-against-registered and
`webcheck.native-bridge.ts`'s two — asserting a surface a mobile build does not
have. `credential.rs` aliases its two `Entry` types the same way and for the same
reason. The mobile arm answers an error rather than panicking: *"the page should
never ask"* is not a reason to make asking fatal.

⚠ **`PICKS_FOLDER` and the `#[cfg]` on `pick_folder` are one condition written
twice**, because a `cfg!` macro and a `#[cfg]` attribute cannot share a token. A
build where they disagree draws a control the shell refuses and **compiles
perfectly**, so `nativecheck` compares the two strings.

⚠ **Never `route.kind === "local"`**, for three reasons and any one is enough.
The route is a *preference* — `setLocalOff` turns loopback off per machine, so a
picker keyed on it puts the tree back the instant somebody chooses the relay on
the machine they are sitting at. The route answers *reachability* and this
question is *identity*; a local daemon that is momentarily unreachable is still
this computer. And a screen cannot reach it at all: `MachineConnection` is pinned
to an exact four-module set with no `ui/` file among them. `AppState.localMachineId`
already carries this argument for the `this device` badge, and the picker is one
of its readers.

⚠ **`osDialog` is not part of `key={selected}`.** `localMachineId` can land at a
`runResume` after the first render — a daemon that came up after the app — so it
can go false → true under a mounted picker; a remount there would throw away a folder somebody had already walked to.

**One component, two arms**, and not two components. `DirectoryPicker` holds one
`path`, one `roots` read and one report effect, and that effect's dependencies are
`[path]` **alone** — `osDialog` in that list would re-fire the report on a clock of
its own, which is the two-writers defect `webcheck`'s ⭐ block exists for arriving
through a new door.

**What the panel arm draws**: the chosen folder through `displayCwd`, never
`pathCrumbs`. A crumb is a navigation control and there is nothing here to
navigate — tapping one would need the listing this arm stopped issuing — and
`displayCwd` already falls back to `shortPath` for a folder under no root, which
on this arm is the ordinary case rather than the exotic one.

**No "New folder here"**, because every platform's open panel has one and hands
back what it made already selected; a second copy would post `POST /fs/mkdir`
against a parent this arm is deliberately not listing. `.makeDir(` appears once in
the file and that is asserted. **"Import code" stays**: it needs a target folder
and is independent of how that folder was chosen.

⚠ **No file manager is named, here or in any string.** `webcheck` sweeps this
package for `macOS`/`Windows`/`Linux` against an exact five-file allowlist and
`NewSession.tsx` is not on it — naming one platform's file manager on a screen
that runs on three is the same defect one word to the left.

## What this loosens, and what it does not

**A panel is not narrowed by `REEMOAT_ROOTS`**, and that costs nothing that was
ever being protected: `resolveCwd` is deliberately unconfined and `POST /sessions`
takes any non-empty string, so `REEMOAT_ROOTS` narrows what `GET /fs/list`
*lists* and nothing else. Who can take this path at all is the uid that already
owns `~/.reemoat`. **No daemon change, no wire change, no new route.**

⚠ **One genuinely new failure mode, recorded rather than pre-mitigated.** Picking
`~/Desktop`, `~/Documents` or `~/Downloads` on macOS puts the agent inside a
TCC-protected directory. The panel grants access to the *app* through the
powerbox; the reader is the **daemon's child**, a separate process. Measure it
before adding any `NS*UsageDescription` key — this repository does not ship a
plist entry for a prompt nobody has seen.

## Two targets, one of them green

⚠ **This all shipped with `pnpm check`, `cargo clippy` and 74 `cargo test`s
green, and the APK would not compile.** Every one of those was honest and every
one was beside the point: **none of them builds for `aarch64-linux-android`**.
`pnpm check` is TypeScript and the drivers; clippy and the tests are the host
target. The only thing that catches a missing mobile arm is building for mobile.

`nativecheck` now carries the **static half** — a named list of desktop-only
dialog APIs, each required to sit behind a gate naming the platforms it is missing
on, with a `report` so a rename cannot make the check go quiet. It cannot know
what a crate offers on a target, so the list is measured rather than derived. The
rest of that lesson is Q7.146.

## The browser arm, which is not a gap

In a browser the tree stays, on every machine including the one the browser is
running on. `showDirectoryPicker()` is **not** the missing piece: it answers a
`FileSystemDirectoryHandle`, an opaque capability scoped to that browsing context,
and yields **no real path** — which is the entire payload, since `cwd` is an
absolute string interpreted on the daemon's own filesystem. There is nothing to
convert the handle into.

## The save panel

**`<a download>` is a request to a browser.** A webview under a custom scheme is
not obliged to honour it, so `saveBlob` hands the bytes to the shell and the shell
shows the platform's save panel. Raw IPC bytes, never JSON: the download bound is
100 MiB and that as a JSON number array is roughly 600 MB of string. The filename
rides in a header because a header is the only other field a raw request has, and
it is percent-encoded — a header value is ASCII and a filename is the one field
somebody definitely did not type in ASCII.
