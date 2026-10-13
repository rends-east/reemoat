//! Everything the webview may ask this process to do. An app-defined command is not ACL-gated,
//! so this file is the capability surface; `nativecheck` holds it to what `native.ts` calls.
//!
//! The host decides which account a command is about, from the calling webview's label and the
//! generation its document presents (Q1.651, Q5.120); a stale document is refused
//! `stale_document`. Hidden webviews are refused `not_shown` for anything that surfaces.
//!
//! Lock rule: no `Host` mutex but `changing` is held across a `Window` or `Webview` call, and the
//! main thread never takes `changing` (it runs `on_page_load`, which takes `seats`).
//!
//! A bare `#[tauri::command]` runs on the main thread. Anything that waits (a socket, a disk
//! flush, a platform panel, a child process, a webview change) or sits on a hot path carries
//! `(async)`; only `host_copy_text` and `host_open_external` are bare. Nothing flags a lost `(async)`.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FsExt, OpenOptions};
use tauri_plugin_opener::OpenerExt;

use crate::accounts::{self, Binding, Decision, Slot, Token};
use crate::config::{self, Evidence};
use crate::credential;
use crate::daemon;
use crate::device::{self, DeviceKey};
use crate::local::{self, LocalDaemon};
use crate::proxy::{self, CpAnswer, CpRequest};
use crate::seats;

const GENERATION_HEADER: &str = "reemoat-generation";

/// The page matches the prefix and reloads.
fn stale() -> String {
    "stale_document: this page was opened for another account, or before this app last changed accounts".into()
}

fn pending_seat(why: &str) -> String {
    format!("pending_seat: {why}")
}

pub struct Host {
    pub client: reqwest::Client,
    pub config_dir: std::path::PathBuf,
    pub durable: bool,
    /// Keyed by root, so a legacy seat and the account it becomes share one. A lock per root, because
    /// a stop holds its supervisor up to `STOP_DEADLINE` and must not stall every account (Q7.148).
    pub supervisors: Mutex<BTreeMap<String, Arc<Mutex<daemon::Supervisor>>>>,
    seats: Mutex<BTreeMap<String, Seat>>,
    shown: Mutex<Option<String>>,
    /// One account change at a time; the only lock held across a webview call, never on the main thread.
    changing: Mutex<()>,
    /// The launch's keyring answer per origin of a pre-accounts file, so it is not asked again.
    evidence: Mutex<BTreeMap<String, bool>>,
    holder: Mutex<Option<String>>,
    /// This and the methods marked alike serve the macOS multi-webview arm; allowed rather than
    /// `cfg`'d away, so every target compiles the same `Host`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    next_seat: AtomicU64,
}

#[derive(Clone, Debug)]
struct Seat {
    slot: Slot,
    generation: Option<String>,
    handed: bool,
    rebinding: bool,
}

struct BootSeat {
    slot: Slot,
    generation: Option<String>,
    hand: bool,
    rebinding: bool,
}

impl Host {
    pub fn new(config_dir: std::path::PathBuf, durable: bool, roster: &config::Roster) -> Host {
        let evidence = if roster.derived {
            roster
                .accounts
                .iter()
                .map(|account| (account.origin.clone(), account.signed_in))
                .collect()
        } else {
            BTreeMap::new()
        };
        Host {
            client: proxy::client(),
            config_dir,
            durable,
            supervisors: Mutex::new(BTreeMap::new()),
            seats: Mutex::new(BTreeMap::new()),
            shown: Mutex::new(None),
            changing: Mutex::new(()),
            evidence: Mutex::new(evidence),
            holder: Mutex::new(roster.legacy_root_holder.clone()),
            next_seat: AtomicU64::new(0),
        }
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn next_label(&self) -> String {
        format!("seat-{}", self.next_seat.fetch_add(1, Ordering::Relaxed))
    }

    /// Before the webview is built, so its first `host_boot` finds a seat.
    pub fn register(&self, label: &str, slot: Slot) {
        if let Ok(mut seats) = self.seats.lock() {
            seats.insert(
                label.to_string(),
                Seat {
                    slot,
                    generation: None,
                    handed: false,
                    rebinding: false,
                },
            );
        }
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn unregister(&self, label: &str) {
        if let Ok(mut seats) = self.seats.lock() {
            seats.remove(label);
        }
        if let Ok(mut shown) = self.shown.lock() {
            if shown.as_deref() == Some(label) {
                *shown = None;
            }
        }
    }

    pub fn set_shown(&self, label: &str) {
        if let Ok(mut shown) = self.shown.lock() {
            *shown = Some(label.to_string());
        }
    }

    pub fn shown(&self) -> Option<String> {
        self.shown.lock().ok().and_then(|held| held.clone())
    }

    /// Copied out, for callers about to make webview calls.
    pub fn labels(&self) -> Vec<(String, Slot)> {
        self.seats
            .lock()
            .map(|seats| {
                seats
                    .iter()
                    .map(|(label, seat)| (label.clone(), seat.slot.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn label_of(&self, key: &str) -> Option<String> {
        self.labels()
            .into_iter()
            .find(|(_, slot)| slot.scope().as_deref() == Some(key))
            .map(|(label, _)| label)
    }

    /// On the main thread (`on_page_load`): takes `seats` briefly and never `changing`.
    pub fn page_loaded(&self, label: &str) {
        if let Ok(mut seats) = self.seats.lock() {
            if let Some(seat) = seats.get_mut(label) {
                seat.generation = None;
                seat.handed = false;
                seat.rebinding = false;
            }
        }
    }

    /// Plain equality is enough: the generation binds a document, it does not authenticate one.
    fn seat(
        &self,
        webview: &tauri::Webview,
        request: &tauri::ipc::Request<'_>,
    ) -> Result<(String, Slot), String> {
        let label = webview.label().to_string();
        let sent = request
            .headers()
            .get(GENERATION_HEADER)
            .and_then(|value| value.to_str().ok());
        let seats = self.seats.lock().map_err(|_| stale())?;
        let seat = seats.get(&label).ok_or_else(stale)?;
        match (&seat.generation, sent) {
            (Some(held), Some(sent)) if !seat.rebinding && held == sent => {
                Ok((label, seat.slot.clone()))
            }
            _ => Err(stale()),
        }
    }

    /// The credential is handed at most once per page load.
    fn boot(&self, label: &str) -> Option<BootSeat> {
        let mut seats = self.seats.lock().ok()?;
        let seat = seats.get_mut(label)?;
        if seat.rebinding {
            return Some(BootSeat {
                slot: seat.slot.clone(),
                generation: None,
                hand: false,
                rebinding: true,
            });
        }
        let generation = seat.generation.get_or_insert_with(new_generation).clone();
        let hand = !seat.handed;
        seat.handed = true;
        Some(BootSeat {
            slot: seat.slot.clone(),
            generation: Some(generation),
            hand,
            rebinding: false,
        })
    }

    /// The same document becoming more of an account; it keeps its generation.
    fn seat_as(&self, label: &str, slot: Slot) {
        if let Ok(mut seats) = self.seats.lock() {
            if let Some(seat) = seats.get_mut(label) {
                seat.slot = slot;
                seat.handed = true;
            }
        }
    }

    /// A different account: the document is stale from this instant.
    pub fn move_seat(&self, label: &str, slot: Slot) {
        if let Ok(mut seats) = self.seats.lock() {
            if let Some(seat) = seats.get_mut(label) {
                seat.slot = slot;
                seat.generation = None;
                seat.handed = false;
                seat.rebinding = true;
            }
        }
    }

    /// Re-checked once `changing` is held.
    fn still(&self, label: &str, slot: &Slot) -> Result<(), String> {
        let seats = self.seats.lock().map_err(|_| stale())?;
        match seats.get(label) {
            Some(seat) if !seat.rebinding && seat.slot == *slot => Ok(()),
            _ => Err(stale()),
        }
    }

    fn require_shown(&self, label: &str) -> Result<(), String> {
        if self.shown().as_deref() == Some(label) {
            Ok(())
        } else {
            Err("not_shown: only the account on screen can do that".into())
        }
    }

    fn lock_changing(&self) -> MutexGuard<'_, ()> {
        self.changing
            .lock()
            .unwrap_or_else(|held| held.into_inner())
    }

    pub fn roster(&self) -> config::Roster {
        config::read_accounts(&self.config_dir, &|origin| self.known(origin))
    }

    fn known(&self, origin: &str) -> bool {
        self.evidence
            .lock()
            .map(|held| held.get(origin).copied().unwrap_or(false))
            .unwrap_or(false)
    }

    /// A derived list is written down before the first act that changes it.
    fn materialize(&self) -> Result<(), String> {
        config::materialize_accounts(&self.config_dir, &|origin| self.known(origin))
    }

    fn refresh_owners(&self) {
        let roots = self.roster().roots;
        if let Ok(mut seats) = self.seats.lock() {
            for seat in seats.values_mut() {
                if let Slot::Account {
                    origin,
                    user,
                    owner,
                } = &mut seat.slot
                {
                    *owner = roots.get(origin.as_str()).map(String::as_str) == Some(user.as_str());
                }
            }
        }
    }

    pub fn holder(&self) -> Option<String> {
        self.holder.lock().ok().and_then(|held| held.clone())
    }

    fn set_holder(&self, origin: &str) {
        if let Ok(mut held) = self.holder.lock() {
            held.get_or_insert_with(|| origin.to_string());
        }
    }

    pub fn supervisor_for(
        &self,
        root: &daemon::StateRoot,
    ) -> Result<Arc<Mutex<daemon::Supervisor>>, String> {
        let mut held = self
            .supervisors
            .lock()
            .map_err(|_| "the supervisor is poisoned".to_string())?;
        Ok(Arc::clone(
            held.entry(root.dir.to_string_lossy().into_owned())
                .or_default(),
        ))
    }

    fn supervisor_if(&self, root: &daemon::StateRoot) -> Option<Arc<Mutex<daemon::Supervisor>>> {
        self.supervisors.lock().ok().and_then(|held| {
            held.get(root.dir.to_string_lossy().as_ref())
                .map(Arc::clone)
        })
    }

    pub fn launch_roots(
        &self,
        home: &std::path::Path,
        roster: &config::Roster,
    ) -> Vec<(daemon::StateRoot, String)> {
        let holder = self.holder();
        roster
            .accounts
            .iter()
            .filter_map(|account| {
                let slot = Slot::from_account(account, &roster.roots);
                Some((slot.root(home, holder.as_deref())?, account.origin.clone()))
            })
            .collect()
    }

    /// Asked under `daemon::lock_roots` before every spawn, which a forget also takes.
    pub fn lists_root(&self, home: &std::path::Path, root: &daemon::StateRoot) -> bool {
        let roster = self.roster();
        let holder = self.holder();
        roster.accounts.iter().any(|account| {
            Slot::from_account(account, &roster.roots)
                .root(home, holder.as_deref())
                .is_some_and(|mapped| mapped.dir == root.dir)
        })
    }
}

/// Falls back to the clock and a counter rather than refuse to boot: only uniqueness is asked of it.
fn new_generation() -> String {
    static FALLBACK: AtomicU64 = AtomicU64::new(0);
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        let count = FALLBACK.fetch_add(1, Ordering::Relaxed);
        return format!("{nanos:x}{count:x}");
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Separate from `host_local_daemon`, which answers `None` to every failure; this one must not
/// hide a daemon this app started that exited. About the calling account's root; a pending seat
/// is `absent`. `foreign` is adopted, never raced. `(async)`: a poll, and the `foreign` branch
/// probes `/health` on every tick.
#[tauri::command(async)]
pub fn host_daemon_state(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<daemon::DaemonState, String> {
    let (_, slot) = host.seat(&webview, &request)?;
    Ok(daemon_state(&app, &host, &slot))
}

fn daemon_state(app: &AppHandle, host: &Host, slot: &Slot) -> daemon::DaemonState {
    let unknown = |status: &str| daemon::DaemonState {
        status: status.to_string(),
        ..Default::default()
    };
    let Ok(home) = app.path().home_dir() else {
        return unknown("unsupported");
    };
    if daemon::Payload::locate(&resource_dir(app), &exe_path()).is_none() {
        return unknown("unsupported");
    }
    let (Some(origin), Some(scope)) = (slot.origin().map(str::to_string), slot.scope()) else {
        return unknown("absent");
    };
    let Some(root) = slot.root(&home, host.holder().as_deref()) else {
        return unknown("absent");
    };

    let announced = local::read_announced(&root.dir);
    // Read here: only the host knows the account.
    let claimed = daemon::read_claim(&host.config_dir, &scope);
    // On every read: a store that cannot see an existing env file buys a second machine.
    let config = daemon::config_state(&root.dir, Some(&origin)).to_string();
    let Ok(handle) = host.supervisor_for(&root) else {
        return daemon::DaemonState {
            status: "absent".to_string(),
            claimed,
            config,
            ..Default::default()
        };
    };
    let Ok(mut supervisor) = handle.lock() else {
        return daemon::DaemonState {
            status: "absent".to_string(),
            claimed,
            config,
            ..Default::default()
        };
    };
    let ours = supervisor.owns_running();
    // An announce survives an unclean stop, and its port may be anybody's: `/health` proves the
    // daemon by `instanceId`. Believing a stale one answers `foreign`, and nothing starts again.
    let announced = announced
        .filter(|found| ours || daemon::is_alive(&found.daemon.base, &found.daemon.instance_id));
    // `~/.reemoat` is last-writer-wins, so another fleet's daemon may answer there.
    let stranger = announced
        .as_ref()
        .is_some_and(|found| found.for_another_server(&origin));

    let mut state = match (announced, ours) {
        (Some(found), true) => daemon::DaemonState {
            status: "running".to_string(),
            machine_id: Some(found.daemon.machine_id),
            claimed,
            ..Default::default()
        },
        (Some(found), false) => daemon::DaemonState {
            status: "foreign".to_string(),
            machine_id: Some(found.daemon.machine_id),
            claimed,
            ..Default::default()
        },
        (None, true) => daemon::DaemonState {
            status: "starting".to_string(),
            claimed,
            ..Default::default()
        },
        (None, false) => {
            let exit_code = supervisor.exit_code();
            daemon::DaemonState {
                exit_code,
                // This poll asks the ring for a bit, never its contents (Q7.140).
                status: if supervisor.printed_anything() {
                    "exited"
                } else {
                    "absent"
                }
                .to_string(),
                machine_id: None,
                claimed,
                ..Default::default()
            }
        }
    };
    state.config = config;
    state.stranger = stranger;
    state
}

/// A code provisions, writing this host's own origin and keeping keys it does not own; no code
/// adopts a file naming this server; a file naming another is refused (Q7.148, Q7.149).
/// `lock_roots` is held from the root's choice to the start, so two servers cannot both take an
/// empty `~/.reemoat`.
#[tauri::command(async)]
pub fn host_daemon_start(
    enroll_code: String,
    machine_id: String,
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<daemon::DaemonState, String> {
    let (_, slot) = host.seat(&webview, &request)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "no home directory".to_string())?;
    let payload = daemon::Payload::locate(&resource_dir(&app), &exe_path())
        .ok_or_else(|| "this build carries no daemon".to_string())?;

    // No account, no root: nothing to adopt either.
    let (Some(origin), Some(scope)) = (slot.origin().map(str::to_string), slot.scope()) else {
        return Err(pending_seat("no account has been signed in to yet"));
    };
    let _roots = daemon::lock_roots();
    let root = slot
        .root(&home, host.holder().as_deref())
        .ok_or_else(|| pending_seat("no account has been signed in to yet"))?;
    if !host.lists_root(&home, &root) {
        return Err(pending_seat("this account is no longer on this computer"));
    }
    let env_file = root.env_file();
    if daemon::config_state(&root.dir, Some(&origin)) == daemon::CONFIG_ELSEWHERE {
        return Err(format!(
            "{} on this computer is set up for a different Reemoat server, so this one was left alone.",
            env_file.display()
        ));
    }

    if !enroll_code.is_empty() && !daemon::is_writable_value(&enroll_code) {
        return Err("that enrollment code is not a shape this can write down".into());
    }
    if !machine_id.is_empty() && !daemon::is_writable_value(&machine_id) {
        return Err("that machine id is not a shape this can write down".into());
    }

    // Before the env file: a machine row is never given back, so a failed write must not lose the claim.
    if !machine_id.is_empty() {
        daemon::write_claim(&host.config_dir, &scope, &machine_id)?;
    }

    // A unit would respawn on the rewritten file and race this child for the single-use code.
    // Only the legacy root: it is the only file a unit can source.
    if root.legacy && !enroll_code.is_empty() && env_file.exists() {
        if let Some(unit) = daemon::managed_unit(&home) {
            return Err(daemon::managed_unit_detail(&unit));
        }
    }

    if !enroll_code.is_empty() {
        // The host's own origin, never the server's `controlPlaneUrl`: another spelling would
        // make `config_state` refuse this file as `elsewhere` on the next launch.
        let control_plane = origin.clone();
        // Before the env file, so no other origin is handed the same empty root.
        if root.legacy && daemon::config_state(&root.dir, Some(&origin)) != daemon::CONFIG_HERE {
            config::set_legacy_root_holder(&host.config_dir, &origin)?;
            host.set_holder(&origin);
        }
        daemon::ensure_root(&home, &root)?;
        // A rewrite: a replacement would delete hand-added lines such as a private CA path.
        let text = match std::fs::read_to_string(&env_file) {
            Ok(existing) => daemon::env_rewritten(&existing, &control_plane, &enroll_code),
            Err(_) => daemon::env_contents(&control_plane, &enroll_code),
        };
        write_private(&env_file, &text)?;
    } else if !env_file.exists() {
        return Err(
            "a control plane and an enrollment code are needed to set this machine up".into(),
        );
    }

    let text = std::fs::read_to_string(&env_file)
        .map_err(|e| format!("could not read {}: {e}", env_file.display()))?;
    let env = daemon::parse_env(&text);
    // Root, server and port go on the spawn, never into the file (`daemon::Spawn`).
    let spawn = daemon::Spawn {
        root: root.dir.clone(),
        control_plane: origin.clone(),
        ephemeral_port: !root.legacy,
    };
    host.supervisor_for(&root)?
        .lock()
        .map_err(|_| "the supervisor is poisoned".to_string())?
        .start(&payload, &home, &env, &spawn)?;
    Ok(daemon::DaemonState {
        status: "starting".to_string(),
        claimed: if machine_id.is_empty() {
            None
        } else {
            Some(machine_id)
        },
        config: daemon::CONFIG_HERE.to_string(),
        ..Default::default()
    })
}

/// This account's daemon only. `(async)`: the stop waits up to `STOP_DEADLINE`.
#[tauri::command(async)]
pub fn host_daemon_stop(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<(), String> {
    let (_, slot) = host.seat(&webview, &request)?;
    let Ok(home) = app.path().home_dir() else {
        return Ok(());
    };
    let Some(handle) = slot
        .root(&home, host.holder().as_deref())
        .and_then(|root| host.supervisor_if(&root))
    else {
        return Ok(());
    };
    handle
        .lock()
        .map_err(|_| "the supervisor is poisoned".to_string())?
        .stop();
    Ok(())
}

/// Its own command, so the log never rides `host_daemon_state`'s poll. Never `Err`: every reason
/// there is nothing to show is an empty list. `(async)`: which ring is asked of the disk.
#[tauri::command(async)]
pub fn host_daemon_log(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Vec<String> {
    let Ok((_, slot)) = host.seat(&webview, &request) else {
        return Vec::new();
    };
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let Some(handle) = slot
        .root(&home, host.holder().as_deref())
        .and_then(|root| host.supervisor_if(&root))
    else {
        return Vec::new();
    };
    // A poisoned lock costs the evidence, never the app.
    let Ok(supervisor) = handle.lock() else {
        return Vec::new();
    };
    supervisor.log_lines()
}

/// `0600` in a `0700` directory: the enrollment code is a machine identity until redeemed.
/// `config::temp_name` because concurrent starts must not share a temporary path.
fn write_private(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    // A temporary created at `0600`, flushed and renamed: `fs::write` truncates first (a crash
    // leaves no `REEMOAT_CONTROL_PLANE`, read as `elsewhere`) and its mode lands after the bytes.
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no directory", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("daemon.env");
    let tmp = dir.join(config::temp_name(name));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    if let Err(e) = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
    {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("could not write {}: {e}", tmp.display()));
    }
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not write {}: {e}", path.display())
    })?;
    // `sync_all` covered the bytes; this is the directory entry. Best effort (`config::sync_dir`).
    let _ = config::sync_dir(dir);
    Ok(())
}

pub(crate) fn resource_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

pub(crate) fn exe_path() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// The same condition as `pick_folder`'s `#[cfg]`, written twice; `nativecheck` compares them.
pub const PICKS_FOLDER: bool = cfg!(not(any(target_os = "android", target_os = "ios")));

/// Declared rather than inferred from `"unsupported"`, which is about the bundle, not the platform.
/// A separate constant from `PICKS_FOLDER`: they answer different questions.
pub const CAN_HOST_DAEMON: bool = cfg!(not(any(target_os = "android", target_os = "ios")));

/// No `rename_all`: every camelCase field carries its own `rename`, which `nativecheck` compares.
#[derive(Serialize)]
pub struct Boot {
    pub server: Option<String>,
    /// Once per page load, and only this seat's. Not kept in Rust alone: `cpFetch` compares it by identity.
    pub credential: Option<String>,
    pub platform: String,
    /// Names the machine; `platform` is `"macos"` on every Mac and would collide.
    #[serde(rename = "hostName")]
    pub host_name: Option<String>,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    pub durable: bool,
    /// Without its `rename` the page would register a new device on every launch.
    #[serde(rename = "deviceId")]
    pub device_id: Option<String>,
    /// Flat rather than a nested `deviceKey`: the census reads top-level fields only.
    #[serde(rename = "devicePublicKey")]
    pub device_public_key: Option<String>,
    #[serde(rename = "deviceKeyAtRest")]
    pub device_key_at_rest: Option<String>,
    #[serde(rename = "picksFolder")]
    pub picks_folder: bool,
    #[serde(rename = "canHostDaemon")]
    pub can_host_daemon: bool,
    /// A suggestion for the field, never `server`, and never written down (Q4.121).
    #[serde(rename = "defaultServer")]
    pub default_server: Option<String>,
    /// Seeds `localMachineId` on a cold launch, when no daemon has announced yet (Q7.139).
    pub claimed: Option<String>,
    /// Sent back only to name a switch target; the host believes it for nothing else (Q1.651).
    pub account: Option<String>,
    pub name: Option<String>,
    /// Also an account whose bare items wait on an unreachable proof; the page confirms either way.
    pub legacy: bool,
    #[serde(rename = "deviceBound")]
    pub device_bound: bool,
    pub generation: Option<String>,
    /// The page retries: on Android the page-load event can trail the new document's first call.
    pub rebinding: bool,
}

/// `outcome`: `bound`, `adopted`, `existing`, `refused` or `unchanged`. Device fields are `None`
/// for every outcome that moves the page elsewhere.
#[derive(Serialize)]
pub struct Bound {
    pub outcome: String,
    pub account: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "deviceId")]
    pub device_id: Option<String>,
    #[serde(rename = "devicePublicKey")]
    pub device_public_key: Option<String>,
    #[serde(rename = "deviceKeyAtRest")]
    pub device_key_at_rest: Option<String>,
}

impl Bound {
    fn elsewhere(outcome: &str, account: Option<String>, name: Option<String>) -> Bound {
        Bound {
            outcome: outcome.to_string(),
            account,
            name,
            device_id: None,
            device_public_key: None,
            device_key_at_rest: None,
        }
    }
}

/// Never a credential.
#[derive(Serialize)]
pub struct AccountSummary {
    pub key: String,
    pub origin: String,
    pub name: Option<String>,
    pub current: bool,
    /// The persisted flag: `host_accounts` reads no keyring.
    #[serde(rename = "signedIn")]
    pub signed_in: bool,
}

#[derive(Serialize)]
pub struct AccountList {
    pub accounts: Vec<AccountSummary>,
    #[serde(rename = "canAdd")]
    pub can_add: bool,
    /// Read live: a desktop webview's boot snapshot outlives later adds and removes.
    pub back: Option<String>,
}

/// Renamed so the payload census has a rename to read here.
#[derive(Serialize)]
pub struct AccountMove {
    #[serde(rename = "reload")]
    pub reload_page: bool,
}

/// The one command without a generation, and the one that issues it. `(async)`: every webview boots at launch.
#[tauri::command(async)]
pub fn host_boot(app: AppHandle, webview: tauri::Webview, host: State<'_, Host>) -> Boot {
    let seat = host.boot(webview.label()).unwrap_or(BootSeat {
        // A label with no seat is one being built.
        slot: Slot::Pending { origin: None },
        generation: None,
        hand: false,
        rebinding: true,
    });
    // While rebinding there is no generation and no credential (`hand` is false).
    let server = seat.slot.origin().map(str::to_string);
    let scope = seat.slot.scope();
    let credential = scope
        .as_deref()
        .filter(|_| seat.hand)
        .and_then(credential::read);
    let roster = host.roster();
    let entry = scope
        .as_deref()
        .and_then(|scope| roster.find(scope))
        .cloned();
    // Corrects the drawer's persisted flag where the keyring lost a sign-in.
    if seat.hand && !roster.derived {
        if let (Some(scope), Some(entry)) = (scope.as_deref(), entry.as_ref()) {
            if entry.signed_in != credential.is_some() {
                let _ = config::set_signed_in(&host.config_dir, scope, credential.is_some());
            }
        }
    }
    let device_id = scope
        .as_deref()
        .and_then(|scope| config::read_device(&host.config_dir, scope));
    // A legacy seat's key is only read (`device::existing_key`).
    let device_key = match &seat.slot {
        Slot::Account { .. } => scope
            .as_deref()
            .and_then(|scope| device::ensure_key(&host.config_dir, scope).ok()),
        Slot::Legacy { .. } => scope
            .as_deref()
            .and_then(|scope| device::existing_key(&host.config_dir, scope)),
        Slot::Pending { .. } => None,
    };
    // A file read, never a probe: identity, not reachability.
    let claimed = scope
        .as_deref()
        .and_then(|scope| daemon::read_claim(&host.config_dir, scope));
    let account = match &seat.slot {
        Slot::Account { .. } => scope.clone(),
        _ => None,
    };
    let legacy = matches!(seat.slot, Slot::Legacy { .. })
        || entry.as_ref().is_some_and(|entry| entry.pending_proof);
    Boot {
        server,
        credential,
        platform: std::env::consts::OS.to_string(),
        host_name: daemon::host_name(),
        app_version: app.package_info().version.to_string(),
        durable: host.durable,
        picks_folder: PICKS_FOLDER,
        can_host_daemon: CAN_HOST_DAEMON,
        device_id,
        device_public_key: device_key.as_ref().map(|k| k.public_key.clone()),
        device_key_at_rest: device_key.as_ref().map(|k| k.at_rest.clone()),
        default_server: config::default_server(),
        account,
        name: entry.as_ref().and_then(|entry| entry.name.clone()),
        legacy,
        device_bound: entry.as_ref().is_some_and(|entry| entry.bound),
        generation: seat.generation,
        rebinding: seat.rebinding,
        claimed,
    }
}

/// A DH oracle scoped to the page and this account's key: less than holding the key, and the same
/// boundary `host_boot` already sits on. `(async)`: a keyring read, twice per Noise handshake. A
/// cache of the static would belong in `device.rs`, beside the at-rest policy.
#[tauri::command(async)]
pub fn host_device_dh(
    peer: String,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<String, String> {
    let (_, slot) = host.seat(&webview, &request)?;
    let scope = slot
        .scope()
        .ok_or_else(|| pending_seat("a sign-in with no account has no device key"))?;
    device::diffie_hellman(&host.config_dir, &scope, &peer)
}

/// The old key is given up first. `(async)`: a keyring erase, durable writes and a verified write.
#[tauri::command(async)]
pub fn host_device_key_reset(
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<DeviceKey, String> {
    let (_, slot) = host.seat(&webview, &request)?;
    let scope = slot
        .scope()
        .ok_or_else(|| pending_seat("a sign-in with no account has no device key"))?;
    device::reset_key(&host.config_dir, &scope)
}

/// Not on `Boot`: a daemon may start after the app. `None` for every failure. `is_alive` before
/// the base leaves this process, because the page spends a 300-second machine token on it and an
/// announce can outlive its daemon. This account's root, then `~/.reemoat`, which keeps a client
/// build finding an `install.sh` daemon; a guest gets its own root alone. Not memoised.
#[tauri::command(async)]
pub fn host_local_daemon(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Option<LocalDaemon> {
    let (_, slot) = host.seat(&webview, &request).ok()?;
    let home = app.path().home_dir().ok()?;
    let own = slot.root(&home, host.holder().as_deref());
    let guest = matches!(slot, Slot::Account { owner: false, .. });
    daemon::announce_roots(&home, own.as_ref().map(|root| root.dir.as_path()), !guest)
        .iter()
        .filter_map(|root| local::read(root))
        .find(|found| daemon::is_alive(&found.base, &found.instance_id))
}

/// A pending seat only: an account is its origin and user id (Q3.643, Q5.120). Writes
/// `server.json` only on a first run, and touches no credential and no daemon (Q7.148).
#[tauri::command(async)]
pub fn host_set_server(
    url: String,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<String, String> {
    let (label, slot) = host.seat(&webview, &request)?;
    let origin = config::normalize_origin(&url)?;
    let _changing = host.lock_changing();
    host.still(&label, &slot)?;
    let Slot::Pending { origin: held } = slot else {
        return Err(pending_seat(
            "an account's server cannot be changed. Add another account from the menu instead.",
        ));
    };
    if held.as_deref() == Some(origin.as_str()) {
        return Ok(origin);
    }
    if host.roster().accounts.is_empty() {
        config::write_server(&host.config_dir, &origin)?;
    }
    host.seat_as(
        &label,
        Slot::Pending {
            origin: Some(origin.clone()),
        },
    );
    Ok(origin)
}

/// The host asks `GET /v1/me` whose token it is and keys the account on that (Q1.651). It revokes
/// the new session itself on `existing` and `refused`. A failed `/v1/me` is an `Err` and nothing is
/// adopted; a keyring write that does not land is `durable: false`, not a refusal.
#[tauri::command]
pub async fn host_credential_set(
    value: String,
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<Bound, String> {
    let (label, slot) = host.seat(&webview, &request)?;
    let origin = slot
        .origin()
        .map(str::to_string)
        .ok_or_else(|| pending_seat("no server has been chosen"))?;
    let me = accounts::me(&host.client, &origin, &value).await?;
    let evidence = match &slot {
        Slot::Account { .. } => Evidence::NONE,
        _ => {
            let home = app.path().home_dir().ok();
            accounts::gather(
                &host.client,
                &host.config_dir,
                home.as_deref(),
                host.holder().as_deref(),
                &origin,
                &value,
                matches!(slot, Slot::Legacy { .. }),
            )
            .await
        }
    };
    let outcome = bind_signin(&host, &label, &slot, &me, &value, &evidence)?;
    Ok(settle(&app, &host, &origin, &value, &me, outcome).await)
}

enum Signed {
    Bound(Slot),
    Adopted(String),
    Existing(String),
    Refused,
}

/// Synchronous, so no lock is held across the requests on either side.
fn bind_signin(
    host: &Host,
    label: &str,
    slot: &Slot,
    me: &accounts::Me,
    value: &str,
    evidence: &Evidence,
) -> Result<Signed, String> {
    let _changing = host.lock_changing();
    host.still(label, slot)?;
    host.materialize()?;
    match accounts::decide(slot, &me.id, &host.roster()) {
        Decision::Refused => Ok(Signed::Refused),
        Decision::Same => {
            let scope = slot.scope().ok_or_else(stale)?;
            // A store that keeps nothing is `durable: false`, not a failed sign-in.
            let _ = credential::write(&scope, value);
            config::set_signed_in(&host.config_dir, &scope, true)?;
            config::set_bound(&host.config_dir, &scope, false)?;
            let _ = config::rename_account(&host.config_dir, &scope, &me.name);
            host.seat_as(label, slot.clone());
            Ok(Signed::Bound(slot.clone()))
        }
        Decision::New | Decision::Existing { .. } => {
            match accounts::bind(
                &host.config_dir,
                slot,
                &me.id,
                &me.name,
                Token::Fresh(value),
                evidence,
            )? {
                Binding::Bound(bound) => {
                    host.seat_as(label, bound.clone());
                    host.refresh_owners();
                    Ok(Signed::Bound(bound))
                }
                Binding::Existing { key, adopted: true } => Ok(Signed::Adopted(key)),
                Binding::Existing {
                    key,
                    adopted: false,
                } => Ok(Signed::Existing(key)),
            }
        }
    }
}

async fn settle(
    app: &AppHandle,
    host: &Host,
    origin: &str,
    value: &str,
    me: &accounts::Me,
    outcome: Signed,
) -> Bound {
    match outcome {
        Signed::Refused => {
            let _ = proxy::revoke(&host.client, origin, value).await;
            Bound::elsewhere("refused", None, None)
        }
        Signed::Existing(key) => {
            let _ = proxy::revoke(&host.client, origin, value).await;
            Bound::elsewhere("existing", Some(key), Some(me.name.clone()))
        }
        Signed::Adopted(key) => {
            seats::refresh(app, host, &key);
            Bound::elsewhere("adopted", Some(key), Some(me.name.clone()))
        }
        Signed::Bound(slot) => described(host, "bound", &slot, Some(me.name.clone())),
    }
}

fn described(host: &Host, outcome: &str, slot: &Slot, name: Option<String>) -> Bound {
    let scope = slot.scope();
    let device_key = scope
        .as_deref()
        .and_then(|scope| device::ensure_key(&host.config_dir, scope).ok());
    Bound {
        outcome: outcome.to_string(),
        account: scope
            .clone()
            .filter(|_| matches!(slot, Slot::Account { .. })),
        name,
        device_id: scope
            .as_deref()
            .and_then(|scope| config::read_device(&host.config_dir, scope)),
        device_public_key: device_key.as_ref().map(|k| k.public_key.clone()),
        device_key_at_rest: device_key.as_ref().map(|k| k.at_rest.clone()),
    }
}

/// Seat-scoped, so a stale document cannot erase the next account's entry (Q7.148).
#[tauri::command(async)]
pub fn host_credential_clear(
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<(), String> {
    let (_, slot) = host.seat(&webview, &request)?;
    let Some(scope) = slot.scope() else {
        return Ok(());
    };
    credential::erase(&scope)?;
    // The erase is the act; failing to write the drawer's flag is not a failed sign-out.
    let _ = host.materialize();
    let _ = config::set_signed_in(&host.config_dir, &scope, false);
    Ok(())
}

/// Also binds the device to the current sign-in. Per account, and not erased when an account is
/// forgotten: the server's row still exists (Q7.148).
#[tauri::command(async)]
pub fn host_device_set(
    value: String,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<(), String> {
    let (_, slot) = host.seat(&webview, &request)?;
    let scope = slot
        .scope()
        .ok_or_else(|| pending_seat("a sign-in with no account has no device"))?;
    config::write_device(&host.config_dir, &scope, &value)
}

/// On `device_revoked`, so the retired id is not offered again.
#[tauri::command(async)]
pub fn host_device_clear(
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<(), String> {
    let (_, slot) = host.seat(&webview, &request)?;
    let Some(scope) = slot.scope() else {
        return Ok(());
    };
    config::erase_device(&host.config_dir, &scope)
}

/// Reads no keyring: a keychain read per row is a prompt per row on an ad-hoc-signed build.
#[tauri::command(async)]
pub fn host_accounts(
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<AccountList, String> {
    let (_, slot) = host.seat(&webview, &request)?;
    let own = slot.scope();
    let roster = host.roster();
    let accounts = roster
        .accounts
        .iter()
        .map(|account| AccountSummary {
            key: account.key(),
            origin: account.origin.clone(),
            name: account.name.clone(),
            current: own.as_deref() == Some(account.key().as_str()),
            signed_in: account.signed_in,
        })
        .collect();
    Ok(AccountList {
        accounts,
        can_add: roster.accounts.len() < accounts::MAX_ACCOUNTS,
        back: roster.recent(own.as_deref()).map(config::Account::key),
    })
}

/// `account` is a key `host_accounts` listed, or `null` for `back`. Shown webview only, or a
/// hidden page could flip the account under somebody's cursor. Stops no daemon.
#[tauri::command(async)]
pub fn host_account_switch(
    account: Option<String>,
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<AccountMove, String> {
    let (label, slot) = host.seat(&webview, &request)?;
    host.require_shown(&label)?;
    let _changing = host.lock_changing();
    host.still(&label, &slot)?;
    let roster = host.roster();
    let own = slot.scope();
    let key = match account {
        Some(key) => key,
        None => roster
            .recent(own.as_deref())
            .map(config::Account::key)
            .ok_or_else(|| "there is no other account to go back to".to_string())?,
    };
    if own.as_deref() == Some(key.as_str()) {
        return Ok(AccountMove { reload_page: false });
    }
    let target = roster
        .find(&key)
        .ok_or_else(|| "that account is not on this computer".to_string())?;
    let target = Slot::from_account(target, &roster.roots);
    let reload = seats::switch_to(&app, &host, &label, &slot, target)?;
    // After the switch: the file decides only which account opens next time.
    let _ = config::show_account(&host.config_dir, &key);
    Ok(AccountMove {
        reload_page: reload,
    })
}

/// Refused at `MAX_ACCOUNTS`. Writes nothing until a sign-in binds the seat. `(async)`: building a
/// webview from a synchronous command deadlocks on Windows.
#[tauri::command(async)]
pub fn host_account_add(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<AccountMove, String> {
    let (label, slot) = host.seat(&webview, &request)?;
    host.require_shown(&label)?;
    let _changing = host.lock_changing();
    host.still(&label, &slot)?;
    if host.roster().accounts.len() >= accounts::MAX_ACCOUNTS {
        return Err(format!(
            "account_limit: this computer holds {} accounts, which is the most it keeps. Remove one first.",
            accounts::MAX_ACCOUNTS
        ));
    }
    let reload = seats::add(&app, &host, &label)?;
    Ok(AccountMove {
        reload_page: reload,
    })
}

/// Sign out and Remove account, for the caller only. Keeps the device id, key and root record;
/// stops the account's daemon unless another listed account shares its root (Q7.149). A pending
/// caller with no account anywhere is refused: a first run stays uncancellable.
#[tauri::command(async)]
pub fn host_account_forget(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<AccountMove, String> {
    let (label, slot) = host.seat(&webview, &request)?;
    let _changing = host.lock_changing();
    host.still(&label, &slot)?;
    let was_shown = host.shown().as_deref() == Some(label.as_str());
    let Some(scope) = slot.scope() else {
        let roster = host.roster();
        let back = roster
            .recent(None)
            .ok_or_else(|| pending_seat("there is no account to go back to yet"))?;
        let key = back.key();
        let next = Slot::from_account(back, &roster.roots);
        let reload = seats::leave(&app, &host, &label, Some(next), slot.clone())?;
        if was_shown {
            let _ = config::show_account(&host.config_dir, &key);
        }
        return Ok(AccountMove {
            reload_page: reload,
        });
    };

    let _ = credential::erase(&scope);
    let roster = host.roster();
    let holder = host.holder();
    let own_root = app.path().home_dir().ok().and_then(|home| {
        let root = slot.root(&home, holder.as_deref())?;
        let shared = roster.accounts.iter().any(|account| {
            account.key() != scope
                && Slot::from_account(account, &roster.roots)
                    .root(&home, holder.as_deref())
                    .is_some_and(|other| other.dir == root.dir)
        });
        (!shared).then_some(root)
    });
    // Under the root lock, then stopped: a start that won the lock is stopped below, a later one finds no account.
    let next_key = {
        let _roots = daemon::lock_roots();
        host.materialize()?;
        config::forget_account(&host.config_dir, &scope)?
    };
    if let Some(root) = own_root {
        if let Some(handle) = host.supervisor_if(&root) {
            if let Ok(mut supervisor) = handle.lock() {
                supervisor.stop();
            }
        }
    }
    let roster = host.roster();
    let next = next_key
        .as_deref()
        .and_then(|key| roster.find(key))
        .map(|account| Slot::from_account(account, &roster.roots));
    let fallback = Slot::Pending {
        origin: slot.origin().map(str::to_string),
    };
    let reload = seats::leave(&app, &host, &label, next, fallback)?;
    if let (true, Some(key)) = (was_shown, next_key.as_deref()) {
        let _ = config::show_account(&host.config_dir, key);
    }
    Ok(AccountMove {
        reload_page: reload,
    })
}

/// A legacy seat's bare credential is moved to the account `/v1/me` names, and its device, claim
/// and root follow only by proof (`accounts::gather`). An account refreshes its name and retries
/// an unreached proof. Reads a credential and returns none; `nativecheck` pins both.
#[tauri::command]
pub async fn host_account_confirm(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<Bound, String> {
    let (label, slot) = host.seat(&webview, &request)?;
    let (Some(origin), Some(scope)) = (slot.origin().map(str::to_string), slot.scope()) else {
        return Err(pending_seat("there is no account to confirm"));
    };
    let token = credential::read(&scope)
        .ok_or_else(|| "signed_out: there is no sign-in on this computer to confirm".to_string())?;
    let me = accounts::me(&host.client, &origin, &token).await?;
    let waiting = matches!(slot, Slot::Legacy { .. })
        || host
            .roster()
            .find(&scope)
            .is_some_and(|account| account.pending_proof);
    let evidence = if waiting {
        let home = app.path().home_dir().ok();
        accounts::gather(
            &host.client,
            &host.config_dir,
            home.as_deref(),
            host.holder().as_deref(),
            &origin,
            &token,
            matches!(slot, Slot::Legacy { .. }),
        )
        .await
    } else {
        Evidence::NONE
    };
    let confirmed = confirm_signin(&host, &label, &slot, &me, &token, &evidence)?;
    Ok(match confirmed {
        Confirmed::Bound(bound) => described(&host, "bound", &bound, Some(me.name)),
        Confirmed::Unchanged => described(&host, "unchanged", &slot, Some(me.name)),
        Confirmed::Existing { key, adopted } => {
            if adopted {
                seats::refresh(&app, &host, &key);
            } else {
                let _ = proxy::revoke(&host.client, &origin, &token).await;
            }
            Bound::elsewhere("existing", Some(key), Some(me.name))
        }
    })
}

enum Confirmed {
    Bound(Slot),
    Unchanged,
    Existing { key: String, adopted: bool },
}

fn confirm_signin(
    host: &Host,
    label: &str,
    slot: &Slot,
    me: &accounts::Me,
    token: &str,
    evidence: &Evidence,
) -> Result<Confirmed, String> {
    let _changing = host.lock_changing();
    host.still(label, slot)?;
    host.materialize()?;
    match slot {
        Slot::Legacy { .. } => match accounts::bind(
            &host.config_dir,
            slot,
            &me.id,
            &me.name,
            Token::Move(token),
            evidence,
        )? {
            Binding::Bound(bound) => {
                host.seat_as(label, bound.clone());
                host.refresh_owners();
                Ok(Confirmed::Bound(bound))
            }
            Binding::Existing { key, adopted } => {
                host.refresh_owners();
                // The page forgets this seat next and lands here.
                let _ = config::show_account(&host.config_dir, &key);
                Ok(Confirmed::Existing { key, adopted })
            }
        },
        Slot::Account { origin, user, .. } => {
            if *user != me.id {
                return Err("this account's sign-in answers for somebody else".into());
            }
            let scope = accounts::scope_of(origin, user);
            let renamed = config::rename_account(&host.config_dir, &scope, &me.name)?;
            let claimed = if evidence.root != config::Proof::NotAsked
                || evidence.device != config::Proof::NotAsked
            {
                let claimed = config::claim_bare(
                    &host.config_dir,
                    &scope,
                    None,
                    evidence,
                    evidence.device_current,
                )?;
                accounts::follow_claim(&host.config_dir, origin, &scope, &claimed);
                claimed.root || claimed.device
            } else {
                false
            };
            if !renamed && !claimed {
                return Ok(Confirmed::Unchanged);
            }
            host.refresh_owners();
            let now = host
                .labels()
                .into_iter()
                .find(|(held, _)| held == label)
                .map(|(_, slot)| slot)
                .unwrap_or_else(|| slot.clone());
            Ok(Confirmed::Bound(now))
        }
        Slot::Pending { .. } => Err(pending_seat("there is no account to confirm")),
    }
}

/// The base is the calling seat's own server; the page names a path, never an address. A probe
/// of a candidate `origin`, and a pending seat, may send no credential. Defence in depth against a
/// page that is wrong, not one that is hostile (Q5.116).
#[tauri::command]
pub async fn host_cp(
    req: CpRequest,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    host: State<'_, Host>,
) -> Result<CpAnswer, String> {
    let (_, slot) = host.seat(&webview, &request)?;
    // Normalized rather than trusted, so a probe cannot reach a shape `host_set_server` refuses.
    let base = match &req.origin {
        Some(candidate) => {
            if proxy::carries_credential(&req.headers) {
                return Err("refused: a server being tried is sent no credential".into());
            }
            config::normalize_origin(candidate)?
        }
        None => {
            if matches!(slot, Slot::Pending { .. }) && proxy::carries_credential(&req.headers) {
                return Err(pending_seat(
                    "a sign-in with no account sends no credential",
                ));
            }
            slot.origin()
                .map(str::to_string)
                .ok_or_else(|| pending_seat("no server has been chosen"))?
        }
    };
    proxy::send(&host.client, &base, &req).await
}

#[tauri::command]
pub fn host_copy_text(
    app: AppHandle,
    webview: tauri::Webview,
    host: State<'_, Host>,
    text: String,
) -> Result<(), String> {
    host.require_shown(webview.label())?;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// A second copy of `links.ts`'s `OPENABLE`, holding if the page is wrong; `nativecheck` compares them.
const OPENABLE_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

#[tauri::command]
pub fn host_open_external(
    app: AppHandle,
    webview: tauri::Webview,
    host: State<'_, Host>,
    url: String,
) -> Result<(), String> {
    host.require_shown(webview.label())?;
    let parsed = url::Url::parse(&url).map_err(|_| "not a link".to_string())?;
    if !OPENABLE_SCHEMES.contains(&parsed.scheme()) {
        return Err("refused: not a scheme this opens".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Base64 in JSON, never a raw body, which only `ipc://` carries (Q3.690). `false` for a dismissed
/// panel, which is not a failure. `(async)`: `blocking_save_file` deadlocks on the main thread.
/// Written through `tauri-plugin-fs`: Android's `ACTION_CREATE_DOCUMENT` answers a `content://` URI with no path.
#[tauri::command(async)]
pub fn host_save_file(
    app: AppHandle,
    webview: tauri::Webview,
    host: State<'_, Host>,
    filename: String,
    data: String,
) -> Result<bool, String> {
    host.require_shown(webview.label())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "the file did not arrive whole".to_string())?;

    let chosen = app
        .dialog()
        .file()
        .set_file_name(&filename)
        .blocking_save_file();
    let Some(chosen) = chosen else {
        return Ok(false);
    };
    let mut options = OpenOptions::new();
    options.read(false).write(true).create(true).truncate(true);
    let mut file = app
        .fs()
        .open(chosen, options)
        .map_err(|e| format!("could not use that location: {e}"))?;
    std::io::Write::write_all(&mut file, &bytes)
        .map_err(|e| format!("could not write the file: {e}"))?;
    Ok(true)
}

/// For this computer's own daemon only, which `NewSession.tsx` decides. `None` for a dismissed
/// panel. `start` is a hint, never a boundary. `(async)`: `blocking_pick_folder` deadlocks on the main thread.
#[tauri::command(async)]
pub fn host_pick_folder(
    app: AppHandle,
    webview: tauri::Webview,
    host: State<'_, Host>,
    start: Option<String>,
) -> Result<Option<String>, String> {
    host.require_shown(webview.label())?;
    pick_folder(app, start)
}

/// Only the body is gated: the command must exist everywhere for the three text censuses.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn pick_folder(app: AppHandle, start: Option<String>) -> Result<Option<String>, String> {
    let mut panel = app.dialog().file();
    if let Some(seed) = start {
        let at = std::path::PathBuf::from(&seed);
        if at.is_absolute() && at.is_dir() {
            panel = panel.set_directory(at);
        }
    }
    let Some(chosen) = panel.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|e| format!("could not use that folder: {e}"))?;
    path.into_os_string()
        .into_string()
        .map(Some)
        .map_err(|_| "that folder's name is not text".to_string())
}

/// `tauri-plugin-dialog` has no mobile `blocking_pick_folder` (Android's `ACTION_OPEN_DOCUMENT_TREE`
/// is a tree URI). Unreachable, since `picks_folder` is false here; an error rather than a panic.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn pick_folder(_app: AppHandle, _start: Option<String>) -> Result<Option<String>, String> {
    Err("this platform has no folder panel".to_string())
}

/// The page says its theme at every boot and show, so only a change is written or applied, and a
/// failed write is applied anyway (Q3.671).
#[tauri::command(async)]
pub fn host_set_theme(
    webview: tauri::Webview,
    host: State<'_, Host>,
    theme: String,
) -> Result<(), String> {
    host.require_shown(webview.label())?;
    let theme = config::Theme::parse(&theme).ok_or("not a theme")?;
    let wrote = config::write_theme(&host.config_dir, theme);
    if !matches!(wrote, Ok(false)) {
        seats::show_theme(&webview.window(), theme);
    }
    wrote.map(|_| ())
}
