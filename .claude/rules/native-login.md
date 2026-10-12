---
paths:
  - packages/native/src-tauri/src/login.rs
  - packages/native/src-tauri/src/away.rs
---

# Opening at login

On a Mac the app sets this computer up as a machine and runs its daemon as a child, so a
reboot left the machine offline until somebody opened the app. The app registers itself to
open at login, window away, and its daemons start as on any launch. macOS only: the one
profile that carries a daemon (`native-packaging.md`). Q7.161.

## The system keeps the answer

- **`SMAppService.mainApp`, through the `objc2` already here** (`login.rs`, the only file
  that names it): no new crate, nothing for `MEASURED_TAURI` to move, and **no file in
  `~/Library/LaunchAgents`**, which `daemon::managed_unit` globs for a daemon's unit at
  two call sites. A plist of this app's own there would have to be exempted from a check
  that matches loosely on purpose.
- **"Is it on" is asked of the system on every read**, never stored: System Settings can
  change it. Only `enabled` is on; not registered, requires approval and not found are off.
- **Unsupported is an answer, not an error**: off macOS, in a debug build (it would
  register a development tree), with no daemon payload, outside `<name>.app/Contents/MacOS`,
  or translocated, whose path is gone after a reboot (`bundled`, `supported`).
- Measured on macOS 15.6, from an unsealed ad-hoc bundle outside `/Applications`, which is
  what a release is: register → `enabled`, unregister → not registered, never registered →
  not found; it survives a rebuilt binary and a moved bundle.

## On by default once, and never switched back on

- **The mark is written before the registration** (`config::decide_login_item`, then
  `register`, in `first_time`): a failure between the two loses the default and never
  repeats it. The mark is `login_item` in `server.json`, a `Value`, so any shape reads as
  decided; a file put aside (`server.json.unreadable`) may have held it and decides nothing.
- **The switch writes the mark too**, on and off, so the default never overrides a choice.
- **The trigger is this app's own supervisor starting a daemon**: `host_daemon_start`
  after `.start(…)`, the first setup; and the launch thread, when
  `start_configured_at_launch` started something, which is how somebody set up before this
  build gets it once. A Mac whose daemon is `install.sh`'s unit starts nothing here
  (`foreign`), registers nothing, and already comes back at login.
- **That second call is the one write a launch makes**, off the main thread, after a daemon
  started: `nativecheck` pins `default_on`'s two callers and keeps every account writer
  out of `lib.rs` and `seats.rs` as before.

## The bridge, and the row

`host_login_item` (seat-scoped for its document alone; the answer is this computer's) →
`on`, `off`, `unsupported`. `host_login_item_set {on}` (shown seat only, `not_shown`
otherwise) → what the system says afterwards. No `Boot` key. `native.ts`'s `loginItemOf`
reads any other word as unsupported; a failed read is `null`, which is not off.

The switch is **Open at login**, under *This computer* on this computer's own machine
screen (`OpenAtLogin` in `MachineSection.tsx`), gated on `canHostDaemon` and
`localMachineId`, absent until the host answers and where it answers unsupported. Drawn
from the host's last answer, never the press; no line under it, nothing to confirm.

## A launch at login opens put away

`opened_at_login` reads the launch's open event inside `setup` (`oapp` whose `prdt` is
`lgit`); `away::at_launch` then sets the window config's `visible` false and
`seats.rs` shows the window only when it is true. The Dock brings it back
(`RunEvent::Reopen`, `away::bring_back`). **False is the safe answer**: the window is shown.

## Not measured

The open event on a real login, on any macOS: a launch from a shell says false, and the
hand check is a reboot. What the system answers after somebody removes the item in System
Settings. macOS 13 and 14.
