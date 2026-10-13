//! Nothing puts this app in the login items: a daemon it runs lives and stops with it, and only a
//! daemon `install.sh` set up starts at login. An earlier build registered the app by itself; this
//! takes that back, once (Q7.161). `SMAppService` is named here to unregister, never to register.

use std::path::Path;

use crate::config;

/// `<name>.app/Contents/MacOS/<exe>` and not a translocated copy: the bundle that was registered.
/// Asked from anywhere else the system answers about another item, and the mark would go for nothing.
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

/// Off the main thread, at launch. Never from a debug build, which would answer for a development tree.
pub fn retire(dir: &Path, exe: &Path) {
    if cfg!(target_os = "macos") && !cfg!(debug_assertions) && bundled(exe) {
        taken_back(dir, &system::unregistered);
    }
}

/// The mark goes only once the system no longer lists the item, so a removal that failed is
/// tried again at the next launch, and one that worked is never repeated.
fn taken_back(dir: &Path, unregistered: &dyn Fn() -> bool) -> bool {
    if !config::holds_login_item(dir) || !unregistered() {
        return false;
    }
    config::forget_login_item(dir).is_ok()
}

#[cfg(target_os = "macos")]
mod system {
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    /// `SMAppServiceStatusEnabled`. Not registered, requires approval and not found are all off.
    const ENABLED: isize = 1;

    /// Read back rather than believed: an item somebody already removed refuses the removal.
    /// The class is looked up by name, so a system without it answers no rather than aborting.
    pub fn unregistered() -> bool {
        autoreleasepool(|_| {
            let Some(class) = AnyClass::get(c"SMAppService") else {
                return false;
            };
            // SAFETY: a class property returning an object the pool owns.
            let service: *mut AnyObject = unsafe { msg_send![class, mainAppService] };
            if service.is_null() {
                return false;
            }
            let mut error: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: the selector takes an `NSError **` and returns `BOOL`.
            let _: bool = unsafe { msg_send![service, unregisterAndReturnError: &mut error] };
            // SAFETY: `status` returns an `NSInteger` enum.
            let status: isize = unsafe { msg_send![service, status] };
            status != ENABLED
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod system {
    pub fn unregistered() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{bundled, taken_back};
    use crate::config;
    use std::cell::Cell;
    use std::path::{Path, PathBuf};

    fn scratch(name: &str, text: Option<&str>) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "reemoat-login-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(text) = text {
            std::fs::write(config::server_file(&dir), text).unwrap();
        }
        dir
    }

    #[test]
    fn only_the_bundle_that_was_registered_is_asked_about() {
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
    fn a_computer_no_earlier_build_marked_is_never_asked() {
        for text in [None, Some(r#"{"server":"https://a.example"}"#)] {
            let dir = scratch("unmarked", text);
            let calls = Cell::new(0);
            let unregistered = || {
                calls.set(calls.get() + 1);
                true
            };
            assert!(!taken_back(&dir, &unregistered));
            assert_eq!(calls.get(), 0);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn the_item_is_taken_back_once() {
        let dir = scratch("once", Some(r#"{"login_item":true}"#));
        let calls = Cell::new(0);
        let unregistered = || {
            calls.set(calls.get() + 1);
            true
        };
        assert!(taken_back(&dir, &unregistered));
        assert!(!config::holds_login_item(&dir));
        assert!(!taken_back(&dir, &unregistered), "a later launch does not");
        assert_eq!(calls.get(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_removal_the_system_did_not_make_is_tried_again() {
        let dir = scratch("refused", Some(r#"{"login_item":true}"#));
        let calls = Cell::new(0);
        let listed = Cell::new(true);
        let unregistered = || {
            calls.set(calls.get() + 1);
            !listed.get()
        };
        assert!(!taken_back(&dir, &unregistered));
        assert!(config::holds_login_item(&dir), "the mark is kept");
        listed.set(false);
        assert!(taken_back(&dir, &unregistered));
        assert_eq!(calls.get(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
