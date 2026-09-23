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

mod commands;
mod config;
mod credential;
mod daemon;
mod device;
mod local;
mod proxy;

use std::collections::BTreeMap;
use std::sync::Mutex;

use tauri::Manager;

use commands::Host;

/// Where the window is allowed to *navigate*, which is not the same question as
/// where a link may open.
///
/// Only this app's own document. A link in agent output is opened by
/// `host_open_external`, in the browser, with its own allowlist; this refuses the
/// other shape — a script assigning `location.href`, or a form posting away —
/// which would otherwise replace the running app with somebody else's page inside
/// a window holding the fleet's credential.
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
fn is_our_own(url: &url::Url) -> bool {
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
            commands::host_cp,
            commands::host_copy_text,
            commands::host_open_external,
            commands::host_save_file,
            commands::host_pick_folder,
        ])
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
            let server = config::read_server(&dir);
            app.manage(Host {
                server: Mutex::new(server),
                client: proxy::client(),
                config_dir: dir,
                durable: credential::probe(),
                supervisors: Mutex::new(BTreeMap::new()),
            });

            /*
             * The window is declared in `tauri.conf.json` with `create: false` and
             * built here, so every setting stays in the configuration file and
             * this adds only the one thing a configuration cannot express.
             */
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or("tauri.conf.json declares no window labelled main")?;
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .on_navigation(is_our_own)
                .build()?;
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
             * There is one per server this app has opened (Q7.148), and a server
             * change leaves the previous one running — so this is the only place
             * they stop, and stopping them in turn would make a quit worth one
             * `STOP_DEADLINE` per server. `daemon::stop_all` signals all, then
             * reaps all against one deadline. A server whose supervisor is poisoned
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
