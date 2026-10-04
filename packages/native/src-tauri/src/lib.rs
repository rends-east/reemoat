//! The native shell around the embedded `packages/web`. The host decides which account a
//! command is about by the webview that asked, never by what the page sends (Q1.651, Q7.149).

mod accounts;
mod away;
mod commands;
mod config;
mod credential;
mod daemon;
mod device;
mod local;
mod proxy;
mod seats;

use tauri::Manager;

use commands::Host;

/// Where a webview may navigate: only this app's own document. Loopback is the Vite dev
/// server only in debug; in a packaged build it is a self-hosted control plane's page.
pub(crate) fn is_our_own(url: &url::Url) -> bool {
    match url.scheme() {
        // macOS and Linux serve the bundle from `tauri://localhost`.
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            // Windows and Android serve the bundle from here.
            Some("tauri.localhost") => true,
            Some("localhost") | Some("127.0.0.1") => cfg!(debug_assertions),
            _ => false,
        },
        _ => false,
    }
}

/// What WebKit reads, before the system's own switches, to rewrite a keystroke — `"` to
/// `“`, `--` to `—`. Registered, never set, so a person's own toggle still wins (Q3.647).
#[cfg(target_os = "macos")]
const VERBATIM_TYPING: [&std::ffi::CStr; 4] = [
    c"WebAutomaticQuoteSubstitutionEnabled",
    c"WebAutomaticDashSubstitutionEnabled",
    c"WebAutomaticTextReplacementEnabled",
    c"WebAutomaticSpellingCorrectionEnabled",
];

/// Before the first webview: the web process is handed the state when it starts.
#[cfg(target_os = "macos")]
fn leave_typing_alone() {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    autoreleasepool(|_| {
        // SAFETY: Foundation class messages with arguments of their declared types; every
        // object lives inside this pool, and `registerDefaults:` copies what it is given.
        unsafe {
            let off: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: Bool::NO];
            let mut keys: Vec<*mut AnyObject> = Vec::with_capacity(VERBATIM_TYPING.len());
            for key in VERBATIM_TYPING {
                keys.push(msg_send![class!(NSString), stringWithUTF8String: key.as_ptr()]);
            }
            let values = vec![off; keys.len()];
            let table: *mut AnyObject = msg_send![
                class!(NSDictionary),
                dictionaryWithObjects: values.as_ptr(),
                forKeys: keys.as_ptr(),
                count: keys.len()
            ];
            let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
            let _: () = msg_send![defaults, registerDefaults: table];
        }
    });
}

/// Without the attribute the mobile `.so` still links and the APK fails on missing runtime symbols.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    leave_typing_alone();
    let builder = tauri::Builder::default();
    // First of the plugins, as it asks: a second launch shows the running app rather than starting another (Q3.697).
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        away::bring_back(app)
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::host_boot,
            commands::host_local_daemon,
            commands::host_daemon_state,
            commands::host_daemon_start,
            commands::host_daemon_stop,
            commands::host_daemon_log,
            commands::host_set_server,
            commands::host_credential_set,
            commands::host_credential_clear,
            commands::host_device_set,
            commands::host_device_clear,
            commands::host_device_dh,
            commands::host_device_key_reset,
            commands::host_accounts,
            commands::host_account_switch,
            commands::host_account_add,
            commands::host_account_forget,
            commands::host_account_confirm,
            commands::host_cp,
            commands::host_copy_text,
            commands::host_open_external,
            commands::host_save_file,
            commands::host_pick_folder,
            commands::host_set_theme,
        ])
        // A page load retires the previous document's generation, so a revived one is refused (Q5.120).
        // A webview's first load may be missed here, which is safe: it holds no generation yet.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                away::on_close_requested(window, api);
            }
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if let Some(host) = webview.try_state::<Host>() {
                    host.page_loaded(webview.label());
                }
            }
        })
        .setup(|app| {
            // Never `~/.reemoat`, which is the daemon's.
            let dir = app.path().app_config_dir()?;
            // Reads only; nothing is written at startup.
            let server = config::read_server(&dir);
            let roster = config::read_accounts(&dir, &|origin| credential::read(origin).is_some());
            let theme = config::read_theme(&dir);
            app.manage(Host::new(dir, credential::probe(), &roster));

            // `create: false` in `tauri.conf.json`; `seats.rs` builds it to add the navigation guard.
            let config = seats::main_config(app.handle())
                .map(|config| seats::themed(&config, theme))
                .ok_or("tauri.conf.json declares no window labelled main")?;
            seats::open_at_launch(app, &config, &roster, server)?;
            #[cfg(target_os = "windows")]
            away::tray(app)?;

            // Every account's daemon, page alive or not; off-thread, since a login shell takes seconds per root.
            if commands::CAN_HOST_DAEMON {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let host = handle.state::<Host>();
                    let Ok(home) = handle.path().home_dir() else {
                        return;
                    };
                    let Some(payload) = daemon::Payload::locate(
                        &commands::resource_dir(&handle),
                        &commands::exe_path(),
                    ) else {
                        return;
                    };
                    let roots = host.launch_roots(&home, &roster);
                    // Called under the root lock, so an account removed since launch is skipped.
                    daemon::start_configured_at_launch(&payload, &home, &roots, &|root| {
                        if !host.lists_root(&home, root) {
                            return None;
                        }
                        host.supervisor_for(root).ok()
                    });
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Reemoat shell could not start")
        .run(|handle, event| {
            // `Child` detaches on drop, so this is the only thing that stops the daemons; `Exit` is
            // the one point every quit passes through (Q6.108, Q3.697). Signalled together, one deadline.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    away::bring_back(handle);
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(host) = handle.try_state::<commands::Host>() {
                    if let Ok(supervisors) = host.supervisors.lock() {
                        let mut held: Vec<_> = supervisors
                            .values()
                            .filter_map(|one| one.lock().ok())
                            .collect();
                        daemon::stop_all(held.iter_mut().map(|guard| &mut **guard));
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::is_our_own;
    use url::Url;

    fn at(raw: &str) -> bool {
        is_our_own(&Url::parse(raw).unwrap())
    }

    #[test]
    fn our_own_document_navigates() {
        assert!(at("tauri://localhost/"));
        assert!(at("tauri://localhost/m/m_ab12/s/s_cd34"));
        assert!(at("http://tauri.localhost/settings"));
    }

    /// An equality against `cfg!` rather than two `#[cfg]` tests, because CI tests debug only.
    #[test]
    fn loopback_navigates_only_in_a_development_build() {
        let dev = cfg!(debug_assertions);
        assert_eq!(at("http://localhost:5173/"), dev);
        assert_eq!(at("http://127.0.0.1:5173/"), dev);
        assert_eq!(at("http://127.0.0.1:7888/"), dev);
        assert_eq!(at("http://127.0.0.1:7887/sessions"), dev);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_keystroke_is_left_as_typed() {
        use objc2::rc::autoreleasepool;
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{class, msg_send};
        super::leave_typing_alone();
        for key in super::VERBATIM_TYPING {
            // SAFETY: as in `leave_typing_alone`, reading where it registers.
            let (held, on) = autoreleasepool(|_| unsafe {
                let defaults: *mut AnyObject =
                    msg_send![class!(NSUserDefaults), standardUserDefaults];
                let name: *mut AnyObject =
                    msg_send![class!(NSString), stringWithUTF8String: key.as_ptr()];
                let held: *mut AnyObject = msg_send![defaults, objectForKey: name];
                let on: Bool = msg_send![defaults, boolForKey: name];
                (!held.is_null(), on.as_bool())
            });
            assert_eq!((held, on), (true, false), "{key:?} is registered, and off");
        }
    }

    #[test]
    fn nothing_else_does() {
        for raw in [
            "https://evil.example/",
            "http://evil.example/",
            "file:///etc/passwd",
            "mailto:someone@example.com",
            "https://localhost.evil.example/",
        ] {
            assert!(!at(raw), "{raw} should not navigate this window");
        }
    }
}
