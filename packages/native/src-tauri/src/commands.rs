//! Everything the webview may ask this process to do, and nothing else.
//!
//! The list is short on purpose: an app-defined command is not
//! ACL-gated, so this file *is* the capability surface. `pnpm nativecheck` holds
//! it to the set `packages/web/src/native.ts` actually calls, in both directions —
//! a command nobody calls is a door nobody is watching, and a call with no command
//! behind it is a runtime failure no offline check would otherwise see.
//!
//! ⚠ **There was a count here and it is gone, having been wrong three times.**
//! It read *twelve* while thirteen were registered — `host_daemon_log` arrived and
//! the sentence did not move — then *fifteen* while seventeen were, then
//! *seventeen* while eighteen were. Three corrections is the point at which the
//! number stops being orientation and starts being the kind of claim
//! `docs/DECISIONS.md` records this repository learning not to keep. What the
//! driver compares is the two *lists*, which is the property that matters, and
//! `generate_handler!` in `lib.rs` is the answer to "how many".
//!
//! ## Which of these may hold the main thread
//!
//! **`#[tauri::command]` runs the body on the main thread — the one the webview
//! paints on — and `#[tauri::command(async)]` runs it on the async runtime.** A
//! bare attribute is the right shape for a `PathBuf` join, a keyring write or a
//! clipboard call, and the wrong one for anything that *waits*, because a command
//! that waits on the main thread is a command that stops the app drawing for
//! exactly as long as it waits.
//!
//! **The rule: a command that waits on a socket, on a disk flush, on a platform
//! panel or on a child process carries `(async)`; so does one on a path hot enough
//! that even a keyring round trip is too much.** Each carries the measurement at
//! its own docblock, and `nativecheck` now asserts the platform-panel half of this
//! rule rather than leaving it to a reader — a command whose body reaches
//! `app.dialog()` or a `blocking_` call must carry the argument form:
//!
//! - `host_daemon_state` and `host_local_daemon` — a loopback `/health` probe
//!   worth three `PROBE_TIMEOUT`s in the bad case.
//! - `host_device_dh` — an OS keyring round trip **twice per Noise handshake**,
//!   which is the hot-path clause rather than the waiting one.
//! - `host_save_file` — a platform panel, and then up to `MAX_DOWNLOAD_BYTES`.
//! - `host_pick_folder` — a platform panel, and nothing after it.
//! - `host_set_server`, `host_device_set`, `host_device_clear`,
//!   `host_device_key_reset` — a `server.json` write, which `config.rs` makes
//!   durable by flushing the file **and** its directory entry: two `sync_all`s.
//!   The first, on a regular file, is `fcntl(F_FULLFSYNC)` on macOS — a full
//!   device cache flush. ⚠ The second is that same call on a **directory**
//!   descriptor, which is measured only as far as being reached and answering
//!   success; `config::sync_dir` carries the numbers, and the platform where it
//!   does nothing at all. The first also erases a keyring entry and the last does
//!   a keyring erase, a keyring write and a read-back to verify it.
//! - `host_daemon_start` — an env file written the same durable way, and then a
//!   child process spawned.
//! - `host_daemon_stop` — a SIGTERM and then a **bounded wait** on the child, up
//!   to `STOP_DEADLINE`. Waiting is the point rather than politeness (`daemon.rs`
//!   has the argument), which is exactly why it may not be waited for here.
//!
//! `host_cp` is an `async fn` and the macro gives it the same treatment without
//! being asked.
//!
//! ⚠ **And the remainder, so this is a closed statement rather than a list with an
//! unspoken tail.** `host_credential_set` and `host_credential_clear` are one
//! keyring call and touch no disk; `host_daemon_log` copies an in-memory ring;
//! `host_copy_text`, `host_open_external` and `host_cp`'s own body are a clipboard
//! call, a URL parse and a join. `host_boot` is the one judgement call: it reads
//! the keyring and, on the single launch that generates a device key, pays that
//! durable write too — and it stays bare because it is the call the page makes
//! *before it draws anything*, so there is no frame for it to hold, and because
//! its four answers are read in one breath about one origin, which the main thread
//! gives it for free.
//!
//! ⚠ **The attribute is the whole fix, and it is easy to lose in a refactor** —
//! `(async)` on a synchronous function is not decoration, it is the difference
//! between `tauri::async_runtime::spawn` and running inline on the event loop.
//! Nothing the compiler does will tell you it went missing; the symptom is a
//! beachball on somebody else's machine.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::config;
use crate::credential;
use crate::daemon;
use crate::device::{self, DeviceKey};
use crate::local::{self, LocalDaemon};
use crate::proxy::{self, CpAnswer, CpRequest};

pub struct Host {
    pub server: Mutex<Option<String>>,
    pub client: reqwest::Client,
    pub config_dir: std::path::PathBuf,
    pub durable: bool,
    /// The daemon this app started, if it started one. See `daemon.rs`.
    pub supervisor: Mutex<daemon::Supervisor>,
}

impl Host {
    fn origin(&self) -> Option<String> {
        self.server.lock().ok().and_then(|held| held.clone())
    }
}

/* ── the daemon on this computer, when this app is the one running it ────── */

/// Where the daemon is and how it is doing.
///
/// ⚠ **The second question about a local daemon, and deliberately not merged into
/// `host_local_daemon`.** That one answers `None` to every failure because its
/// caller has exactly one question — *is there a daemon here worth showing a token
/// to?* — and a diagnostic on that path would be noise. This one exists because
/// the app is now sometimes *responsible* for the daemon, and reporting "none" for
/// a process that exited two seconds ago would be the app hiding its own failure.
///
/// The states, and each names a different thing to do about it:
///
/// - `unsupported` — no payload in this build. Nothing to offer; the relay is the
///   only route, as it was before any of this.
/// - `foreign` — a daemon is announced that this app did not start. Adopted, never
///   raced: `claimDaemonLock` would refuse a second process against one database,
///   and creating a second control-plane machine for one computer would burn a
///   quota slot permanently.
/// - `running` — this app started it and it has announced itself.
/// - `starting` — this app started it and it has not announced itself yet.
/// - `exited` — it was started and is gone. `detail` carries the tail of what it
///   printed, which is the whole reason this command exists.
/// - `absent` — nothing here, and nothing has been tried.
///
/// ⚠ **`(async)`, because this one is a *poll*.** Four `read_to_string`s is
/// already more than the painting thread should be asked for once a second, but
/// the cost that mattered is the `is_alive` probe below and it is paid only on
/// the branch nobody developing this app ever takes. On a `deploy/install.sh`
/// machine `ours` is false for ever, so every tick does a synchronous loopback
/// connect, write and read — three `PROBE_TIMEOUT`s, three quarters of a second,
/// whenever the announced port is stale and *filtered* rather than refused, which
/// is the case the timeout exists for. `store.ts` asks at `SETUP_POLL_MS` while a
/// computer is being set up and `LogsSection` every two seconds afterwards. An app
/// running its own child answers from a process handle and pays none of it, which
/// is why a whole release of this was invisible.
#[tauri::command(async)]
pub fn host_daemon_state(app: AppHandle, host: State<'_, Host>) -> daemon::DaemonState {
    let unknown = |status: &str| daemon::DaemonState {
        status: status.to_string(),
        ..Default::default()
    };
    let Ok(home) = app.path().home_dir() else {
        return unknown("unsupported");
    };
    if daemon::Payload::locate(&resource_dir(&app), &exe_path()).is_none() {
        return unknown("unsupported");
    }

    let announced = local::read(&home);
    /*
     * What this app already spent a machine on, for *this* server. Read here rather
     * than left to the page, because the page would have to be told the origin to
     * ask the question and the origin is deliberately something only the host
     * knows — the same rule `host_cp` keeps.
     */
    let origin = host.origin();
    let claimed = origin
        .as_deref()
        .and_then(|origin| daemon::read_claim(&host.config_dir, origin));
    /*
     * ⚠ **Answered on every state read, because the caller's *first* decision
     * depends on it.** A store that cannot see an existing env file creates a
     * machine for a computer that already had one — a quota slot spent on a
     * machine nobody asked for, and one only a person who notices it can return. `daemon::config_state` carries the measurement.
     */
    let config = daemon::config_state(&home, origin.as_deref()).to_string();
    let Ok(mut supervisor) = host.supervisor.lock() else {
        return daemon::DaemonState {
            status: "absent".to_string(),
            claimed,
            config,
            ..Default::default()
        };
    };
    let ours = supervisor.owns_running();
    /*
     * ⚠ **A daemon this app did not start has to be *there*, not merely announced.**
     * `src/announce.ts` removes its file on a clean stop and cannot on an unclean
     * one, so a force quit, a crash or a power cut leaves one naming a port nobody
     * is on. Believing it answers `foreign`, which is the one status the setup flow
     * treats as "somebody else has this covered" — and then nothing starts a daemon
     * ever again, on a computer whose daemon dies with the app by design.
     * ⚠ **And it is `/health` rather than a bare connect, because the port is not
     * the daemon.** `REEMOAT_PORT` is a fixed value in the env file, so a stale
     * announce names an ordinary port that anything may hold afterwards. The
     * answer carries the same `instanceId` the file does, so this proves the
     * daemon rather than the socket.
     * Not asked when this app owns the child: the handle is better evidence than a
     * probe, and it keeps a round trip off the one-second polling path.
     * ⚠ **The `foreign` branch has always paid it, every tick.** That is not a
     * thing this filter can fix — a daemon this app did not start is exactly the
     * one that has to be proved — so the fix is the `(async)` on this command:
     * the round trip is off the *main thread* now rather than off the poll.
     */
    let announced =
        announced.filter(|found| ours || daemon::is_alive(&found.base, &found.instance_id));

    let mut state = match (announced, ours) {
        (Some(found), true) => daemon::DaemonState {
            status: "running".to_string(),
            machine_id: Some(found.machine_id),
            claimed,
            ..Default::default()
        },
        // Announced by somebody else's daemon — the shell installer's, or one left
        // from a previous run of this app that outlived it.
        (Some(found), false) => daemon::DaemonState {
            status: "foreign".to_string(),
            machine_id: Some(found.machine_id),
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
                // A ring with something in it and no live child means one was
                // started and is gone; an empty one, that nothing was ever tried
                // here. The lines themselves are `host_daemon_log`'s — this poll
                // asks the ring for a bit and never for its contents (Q7.140).
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
    state
}

/// Bring the daemon up, provisioning this computer first if it is being asked to.
///
/// **Three cases, decided by what the caller brought and by what is already on
/// disk**, and the docblock that used to be here described none of them: it
/// claimed this "refuses rather than overwrites when an env file already exists",
/// while the code silently skipped the write and started the daemon on whatever
/// the file said. That is how a machine created at 15:15:54 was followed one
/// second later by a daemon enrolling with a *different* machine's hour-old code
/// and dying on `409 code_unusable`, with nothing on screen — measured on a real
/// machine 2026-09-15.
///
/// - **A code** — provisioning, whether this is the first time or a fresh code for
///   a machine whose last one expired. Writes the file, preserving every key this
///   app does not own (`daemon::env_rewritten`), and writes **this host's own
///   origin** as the control plane rather than anything the page supplied.
/// - **No code, and a file that names this server** — adoption. Start what is
///   already configured and create nothing. This is a `deploy/install.sh` machine,
///   or this app's own after a restart.
/// - **A file naming another server** — refused outright, both above. Overwriting
///   it would point somebody's working daemon at a fleet they did not choose.
///
/// ⚠ **`(async)`, because everything this does waits.** `write_private` below is
/// durable now — the bytes and then the directory entry, two `sync_all`s, the
/// first of them a full device cache flush on macOS and the second the same call
/// on a directory descriptor, which `config::sync_dir` measures rather than
/// assumes — and then this spawns a child process. On the main thread that is a
/// window that
/// stops drawing at exactly the moment somebody has pressed the button that sets
/// their computer up, which is the one moment they are watching it.
#[tauri::command(async)]
pub fn host_daemon_start(
    enroll_code: String,
    machine_id: String,
    app: AppHandle,
    host: State<'_, Host>,
) -> Result<daemon::DaemonState, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "no home directory".to_string())?;
    let payload = daemon::Payload::locate(&resource_dir(&app), &exe_path())
        .ok_or_else(|| "this build carries no daemon".to_string())?;

    let env_file = daemon::env_path(&home);
    let origin = host.origin();
    if daemon::config_state(&home, origin.as_deref()) == daemon::CONFIG_ELSEWHERE {
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

    /*
     * ⚠ **Before the env file, not after.** The claim is what stops the next launch
     * buying a second machine for this computer, and a machine row is never given
     * back — so if writing the file fails on a full disk or a bad permission, the
     * `?` must not carry away the record that a machine was already bought. Cheap
     * and idempotent, which is what makes ordering it first free.
     */
    if !machine_id.is_empty() {
        if let Some(origin) = origin.as_deref() {
            daemon::write_claim(&host.config_dir, origin, &machine_id)?;
        }
    }

    /*
     * ⚠ **A rewrite is refused while a background service owns the same file.** It
     * would respawn within its throttle interval, source the new file and race this
     * app's child for a single-use code, the database lock and the port — and
     * whichever loses, the code is spent. Only the rewrite: adoption below is
     * exactly the right thing to do with a machine somebody else set up.
     */
    if !enroll_code.is_empty() && env_file.exists() {
        if let Some(unit) = daemon::managed_unit(&home) {
            return Err(daemon::managed_unit_detail(&unit));
        }
    }

    if !enroll_code.is_empty() {
        /*
         * ⚠ **The origin this app is signed in to, never a URL from the page.**
         * `native-shell.md` already states the rule — *a path crosses the bridge,
         * never a URL* — and the first version of this broke it by writing
         * whatever `POST /v1/machines` answered in `controlPlaneUrl`. That value is
         * `installOrigin`, which is the *request's* origin with `x-forwarded-proto`
         * applied, so behind a proxy declaring `http` it is a different spelling
         * from the one this app uses — and a different spelling makes
         * `config_state` answer `elsewhere` on the next launch, which is this app
         * refusing a file it wrote itself, for ever. Writing the origin the host
         * already holds makes `CONFIG_HERE` true by construction rather than by
         * agreement between two services.
         */
        let control_plane = origin
            .clone()
            .ok_or_else(|| "no server has been chosen yet".to_string())?;
        let dir = env_file
            .parent()
            .ok_or_else(|| "bad env path".to_string())?;
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        /*
         * ⚠ **A rewrite, not a replacement, when there is already a file.** The one
         * measured here carried a private CA path its owner had added by hand —
         * without which the daemon cannot reach that control plane at all. Writing
         * `env_contents` over it would have deleted the line and turned a refused
         * enrollment code into a TLS failure.
         */
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
    host.supervisor
        .lock()
        .map_err(|_| "the supervisor is poisoned".to_string())?
        .start(&payload, &home, &env)?;
    Ok(daemon::DaemonState {
        status: "starting".to_string(),
        claimed: if machine_id.is_empty() {
            None
        } else {
            Some(machine_id)
        },
        // True by construction: every path that reaches here either wrote a file
        // naming this server or adopted one that already did.
        config: daemon::CONFIG_HERE.to_string(),
        ..Default::default()
    })
}

/// Stop the daemon this app started, and only that one.
///
/// ⚠ **`(async)`, and this is the longest wait in the file by an order of
/// magnitude.** `Supervisor::stop` signals and then **waits** — bounded by
/// `STOP_DEADLINE`, and waiting is the point rather than politeness: a stop that
/// returned early would let a relaunch start a second daemon while the first still
/// held `reemoat.db`, which the setup flow reads as a daemon that will not start.
/// That argument is about the *quit* path, where holding the main loop is
/// unavoidable because the loop is on its way out. Here it is avoidable, and bare
/// it was a window frozen for up to that whole deadline because somebody pressed
/// Stop.
#[tauri::command(async)]
pub fn host_daemon_stop(host: State<'_, Host>) -> Result<(), String> {
    host.supervisor
        .lock()
        .map_err(|_| "the supervisor is poisoned".to_string())?
        .stop();
    Ok(())
}

/// What the daemon this app started has printed, newest last.
///
/// ⚠ **Its own command rather than a field on `host_daemon_state`, and that is
/// about what each is asked.** `host_daemon_state` answers a word on a one-second
/// poll while a computer is being set up; this answers two hundred lines to one
/// screen that somebody opened on purpose. Folding the second into the first would
/// put the log on the poll, and `DaemonState.detail` — which means *what explains
/// this failure* and is `None` wherever nothing needs explaining — would become a
/// log field by accident.
///
/// **Never `Err`.** A screen whose subject is "what did it say" has no use for a
/// refusal it would have to render instead; every reason there is nothing to show
/// — no daemon started here, a daemon somebody else's installer started, a daemon
/// that has printed nothing yet — is an empty list, and the screen says which of
/// those it is from the state it already has.
#[tauri::command]
pub fn host_daemon_log(host: State<'_, Host>) -> Vec<String> {
    match host.supervisor.lock() {
        Ok(supervisor) => supervisor.log_lines(),
        // See `log_lines`: a poisoned lock costs the evidence, never the app.
        Err(_) => Vec::new(),
    }
}

/// `0600` inside a `0700` directory, on the platforms that have modes.
///
/// The enrollment code is a full machine identity until it is redeemed, so this
/// is the same discipline `src/announce.ts` applies to `daemon.json` and
/// `deploy/install.sh` to this very file. A filesystem with no POSIX modes is not
/// a reason to refuse — it is the same judgement `store/sqlite.ts` already makes.
///
/// ⚠ **The temporary name comes from `config::temp_name`, and that stopped being
/// cosmetic when this function's caller became `(async)`.** It used to be the pid
/// alone, which was modelled on `write_stored`'s name *minus* the counter that
/// name carries — survivable only while `host_daemon_start` ran on the main
/// thread and could not overlap itself. `temp_name`'s docblock has what two
/// writers sharing one temporary path cost, which for this file is the truncated
/// `daemon.env` the block below exists to prevent rather than an untidy
/// directory.
///
/// ⚠ **Known gap, bounded and named rather than half-fixed: the lost update on
/// `daemon.env` is still open.** `host_daemon_start` does `read_to_string` →
/// `daemon::env_rewritten` → this function with nothing serialising it — there is
/// no `CONFIG_LOCK` on this path, `config.rs` says so in as many words — so two
/// concurrent starts can each write a file built from bytes the other has already
/// replaced. A shared temporary name was the half that produced a *torn* file and
/// it is closed; a lock here is a larger change that reaches the machine-claim
/// ordering above, which is why it is written down instead of guessed at.
fn write_private(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    /*
     * ⚠ **`std::fs::write` was wrong here twice over, and this is the one file
     * that can afford neither.** It truncates before it writes, so a crash in
     * between leaves an env file with no `REEMOAT_CONTROL_PLANE` — which
     * `config_state` reads as `elsewhere`, and the app then refuses to touch a
     * file it corrupted itself, telling the person their computer is set up for
     * another server. Being locked out is bad; being locked out by a sentence that
     * is not true is worse. And the `chmod` landed *after* the bytes, so the
     * enrollment code and the certificate path sat at the umask's mode for the
     * length of a write.
     *
     * A temporary file created at `0600`, filled, flushed and renamed over the
     * target closes both: the mode is never wrong because it is set at creation,
     * and every reader sees either the whole old file or the whole new one.
     *
     * ⚠ **And the rename is flushed too, which for a long time it was not.** That
     * sentence above described a crash *during* a write and stopped at the last
     * statement: `sync_all` promises the temporary's bytes, and the directory
     * entry naming them is a separate write that nothing waited on. See the call
     * at the foot of this function.
     */
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
    // The pid **and** a counter, through the one function that builds both. Two
    // `host_daemon_start`s can be in flight in one process — it carries `(async)`
    // — and both opens below carry `truncate(true)`, so a temporary path they
    // share is the second one emptying bytes the first has already flushed.
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
    // `sync_all` rather than a plain close: a rename that beats its own contents to
    // disk is the failure this shape exists to prevent.
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
    /*
     * ⚠ **The flush above is the bytes; this is the name.** `sync_all` promises
     * the temporary's *contents* are on the device and says nothing about the
     * directory entry that gives them a path — a separate write, and an un-synced
     * one can leave neither the new name nor the old after a crash or a power cut.
     * For this file that state is an env file with no `REEMOAT_CONTROL_PLANE`,
     * which `config_state` reads as `elsewhere`: exactly the failure the block
     * above exists to prevent, where the app refuses to touch a file it corrupted
     * itself while telling the person their computer belongs to another server.
     *
     * The same gap was in `config.rs`'s `write_stored`, which this shape was
     * modelled on, so the fix is one function called from both — two copies that
     * drift apart is how one of them stops being a fix, and the temporary name
     * above now goes through that same door. Best effort for `sync_dir`'s own
     * reason: a platform with no openable directory handle may not turn a write
     * that landed into a refusal. It answers an `io::Result` rather than
     * swallowing one, so the discard is stated here and its docblock can carry
     * what each platform actually does with the call.
     */
    let _ = config::sync_dir(dir);
    Ok(())
}

/// Where `bundle.resources` landed, in a bundle and in `tauri dev` alike.
fn resource_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// This process's own executable, from which `daemon::runtime_beside` finds the
/// runtime — on macOS the helper app in `Contents/Helpers`, not a file beside it.
fn exe_path() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// Whether this build has a folder panel to open at all.
///
/// ⚠ **One spelling, two mechanisms, and `nativecheck` holds them to each other.**
/// A `cfg!` macro and a `#[cfg]` attribute cannot share a token, so the condition
/// exists twice — here and on `pick_folder` — and a build where they disagree is a
/// page that draws a control the shell will refuse. The driver compares the two
/// strings for exactly that reason.
pub const PICKS_FOLDER: bool = cfg!(not(any(target_os = "android", target_os = "ios")));

/// Whether a daemon could be on *this* computer at all.
///
/// ⚠ **A declared capability rather than an accident, and the accident is what
/// it replaces.** `mod daemon` and `mod local` compile for Android, so all five of
/// the daemon commands exist there, are registered, and answer `"unsupported"` or
/// `None` — `Payload::locate` finds nothing staged and `~/.reemoat/daemon.json` is
/// not on a phone. Both are true today and both are luck: the first is a property
/// of the *bundle* rather than of the platform, and the second is the very
/// inference {@link Boot::picks_folder}'s own docblock refuses in so many words.
///
/// ⚠ **No `#[cfg]` counterpart, unlike {@link PICKS_FOLDER}, and the asymmetry
/// is the whole reason this had to be written down rather than discovered.** The
/// folder panel got its constant for free: `blocking_pick_folder` does not exist
/// on Android, so an APK failed to compile and somebody had to decide something.
/// Nothing here fails to compile — there is no desktop-only call in these five
/// — so the page went on asking a phone to set itself up as a machine and
/// reading a plausible answer.
///
/// The condition is the same string as {@link PICKS_FOLDER}'s and they are
/// deliberately two constants: they answer different questions, and the day
/// Android grows a Storage Access Framework folder picker that one becomes `true`
/// while this one cannot.
pub const CAN_HOST_DAEMON: bool = cfg!(not(any(target_os = "android", target_os = "ios")));

/// What the first paint needs, in one round trip.
///
/// One call rather than four, because the webview cannot draw anything honest
/// until it knows all of it: whether there is a server, whether there is a
/// sign-in for that server, and whether a sign-in will survive a restart.
#[derive(Serialize)]
pub struct Boot {
    pub server: Option<String>,
    /// **The credential, handed over once.**
    ///
    /// It lives in the webview's memory from here, exactly as it does in a
    /// browser, and in the OS keyring at rest — never in `localStorage`. Keeping
    /// the value in this process instead was considered and refused: `cpFetch`
    /// attributes a 401 by comparing `credential === sent` by identity, and a
    /// handle it cannot compare would silently lose the rule that stops a late
    /// 401 signing you out of a session you just started.
    pub credential: Option<String>,
    pub platform: String,
    /// What this computer is called, for naming the machine it becomes.
    ///
    /// ⚠ **Not `platform`, and the difference is the whole reason this field
    /// exists.** `platform` is `std::env::consts::OS` — the literal string
    /// `"macos"` on every Mac ever made. Naming a control-plane machine from it
    /// succeeds once and then collides for ever, and the collision is checked
    /// case-insensitively against every machine the account can see, so the second
    /// computer gets a `409` for a name nobody typed.
    ///
    /// `None` where the host name cannot be read, which is a real state on a
    /// locked-down box: the caller then has to ask rather than guess.
    #[serde(rename = "hostName")]
    pub host_name: Option<String>,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    /// `false` where this machine's keyring took a canary and lost it — see
    /// `credential::probe`.
    pub durable: bool,
    /// The device this installation is registered as on that server, or `None`.
    ///
    /// ⚠ **The `rename` is load-bearing and its absence is invisible.** This
    /// struct carries no `rename_all` — every camelCase field names itself, which
    /// is `local.rs`'s convention too — so `device_id` without this line
    /// serializes as `device_id`, `boot.deviceId` reads `undefined` for ever, and
    /// `tsc`, `cargo`, `nativecheck`, `webcheck` and `cargo test` all stay green.
    /// The app would then decide on every launch that it has no device, register
    /// one, and walk into the account's device limit. `nativecheck` compares this
    /// struct's serialized keys against `NativeBoot`'s for exactly that reason.
    ///
    /// It comes from `config.rs` rather than the keyring, and that is what makes
    /// it survive a machine whose credential store silently discards writes.
    #[serde(rename = "deviceId")]
    pub device_id: Option<String>,
    /// This installation's X25519 public key on that server, base64url.
    ///
    /// ⚠ **Two flat fields rather than one nested `deviceKey` object, and that is
    /// forced rather than chosen.** `nativecheck`'s census reads `^\s{4}pub (\w+): `
    /// — the **top-level** fields of this struct and nothing deeper. A nested
    /// struct's members are invisible to it, so a missing `rename` inside one
    /// would be the failure the `device_id` block above describes, repeating one
    /// level down where the census that was built to catch it cannot look.
    ///
    /// `None` before the first launch that generates one, and on a failure to
    /// reach any store at all — the page then has no encrypted route to a remote
    /// machine and says so, rather than opening an unencrypted one.
    #[serde(rename = "devicePublicKey")]
    pub device_public_key: Option<String>,
    /// `"keyring"` or `"file"` — where that key is actually kept.
    ///
    /// Carried to the page because a person on a machine whose credential store
    /// keeps nothing should be **told** their key is in a file, on the screen that
    /// lists their devices. The alternative to the file is that installation
    /// having no remote access at all, so this is a disclosure rather than a
    /// setting.
    #[serde(rename = "deviceKeyAtRest")]
    pub device_key_at_rest: Option<String>,
    /// Whether this shell can open a folder panel — see {@link PICKS_FOLDER}.
    ///
    /// **A declared capability rather than something the page infers.** The page
    /// could have keyed the panel on `platform`, but `HostPlatform` narrows
    /// `"android"` to `"other"` along with every future desktop target, so that
    /// would be a guess that reads as a fact. It could also have relied on the
    /// accident that a phone has no local daemon and therefore never matches
    /// `localMachineId` — which is true today and is luck, not a rule.
    ///
    /// ⚠ **This field and these paragraphs were spliced into the middle of
    /// `device_id`'s docblock**, so the ⚠ about the load-bearing `rename` read as
    /// documentation for the folder panel and `device_id` — the field that
    /// `rename` protects and that the census below exists for — carried no
    /// docblock at all. Nothing can catch that: a doc comment binds to whatever
    /// follows it, both fields kept their attributes, and every driver stayed
    /// green. Moved rather than reworded, and the two declared capabilities sit
    /// together now so the next one has an obvious home.
    #[serde(rename = "picksFolder")]
    pub picks_folder: bool,
    /// Whether a daemon could be on *this* computer at all — see
    /// {@link CAN_HOST_DAEMON}.
    ///
    /// **What the page does with it is refuse to ask.** The five wrappers in
    /// `native.ts` answer `null`, `[]` or a sentence without reaching the bridge,
    /// so the setup flow, the log screen and `localRoute.ts`'s probe are all off
    /// on a platform where none of them can end anywhere.
    ///
    /// ⚠ **The host's `"unsupported"` is still underneath and is not what this
    /// replaces.** That one is a fact about the *bundle* — `Payload::locate`
    /// finding nothing staged — so it is per build and per overlay and could
    /// never be a compile-time constant. This one is a fact about the *platform*.
    /// A desktop client build keeps answering `true` here and `"unsupported"`
    /// there, which is what leaves `host_local_daemon` reaching a daemon
    /// `deploy/install.sh` put on a Linux box.
    #[serde(rename = "canHostDaemon")]
    pub can_host_daemon: bool,
    /// The address this build suggests, for the setup screen's field to open on.
    ///
    /// ⚠ **A suggestion, and never `server`.** They are different questions —
    /// *what shall I put in the box* against *which fleet is this installation
    /// on* — and the first draft answered them with one field by seeding the
    /// default into `server.json` on first run. That skipped the setup screen
    /// entirely, so the app chose somebody's fleet and told them afterwards, and
    /// it made a `credential#<origin>` keyring account for an origin nobody had
    /// confirmed. Two fields, and only the second one is ever written down.
    ///
    /// `None` in this repository: nothing here compiles a default in, which
    /// `nativecheck` asserts the way it asserts `signingIdentity: null`.
    #[serde(rename = "defaultServer")]
    pub default_server: Option<String>,
}

#[tauri::command]
pub fn host_boot(app: AppHandle, host: State<'_, Host>) -> Boot {
    let server = host.origin();
    let credential = server.as_deref().and_then(credential::read);
    // Read from the same origin the credential was, and in the same breath, so
    // the two cannot answer about different servers.
    let device_id = server
        .as_deref()
        .and_then(|origin| config::read_device(&host.config_dir, origin));
    // The same origin again, and in the same breath, for the reason the device id
    // is read here: three answers about three different servers is the shape this
    // function exists to make impossible.
    let device_key = server
        .as_deref()
        .and_then(|origin| device::ensure_key(&host.config_dir, origin).ok());
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
    }
}

/// One Diffie-Hellman with this installation's device key.
///
/// The page runs the Noise handshake — `native-shell.md` gives four reasons the
/// daemon leg may not leave the webview, and one of them is that an encrypted
/// stream with two decryptors is not a design — so the two operations in the IK
/// pattern that need the *static* key come back here. Every other operation uses
/// an ephemeral the page generated and holds itself.
///
/// ⚠ **This is a Diffie-Hellman oracle scoped to the page, and naming it as one
/// is the point.** Anything running in the webview can ask for `DH(device, X)` for
/// an `X` it chooses. That is strictly less than holding the key — it cannot be
/// exported, survives no copy, and is gone when the origin changes — and it is the
/// same trust boundary `host_credential_set` already sits on, which hands over the
/// fleet credential outright.
///
/// ⚠ **`(async)`, and on this command that is the hot path itself.** The work
/// here is an OS keyring read — on macOS a `securityd` IPC round trip rather than
/// a memory lookup — plus an X25519 scalar multiplication, and the IK handshake
/// crosses this bridge **twice**: `ss` in message 1 and `se` in message 2.
/// `e2ee.ts` holds a pool rather than a multiplexer with `MAX_IDLE_CONNECTIONS`
/// of 2, so any burst — the four-second poll fanning out across a fleet, or a
/// wake — dials fresh connections and pays two blocking keychain reads *each*.
/// Every byte of remote traffic now sits behind this call, which makes it the
/// last thing in this file that may hold the thread the webview paints on.
///
/// **The two reads are still two, and that is a file-ownership fact rather than a
/// judgement.** Caching the decoded static in `Host` after the first successful
/// read would make a handshake one keyring hit; the process holds the key in
/// memory for the length of the DH anyway, so it costs no exposure that is not
/// already taken. But `device::read_secret` is private and the at-rest policy it
/// implements — keyring first on *every* read, file fallback second, a keyring
/// answer retiring the file — is deliberately in one place. A cache here would be
/// a second copy of that policy in a module that has no other reason to know it,
/// so it belongs in `device.rs`, beside the only reader.
#[tauri::command(async)]
pub fn host_device_dh(peer: String, host: State<'_, Host>) -> Result<String, String> {
    let origin = host.origin().ok_or("no server has been chosen")?;
    device::diffie_hellman(&host.config_dir, &origin, &peer)
}

/// Start this installation over with a fresh device key on the chosen server.
///
/// Two cases, one act: a credential store that was reset out from under the app,
/// and somebody deliberately re-keying from Settings → Devices. The old key is
/// given up first, so a failure part-way leaves no installation holding a key the
/// server has never heard of.
///
/// ⚠ **`(async)`, because re-keying is three stores in a row.** A keyring erase, a
/// `server.json` write to drop any fallback copy, and then `ensure_key`: fresh
/// randomness, a keyring write **verified by reading it back** (`device.rs` says
/// why the `Ok` cannot be trusted), and on a machine where that read-back fails, a
/// second durable `server.json` write. Each of those writes flushes the file and
/// its directory entry, so on macOS this is several `F_FULLFSYNC`s and two or more
/// `securityd` round trips in one command.
#[tauri::command(async)]
pub fn host_device_key_reset(host: State<'_, Host>) -> Result<DeviceKey, String> {
    let origin = host.origin().ok_or("no server has been chosen")?;
    device::reset_key(&host.config_dir, &origin)
}

/// Is there a daemon on *this computer*, and which machine is it?
///
/// A separate call rather than a field on {@link Boot}, because a daemon can start
/// after the app does — and usually has, on a laptop where both come up at login.
/// The client re-asks; a boot payload would be a one-shot answer to a question
/// whose answer changes.
///
/// `None` for every failure, including the ordinary one of there being no daemon
/// here. `local::read` is where the refusals are, and loopback is enforced inside
/// it so the page never sees the parts an address was built from.
///
/// ⚠ **`is_alive` before the base leaves this process, because the caller spends a
/// machine token on it.** `machine.ts`'s `proveLocal` sends `Authorization: Bearer`
/// to whatever this answers, and `.claude/rules/relay.md` states what that costs
/// if the listener is not the daemon: a 300-second bearer, spendable **through the
/// relay from anywhere**. The file being unplantable by another uid closes only
/// half of it — `src/announce.ts` cannot remove its file on a SIGKILL, a crash or a
/// power cut, `REEMOAT_PORT` is a fixed 7887 by decision, and anything may hold an
/// ordinary port afterwards. `host_daemon_state` already applies exactly this
/// filter, with a ⚠ saying exactly this; it was the *status* path that had the
/// proof and the token-bearing path that did not.
///
/// It costs one `/health` round trip against `PROBE_TIMEOUT`, and `localRoute.ts`
/// asks this once per route resolution — a wake or a fifteen-second retry, never
/// the four-second poll. ⚠ **It also does not memoise, on purpose**, so a fleet of
/// N machines resolving after a wake is N of these one after another, each worth a
/// connect, a write and a read against that timeout: three quarters of a second
/// apiece against a port that is stale and filtered rather than refused.
///
/// This docblock used to end *"it is paid on **this** thread, which is the main
/// one until this command is `#[tauri::command(async)]`"* — a standing TODO
/// written as prose, which is the shape of comment this repository keeps finding
/// on the wrong side of the code it describes. It is the attribute now, so the
/// probe is paid on the async runtime and the webview goes on painting through it.
#[tauri::command(async)]
pub fn host_local_daemon(app: AppHandle) -> Option<LocalDaemon> {
    let home = app.path().home_dir().ok()?;
    local::read(&home).filter(|found| daemon::is_alive(&found.base, &found.instance_id))
}

/// Adopt a server, and give up the previous one's sign-in in the same act.
///
/// The erase is not tidiness. A credential this app is no longer going to present
/// is one it has no reason to keep, and doing it here — rather than on some later
/// sign-out that may never happen — is what makes "no credential is retained for a
/// server you are not using" true of the act rather than of an intention.
///
/// ⚠ **`(async)`, because both halves of that act wait on a store.** The write is
/// a durable `server.json` — the bytes and the directory entry, the first of
/// which is a full device cache flush on macOS and the second of which
/// `config::sync_dir` states the measured limits of — and the erase is a
/// `securityd` IPC round trip. Neither was ever free; the durability fix is what
/// made the first of them expensive enough to stop pretending otherwise.
///
/// Nothing here reaches the event loop — `State` and a `Mutex`, no `AppHandle` —
/// so there is no reentrancy the attribute could turn into a deadlock.
#[tauri::command(async)]
pub fn host_set_server(url: String, host: State<'_, Host>) -> Result<String, String> {
    let origin = config::normalize_origin(&url)?;
    let previous = host.origin();
    if previous.as_deref() == Some(origin.as_str()) {
        return Ok(origin);
    }
    config::write_server(&host.config_dir, &origin)?;
    if let Some(previous) = previous {
        let _ = credential::erase(&previous);
    }
    if let Ok(mut held) = host.server.lock() {
        *held = Some(origin.clone());
    }
    Ok(origin)
}

#[tauri::command]
pub fn host_credential_set(value: String, host: State<'_, Host>) -> Result<(), String> {
    let origin = host.origin().ok_or("no server has been chosen")?;
    credential::write(&origin, &value)
}

#[tauri::command]
pub fn host_credential_clear(host: State<'_, Host>) -> Result<(), String> {
    let Some(origin) = host.origin() else {
        return Ok(());
    };
    credential::erase(&origin)
}

/// Remember which device this server registered us as.
///
/// Scoped to the chosen origin, like the credential beside it, so an id issued by
/// one control plane can never be offered to another — which matters more than it
/// looks: that id names a row in *that* server's table, and presenting it
/// elsewhere would at best register a stranger's-looking device and at worst be a
/// value from a fleet this person does not administer.
///
/// Unlike the credential, this is **not** erased when the server changes. See
/// `config.rs`: the row on the old server still exists, so forgetting the id
/// leaves an installation nobody can recognise in their own list and spends a
/// second slot the next time they point back.
///
/// ⚠ **`(async)`, for the durable write.** `config.rs` flushes the file *and* the
/// directory entry that names it, because an `fsync` on the bytes alone leaves the
/// rename unguaranteed — and this is the one call on the sign-in path, so a device
/// registration is not a thing to stop the window drawing for.
#[tauri::command(async)]
pub fn host_device_set(value: String, host: State<'_, Host>) -> Result<(), String> {
    let origin = host.origin().ok_or("no server has been chosen")?;
    config::write_device(&host.config_dir, &origin, &value)
}

/// Give up the device recorded for the chosen server.
///
/// Called when the control plane answers `device_revoked` — the one refusal that
/// means this installation's id is finished rather than its session. Without it
/// the next sign-in would offer the retired id again; the server declines to bind
/// it and registers a fresh device, so the loop terminates either way, but the app
/// would go on presenting something it has been told is dead.
///
/// ⚠ **`(async)` for the same durable write as `host_device_set`**, and left bare
/// it would have been the odder of the two: this one fires on a `device_revoked`
/// answer, which arrives mid-session while somebody is looking at the app.
#[tauri::command(async)]
pub fn host_device_clear(host: State<'_, Host>) -> Result<(), String> {
    let Some(origin) = host.origin() else {
        return Ok(());
    };
    config::erase_device(&host.config_dir, &origin)
}

/// The `/v1/*` leg. See `proxy.rs` for why it is the only one here.
#[tauri::command]
pub async fn host_cp(req: CpRequest, host: State<'_, Host>) -> Result<CpAnswer, String> {
    // A candidate origin is accepted **only** from the server picker, which is
    // asking "is there a Reemoat at this address" before anything is stored. It is
    // normalized here rather than trusted, so the probe cannot reach a shape
    // `host_set_server` would have refused.
    let base = match &req.origin {
        Some(candidate) => config::normalize_origin(candidate)?,
        None => host.origin().ok_or("no server has been chosen")?,
    };
    proxy::send(&host.client, &base, &req).await
}

#[tauri::command]
pub fn host_copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// The schemes a link may open, and this list is a **second copy on purpose**.
///
/// The policy is `OPENABLE` in `packages/web/src/ui/links.ts`, which is where the
/// argument lives — everything outside it is *"launching a program named by an
/// agent-chosen string"*, on a page that renders agent output. The webview
/// already applies it; this is the half that holds if the page is ever wrong, and
/// `pnpm nativecheck` reads both lists off disk and asserts they are the same set,
/// which is what stops a second copy from becoming a second policy.
const OPENABLE_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

#[tauri::command]
pub fn host_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "not a link".to_string())?;
    if !OPENABLE_SCHEMES.contains(&parsed.scheme()) {
        return Err("refused: not a scheme this opens".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Hand a file to the person who asked for it, through the platform's own panel.
///
/// **Raw bytes, never JSON.** The client's download bound is 100 MiB
/// (`MAX_DOWNLOAD_BYTES`), and 100 MiB as a JSON array of numbers is roughly
/// 600 MB of string — so this takes `tauri::ipc::Request`, whose body arrives as
/// bytes over Tauri's own IPC protocol, and the filename rides in a header because
/// a header is the only other field a raw request has.
///
/// Answers `false` where the panel was dismissed, which is not a failure and must
/// not be drawn as one.
///
/// ⚠ **`(async)`, and `tauri-plugin-dialog` documents this as the only correct
/// way to call it.** `blocking_save_file` carries *"this is a blocking operation,
/// and should **NOT** be used when running on the main thread"*, for a mechanical
/// reason rather than a stylistic one: the panel's result is delivered *by* the
/// main event loop, so a main-thread command that blocks waiting for it is waiting
/// on the loop it is itself holding — a frozen window while the panel is open at
/// best, and a deadlock at worst. The plugin's own `save` command is an `async fn`
/// wrapped around exactly this call, which is the shape being copied here.
///
/// The `std::fs::write` underneath is the second reason and stands on its own:
/// `MAX_DOWNLOAD_BYTES` is 100 MiB, and 100 MiB to a spinning disk or a network
/// volume is not something to do between two paints even if the panel were free.
#[tauri::command(async)]
pub fn host_save_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file as bytes".into());
    };
    let encoded = request
        .headers()
        .get("x-reemoat-filename")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("download");
    let name = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| "that filename is not text".to_string())?
        .to_string();

    let chosen = app
        .dialog()
        .file()
        .set_file_name(&name)
        .blocking_save_file();
    let Some(path) = chosen else {
        return Ok(false);
    };
    let path = path
        .into_path()
        .map_err(|e| format!("could not use that location: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write the file: {e}"))?;
    Ok(true)
}

/// Ask this computer for a folder, through the platform's own panel.
///
/// Called for exactly one machine: the one this app is running on. That is
/// **not** enforced here and could not be — the shell has no idea which daemon a
/// page is talking to — it is `NewSession.tsx`'s predicate, and
/// `webcheck.local-route.ts` is what holds it there. What this side guarantees is
/// narrower and is the honest half: the panel shows *this* computer's disk, and
/// so a path it answers is only ever meaningful about this computer.
///
/// Answers `None` where the panel was dismissed. **A cancel is not a failure**,
/// and drawing it as one is a lie about what the person just did —
/// `host_save_file`'s `Ok(false)` is the same distinction one command up.
///
/// `start` is a **hint and never a boundary.** A panel can be walked anywhere, so
/// checking it is about landing somewhere useful rather than about safety — which
/// is the opposite of `host_cp`'s origin, where the comparison is the only thing
/// standing between the page and a credential going somewhere nobody chose. A
/// seed that is relative, gone, or not a directory is ignored rather than
/// refused: a seed that cannot be honoured must not stop a panel opening.
///
/// ⚠ **`(async)`, for `host_save_file`'s reason exactly.**
/// `blocking_pick_folder` carries the same *"should **NOT** be used when running
/// on the main thread"* as its sibling, because the panel's result is delivered
/// *by* the main event loop — so a main-thread command blocking on it waits on the
/// loop it is itself holding.
#[tauri::command(async)]
pub fn host_pick_folder(app: AppHandle, start: Option<String>) -> Result<Option<String>, String> {
    pick_folder(app, start)
}

/// The real one, on the platforms that have a folder panel to open.
///
/// ⚠ **Split into two functions rather than gated at the declaration**, and both
/// halves of that are deliberate. The *body* is what is platform-specific —
/// `blocking_pick_folder` does not exist on mobile — while the **command must go
/// on existing everywhere**: three separate censuses read this file and `lib.rs`
/// as text (`nativecheck`'s declared-against-registered, and
/// `webcheck.native-bridge.ts`'s two), and a `#[cfg]` on the declaration or on the
/// `generate_handler!` line would leave all three asserting a surface that is not
/// the one a mobile build actually has. `credential.rs` aliases its two `Entry`
/// types the same way and for the same reason: one body at the call site, the
/// platform difference resolved above it.
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
    // `to_str().unwrap()` is the one line that turns a mounted volume into a
    // panic. APFS enforces UTF-8 so this arm is unreachable on the platform this
    // ships on, and it is written for the ones it does not — the same shape as
    // `host_save_file`'s "that filename is not text".
    path.into_os_string()
        .into_string()
        .map(Some)
        .map_err(|_| "that folder's name is not text".to_string())
}

/// ⚠ **Android and iOS have no folder panel, and this is what that cost.**
///
/// `tauri-plugin-dialog` 2.7.3 offers `blocking_pick_file` on mobile and **not**
/// `blocking_pick_folder`: Android's equivalent is `ACTION_OPEN_DOCUMENT_TREE`
/// through the Storage Access Framework, which hands back a tree *URI* rather than
/// a filesystem path, and the plugin does not wrap it. `host_save_file` survives
/// beside this only because a *file* panel does have a mobile arm.
///
/// Found by an APK build failing to compile, after `pnpm check`, `cargo clippy`
/// and 74 `cargo test`s were all green — **none of them compiles for
/// `aarch64-linux-android`**, so every one of them was honest and beside the
/// point. `nativecheck` now carries the static half of that lesson; the whole of
/// it is that a second target is not covered until something builds for it.
///
/// Unreachable in practice: {@link Boot::picks_folder} is `false` on this arm, so
/// `NewSession.tsx` never draws the control that would call it. It answers rather
/// than panicking because "the page should never ask" is not a reason to make
/// asking fatal.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn pick_folder(_app: AppHandle, _start: Option<String>) -> Result<Option<String>, String> {
    Err("this platform has no folder panel".to_string())
}
