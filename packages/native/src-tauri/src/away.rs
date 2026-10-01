//! Closing the window puts Reemoat away instead of quitting it, on macOS and Windows, so a
//! stray click never stops the agents or the daemons the app started; quitting is its own
//! act (Q3.697).
//!
//! - macOS: the window hides and the Dock icon brings it back (`RunEvent::Reopen`). The app
//!   menu's Quit, ⌘Q and the Dock's Quit end it.
//! - Windows: the window hides to the notification area. The tray icon brings it back, its
//!   menu's Quit ends it, and launching the app again shows the running one.
//! - Linux and the mobile shells keep the platform's own close.
//!
//! Every quit still ends in `RunEvent::Exit`, where `lib.rs` stops every daemon.

#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::{AppHandle, Manager};
use tauri::{CloseRequestApi, Runtime, Window};

use crate::seats::MAIN;

/// Whether the close button hides the window rather than closing it.
pub const PUTS_AWAY: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// The close button, ⌘W and Alt+F4 on the one window.
pub fn on_close_requested<R: Runtime>(window: &Window<R>, api: &CloseRequestApi) {
    if !PUTS_AWAY || window.label() != MAIN {
        return;
    }
    api.prevent_close();
    // A hidden full-screen window leaves its space black; hiding the app leaves it as ⌘H does.
    #[cfg(target_os = "macos")]
    if window.is_fullscreen().unwrap_or(false) {
        let _ = window.app_handle().hide();
        return;
    }
    let _ = window.hide();
}

/// The Dock icon, the tray icon or a second launch: the window back, in front.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn bring_back<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = main_window(app) else {
        return;
    };
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// macOS's arm builds `main` as a bare window holding a webview per account (`seats.rs`).
#[cfg(target_os = "macos")]
fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<Window<R>> {
    app.get_window(MAIN)
}

#[cfg(target_os = "windows")]
fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<Window<R>> {
    app.get_webview_window(MAIN).map(|window| window.as_ref().window())
}

/// The notification-area icon: a click shows the window, the menu shows it or quits.
#[cfg(target_os = "windows")]
pub fn tray<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "Open Reemoat", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Reemoat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut icon = TrayIconBuilder::with_id(MAIN)
        .tooltip("Reemoat")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => bring_back(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                bring_back(tray.app_handle());
            }
        });
    if let Some(image) = app.default_window_icon() {
        icon = icon.icon(image.clone());
    }
    icon.build(app)?;
    Ok(())
}
