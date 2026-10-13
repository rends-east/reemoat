//! The webviews, and the only file that builds one (Q7.149). macOS: one window, a child webview
//! per account, a switch hides one and shows another; every page shares one `WKWebsiteDataStore`,
//! so `localStorage` is shared. Elsewhere: one `WebviewWindow` rebound and reloaded (tao packs
//! Linux children into a `GtkBox` and ignores their bounds). Every webview is `main`'s config,
//! which carries `dragDropEnabled: false`, with `on_navigation(is_our_own)`. Nothing here holds a
//! `Host` lock across a webview call: the main thread takes `seats` on every page load.

use std::error::Error;

use tauri::utils::config::WindowConfig;
use tauri::window::Color;
use tauri::{App, AppHandle, Manager};

use crate::accounts::Slot;
use crate::commands::Host;
use crate::config::{self, Theme};
use crate::is_our_own;

/// Flipping this is the whole of falling back to the single-webview arm on macOS.
#[cfg(target_os = "macos")]
pub const MULTI_WEBVIEW: bool = true;

pub const MAIN: &str = "main";

pub fn main_config(app: &AppHandle) -> Option<WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN)
        .cloned()
}

/// The page's `--color-ink`, shown before it paints; `nativecheck` holds both to `index.css`.
const LIGHT_INK: Color = Color(0xf9, 0xf8, 0xf6, 0xff);
const DARK_INK: Color = Color(0x11, 0x10, 0x0e, 0xff);

fn ink(theme: Theme) -> Color {
    match theme {
        Theme::Light => LIGHT_INK,
        Theme::Dark => DARK_INK,
    }
}

fn to_tauri(theme: Theme) -> tauri::Theme {
    match theme {
        Theme::Light => tauri::Theme::Light,
        Theme::Dark => tauri::Theme::Dark,
    }
}

fn from_tauri(theme: tauri::Theme) -> Theme {
    match theme {
        tauri::Theme::Dark => Theme::Dark,
        _ => Theme::Light,
    }
}

/// Always a theme: on macOS a window's is app-wide, and with none the system's reaches every page (Q3.671).
pub fn themed(config: &WindowConfig, theme: Theme) -> WindowConfig {
    let mut themed = inked(config, theme);
    themed.theme = Some(to_tauri(theme));
    themed
}

fn theme_in(config: &WindowConfig) -> Theme {
    config.theme.map(from_tauri).unwrap_or(Theme::Light)
}

fn inked(config: &WindowConfig, theme: Theme) -> WindowConfig {
    let mut inked = config.clone();
    inked.background_color = Some(ink(theme));
    inked
}

/// The per-webview half is a no-op on WKWebView, which takes a background only at creation.
fn paint(window: &tauri::Window, theme: Theme) {
    let color = Some(ink(theme));
    let _ = window.set_background_color(color);
    for webview in window.webviews() {
        let _ = webview.set_background_color(color);
    }
}

/// Also on a window just built: tao's Linux window ignores a configured theme. On the window, not
/// app-wide, which leaves the window's theme stale on macOS.
pub fn show_theme(window: &tauri::Window, theme: Theme) {
    let _ = window.set_theme(Some(to_tauri(theme)));
    paint(window, theme);
}

#[derive(Debug, PartialEq, Eq)]
pub struct Launch {
    pub seats: Vec<Slot>,
    pub shown: usize,
}

/// A pending server (chosen, never signed in to) is shown when there is one: that is where the person was.
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

/// Writes nothing. A seat that cannot be built is opened by the switch that wants it.
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

/// Answers whether the page reloads.
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

pub fn add(app: &AppHandle, host: &Host, caller: &str) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    if MULTI_WEBVIEW {
        return multi::add(app, host);
    }
    let _ = app;
    host.move_seat(caller, Slot::Pending { origin: None });
    Ok(true)
}

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

/// After an `adopted` sign-in. The single arm's following switch reloads anyway.
pub fn refresh(app: &AppHandle, host: &Host, key: &str) {
    #[cfg(target_os = "macos")]
    if MULTI_WEBVIEW {
        multi::refresh(app, host, key);
        return;
    }
    let _ = (app, host, key);
}

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
        host.register(MAIN, slot);
        host.set_shown(MAIN);
        let window = tauri::WebviewWindowBuilder::from_config(app, config)?
            .on_navigation(is_our_own)
            .build()?;
        // Still inside `setup` on the main thread, so this lands before the first draw.
        show_theme(&window.as_ref().window(), theme_in(config));
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod multi {
    use super::*;
    use tauri::{LogicalPosition, PhysicalSize, Position, Rect, Size};

    fn builder(config: &WindowConfig, label: &str) -> tauri::webview::WebviewBuilder<tauri::Wry> {
        let mut seat = config.clone();
        seat.label = label.to_string();
        tauri::webview::WebviewBuilder::from_config(&seat)
            .on_navigation(is_our_own)
            .auto_resize()
    }

    /// A webview has no visible flag, so the rest are added at zero size and hidden, after the shown one.
    pub fn open_at_launch(
        app: &App,
        config: &WindowConfig,
        host: &Host,
        launch: Launch,
    ) -> Result<(), Box<dyn Error>> {
        let window = tauri::window::WindowBuilder::from_config(app, config)?
            .visible(false)
            .build()?;
        show_theme(&window, theme_in(config));
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
                Err(_) => host.unregister(&label),
            }
        }
        if let Some(webview) = app.get_webview(&shown) {
            let _ = webview.set_focus();
        }
        Ok(())
    }

    fn open(app: &AppHandle, host: &Host, slot: Slot) -> Result<String, String> {
        let config = main_config(app).ok_or("tauri.conf.json declares no window labelled main")?;
        let window = app
            .get_window(MAIN)
            .ok_or("the window has already closed")?;
        let config = inked(
            &config,
            window.theme().map(from_tauri).unwrap_or(Theme::Light),
        );
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

    /// Hide first, then show, so two are never on screen at once.
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
        // A seat added at zero size has auto-resize ratios of zero until its bounds are set.
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

    /// `Webview::close` alone leaves the page running and talking to its server (measured,
    /// Q7.149), so WebKit's `_close` is sent first.
    fn close(app: &AppHandle, host: &Host, label: &str) {
        if let Some(webview) = app.get_webview(label) {
            end_page(&webview);
            let _ = webview.close();
        }
        host.unregister(label);
    }

    /// A private selector, so asked for rather than assumed. Queued ahead of the caller's `close`.
    fn end_page(webview: &tauri::Webview) {
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{msg_send, sel};
        let _ = webview.with_webview(|platform| {
            let view = platform.inner() as *mut AnyObject;
            // SAFETY: `inner()` is the live WKWebView on the main thread, and `_close` is sent only if it answers.
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
        // A pending caller is a cancelled Add account.
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
        // A hidden caller (a legacy seat whose account is already open) leaves the screen alone.
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

    /// An account key carries `#` and `.`, outside Tauri's label alphabet, so a label is a counter.
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

    #[test]
    fn a_launch_is_built_in_the_theme() {
        let declared = WindowConfig {
            drag_drop_enabled: false,
            ..WindowConfig::default()
        };
        let dark = themed(&declared, Theme::Dark);
        assert_eq!(
            (dark.theme, dark.background_color, theme_in(&dark)),
            (Some(tauri::Theme::Dark), Some(DARK_INK), Theme::Dark)
        );
        let light = themed(&declared, Theme::Light);
        assert_eq!(
            (light.theme, light.background_color, theme_in(&light)),
            (Some(tauri::Theme::Light), Some(LIGHT_INK), Theme::Light)
        );
        assert!(
            !light.drag_drop_enabled,
            "the rest of main's configuration rides along"
        );
        assert_eq!(
            inked(&dark, Theme::Light).theme,
            Some(tauri::Theme::Dark),
            "an ink is not a theme"
        );
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
