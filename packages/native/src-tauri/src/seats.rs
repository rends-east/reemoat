//! The webviews, one per account where the platform allows it — and the only
//! file that builds one.
//!
//! **Two arms, and the split is confined to this file.** Everything the rest of
//! the host decides — which account a command is about, what a switch changes,
//! when a document is stale — is the same in both; what differs is whether an
//! account change is a webview shown or a webview rebound. Q7.149.
//!
//! - **macOS: one window, one child webview per account** (`MULTI_WEBVIEW`). A
//!   switch hides one and shows another: nothing reloads, and a page keeps its
//!   heap, its sockets and whatever somebody was typing. Every account's webview
//!   is created at launch — the shown one first, at full size, then the rest at
//!   zero size and hidden — so each page boots and sets its computer up whether or
//!   not anybody looks at it. It needs Tauri's `unstable` feature
//!   (`Window::add_child`, `WindowBuilder`, `WebviewBuilder`,
//!   `Manager::get_webview`), which `Cargo.toml` enables for the macOS target
//!   alone.
//! - **Everywhere else, and on macOS with `MULTI_WEBVIEW` flipped off: one
//!   `WebviewWindow`, `main`, rebound.** A switch moves the webview's seat to the
//!   other account and the page reloads (`location.replace("/")`). Linux is here
//!   on purpose — tao packs a window's child webviews into a `GtkBox` and ignores
//!   their bounds, so two children split the height — and Windows and Android
//!   until a pass of their own measures them.
//!
//! **Every webview is built from `main`'s own configuration and guarded.**
//! `from_config` is what carries `dragDropEnabled: false` (`native-shell.md`'s
//! assertion with no other symptom) and the background colour into every
//! account's webview, and `on_navigation(is_our_own)` is on every one, so no
//! account's page can be navigated away from this app's own document. There is no
//! `initialization_script` anywhere: the credential crosses by `host_boot`.
//!
//! **What a window close means, stated because nothing else here says it.**
//! Closing the window destroys every child; the last window's destruction is
//! `RunEvent::Exit`, where `lib.rs` stops every account's daemon. Closing one
//! child webview never quits — and the last account's webview is never closed:
//! forgetting the last account rebinds it to a sign-in instead.
//!
//! ⚠ **What a hidden page is, measured nowhere yet.** It runs — its sockets stay
//! open and its bootstrap completes — but `store.ts` skips its poll while
//! `visibilityState` is not `visible`, `resume.ts` catches up on show, and macOS
//! 14 and later suspends a hidden `WKWebView` after about five minutes. That last
//! is why no account's *daemon* depends on its page: the host starts every set-up
//! one at launch (`daemon::start_configured_at_launch`). And every page shares one
//! `WKWebsiteDataStore`, so `localStorage` is shared across accounts — isolating it
//! needs `data_store_identifier`, which is macOS 14, and the bundle's minimum is
//! 13. Both are recorded in Q7.149.
//!
//! ⚠ **The lock rule** (`commands.rs`'s module docblock): nothing here holds a
//! `Host` lock across a webview call. Every function copies what it needs out of
//! `Host` first — `labels`, `label_of`, `shown` all answer copies — and the one
//! lock an account change holds across these calls is `changing`, which the main
//! thread never takes.

use std::error::Error;

use tauri::utils::config::WindowConfig;
use tauri::{App, AppHandle, Manager};

use crate::accounts::Slot;
use crate::commands::Host;
use crate::config;
use crate::is_our_own;

/// One window, one webview per account. See the module docblock; flipping this is
/// the whole of falling back to the single-webview arm on macOS.
#[cfg(target_os = "macos")]
pub const MULTI_WEBVIEW: bool = true;

/// The label of the one `WebviewWindow` the single arm builds, which is also the
/// window label in both arms.
const MAIN: &str = "main";

/// `main`'s configuration, as `tauri.conf.json` declares it with `create: false`.
pub fn main_config(app: &AppHandle) -> Option<WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN)
        .cloned()
}

/// Which seats a launch opens, and which of them is shown.
#[derive(Debug, PartialEq, Eq)]
pub struct Launch {
    pub seats: Vec<Slot>,
    pub shown: usize,
}

/// A seat per account, shown in the order they were added; the account shown
/// last on top. A server chosen and never signed in to — before accounts, or a
/// first run — is a pending seat, and it is the one shown when there is one,
/// since that is where the person was.
pub fn plan(roster: &config::Roster, server: Option<String>) -> Launch {
    let mut seats: Vec<Slot> = roster
        .accounts
        .iter()
        .map(|account| Slot::from_account(account, &roster.roots))
        .collect();
    let mut shown = roster
        .shown()
        .map(config::Account::key)
        .and_then(|key| {
            roster
                .accounts
                .iter()
                .position(|account| account.key() == key)
        })
        .unwrap_or(0);
    if let Some(pending) = &roster.pending {
        seats.push(Slot::Pending {
            origin: Some(pending.clone()),
        });
        shown = seats.len() - 1;
    }
    if seats.is_empty() {
        seats.push(Slot::Pending { origin: server });
        shown = 0;
    }
    Launch { seats, shown }
}

/// Build the window and every account's webview. **Writes nothing** — the plan
/// is read from what `lib.rs` already read, and a seat that cannot be built is
/// opened on the switch that wants it rather than failing the launch.
pub fn open_at_launch(
    app: &App,
    config: &WindowConfig,
    roster: &config::Roster,
    server: Option<String>,
) -> Result<(), Box<dyn Error>> {
    let launch = plan(roster, server);
    let host = app.state::<Host>();
    #[cfg(target_os = "macos")]
    if MULTI_WEBVIEW {
        return multi::open_at_launch(app, config, &host, launch);
    }
    single::open_at_launch(app, config, &host, launch)
}

/// Show `target` in place of the caller — answering whether the page reloads.
pub fn switch_to(
    app: &AppHandle,
    host: &Host,
    caller: &str,
    caller_slot: &Slot,
    target: Slot,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    if MULTI_WEBVIEW {
        return multi::switch_to(app, host, caller, caller_slot, target);
    }
    let _ = (app, caller_slot);
    host.move_seat(caller, target);
    Ok(true)
}

/// Open a sign-in for a new account and show it.
pub fn add(app: &AppHandle, host: &Host, caller: &str) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    if MULTI_WEBVIEW {
        return multi::add(app, host);
    }
    let _ = app;
    host.move_seat(caller, Slot::Pending { origin: None });
    Ok(true)
}

/// The caller's account is gone: show `next`, or — with no account left —
/// become `fallback` on the same webview and reload.
pub fn leave(
    app: &AppHandle,
    host: &Host,
    caller: &str,
    next: Option<Slot>,
    fallback: Slot,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    if MULTI_WEBVIEW {
        return multi::leave(app, host, caller, next, fallback);
    }
    let _ = app;
    host.move_seat(caller, next.unwrap_or(fallback));
    Ok(true)
}

/// An account just gained a sign-in from somewhere else (`adopted`): reload its
/// webview, if it has one, so its page boots with it. In the single arm the
/// switch that follows reloads anyway.
pub fn refresh(app: &AppHandle, host: &Host, key: &str) {
    #[cfg(target_os = "macos")]
    if MULTI_WEBVIEW {
        multi::refresh(app, host, key);
        return;
    }
    let _ = (app, host, key);
}

/// One `WebviewWindow`, rebound.
mod single {
    use super::*;

    pub fn open_at_launch(
        app: &App,
        config: &WindowConfig,
        host: &Host,
        launch: Launch,
    ) -> Result<(), Box<dyn Error>> {
        let slot = launch
            .seats
            .into_iter()
            .nth(launch.shown)
            .unwrap_or(Slot::Pending { origin: None });
        // Registered before it exists, so its first `host_boot` finds a seat.
        host.register(MAIN, slot);
        host.set_shown(MAIN);
        tauri::WebviewWindowBuilder::from_config(app, config)?
            .on_navigation(is_our_own)
            .build()?;
        Ok(())
    }
}

/// One window, one child webview per account.
#[cfg(target_os = "macos")]
mod multi {
    use super::*;
    use tauri::{LogicalPosition, PhysicalSize, Position, Rect, Size};

    /// A child webview for `label`, from `main`'s configuration with the label
    /// swapped in — `from_config` takes the label from the configuration.
    fn builder(config: &WindowConfig, label: &str) -> tauri::webview::WebviewBuilder<tauri::Wry> {
        let mut seat = config.clone();
        seat.label = label.to_string();
        tauri::webview::WebviewBuilder::from_config(&seat)
            .on_navigation(is_our_own)
            .auto_resize()
    }

    /// ⚠ **Hidden at creation cannot be said**: a webview has no visible flag
    /// (`tauri-runtime`'s `WebviewAttributes`). So the window is built hidden, the
    /// shown account's webview is added at full size and the window shown, and
    /// every other account's is added at zero size and hidden — so none flashes on
    /// top of the one somebody is looking at.
    pub fn open_at_launch(
        app: &App,
        config: &WindowConfig,
        host: &Host,
        launch: Launch,
    ) -> Result<(), Box<dyn Error>> {
        let window = tauri::window::WindowBuilder::from_config(app, config)?
            .visible(false)
            .build()?;
        let size = window.inner_size()?;
        let shown = host.next_label();
        let first = launch
            .seats
            .get(launch.shown)
            .cloned()
            .unwrap_or(Slot::Pending { origin: None });
        host.register(&shown, first);
        window.add_child(
            builder(config, &shown),
            LogicalPosition::new(0.0, 0.0),
            size,
        )?;
        host.set_shown(&shown);
        window.show()?;
        for (index, slot) in launch.seats.into_iter().enumerate() {
            if index == launch.shown {
                continue;
            }
            let label = host.next_label();
            host.register(&label, slot);
            match window.add_child(
                builder(config, &label),
                LogicalPosition::new(0.0, 0.0),
                PhysicalSize::new(0, 0),
            ) {
                Ok(webview) => {
                    let _ = webview.hide();
                }
                // Opened lazily by the switch that wants it; a launch is not
                // failed over one account's webview.
                Err(_) => host.unregister(&label),
            }
        }
        if let Some(webview) = app.get_webview(&shown) {
            let _ = webview.set_focus();
        }
        Ok(())
    }

    /// Build a hidden webview for `slot`, and answer its label.
    fn open(app: &AppHandle, host: &Host, slot: Slot) -> Result<String, String> {
        let config = main_config(app).ok_or("tauri.conf.json declares no window labelled main")?;
        let window = app
            .get_window(MAIN)
            .ok_or("the window has already closed")?;
        let label = host.next_label();
        host.register(&label, slot);
        match window.add_child(
            builder(&config, &label),
            LogicalPosition::new(0.0, 0.0),
            PhysicalSize::new(0, 0),
        ) {
            Ok(webview) => {
                let _ = webview.hide();
                Ok(label)
            }
            Err(e) => {
                host.unregister(&label);
                Err(format!("could not open that account: {e}"))
            }
        }
    }

    /// Show `label` and hide every other — **hide first, then show**, so two are
    /// never on screen at once — then give it the window's size and the keyboard.
    fn present(app: &AppHandle, host: &Host, label: &str) -> Result<(), String> {
        let window = app
            .get_window(MAIN)
            .ok_or("the window has already closed")?;
        let target = app
            .get_webview(label)
            .ok_or("that account's webview is gone")?;
        for (other, _) in host.labels() {
            if other != label {
                if let Some(webview) = app.get_webview(&other) {
                    let _ = webview.hide();
                }
            }
        }
        // A seat added at zero size has auto-resize ratios of zero; setting its
        // bounds to the window's is what resets them to the whole window.
        if let Ok(size) = window.inner_size() {
            let _ = target.set_bounds(Rect {
                position: Position::Logical(LogicalPosition::new(0.0, 0.0)),
                size: Size::Physical(size),
            });
        }
        target.show().map_err(|e| e.to_string())?;
        let _ = target.set_focus();
        host.set_shown(label);
        Ok(())
    }

    /// Close a webview and forget its seat. Closing the caller from its own
    /// command leaves that command's answer with nobody to receive it, which is
    /// the point.
    ///
    /// ⚠ **`Webview::close` alone leaves the page running, measured.** It drops
    /// Tauri's wrapper and wry removes the view from its superview, but something
    /// still retains the `WKWebView`, so its page is never closed: in the first
    /// bundled build a signed-out account's page answered its WebSocket 17 s
    /// later, its TCP connections stayed established until the app quit, and every
    /// Add → Cancel left one more WebContent process of about 48 MB. That is a
    /// removed account still talking to its server, which is the one thing Sign
    /// out promises it no longer does. So the view is told `_close` first —
    /// WebKit's own teardown of the page, whoever holds the view — and with it the
    /// socket closed and the process exited at once. The retainer itself was not
    /// traced; this does not depend on finding it.
    fn close(app: &AppHandle, host: &Host, label: &str) {
        if let Some(webview) = app.get_webview(label) {
            end_page(&webview);
            let _ = webview.close();
        }
        host.unregister(label);
    }

    /// Ask WebKit to close the page behind a `WKWebView`, if it answers `_close`.
    ///
    /// A private selector, so it is asked for rather than assumed: a WebKit that
    /// dropped it leaves `close` as it was — the page lives until quit — rather than
    /// crashing on an unrecognised message. Queued on the main thread ahead of the
    /// `close` the caller sends next, which is the order the measurement used.
    fn end_page(webview: &tauri::Webview) {
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{msg_send, sel};
        let _ = webview.with_webview(|platform| {
            let view = platform.inner() as *mut AnyObject;
            // SAFETY: `inner()` is the live WKWebView on the main thread, where
            // this closure runs; both messages are sent to it and nothing else,
            // and `_close` is only sent after the view says it answers it.
            unsafe {
                let answers: Bool = msg_send![view, respondsToSelector: sel!(_close)];
                if answers.as_bool() {
                    let _: () = msg_send![view, _close];
                }
            }
        });
    }

    fn label_for(app: &AppHandle, host: &Host, slot: &Slot) -> Result<String, String> {
        match slot.scope().and_then(|key| host.label_of(&key)) {
            Some(label) => Ok(label),
            None => open(app, host, slot.clone()),
        }
    }

    pub fn switch_to(
        app: &AppHandle,
        host: &Host,
        caller: &str,
        caller_slot: &Slot,
        target: Slot,
    ) -> Result<bool, String> {
        let label = label_for(app, host, &target)?;
        present(app, host, &label)?;
        // A pending caller is an Add account being cancelled: nothing of it is
        // worth keeping, and a webview nobody can reach is a process wasted.
        if matches!(caller_slot, Slot::Pending { .. }) {
            close(app, host, caller);
        }
        Ok(false)
    }

    pub fn add(app: &AppHandle, host: &Host) -> Result<bool, String> {
        let existing = host
            .labels()
            .into_iter()
            .find(|(_, slot)| matches!(slot, Slot::Pending { .. }))
            .map(|(label, _)| label);
        let label = match existing {
            Some(label) => label,
            None => open(app, host, Slot::Pending { origin: None })?,
        };
        present(app, host, &label)?;
        Ok(false)
    }

    pub fn leave(
        app: &AppHandle,
        host: &Host,
        caller: &str,
        next: Option<Slot>,
        fallback: Slot,
    ) -> Result<bool, String> {
        let Some(next) = next else {
            host.move_seat(caller, fallback);
            return Ok(true);
        };
        // A hidden caller — a legacy seat at launch finding its account already
        // open — goes quietly and leaves the screen alone.
        if host.shown().as_deref() == Some(caller) {
            let label = label_for(app, host, &next)?;
            present(app, host, &label)?;
        }
        close(app, host, caller);
        Ok(false)
    }

    pub fn refresh(app: &AppHandle, host: &Host, key: &str) {
        let Some(label) = host.label_of(key) else {
            return;
        };
        let slot = host
            .labels()
            .into_iter()
            .find(|(held, _)| *held == label)
            .map(|(_, slot)| slot);
        if let Some(slot) = slot {
            host.move_seat(&label, slot);
        }
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.reload();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tauri's label alphabet is `a-zA-Z0-9-/:_`, which an account key — `#` and
    /// `.` in every one — is not in; so a seat's label is a counter.
    #[test]
    fn a_seat_label_is_one_tauri_accepts() {
        let roster = config::Roster::default();
        let host = Host::new(std::env::temp_dir(), false, &roster);
        for _ in 0..3 {
            let label = host.next_label();
            assert!(label.starts_with("seat-"));
            assert!(
                label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')),
                "{label}"
            );
        }
    }

    fn account(origin: &str, user: Option<&str>, seen: u64) -> config::Account {
        config::Account {
            origin: origin.into(),
            user: user.map(str::to_string),
            name: None,
            bound: false,
            signed_in: true,
            seen,
            pending_proof: false,
        }
    }

    /// A first run is one pending seat; a computer with accounts opens every one
    /// with the last shown on top; and a server chosen before accounts and never
    /// signed in to opens as the sign-in it was rather than as an account.
    #[test]
    fn a_launch_opens_every_account_with_the_last_one_shown() {
        let first = plan(&config::Roster::default(), Some("https://a.example".into()));
        assert_eq!(
            first,
            Launch {
                seats: vec![Slot::Pending {
                    origin: Some("https://a.example".into())
                }],
                shown: 0
            }
        );

        let roster = config::Roster {
            accounts: vec![
                account("https://a.example", Some("u_a"), 1),
                account("https://a.example", Some("u_b"), 3),
                account("https://b.example", None, 2),
            ],
            current: Some("https://a.example#u_a".into()),
            ..Default::default()
        };
        let launch = plan(&roster, None);
        assert_eq!(launch.seats.len(), 3);
        assert_eq!(launch.shown, 0, "the account the file names as shown last");
        assert_eq!(
            launch.seats[2],
            Slot::Legacy {
                origin: "https://b.example".into()
            }
        );

        let phantom = config::Roster {
            accounts: vec![account("https://b.example", None, 1)],
            pending: Some("https://a.example".into()),
            derived: true,
            ..Default::default()
        };
        let launch = plan(&phantom, Some("https://a.example".into()));
        assert_eq!(launch.seats.len(), 2);
        assert_eq!(
            launch.seats[launch.shown],
            Slot::Pending {
                origin: Some("https://a.example".into())
            }
        );
    }
}
