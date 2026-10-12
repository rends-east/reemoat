//! Opening at login on macOS, so the daemons this app supervises come back after a reboot
//! without anybody opening it (Q7.161). `SMAppService.mainApp`: the system keeps the answer,
//! and nothing lands in `~/Library/LaunchAgents`, where `daemon::managed_unit` looks.

use std::path::Path;

use crate::config;

pub const ON: &str = "on";
pub const OFF: &str = "off";
pub const UNSUPPORTED: &str = "unsupported";

/// A bundle the system can find again at the next login: `<name>.app/Contents/MacOS/<exe>`, and
/// not a translocated copy, whose path is gone after a reboot.
pub fn bundled(exe: &Path) -> bool {
    let mut above = exe.ancestors().skip(1);
    let in_bundle = above
        .next()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "MacOS")
        && above
            .next()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "Contents")
        && above
            .next()
            .and_then(Path::extension)
            .is_some_and(|extension| extension == "app");
    in_bundle
        && !exe
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation")
}

/// Only where there is a daemon to bring back, and never from a debug build, which would
/// register a development tree.
pub fn supported(exe: &Path, carries_daemon: bool) -> bool {
    cfg!(target_os = "macos") && !cfg!(debug_assertions) && carries_daemon && bundled(exe)
}

/// The system's answer, asked every time: a stored flag would lie the day somebody used
/// System Settings instead.
pub fn state(exe: &Path, carries_daemon: bool) -> &'static str {
    if !supported(exe, carries_daemon) {
        return UNSUPPORTED;
    }
    match system::enabled() {
        Some(true) => ON,
        Some(false) => OFF,
        None => UNSUPPORTED,
    }
}

pub fn set(dir: &Path, exe: &Path, carries_daemon: bool, on: bool) -> Result<&'static str, String> {
    if !supported(exe, carries_daemon) {
        return Ok(UNSUPPORTED);
    }
    if on {
        // Decided before it is registered, so the default can never repeat a choice made here.
        config::decide_login_item(dir)?;
        system::register()?;
    } else {
        // Best effort: switching it off must always be possible.
        let _ = config::decide_login_item(dir);
        system::unregister()?;
    }
    Ok(state(exe, carries_daemon))
}

/// Once, the first time this app's own supervisor starts a daemon on this computer.
pub fn default_on(dir: &Path, exe: &Path, carries_daemon: bool) {
    if supported(exe, carries_daemon) {
        first_time(dir, &system::register);
    }
}

/// The mark is written before the registration, so a failure between the two loses the default
/// and never repeats it: somebody who switched this off is never switched back on.
fn first_time(dir: &Path, register: &dyn Fn() -> Result<(), String>) -> bool {
    if !matches!(config::decide_login_item(dir), Ok(true)) {
        return false;
    }
    let _ = register();
    true
}

/// Whether the system started this launch as a login item, read inside `setup`, while the open
/// event is still the current one. False is the safe answer: the window is shown.
pub fn opened_at_login() -> bool {
    system::opened_at_login()
}

#[cfg(target_os = "macos")]
mod system {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{class, msg_send};

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    /// `SMAppServiceStatusEnabled`. Not registered, requires approval and not found are all off.
    const ENABLED: isize = 1;

    const fn four(code: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*code)
    }

    /// Looked up by name, so a system without the class reads as unsupported rather than aborting.
    fn main_app() -> Option<*mut AnyObject> {
        let class = AnyClass::get(c"SMAppService")?;
        // SAFETY: a class property returning an object the pool owns.
        let service: *mut AnyObject = unsafe { msg_send![class, mainAppService] };
        (!service.is_null()).then_some(service)
    }

    pub fn enabled() -> Option<bool> {
        autoreleasepool(|_| {
            let service = main_app()?;
            // SAFETY: `status` returns an `NSInteger` enum.
            let status: isize = unsafe { msg_send![service, status] };
            Some(status == ENABLED)
        })
    }

    fn act(register: bool) -> Result<(), String> {
        autoreleasepool(|_| {
            let service =
                main_app().ok_or("this version of macOS has no login items for an app")?;
            let mut error: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: both selectors take an `NSError **` and return `BOOL`.
            let done: bool = unsafe {
                if register {
                    msg_send![service, registerAndReturnError: &mut error]
                } else {
                    msg_send![service, unregisterAndReturnError: &mut error]
                }
            };
            if done {
                return Ok(());
            }
            Err(described(error).unwrap_or_else(|| {
                "macOS refused to change whether Reemoat opens at login".to_string()
            }))
        })
    }

    fn described(error: *mut AnyObject) -> Option<String> {
        if error.is_null() {
            return None;
        }
        // SAFETY: `localizedDescription` is an `NSString`, read while the pool still holds it.
        unsafe {
            let text: *mut AnyObject = msg_send![error, localizedDescription];
            if text.is_null() {
                return None;
            }
            let bytes: *const std::ffi::c_char = msg_send![text, UTF8String];
            (!bytes.is_null()).then(|| {
                std::ffi::CStr::from_ptr(bytes)
                    .to_string_lossy()
                    .into_owned()
            })
        }
    }

    pub fn register() -> Result<(), String> {
        act(true)
    }

    pub fn unregister() -> Result<(), String> {
        act(false)
    }

    /// An open-application event whose `prdt` is `lgit`, which is what a login item is launched with.
    pub fn opened_at_login() -> bool {
        autoreleasepool(|_| {
            // SAFETY: Foundation messages with arguments and returns of their declared types.
            unsafe {
                let manager: *mut AnyObject =
                    msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
                let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
                if event.is_null() {
                    return false;
                }
                let id: u32 = msg_send![event, eventID];
                if id != four(b"oapp") {
                    return false;
                }
                let launched: *mut AnyObject =
                    msg_send![event, paramDescriptorForKeyword: four(b"prdt")];
                if launched.is_null() {
                    return false;
                }
                let code: u32 = msg_send![launched, enumCodeValue];
                code == four(b"lgit")
            }
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod system {
    pub fn enabled() -> Option<bool> {
        None
    }

    pub fn register() -> Result<(), String> {
        Err("this platform has no login item".to_string())
    }

    pub fn unregister() -> Result<(), String> {
        Err("this platform has no login item".to_string())
    }

    pub fn opened_at_login() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{bundled, first_time, opened_at_login};
    use std::cell::Cell;
    use std::path::Path;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "reemoat-login-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_a_bundle_the_system_can_find_again_is_registered() {
        for (path, stable) in [
            ("/Applications/Reemoat.app/Contents/MacOS/reemoat", true),
            ("/Users/a/src/target/release/bundle/macos/Reemoat.app/Contents/MacOS/reemoat", true),
            (
                "/private/var/folders/x/T/AppTranslocation/1F2E/d/Reemoat.app/Contents/MacOS/reemoat",
                false,
            ),
            ("/Users/a/src/target/debug/reemoat", false),
            ("/Applications/Reemoat.app/Contents/Resources/reemoat", false),
            ("/Applications/Reemoat/Contents/MacOS/reemoat", false),
        ] {
            assert_eq!(bundled(Path::new(path)), stable, "{path}");
        }
    }

    #[test]
    fn the_default_is_applied_once_and_never_again() {
        let dir = scratch("once");
        let calls = Cell::new(0);
        let register = || {
            calls.set(calls.get() + 1);
            Ok(())
        };
        assert!(
            first_time(&dir, &register),
            "the first daemon start registers"
        );
        assert!(!first_time(&dir, &register), "a later one does not");
        assert!(!first_time(&dir, &register));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn a_registration_that_fails_is_not_tried_again() {
        let dir = scratch("failed");
        let calls = Cell::new(0);
        let register = || {
            calls.set(calls.get() + 1);
            Err("refused".to_string())
        };
        assert!(first_time(&dir, &register));
        assert!(!first_time(&dir, &register));
        assert_eq!(calls.get(), 1, "the mark was written before the attempt");
    }

    #[test]
    fn a_choice_already_made_is_never_overridden_by_the_default() {
        let dir = scratch("chosen");
        // What the switch does before it registers or unregisters.
        assert_eq!(crate::config::decide_login_item(&dir), Ok(true));
        let calls = Cell::new(0);
        let register = || {
            calls.set(calls.get() + 1);
            Ok(())
        };
        assert!(!first_time(&dir, &register));
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn a_test_run_was_not_started_by_a_login() {
        assert!(!opened_at_login());
    }
}
