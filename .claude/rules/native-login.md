---
paths:
  - packages/native/src-tauri/src/login.rs
---

# The login items

**Nothing puts this app in the login items.** A daemon the app runs is its child: it starts
with the app and stops when the app quits, so a Mac the app set up is a machine only while
the app is open. Only a daemon `install.sh` set up starts at login, from its own unit
(`deployment.md`). No switch, no bridge command, no window opened put away. The owner's
decision, 2026-10-14, taking back 2026-10-11's. Q7.161.

## What an earlier build registered comes out once

Development builds of 2026-10-12 and 13 registered the app with `SMAppService.mainApp` the
first time their supervisor started a daemon, and wrote `login_item` into `server.json`.

- **`login::retire`, from the launch thread alone**, before any daemon is started: where
  that mark is present it unregisters the app, and removes the mark only once the system no
  longer says *enabled* (`taken_back`). A removal that failed is tried at the next launch;
  one that worked is never repeated. It is the one write a launch may make.
- **The mark, not the system's answer, is the trigger**: no build writes it now (it is read
  out of `Stored.rest`), so nothing registered any other way is ever touched.
- **The answer is read back, never believed**: an item somebody already removed in System
  Settings refuses the removal, and still reads as gone.
- **Never from a debug build, outside `<name>.app/Contents/MacOS`, or translocated**
  (`bundled`): asked from anywhere else the system answers about another item, and the mark
  would go for nothing.
- `SMAppService` is named in `login.rs` alone, which never sends a registration;
  `nativecheck` pins both, and that no command or window names a login item.

Delete `login.rs`, the two `config.rs` functions and this file once no computer still runs
one of those two days' builds.

## Not measured

The removal on a Mac that holds the item: the two messages are the ones measured for Q7.161
on macOS 15.6 (unregister, then *not registered*), sent here from a later build of the same
bundle.
