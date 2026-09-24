//! The Reemoat native shell.
//!
//! It draws nothing. The whole user interface is `packages/web`, built once and
//! **embedded in this binary** — which is the point of the exercise: the server
//! this app talks to cannot replace the code running in it.
//!
//! What this process adds is four things the webview cannot do for itself: reach
//! a control plane that answers no CORS, keep a sign-in in the operating system's
//! credential store, open a link in the real browser, and write a file through a
//! save panel. Everything else — the relay, the daemons, the WebSocket, every
//! retry rule — stays in the webview and is the same code the browser client runs.
//!
//! **One window, and a webview per account in it** where the platform allows
//! (`seats.rs`): each account's page is a single-account app, exactly as a browser
//! tab is, and switching is showing another one. **The host decides which account
//! a command is about, by the webview that asked** — its label and the generation
//! its document presents — and never by anything the page sends (`commands.rs`,
//! `accounts.rs`). Q1.651, Q7.149.

mod accounts;
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

/// Where every account's webview is allowed to *navigate*, which is not the same
/// question as where a link may open.
///
/// Only this app's own document. A link in agent output is opened by
/// `host_open_external`, in the browser, with its own allowlist; this refuses the
/// other shape — a script assigning `location.href`, or a form posting away —
/// which would otherwise replace the running app with somebody else's page inside
/// a webview holding an account's credential. `seats.rs` puts it on every webview
/// it builds, and it builds every one.
///
/// The dev server is here because `tauri dev` loads the frontend from Vite, and a
/// rule that only worked in a packaged build is a rule nobody develops against —
/// but it is here *only* in a development build, and that is load-bearing rather
/// than tidy.
///
/// ⚠ **`localhost` and `127.0.0.1` were allowed unconditionally and that was a
/// hole.** A Reemoat control plane on loopback is the ordinary self-hosted shape —
/// `pnpm cp`, a dev stand, a single-box install — and it serves `index.html` at
/// `/`. Unconditionally allowed, a script assigning `location.href` could
/// therefore replace the running app with the *backend's* page, inside the window
/// holding the fleet's credential: the one thing bundling the frontend exists to
/// make impossible. The CSP cannot help — there is no `navigate-to` directive, and
/// neither `form-action` nor `base-uri` constrains a navigation. A local daemon at
/// `127.0.0.1:7887` falls under the same rule; it serves only JSON today, which is
/// luck rather than a boundary.
///
/// `tauri.localhost` stays in every build: it is the *bundle's* own origin on
/// Windows and Android, not a server's.
pub(crate) fn is_our_own(url: &url::Url) -> bool {
    match url.scheme() {
        // macOS and Linux serve the bundle from `tauri://localhost`.
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            // Windows and Android serve the bundle from here. Always this app.
            Some("tauri.localhost") => true,
            // The Vite dev server — and, in a packaged build, somebody else's
            // service. See above.
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

/// ⚠ **The attribute is what makes a mobile build a build rather than a library
/// nobody can start, and it was missing for as long as `main.rs` has claimed the
/// layout was ready.**
///
/// `main.rs` says *"a mobile target does not use this file at all: `tauri ios` /
/// `tauri android` build the library and call `run()` from a generated shim"* —
/// true, and incomplete. The shim reaches this function through symbols the macro
/// emits, and without it the `.so` links, `cargo build` is green, and the APK
/// assembly stops with *"does not include required runtime symbols"*. Measured
/// 2026-09-19: that is exactly where the first Android build in this project's
/// history stopped.
///
/// `mobile` is `tauri-build`'s own cfg alias — `target_os` is `android` or `ios`
/// — so there is nothing to declare and nothing that can disagree with it.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    leave_typing_alone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
        /*
         * ⚠ **A new page load is a new document, and the one place the host can
         * see one start.** `Host::page_loaded` retires the previous document's
         * generation, clears what was handed to it and ends a rebind — so a
         * document from before, revived by Android's Back or a back/forward-cache
         * restore, is refused rather than answered about whichever account the
         * webview holds now (Q5.120).
         *
         * The global hook looks the webview up by label and silently skips one not
         * registered yet (`tauri`'s `manager/webview.rs`), so a webview's very first
         * load may not be seen here. That is safe: a label that has never loaded
         * has never been issued a generation or handed a credential.
         */
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if let Some(host) = webview.try_state::<Host>() {
                    host.page_loaded(webview.label());
                }
            }
        })
        .setup(|app| {
            /*
             * The configuration directory, from Tauri rather than hand-built.
             *
             * ⚠ Never `~/.reemoat`. That is the *daemon's* directory — it holds
             * `reemoat.db`, whose `identity.tunnel_key` is a live secret — and a
             * client writing into it would be a second writer on a tree with an
             * owner.
             */
            let dir = app.path().app_config_dir()?;
            /*
             * ⚠ **Three reads and no write.** `read_server` is the server a first run
             * chose, which is the pending seat's when there is no account at all;
             * `read_accounts` is every account; `read_theme` is the switch's theme,
             * which the window is built in. A file from before accounts has its
             * list derived rather than written: the evidence for its server is one
             * keyring read here, once, and the list reaches the disk only with the
             * first act that changes it.
             */
            let server = config::read_server(&dir);
            let roster = config::read_accounts(&dir, &|origin| credential::read(origin).is_some());
            let theme = config::read_theme(&dir);
            app.manage(Host::new(dir, credential::probe(), &roster));

            /*
             * The window is declared in `tauri.conf.json` with `create: false` and
             * built by `seats.rs`, so every setting stays in the configuration file
             * and that module adds only what a configuration cannot express: a
             * webview per account, and the navigation guard on every one.
             */
            let config = seats::main_config(app.handle())
                .map(|config| seats::themed(&config, theme))
                .ok_or("tauri.conf.json declares no window labelled main")?;
            seats::open_at_launch(app, &config, &roster, server)?;

            /*
             * ⚠ **Every account's daemon, from launch, whether or not its page is
             * alive** (D2). On a thread of its own: starting one runs a login shell
             * for its `PATH`, which is seconds, per root, before a first paint that
             * should not wait for any of it.
             */
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
            /*
             * ⚠ **The daemon dies with the app, and this is the only thing that
             * makes that true.** `Child` does not kill on drop — it detaches — so
             * without this the daemon is orphaned on every quit and keeps running
             * with nothing able to stop it. Measured 2026-09-15: two seconds after
             * the parent exits the child is alive on `ppid 1`, answering `/health`,
             * and it stays that way indefinitely.
             *
             * It is not merely untidy. The orphan keeps its *own* bundle's runtime
             * and sources, so replacing Reemoat.app leaves the old daemon running
             * and announced — the new app finds it alive with a matching
             * `instanceId`, reads `foreign`, and never starts the version it
             * shipped with. Emptying the Trash makes it worse rather than better:
             * the process survives on its inodes while `tsx` still resolves
             * plugin, agent and upload paths lazily, so the first one needed is an
             * `ENOENT` inside a daemon that goes on answering 200.
             *
             * `RunEvent::Exit` rather than a window-close handler, and the
             * reason written here for four releases was wrong.
             *
             * ⚠ It said *"closing the window on macOS is not quitting"*. That is
             * a fact about **AppKit**, which Tauri does not implement: measured
             * in `tauri-runtime-wry`, destroying the last window emits
             * `ExitRequested` and, with nothing calling `prevent_exit()`, sets
             * `ControlFlow::Exit` — on every platform, macOS included. So ⌘W
             * quits this app and takes its daemons with it, which is what
             * Windows and Linux users expect and what a Mac user does not.
             *
             * The code is right either way and the event is still the one to
             * hang this on: it is the single point every quit passes through,
             * whether it came from a window close, the menu, or `AppHandle::exit`.
             * What changes is that the macOS convention — stay running, come back
             * from the dock — is a **deliberate non-goal** beside "no menu bar, no
             * tray" rather than something this comment claimed was already true.
             *
             * ⚠ **Every daemon it started, signalled together and waited on once.**
             * There is one per account (D2, Q7.149), every one runs from launch, and
             * a switch leaves each running — so this is the only place they stop
             * together, and stopping them in turn would make a quit worth one
             * `STOP_DEADLINE` per account. `daemon::stop_all` signals all, then
             * reaps all against one deadline. A root whose supervisor is poisoned
             * is skipped rather than blocking the rest; its child is orphaned, which
             * is the failure this block exists to prevent, for that one only.
             */
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

    /// The dev server, and the rule stated so it holds in **both** profiles.
    ///
    /// Written as an equality against `cfg!` rather than as two `#[cfg]` tests,
    /// because CI runs `cargo test` in debug only (`.github/workflows/check.yml`)
    /// and a release-only test there would assert nothing. This one fails in debug
    /// if the arm is deleted and in release if the `cfg!` is dropped, from one run.
    #[test]
    fn loopback_navigates_only_in_a_development_build() {
        let dev = cfg!(debug_assertions);
        assert_eq!(at("http://localhost:5173/"), dev);
        assert_eq!(at("http://127.0.0.1:5173/"), dev);
        // A control plane and a daemon are the two loopback services this app
        // actually meets, and a packaged build may navigate to neither.
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
