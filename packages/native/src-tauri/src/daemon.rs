//! The daemon this app carries, and how it is started.
//!
//! `local.rs` answers *"is there a daemon on this computer worth showing a token
//! to?"* by reading a file the daemon wrote. This module answers the question that
//! only exists once the app is **responsible** for one: *"is there a daemon
//! because I started it, and if not, why not?"*
//!
//! ⚠ **The two must not be merged.** `local.rs` answers `None` to every failure on
//! purpose — its caller has one question and it is not "why not". That is right
//! for a daemon somebody else installed with `deploy/install.sh`. It is wrong for a
//! daemon this app launched: answering `None` to a process that exited two seconds
//! ago is the app hiding a failure it caused. So `local.rs` stays exactly as it is
//! and this is a second question with its own answer type.
//!
//! ## A child process, not a service
//!
//! The daemon is an ordinary child of this app and dies with it. Surviving a quit
//! is a **switch**, off by default.
//!
//! That is a reversal, and the reason is prior art rather than taste.
//! `getpaseo/paseo` is the same shape of product — a Node daemon owning
//! coding-agent sessions behind a desktop client, worktrees and all — and it runs
//! its daemon as a plain child with `daemon.keepRunningAfterQuit` defaulting to
//! **false**, registering no `LaunchAgent` and no `SMAppService` at all; always-on
//! is a separate CLI install. Two things follow. A login item macOS shows in
//! System Settings is a thing the user can switch off, which would revoke
//! "survives a quit" silently — so making it the default is building on something
//! that can vanish. And a child process needs no entitlement, no registration API
//! and no uninstall story: quitting the app is the uninstall.
//!
//! ## What it will not do
//!
//! **It never starts a daemon that is already there.** Each state root's
//! `reemoat.db` holds one identity and `claimDaemonLock` refuses a second process
//! against it, so a machine installed by `deploy/bootstrap.sh` is *adopted* — read
//! through `local.rs` like any other — and never raced. The same rule is what stops
//! a second control-plane machine being created for one computer, which would burn
//! a quota slot until a person notices and revokes it — the count is
//! `machine_owners` rows, and a revoke is what releases one.
//!
//! **One database is one machine on one server for one person, so there is a
//! root per account.** A server's *first* account — its owner, `server.json`'s
//! `roots` — keeps the root `state_root` gives that server: `~/.reemoat` for the
//! server its `daemon.env` names, the one `deploy/install.sh` and launchd know
//! about, untouched, and `~/.reemoat/servers/<server>/` for every other. **Every
//! other account on that server gets `servers/<server>@<user id>/`**
//! (`guest_root`), which is never the legacy root. Each has a `Supervisor` of its
//! own, started at launch where its root is already set up
//! (`start_configured_at_launch`) or the first time its page sets it up, and all of
//! them stopped together when the app quits. Re-enrolling one database back and
//! forth was the alternative, and it is refused in Q7.148: the identity is a single
//! row, and a daemon that checks `aud` and never the subject would serve every
//! session in it to whoever holds a grant on the new server. Q7.149 extends the
//! same argument from servers to people.
//!
//! **And it never kills a daemon it did not start.** `Instance` records the pid and
//! the start time of the child this app launched; a daemon whose file says
//! otherwise is somebody else's and is left running.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Where the payload and the runtime are, relative to this process.
///
/// **One code path for the bundle and for `tauri dev`**, which is worth stating
/// because it looks like it should need two. `tauri-build` copies
/// `bundle.resources` into `target/<profile>/` during `build.rs`, and Tauri's own
/// `resource_dir()` answers that directory in a development build and
/// `Contents/Resources` in a bundle. The runtime is found from the executable by
/// {@link runtime_beside}, and on macOS by one relative path in both layouts —
/// see there for why the staging directory was chosen to make that true.
pub struct Payload {
    /// The daemon's own tree: `src/`, `scripts/`, `deploy/`, `node_modules/`.
    pub root: PathBuf,
    /// The Node binary the daemon runs under.
    pub node: PathBuf,
}

/// The development escape hatch: run the daemon from a checkout, not the copy.
///
/// ⚠ **Without this there is no usable loop for daemon work through the app.** The
/// payload is a *snapshot* taken by `build-daemon.mjs` and copied again by
/// `build.rs`, and `resource_dir()` answers that copy in `tauri dev` exactly as it
/// does in a bundle — measured, not assumed. So editing `src/session.ts` and
/// pressing reload shows the old code, with nothing anywhere saying why. Pointed at
/// a checkout, this runs the tree somebody is actually editing.
///
/// ⚠ **Development builds only, and that is a deliberate refusal rather than
/// caution.** It names a directory this process will execute as the user, so in a
/// shipped app it would be a way to make somebody else's Reemoat run somebody
/// else's code by setting one variable. `lib.rs`'s navigation guard is gated the
/// same way and for the same reason — a door that is fine on a developer's machine
/// is not fine in an application people install.
const PAYLOAD_OVERRIDE: &str = "REEMOAT_DAEMON_PAYLOAD";

/// The helper app the runtime lives in on macOS.
///
/// Written down in `build-daemon.mjs`, `build.rs` and `tauri.conf.json`'s
/// `bundle.macOS.files` as well; `nativecheck` compares all four.
///
/// ⚠ **macOS only, like its one reader.** Only the macOS arm of
/// {@link runtime_beside} names it, so on every other target it is dead code, and
/// the `native-android` job's `clippy --target aarch64-linux-android -- -D warnings`
/// refuses the crate over it — which a clippy run on a Mac cannot show.
#[cfg(target_os = "macos")]
pub const RUNTIME_HELPER: &str = "Reemoat Runtime.app";

/// The Node binary the daemon runs under, found from this process's executable.
///
/// ⚠ **On macOS it is not beside the executable, and that is the fix for the Dock.**
/// It is `Contents/Helpers/Reemoat Runtime.app/Contents/MacOS/node`, a bundle of
/// its own whose `Info.plist` carries `LSUIElement`. libuv registers a process with
/// LaunchServices when `process.title` is set — npm sets one for every MCP server
/// an agent starts through `npx` — and a binary in `Contents/MacOS` was registered
/// as a Foreground application of *this* bundle, which drew a blank "exec" tile in
/// the Dock for each of them. `build-daemon.mjs` carries the measurements.
///
/// **One relative path for the bundle and a development build.** The executable is
/// `Contents/MacOS/<app>` in one and `target/<profile>/<app>` in the other, and the
/// helper is staged at `target/Helpers` so that `<exe>/../../Helpers` lands on
/// `Contents/Helpers` and on `target/Helpers` alike. `build.rs` copies it beside a
/// profile directory that is not under `src-tauri/target`.
///
/// Elsewhere it is beside the executable, which is where `tauri-build` puts an
/// `externalBin`. No overlay ships a runtime today, so `locate` refuses on the
/// payload before this matters; it is the layout such a platform would have.
#[cfg(target_os = "macos")]
pub fn runtime_beside(exe: &Path) -> Option<PathBuf> {
    Some(
        exe.parent()?
            .parent()?
            .join("Helpers")
            .join(RUNTIME_HELPER)
            .join("Contents")
            .join("MacOS")
            .join("node"),
    )
}

/// See the macOS arm above: beside the executable, where an `externalBin` lands.
#[cfg(not(target_os = "macos"))]
pub fn runtime_beside(exe: &Path) -> Option<PathBuf> {
    Some(exe.parent()?.join("node"))
}

impl Payload {
    pub fn locate(resource_dir: &Path, exe: &Path) -> Option<Payload> {
        let node = runtime_beside(exe)?;
        /*
         * The checkout wins when one is named, and only in a development build.
         * The *runtime* is still the bundled one: what is being swapped is the
         * code, not the Node it runs under, so a checkout is exercised against the
         * same binary that will ship.
         */
        if cfg!(debug_assertions) {
            if let Some(dir) = std::env::var_os(PAYLOAD_OVERRIDE) {
                let root = PathBuf::from(dir);
                if root.join("scripts").join("daemon.ts").is_file() && node.is_file() {
                    return Some(Payload { root, node });
                }
            }
        }
        let root = resource_dir.join("daemon");
        // Both, or neither. A payload with no runtime is a staging step that ran
        // half way, and reporting it as "no daemon here" would send somebody
        // looking at the control plane for a build problem.
        if !root.join("scripts").join("daemon.ts").is_file() || !node.is_file() {
            return None;
        }
        Some(Payload { root, node })
    }
}

/* ── which directory a server's daemon lives in ──────────────────────────── */

/// `~/.reemoat` — the root `deploy/install.sh`, launchd and every hand-started
/// daemon use, and the one a server keeps when its `daemon.env` is there.
pub fn legacy_root(home: &Path) -> PathBuf {
    home.join(".reemoat")
}

/// The directory under the legacy root that holds one folder per other server.
const SERVERS_DIR: &str = "servers";

/// A server's folder name under `~/.reemoat/servers`.
///
/// `https://app.reemoat.com` → `https_app.reemoat.com`, and
/// `http://127.0.0.1:7890` → `http_127.0.0.1_7890`: every `_` doubled first, then
/// the scheme's `://` and the port's `:` each written as one `_`.
///
/// ⚠ **Injective, and the doubling is what makes it so.** Underscore is legal in a
/// host, so without it `http://a.b:8080` and `http://a.b_8080` would share a folder
/// — which `config_state` would catch as `elsewhere`, a permanent refusal whose
/// remedy (move the folder aside) strands the *other* server's database. With it
/// the second is `http_a.b__8080`. The scheme is kept, because `http://` and
/// `https://` are different trust boundaries and must not share a database.
///
/// The input is always a canonical origin — a seat's, which `normalize_origin`
/// produced on the way in and `read_server` re-normalizes on the way out — so it
/// carries no path, no `/` after the scheme and no `\`. The last arm writes those
/// as `_` anyway, so the answer is one path component by construction rather than
/// by the caller's good behaviour. It never carries `@`, which is what keeps a
/// guest's `<slug>@<user id>` from ever being a server's own folder
/// (`guest_root`).
pub fn server_slug(origin: &str) -> String {
    origin
        .replace('_', "__")
        .replacen("://", "_", 1)
        .chars()
        .map(|c| match c {
            ':' | '/' | '\\' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect()
}

/// Where one account's daemon keeps its database, its worktrees and its env file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateRoot {
    pub dir: PathBuf,
    /// `~/.reemoat` itself — the root a service unit can source, the one whose
    /// port stays 7887, and the only one `managed_unit` is asked about.
    pub legacy: bool,
}

impl StateRoot {
    pub fn env_file(&self) -> PathBuf {
        env_path(&self.dir)
    }
}

/// Whether a root holds nothing a daemon left, or might have.
///
/// ⚠ **"Could not tell" is not "empty"**, for `config_state`'s reason: the one
/// thing that must not happen is somebody else's state being treated as an empty
/// slot. So an existence check that errors counts as present. `daemon.json` is
/// on the list beside the env file and the database because it is the one trace a
/// live daemon with both of those elsewhere (`REEMOAT_ENV_FILE`, `REEMOAT_DB`)
/// still leaves here — and giving that root to a new server would put two daemons
/// on one announcement and one port.
pub fn holds_no_daemon(root: &Path) -> bool {
    ["daemon.env", "reemoat.db", "daemon.json"]
        .iter()
        .all(|name| matches!(root.join(name).try_exists(), Ok(false)))
}

/// Which root a server's daemon gets — the server's **owner's**, and a legacy
/// seat's (`accounts::Slot::root`); every other account on the server has a
/// `guest_root`. First match wins.
///
/// 1. **`~/.reemoat`, when its `daemon.env` names this server.** The launchd or
///    `install.sh` daemon keeps working exactly as it did, and this app adopts it.
/// 2. **`~/.reemoat/servers/<server>`, when that folder already has an env file.**
///    Once a server has a folder it keeps it, whatever happens to the legacy root
///    afterwards.
/// 3. **`~/.reemoat`, on a computer with nothing there** — no env file, no
///    database, no announcement — **and no service unit left behind.** This keeps
///    "`install.sh` can take over what the app set up" true for the first server.
///    ⚠ The unit half is not decoration: `host_daemon_start`'s refusal needs an env
///    file to exist, so a leftover plist beside an empty `~/.reemoat` used to be
///    handed the file this app then wrote, and launchd raced its child for the code.
/// 4. **`~/.reemoat/servers/<server>`** for everything else.
///
/// ⚠ **Asked on every state read rather than remembered**, because every answer is
/// a fact about the disk that can change under a running app — `install.sh`
/// writing the legacy file, somebody moving a folder aside — and a remembered root
/// would go on reading a folder that is no longer this server's. Q7.148.
pub fn state_root(home: &Path, origin: &str) -> StateRoot {
    let legacy = legacy_root(home);
    if config_state(&legacy, Some(origin)) == CONFIG_HERE {
        return StateRoot {
            dir: legacy,
            legacy: true,
        };
    }
    let own = legacy.join(SERVERS_DIR).join(server_slug(origin));
    if !matches!(env_path(&own).try_exists(), Ok(false)) {
        return StateRoot {
            dir: own,
            legacy: false,
        };
    }
    if holds_no_daemon(&legacy) && managed_unit(home).is_none() {
        return StateRoot {
            dir: legacy,
            legacy: true,
        };
    }
    StateRoot {
        dir: own,
        legacy: false,
    }
}

/// The root a server's **owner** gets: `state_root`'s, except that `~/.reemoat`
/// is handed out for being empty to one origin only.
///
/// ⚠ **Rule 3 of `state_root` is a fact about the disk at one instant**, and two
/// accounts on two servers being set up together at launch can both see an empty
/// `~/.reemoat` before either writes into it — so both would be answered the
/// legacy root, the second `Supervisor::start` would return `Ok` over nothing, and
/// at the next launch rule 1 would hand the folder to whichever wrote its env file
/// last. `ROOT_LOCK` serialises the writes; this is the other half, which makes
/// the answer itself stable: `holder` is `server.json`'s `legacy_root_holder`, the
/// origin recorded as having been handed the empty folder, and any other origin
/// asking rule 3 is sent to a folder of its own. Rule 1 — a file that already
/// names this server — is unaffected.
pub fn owner_root(home: &Path, origin: &str, holder: Option<&str>) -> StateRoot {
    let root = state_root(home, origin);
    match holder {
        Some(held)
            if root.legacy
                && held != origin
                && config_state(&root.dir, Some(origin)) != CONFIG_HERE =>
        {
            StateRoot {
                dir: legacy_root(home)
                    .join(SERVERS_DIR)
                    .join(server_slug(origin)),
                legacy: false,
            }
        }
        _ => root,
    }
}

/// The root of an account that is not its server's owner:
/// `~/.reemoat/servers/<server>@<user id>`.
///
/// ⚠ **Never the legacy root**, so its daemon is always on the kernel's port
/// (`Spawn.ephemeral_port = !root.legacy`) and no install.sh unit is ever asked
/// about it. **Injective**: `@` cannot occur in a slug and
/// `accounts::is_user_id` refuses it in a user id, so no guest's folder is
/// another's or a server's own. `ensure_root` builds the chain to it at `0700`
/// like any other root of its own.
pub fn guest_root(home: &Path, origin: &str, user: &str) -> StateRoot {
    StateRoot {
        dir: legacy_root(home)
            .join(SERVERS_DIR)
            .join(format!("{}@{user}", server_slug(origin))),
        legacy: false,
    }
}

/// Where to look for a daemon's announcement, in order.
///
/// **This account's root first, then `~/.reemoat`.** The first is the daemon this
/// app runs for the account; the second keeps reaching a daemon
/// `deploy/install.sh` set up, or one started by hand with no `REEMOAT_HOME`,
/// which is what a client build with no payload depends on (`native-packaging.md`).
/// A machine id in the legacy file that belongs to another fleet costs nothing:
/// the page checks it against the machine it wants and declines a mismatch.
///
/// ⚠ **A guest is answered its own root and nothing else** (`include_legacy`
/// false). `~/.reemoat` is its server's owner's, or install.sh's: handing a
/// guest's page that daemon's machine id and loopback port is handing it another
/// person's machine — and where the owner has shared that machine with the guest,
/// the setup flow's adoption would take it as this account's own and never give
/// the guest the machine of its own an account is promised. Q7.149.
pub fn announce_roots(home: &Path, own: Option<&Path>, include_legacy: bool) -> Vec<PathBuf> {
    let legacy = legacy_root(home);
    let Some(own) = own else {
        return vec![legacy];
    };
    if own == legacy.as_path() {
        vec![legacy]
    } else if include_legacy {
        vec![own.to_path_buf(), legacy]
    } else {
        vec![own.to_path_buf()]
    }
}

/// One root chosen and one daemon started at a time, across every account.
///
/// ⚠ **Held from `state_root` through `Supervisor::start`**, because each step
/// reads what the one before it wrote: rule 3 looks at the legacy root, the env
/// file is written into the root it chose, and the start reads that file back.
/// Two accounts interleaved there is two servers in one database. Every path that
/// takes it is off the main thread — `host_daemon_start` carries `(async)` and the
/// launch start runs on a thread of its own — and nothing takes it while holding a
/// `Host` lock.
static ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `ROOT_LOCK`, taken even where an earlier holder panicked: the guarded value is
/// `()`, so there is no half-built invariant to refuse over.
pub fn lock_roots() -> std::sync::MutexGuard<'static, ()> {
    ROOT_LOCK.lock().unwrap_or_else(|held| held.into_inner())
}

/// Start, at launch, every account's daemon that is already set up — whether or
/// not any page is alive to ask for it.
///
/// ⚠ **The host owns the daemons, not the pages.** Every account's daemon runs
/// from app launch to quit (D2), and a page cannot be relied on to start one: in
/// the single-webview arm only the account on screen has a page at all, and a
/// hidden `WKWebView` is suspended by macOS 14 and later after about five
/// minutes. So this is the adoption path — no enrollment code, a file that
/// already names the server — taken for each root, the way the setup flow takes
/// it: nothing is provisioned and no machine is created here.
///
/// A root is skipped where its env file does not name its server, and where a
/// daemon this app did not start is alive there already — `claimDaemonLock` would
/// refuse a second process against one database, which the setup flow reads as a
/// daemon that will not start. Failures are not reported: the page's setup flow
/// asks `host_daemon_state` and says what it finds.
///
/// Answers the roots it started, for a test.
pub fn start_configured_at_launch(
    payload: &Payload,
    home: &Path,
    roots: &[(StateRoot, String)],
    supervisor_for: &dyn Fn(&StateRoot) -> Option<std::sync::Arc<std::sync::Mutex<Supervisor>>>,
) -> Vec<PathBuf> {
    let mut started = Vec::new();
    let mut seen: Vec<&Path> = Vec::new();
    for (root, origin) in roots {
        if seen.contains(&root.dir.as_path()) {
            continue;
        }
        seen.push(&root.dir);
        let _held = lock_roots();
        if config_state(&root.dir, Some(origin)) != CONFIG_HERE {
            continue;
        }
        let Some(handle) = supervisor_for(root) else {
            continue;
        };
        let Ok(mut supervisor) = handle.lock() else {
            continue;
        };
        if supervisor.owns_running() {
            continue;
        }
        if crate::local::read_announced(&root.dir)
            .is_some_and(|found| is_alive(&found.daemon.base, &found.daemon.instance_id))
        {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(root.env_file()) else {
            continue;
        };
        let spawn = Spawn {
            root: root.dir.clone(),
            control_plane: origin.clone(),
            ephemeral_port: !root.legacy,
        };
        if supervisor
            .start(payload, home, &parse_env(&text), &spawn)
            .is_ok()
        {
            started.push(root.dir.clone());
        }
    }
    started
}

/// Create a root, and narrow every level of it to `0700`.
///
/// ⚠ **Every level, not only the last.** A writable `servers/` would let another
/// account plant a folder named for a server before this app creates it — an env
/// file naming a control plane of its choosing and an announcement naming a port
/// it holds, which is the harvested machine token `local.rs`'s whole file argument
/// exists to prevent. `DirBuilder::mode` so a directory is never wider than `0700`
/// for the length of a `chmod`, and the `chmod` afterwards for one that already
/// existed wider — `src/announce.ts` makes the same pair of moves for the same
/// reason. Best effort on the `chmod`, for `write_private`'s: a filesystem with no
/// modes is not a reason to refuse.
pub fn ensure_root(home: &Path, root: &StateRoot) -> Result<(), String> {
    let legacy = legacy_root(home);
    let mut chain = vec![legacy.clone()];
    if !root.legacy {
        chain.push(legacy.join(SERVERS_DIR));
        chain.push(root.dir.clone());
    }
    for dir in &chain {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
            match std::fs::DirBuilder::new().mode(0o700).create(dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("could not create {}: {e}", dir.display())),
            }
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        #[cfg(not(unix))]
        {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
    }
    Ok(())
}

/* ── the environment a daemon is started with ────────────────────────────── */

/// `<root>/daemon.env`, for a state root from `state_root`.
pub fn env_path(root: &Path) -> PathBuf {
    root.join("daemon.env")
}

/// The env file's whole content, for a machine this app is enrolling.
///
/// ⚠ **The same three keys `deploy/install.sh` writes, in the same file, in the
/// same format** — which is deliberate and is the property that keeps this from
/// becoming a fork. A machine set up by the app can afterwards be taken over by
/// the shell installer, and one set up by the installer is adopted by the app,
/// because neither can tell which wrote the file.
///
/// ⚠ **That takeover is a property of `~/.reemoat/daemon.env` alone.** A file under
/// `~/.reemoat/servers/<server>/` has the same three keys in the same format, and
/// `install.sh` still has no way to run a second daemon beside the first — its
/// unit label and its log path are one per account — so a server that is not the
/// legacy root's is reachable while this app runs and not after (Q7.148). Its
/// `REEMOAT_CONTROL_PLANE` line is a record for `config_state` rather than the value
/// the daemon enrolls with: the spawn passes the host's own origin over it.
///
/// ⚠ **The enrollment code is written to a `0600` file and never to argv.**
/// `deploy/bootstrap.sh` passes it on stdin for this reason: argv is readable by
/// every account on the host. A `0600` file inside the `0700` directory
/// `src/announce.ts` already creates is the same guarantee by a different
/// mechanism. It must also not go into a launchd plist, which is why the opt-in
/// service path still points at this file rather than inlining values.
pub fn env_contents(control_plane: &str, enroll_code: &str) -> String {
    let mut text = format!(
        "# Written by Reemoat.app. The same file `deploy/install.sh` writes.\n\
         REEMOAT_AUTH=signed\n\
         REEMOAT_CONTROL_PLANE={control_plane}\n\
         REEMOAT_ENROLL_CODE={enroll_code}\n"
    );
    /*
     * ⚠ **And the certificate, when this process was given one — because the
     * daemon cannot borrow this app's trust store.**
     *
     * `proxy.rs` reaches the control plane through Security.framework, so a
     * private CA in the macOS keychain is enough for *this* process. Node reads no
     * keychain and `--use-system-ca` does not close it, so the daemon needs the
     * path spelled out or it dies on `enroll` with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
     * — an app that set the machine up successfully and then produced a daemon
     * that will not start.
     *
     * Written into the file rather than only passed to the child, because the file
     * is what survives a restart and what the opt-in launchd path will read. A GUI
     * launch usually has none of this set, and then the line is simply absent —
     * which is correct for the ordinary case of a control plane with a public
     * certificate.
     */
    for name in [
        "NODE_EXTRA_CA_CERTS",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
    ] {
        if let Some(value) = std::env::var_os(name).and_then(|v| v.into_string().ok()) {
            // Refused rather than escaped: a newline would let one value write a
            // second assignment into a file `sh` sources, and nothing here needs a
            // certificate path clever enough to contain one.
            if !value.is_empty() && !value.contains('\n') && !value.contains('\r') {
                text.push_str(&format!("{name}={value}\n"));
            }
        }
    }
    text
}

/// How long the liveness probe is given, connect and answer alike.
///
/// Loopback, so this is a syscall rather than a network round trip; the timeout
/// exists for the pathological case — a socket whose backlog is full, or a process
/// wedged mid-answer — not for latency.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

/// The most of a `/health` answer this will read before giving up on it.
const PROBE_LIMIT: u64 = 8 * 1024;

/// Whether *this* daemon — the one the announce file describes — is still there.
///
/// ⚠ **The announce file is not evidence that a daemon is running, and treating
/// it as evidence strands this app permanently.** `src/announce.ts` writes it at
/// start and removes it on a clean stop — so an unclean one (a force quit, a
/// crash, a `kill -9`, a power cut) leaves it behind. `host_daemon_state` then
/// answers `foreign`, the setup flow returns at its status gate because somebody
/// else's daemon is apparently up, and **nothing ever starts one again** — on a
/// computer whose daemon dies with the app by design. The only way out was
/// deleting a file nobody tells you about.
///
/// ⚠ **And a bare connect is not enough, which is the second half of the same
/// bug.** `REEMOAT_PORT` is either fixed in the env file — 7887, on the legacy
/// root — or `0` and so a new port every start, on a root of its own; either way,
/// after an unclean exit the port named by a stale announce is an ordinary port
/// that anything may now hold — another dev server, a second daemon on a
/// different database, a proxy. A connect proves somebody is listening; it does not prove it
/// is the daemon this file describes, and answering `foreign` to a stranger is the
/// same permanent deadlock, just rarer.
///
/// `GET /health` proves it, and costs nothing to ask: `src/server.ts` lets that one
/// route past the auth middleware — *"the one route without a token"* — and it
/// answers the same `instanceId` the announce file holds. The rule `local.rs`
/// keeps is about not handing a **credential** to whatever answered, and this
/// sends no `authorization` header at all; it is written as a raw request over the
/// socket rather than through `reqwest` so that there is no configured client for
/// a later edit to attach one to.
pub fn is_alive(base: &str, instance_id: &str) -> bool {
    use std::io::{Read, Write};
    let Ok(url) = url::Url::parse(base) else {
        return false;
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port()) else {
        return false;
    };
    // `local::read` already refused anything but `127.0.0.1` and `::1`, so this
    // parses back what it built rather than trusting the file.
    let Ok(address) = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
    else {
        return false;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::new(address, port),
        PROBE_TIMEOUT,
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
    // HTTP/1.0 with an explicit close, so the answer ends at EOF and this needs no
    // chunked or keep-alive handling of its own.
    let request =
        format!("GET /health HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut raw = Vec::new();
    if (&mut stream)
        .take(PROBE_LIMIT)
        .read_to_end(&mut raw)
        .is_err()
    {
        return false;
    }
    let text = String::from_utf8_lossy(&raw);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return false;
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return false;
    };
    parsed.get("instanceId").and_then(|value| value.as_str()) == Some(instance_id)
}

/* ── what an existing env file already says ──────────────────────────────── */

/// The key that decides which fleet a daemon belongs to.
const CONTROL_PLANE_KEY: &str = "REEMOAT_CONTROL_PLANE";

/// The daemon's state root, which `resolveStateRoot` in `src/paths.ts` reads.
///
/// Not `HOME_KEY`, beside a `.env("HOME", home)` that means something else
/// entirely: `HOME` stays the user's real home, so the agents a daemon spawns
/// find their own sign-ins in `~/.claude` and `~/.codex` whichever server it is.
const STATE_ROOT_KEY: &str = "REEMOAT_HOME";

/// The daemon's listening port.
const PORT_KEY: &str = "REEMOAT_PORT";

/// What a spawn is told on top of the env file, and never writes into it.
///
/// ⚠ **Variables rather than configuration, deliberately.** Written into the file,
/// the root and the port would be two more keys this app owns — `OWNED_KEYS` grows,
/// and with it what a refreshed code may rewrite in a file `install.sh` wrote —
/// and a second daemon's address would become a setting somebody could copy into
/// the one file a service sources. Passed at spawn, after the file, they win over
/// it for the child this app starts and are nothing to any other reader.
pub struct Spawn {
    /// `REEMOAT_HOME` — `state_root`'s answer for this server.
    pub root: PathBuf,
    /// `REEMOAT_CONTROL_PLANE` — the host's own origin, which the file's copy is a
    /// record of.
    pub control_plane: String,
    /// `REEMOAT_PORT=0`, so the kernel picks and the announcement carries it.
    ///
    /// ⚠ **Only for a root of its own, never the legacy one.** `~/.reemoat`'s
    /// daemon stays on 7887, the value `install.sh` wrote or the default, because
    /// `pnpm client` and `deploy/lib.sh`'s `/health` probe address it there (Q1.22)
    /// — and overriding a `REEMOAT_PORT=7887` line would break the rule a few lines
    /// down that the file wins. Only the per-server roots can collide on a port.
    pub ephemeral_port: bool,
}

/// The three keys this app owns. Everything else in the file is somebody else's.
///
/// ⚠ **Ownership is what makes a rewrite safe.** A file written by
/// `deploy/install.sh` and edited by hand afterwards carries things this app never
/// wrote — measured on a real machine 2026-09-15: 324 lines, 292 of them comments,
/// with a private CA path its owner had added. Rewriting the whole file to refresh
/// an enrollment code would delete all of it, so only these three are replaced.
const OWNED_KEYS: [&str; 3] = ["REEMOAT_AUTH", CONTROL_PLANE_KEY, "REEMOAT_ENROLL_CODE"];

/// A unit an earlier shell install left behind for this daemon, if there is one.
///
/// ⚠ **A supervisor and this app cannot both own one env file.**
/// `deploy/launchd/reemoat.plist.in` sets `KeepAlive` with `ThrottleInterval 10`,
/// which is correct for a server and hostile here: rewrite the file with a fresh
/// enrollment code and launchd's next respawn — within ten seconds — sources the
/// *new* file and races this app's child for a single-use code, the database lock
/// and the port. Whichever loses, one of them redeems the code and the other never
/// can. Measured on a real machine 2026-09-15: exactly such a plist, pointing at
/// `~/srv/reemoat/deploy/run-daemon.sh` with the same env file and database, with
/// 2019 failed starts behind it.
///
/// So the rewrite is refused and the person is told which file to deal with. Named
/// by a glob rather than by the label `deploy/` happens to use today, because a
/// unit somebody renamed is still a unit that will respawn.
pub fn managed_unit(home: &Path) -> Option<PathBuf> {
    let directories = [
        home.join("Library").join("LaunchAgents"),
        home.join(".config").join("systemd").join("user"),
    ];
    for directory in directories {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        let found = entries.flatten().map(|entry| entry.path()).find(|path| {
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_lowercase();
            (extension == "plist" || extension == "service") && name.contains("reemoat")
        });
        if found.is_some() {
            return found;
        }
    }
    None
}

/// What to say about one, including a remedy that actually clears it.
///
/// ⚠ **The remedy has to make this check pass, and the first one did not.**
/// It said `launchctl bootout`, which unloads a service and leaves its file
/// exactly where it was — so the check found it again, refused again, and offered
/// the same useless command: a permanent lockout whose own instructions could not
/// end it. Caught on a machine where the unit was *already* unloaded.
///
/// ⚠ **And unloaded is not harmless, which is why the file is the test rather than
/// the running service.** `deploy/launchd/reemoat.plist.in` sets `RunAtLoad`, so a
/// plist sitting in `~/Library/LaunchAgents` is loaded again at the next login —
/// a check that passed on "not running now" would hand the machine over and lose
/// it at the next reboot. Moving the file is what settles it both ways, so that is
/// what is asked for; the unload is there to stop one that is running this minute.
pub fn managed_unit_detail(unit: &Path) -> String {
    let name = unit
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("the unit");
    let remedy = if unit.extension().and_then(|value| value.to_str()) == Some("plist") {
        let label = name.trim_end_matches(".plist");
        format!(
            "launchctl bootout gui/$(id -u)/{label} 2>/dev/null; mv {} ~/{name}.off",
            unit.display()
        )
    } else {
        let label = name.trim_end_matches(".service");
        format!(
            "systemctl --user disable --now {label}; mv {} ~/{name}.off",
            unit.display()
        )
    };
    format!(
        "This computer already has a Reemoat daemon installed as a background service, at {}. \
         It would restart itself and compete for the same settings, so Reemoat left them alone. \
         Move it aside first — unloading is not enough, because it is loaded again at every login:\n  {remedy}",
        unit.display()
    )
}

/// Whether a value may be written into the env file as itself.
///
/// ⚠ **This file is sourced by `deploy/run-daemon.sh` with `.`, and every key
/// `parse_env` finds is set on the daemon's environment with no whitelist.** So a
/// value carrying a newline writes a *second* assignment — and `NODE_OPTIONS`
/// pointing at a `data:` import is arbitrary code inside the daemon — while one
/// carrying `$(…)` or a backtick is arbitrary code in the shell that sources it.
/// These values come from the control plane rather than from a stranger, which is
/// an argument for this being unreachable today and none at all for writing them
/// verbatim.
///
/// **Refused rather than escaped**, for the reason `env_contents` already gives
/// about newlines: `parse_env` strips one pair of quotes and does not understand
/// `'\''`, so an escaping scheme here would be a second, divergent reading of a
/// file that already has one authoritative reader. Nothing legitimate is refused —
/// an enrollment code is `ec_` and base64url, and a machine id is an opaque token
/// of the same alphabet.
pub fn is_writable_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '/'))
}

/// There is no env file on this computer.
pub const CONFIG_NONE: &str = "none";
/// There is one, and it names the server this app is signed in to.
pub const CONFIG_HERE: &str = "here";
/// There is one, and it names something else — or nothing this can read.
pub const CONFIG_ELSEWHERE: &str = "elsewhere";

/// Which fleet the env file on this computer belongs to, if there is one.
///
/// ⚠ **The signal that was missing, and its absence cost a quota slot every
/// launch.** Without it `host_daemon_state` answered `absent` for a computer that
/// already had a half-finished install; the store then created a machine —
/// held until somebody revokes it, which nobody does to a machine they never
/// knew was made — and
/// `host_daemon_start` skipped the write and started the daemon carrying the *old*
/// file's code, for a *different* machine. Measured on a real machine 2026-09-15:
/// a machine row created at 15:15:54, a daemon started at 15:15:55, and an
/// identity table that stayed empty.
///
/// `origin` is the canonical spelling the host holds for the account asking, so
/// this compares two values `normalize_origin` produced rather than two strings
/// somebody typed.
///
/// ⚠ **A file naming nothing this can parse reads as `elsewhere`, never `none`.**
/// The one thing that must not happen is a file somebody else wrote being treated
/// as an empty slot, and "I could not read it" is not evidence that it is empty.
///
/// **`root` is a state root, and which one decides what `elsewhere` can mean.**
/// `state_root` hands the legacy root to a server only when this answers `here`
/// for it, or when there is nothing there at all — so on the root a server is
/// actually given, `elsewhere` is a file in that server's *own* folder that was
/// edited by hand or cannot be read. A folder-name collision would be the third
/// way, and `server_slug` is injective so that it is not one.
pub fn config_state(root: &Path, origin: Option<&str>) -> &'static str {
    let path = env_path(root);
    if !path.exists() {
        return CONFIG_NONE;
    }
    let named = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| parse_env(&text).get(CONTROL_PLANE_KEY).cloned())
        .and_then(|raw| crate::config::normalize_origin(&raw).ok());
    match (named, origin) {
        (Some(named), Some(origin)) if named == origin => CONFIG_HERE,
        _ => CONFIG_ELSEWHERE,
    }
}

/// Replace the keys this app owns, keeping every other line exactly as it was.
///
/// For a machine this app created that needs a **fresh** enrollment code: a code
/// lives an hour, and a daemon that did not redeem one in time needs the new one
/// in the file it already reads.
///
/// ⚠ **Line-preserving rather than regenerated from parsed pairs.** Re-emitting
/// pairs would be shorter and would throw away the installer's comments and every
/// key this app does not know about — which is the same data loss {@link
/// OWNED_KEYS} exists to prevent. A duplicate owned key is dropped rather than
/// left in place, because a later assignment wins in both readers of this file and
/// a survivor below would shadow the line just written.
pub fn env_rewritten(existing: &str, control_plane: &str, enroll_code: &str) -> String {
    /*
     * ⚠ **`both` survives a rewrite, and only an absent or shared-secret mode
     * becomes `signed`.** `both` is the break-glass shape — a control-plane
     * identity *and* `REEMOAT_TOKEN` — and a machine set up by hand that way has
     * clients presenting the shared secret. Rewriting it to `signed` to refresh an
     * enrollment code would sign those clients out for a reason that has nothing
     * to do with them.
     */
    let mode = match parse_env(existing)
        .get("REEMOAT_AUTH")
        .map(|value| value.trim().to_lowercase())
    {
        Some(found) if found == "both" => "both",
        _ => "signed",
    };
    let wanted: [(&str, &str); 3] = [
        ("REEMOAT_AUTH", mode),
        (CONTROL_PLANE_KEY, control_plane),
        ("REEMOAT_ENROLL_CODE", enroll_code),
    ];
    let mut written = [false; 3];
    let mut out = String::new();
    for line in existing.lines() {
        let owned = if line.trim_start().starts_with('#') {
            None
        } else {
            line.split_once('=')
                .and_then(|(key, _)| OWNED_KEYS.iter().position(|k| *k == key.trim()))
        };
        match owned {
            Some(index) => {
                if !written[index] {
                    let (name, value) = wanted[index];
                    out.push_str(&format!("{name}={value}\n"));
                    written[index] = true;
                }
            }
            None => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    for (index, (name, value)) in wanted.iter().enumerate() {
        if !written[index] {
            out.push_str(&format!("{name}={value}\n"));
        }
    }
    out
}

/// Read an env file into pairs, the way `run-daemon.sh` sources one.
///
/// Deliberately small: `KEY=value`, `#` comments, blank lines. It is not a shell
/// parser and must not become one — `deploy/install.sh` writes plain assignments,
/// and anything cleverer here would be a second, divergent reading of a file that
/// already has one authoritative reader.
pub fn parse_env(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        // Quotes are stripped because `install.sh` writes some values quoted
        // (`REEMOAT_TOKEN='…'`) and `sh` would remove them on the way in.
        let value = value.trim();
        let value = value
            .strip_prefix('\'')
            .and_then(|v| v.strip_suffix('\''))
            .or_else(|| value.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
            .unwrap_or(value);
        out.insert(key.to_string(), value.to_string());
    }
    out
}

/* ── the machine this app already created ───────────────────────────────── */

/// What this app has already claimed for a given server, so it never claims twice.
///
/// ⚠ **This exists because a machine row is permanent and a quota slot is not
/// given back.** `machine_owners` is counted with **no revoked filter**, so every
/// `POST /v1/machines` spends one of fifty until somebody revokes it by hand. The window is small and real:
/// the app creates a machine, writes the env file, starts the daemon — and if it
/// is quit, or crashes, or the enrollment code expires before the daemon redeems
/// it, then on the next launch the machine id exists only on the control plane and
/// nothing on this computer remembers it. Without this file the next launch would
/// see "no daemon here" and create a *second* machine, and a third, one per
/// unlucky restart.
///
/// The env file cannot carry it: that file is the one `deploy/install.sh` writes,
/// its three keys are the daemon's contract, and adding a fourth that only this
/// app reads would make two programs disagree about what the file is.
///
/// Keyed on the **account** — `<origin>#<user id>`, or the bare origin for a claim
/// made before accounts — for the reason `credential.rs` keys on it: one
/// installation may hold two fleets and two people on one fleet, and a machine id
/// bought for one is meaningless — and misleading — to another.
///
/// ⚠ **A map keyed by origin, not a single record, and that was a real bug.** The
/// first version stored one `{origin, machineId}` and answered `None` when the
/// origin did not match. Point the app at a second control plane and the first
/// server's claim is overwritten; point it back, and the claim is gone, so
/// bootstrap creates a *second* machine there and spends a second permanent slot.
/// Somebody who keeps a work fleet and a personal one would pay that on every
/// switch. A map costs one line and closes it.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Claims {
    /// scope → machine id.
    #[serde(default)]
    machines: BTreeMap<String, String>,
}

/// One writer of `machine.json` at a time.
///
/// ⚠ **Required rather than tidy once there is a webview per account.** Every
/// account's page sets itself up at launch, each `write_claim` is a
/// read-modify-write, and two interleaved lose one claim — which costs a machine
/// quota slot at the next launch, a permanent one until somebody revokes it by
/// hand. `server.json` has `CONFIG_LOCK` for the same reason.
static CLAIM_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn claim_file(dir: &Path) -> PathBuf {
    dir.join("machine.json")
}

/// The machine this app created for `origin`, if it created one.
///
/// Every failure answers `None`, which is the same as never having claimed —
/// the cost of that being wrong is one extra machine, and the cost of *refusing*
/// to start over an unreadable preference file is an app that cannot be used.
pub fn read_claim(dir: &Path, scope: &str) -> Option<String> {
    let text = std::fs::read_to_string(claim_file(dir)).ok()?;
    let claims: Claims = serde_json::from_str(&text).ok()?;
    claims
        .machines
        .get(scope)
        .filter(|id| !id.is_empty())
        .cloned()
}

pub fn write_claim(dir: &Path, scope: &str, machine_id: &str) -> Result<(), String> {
    let _held = CLAIM_LOCK.lock().unwrap_or_else(|held| held.into_inner());
    // Read-modify-write rather than replace, which is the whole point of the map.
    let mut claims = read_claims(dir);
    claims
        .machines
        .insert(scope.to_string(), machine_id.to_string());
    write_claims(dir, &claims)
}

/// Every scope `machine.json` holds a claim for — which bare origins had a machine
/// bought for them before accounts, for `config::read_accounts`'s derivation.
pub fn claim_scopes(dir: &Path) -> Vec<String> {
    read_claims(dir)
        .machines
        .into_iter()
        .filter(|(_, id)| !id.is_empty())
        .map(|(scope, _)| scope)
        .collect()
}

/// Move a claim made under the bare origin to the account proved to own it.
///
/// **Nothing moves where the account already has one**, and nothing is lost where
/// the bare claim is absent: both are the no-op a retried move has to be.
pub fn move_claim(dir: &Path, from: &str, to: &str) -> Result<(), String> {
    let _held = CLAIM_LOCK.lock().unwrap_or_else(|held| held.into_inner());
    let mut claims = read_claims(dir);
    if claims.machines.contains_key(to) {
        return Ok(());
    }
    let Some(id) = claims.machines.remove(from) else {
        return Ok(());
    };
    claims.machines.insert(to.to_string(), id);
    write_claims(dir, &claims)
}

fn read_claims(dir: &Path) -> Claims {
    std::fs::read_to_string(claim_file(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// A temporary file, flushed, renamed over `machine.json`, and the rename flushed.
///
/// ⚠ **`fs::write` truncated first**, so a crash in between left an empty file —
/// every claim gone, and every one of them a quota slot the next launch spends
/// again. `config::write_stored`'s shape, through its two shared helpers.
fn write_claims(dir: &Path, claims: &Claims) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(claims).map_err(|e| e.to_string())?;
    let tmp = dir.join(crate::config::temp_name("machine.json"));
    let written = std::fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(text.as_bytes())?;
        file.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("could not write the machine file: {e}"));
    }
    std::fs::rename(&tmp, claim_file(dir)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not write the machine file: {e}")
    })?;
    // Best effort, for `config::sync_dir`'s reason.
    let _ = crate::config::sync_dir(dir);
    Ok(())
}

/// This computer's name, for naming the machine it is about to become.
///
/// ⚠ **Nothing on the bridge carried this, which is why it is here.** `Boot`
/// reports `platform`, and that is `std::env::consts::OS` — the string `"macos"`,
/// identical on every Mac alive. Naming a machine from it works on the first
/// computer and collides on the second, and the control plane compares names
/// case-insensitively across everything you can *see*, so the second person to try
/// gets a `409 machine_exists` for a name they never chose.
///
/// Raw and unsanitised on purpose: what a control-plane label may contain is that
/// service's rule, and the caller that has to handle the refusal is the one that
/// should shape the name.
pub fn host_name() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = vec![0u8; 256];
        // Safe: the pointer and length describe `buf`, which outlives the call.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        buf.truncate(end);
        let name = String::from_utf8(buf).ok()?;
        let name = name.trim();
        // `Some-Mac.local` is what a Mac answers; the suffix is mDNS's, not a name.
        let name = name.strip_suffix(".local").unwrap_or(name);
        if name.is_empty() {
            return None;
        }
        Some(name.to_string())
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").ok().filter(|n| !n.is_empty())
    }
}

/// The account name this process runs as, for the child's `USER`/`LOGNAME`.
///
/// ⚠ **Measured 2026-09-15, and it is the whole of why an agent could not
/// authenticate while the same CLI worked in a terminal three feet away.**
/// `env_clear` in `Supervisor::start` is deliberate, and what it cleared included
/// `USER`. On macOS `claude` derives its **Keychain account** from that variable
/// and falls back to the literal `unknown` — so the agent looked up
/// `(Claude Code-credentials, "unknown")`, found nothing, wrote an *empty*
/// credential there on its first start, and from then on read back `expiresAt: 0`
/// with no refresh token to fix it. What the person sees is `Failed to
/// authenticate: OAuth session expired and could not be refreshed`, which reads as
/// a login that lapsed rather than as a lookup under the wrong name — and it is
/// unfixable by signing in again, because signing in writes the *right* account
/// and the agent keeps reading the wrong one.
///
/// Reproduced on the machine that had it, same binary, same `HOME`:
/// `env -i HOME=… PATH=… LANG=…` refuses; adding `USER=… LOGNAME=…` answers.
///
/// ⚠ **`getpwuid` first and the environment second**, which is the ordering `HOME`
/// already has: `commands.rs` takes the home from `app.path().home_dir()` rather
/// than from `$HOME`, because a value the system answers cannot be a stale export
/// from whoever launched the bundle. The environment is the fallback for a uid
/// with no passwd entry, which is a container rather than a Mac.
///
/// **This is one instance of a class, not a special case for claude.** Anything
/// that keys a credential, a cache or a config directory on the account name has
/// the same hole, and nothing in a clean environment would have said so — see the
/// pass-through list in `start` for the two neighbours caught with it.
fn login_name() -> Option<String> {
    #[cfg(unix)]
    {
        // Safe: `getpwuid` answers a pointer into libc's own static storage, valid
        // until this thread calls it again; the name is copied out before anything
        // else can. A null answer is "no passwd entry for this uid", which is a
        // real state rather than an error, so it falls through to the environment.
        let from_passwd = unsafe {
            let entry = libc::getpwuid(libc::getuid());
            if entry.is_null() {
                None
            } else {
                std::ffi::CStr::from_ptr((*entry).pw_name)
                    .to_str()
                    .ok()
                    .map(str::to_owned)
            }
        };
        for candidate in [
            from_passwd,
            std::env::var("USER").ok(),
            std::env::var("LOGNAME").ok(),
        ] {
            match candidate {
                Some(name) if !name.trim().is_empty() => return Some(name),
                _ => continue,
            }
        }
        None
    }
    #[cfg(not(unix))]
    {
        std::env::var("USERNAME")
            .ok()
            .filter(|name| !name.trim().is_empty())
    }
}

/* ── PATH ────────────────────────────────────────────────────────────────── */

/// How long the login shell gets to answer before its PATH is given up on.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// The user's real `PATH`, as their login shell reports it.
///
/// ⚠ **A GUI application does not inherit the PATH a terminal has.** launchd hands
/// an app a bare default, so `git`, and every coding-agent CLI in `~/.local/bin`,
/// `~/.codex` or `~/.opencode`, are simply invisible — and the failure reads as
/// "the CLI is not installed" on a machine where it plainly is. `deploy/agents.sh`
/// and `src/acp/agents.ts` both resolve by PATH, so this is not cosmetic.
///
/// The remedy is the one VS Code established and `paseo` adopted from it: ask the
/// login shell. `-i` so the interactive profile is read, `-l` so the login profile
/// is, and a marker around the value because a profile that prints a banner would
/// otherwise have its banner parsed as a PATH.
///
/// **Every failure answers `None` and the caller falls back to a composed list.**
/// A shell that hangs, a profile that exits non-zero, a marker that never appears:
/// none of them is worth a diagnostic, because the fallback is a working machine
/// with a narrower PATH rather than a broken one.
pub fn login_shell_path(shell: Option<&str>) -> Option<String> {
    const MARK: &str = "__reemoat_path__";
    /*
     * ⚠ **Unix by decision rather than by accident.** `SHELL` is unset on
     * Windows, so this already answered `None` there — by luck, and luck that
     * breaks under Git Bash and MSYS2, which do set `SHELL=/usr/bin/bash`. The
     * spawn would then run a POSIX shell that knows nothing of the Windows `PATH`
     * this is trying to read, and the answer would be worse than no answer.
     *
     * There is no Windows arm because there is nothing to write yet: a GUI
     * process there inherits the user's environment rather than a bare launchd
     * default, so the problem this exists for may not arise at all — and
     * `paseo`'s equivalent refuses outright for the same reason. `daemon_path`'s
     * fallback is what runs instead.
     */
    if !cfg!(unix) {
        return None;
    }
    let shell = shell?;
    if shell.is_empty() {
        return None;
    }

    /*
     * ⚠ **The timeout is the reason this is not three lines around `output()`.**
     *
     * `-i` reads the interactive profile, which is somebody else's shell script:
     * it can prompt, it can wait on a network mount, it can call a version manager
     * that decides to install something. `output()` waits for ever, and this runs
     * during startup — so a profile that blocks would be an app that never opens a
     * window, with nothing on screen saying why. Spawned and reaped on a deadline
     * instead, and a shell that misses it is killed and treated as no answer.
     */
    let mut child = Command::new(shell)
        .arg("-ilc")
        .arg(format!("printf '{MARK}%s{MARK}' \"$PATH\""))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + SHELL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }

    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    /*
     * The marker, rather than trusting the whole of stdout. A profile that prints
     * a banner — a version manager's notice, a fortune, a corporate MOTD — would
     * otherwise have that banner parsed as the PATH, and the daemon would be
     * started with a PATH that is a sentence.
     */
    let value = text.split(MARK).nth(1)?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

/// What the daemon's `PATH` ends up being.
///
/// Three parts, in order, and the order is the whole of it:
///
/// 1. **The payload's own `node_modules/.bin` first**, because it holds `node` and
///    `npm` *beside each other*. `deploy/agents.sh` resolves the runtime as
///    `$(dirname -- "$(command -v npm)")/node` — the node next to npm — so putting
///    this first is what makes the script install kimi with the runtime this app
///    shipped rather than with something else it happened to find.
/// 2. **The user's real PATH**, so their `git` and their already-installed agent
///    CLIs are reachable.
/// 3. **The directories `deploy/agents.sh` installs into**, so a CLI it installed
///    on a previous run is found even if the user's profile never mentioned them.
///
/// ⚠ **Appended, never prepended, for part 3** — `src/acp/agents.ts` documents why
/// at length: those directories are writable by this uid, and a file dropped into
/// `~/.local/bin` should not take precedence over a deliberate install.
pub fn daemon_path(payload: &Payload, home: &Path, user_path: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(
        payload
            .root
            .join("node_modules")
            .join(".bin")
            .display()
            .to_string(),
    );
    match user_path {
        /*
         * ⚠ **Split rather than pushed whole**, which `join_paths` forced and was
         * right to: a component that itself contains the separator is exactly what
         * it refuses, and the user's `PATH` *is* a list. Pushing it as one string
         * made the whole join fail and collapsed the daemon's PATH to the payload's
         * own `.bin` — caught by this file's own test, which is why it has one.
         */
        Some(p) if !p.trim().is_empty() => parts.extend(
            std::env::split_paths(p.trim())
                .map(|part| part.display().to_string())
                .filter(|part| !part.is_empty()),
        ),
        /*
         * The fallback, and it is deliberately the bare system default rather
         * than a guess at where somebody keeps things.
         *
         * ⚠ **Per platform, and Homebrew is named on exactly one of them.** It is
         * on the macOS list because that is where `git` lives on most developer
         * Macs that have it from Homebrew rather than from the Command Line
         * Tools — a measurement. Linuxbrew is deliberately *not* on the Linux
         * list: naming it would be a guess wearing a measurement's clothes.
         * Anything else gets no fallback at all, which leaves the payload's own
         * `.bin` plus the managed directories — the honest answer for a platform
         * nobody here has measured, and better than a list of paths that may not
         * exist.
         */
        _ if cfg!(target_os = "macos") => {
            parts.push("/opt/homebrew/bin".to_string());
            parts.push("/usr/local/bin".to_string());
            parts.push("/usr/bin".to_string());
            parts.push("/bin".to_string());
            parts.push("/usr/sbin".to_string());
            parts.push("/sbin".to_string());
        }
        _ if cfg!(target_os = "linux") => {
            parts.push("/usr/local/bin".to_string());
            parts.push("/usr/bin".to_string());
            parts.push("/bin".to_string());
            parts.push("/usr/local/sbin".to_string());
            parts.push("/usr/sbin".to_string());
            parts.push("/sbin".to_string());
        }
        _ => {}
    }
    for managed in [
        ".local/bin",
        ".codex/bin",
        ".opencode/bin",
        ".reemoat/toolchain/bin",
    ] {
        parts.push(home.join(managed).display().to_string());
    }
    /*
     * ⚠ **`join_paths`, never `join(":")`.** `:` is POSIX's list separator and
     * `;` is Windows's, so the hand-rolled join produced one garbage entry rather
     * than a list on the platform this app is meant to be a client on. It also
     * closes a latent bug on the platforms that *do* use `:` — a directory whose
     * own name contains one silently corrupted the list, and this refuses it
     * instead.
     *
     * A refusal falls back to the payload's own `.bin` alone, which is what the
     * daemon actually needs: `src/acp/agents.ts` spawns out of it, and everything
     * else on the list is a convenience.
     */
    match std::env::join_paths(parts.iter().map(std::ffi::OsString::from)) {
        Ok(joined) => joined.to_string_lossy().into_owned(),
        Err(_) => parts.first().cloned().unwrap_or_default(),
    }
}

/* ── starting one, and watching it ───────────────────────────────────────── */

/// How many lines of the child's output are kept to explain a failure.
///
/// The same *shape* as the ring `src/plugins/runtime.ts` keeps for a plugin, and
/// deliberately ten times the size: `PLUGIN_LOG_LINES` is 20 because a plugin's
/// ring only has to carry the sentence that killed it onto one failure row, while
/// this is the startup transcript a person reads on Settings → Logs. Enough to
/// carry a banner and everything after it, not enough to be a log file nobody
/// rotates.
///
/// ⚠ **And unlike that ring, no per-line clip is applied here.** `runtime.ts`
/// also holds `MAX_LOG_LINE_CHARS`; this keeps a pathological line whole.
const LOG_LINES: usize = 200;

/// How long a stopping daemon is given before it is killed outright.
///
/// `scripts/daemon.ts`'s own `SHUTDOWN_HARD_LIMIT_MS`, plus a second: a daemon
/// that has not gone by then was not going to, and the extra second means the
/// usual path is the daemon's own timer rather than this one racing it.
const STOP_DEADLINE: std::time::Duration = std::time::Duration::from_millis(26_000);

/// How often the stop above looks, while it waits.
const STOP_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// A daemon this app started, and what it said.
///
/// ⚠ **The pid is recorded so that stopping is identity-checked.** `~/.reemoat` is
/// shared with whatever `deploy/install.sh` may have set up, and a pid is reused
/// by the kernel — so "stop the daemon" must mean "stop *this* child", never "kill
/// whatever is at the pid in that file". The handle is the identity.
///
/// **One per state root, not one per app.** `Host` keeps a map from a root's
/// directory to one of these — a root per account, and a legacy seat and the
/// account it becomes share one — so switching accounts leaves every other child
/// running and its ring intact; `RunEvent::Exit` stops every one of them under a
/// single deadline (`stop_all`). Q7.148, Q7.149.
pub struct Supervisor {
    child: Option<std::process::Child>,
    log: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    /// The exit status of the last child, once one has finished. See `owns_running`.
    last_exit: Option<i32>,
}

/// What the page is told. Deliberately a small, closed set.
#[derive(serde::Serialize)]
pub struct DaemonState {
    /// `absent` · `starting` · `running` · `foreign` · `exited` · `unsupported`
    pub status: String,
    /// The machine the daemon announced itself as, when it has.
    #[serde(rename = "machineId")]
    pub machine_id: Option<String>,
    /// The machine this app already created for this server, if it created one.
    ///
    /// ⚠ **Not the same question as `machineId`, and conflating them costs a quota
    /// slot.** `machineId` is what a *running* daemon says it is. This is what this
    /// app spent a `POST /v1/machines` on, whether or not the daemon ever came up.
    /// A caller that sees this set must re-mint a code against it rather than
    /// create a second machine.
    pub claimed: Option<String>,
    /// How it exited, when this app started it and it has finished.
    ///
    /// `3` is an enrollment code the control plane refused and `4` a control plane
    /// it could not reach — the two the caller acts on differently. See
    /// `Supervisor::owns_running`.
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    /// `none` · `here` · `elsewhere` — what this server's env file already says:
    /// `daemon.env` in the root `state_root` gives it.
    ///
    /// ⚠ **Asked before a machine is created, never after.** See `config_state`,
    /// which carries the measurement behind that ordering.
    pub config: String,
    /// Whether the announcement behind `machineId` names a control plane other
    /// than this server's — `local::Announced::for_another_server`.
    ///
    /// ⚠ **A flag on the status rather than a status of its own, and never
    /// `absent`.** `~/.reemoat` is shared by every daemon started without
    /// `REEMOAT_HOME`, so a stranger's file there says nothing about whether this
    /// server's own daemon is up — the launchd one may well be, announced over. An
    /// `absent` would send the setup flow's adoption arm to start a second daemon
    /// on a database that unit holds. So the status stays what the file and the
    /// probe say, and this tells the page that the machine beside it is somebody
    /// else's fleet's: nothing to adopt and nothing to say "for this server" about.
    pub stranger: bool,
}

impl Default for DaemonState {
    /// `config` defaults to `none` rather than to `String::default()`: an empty
    /// string is not one of the three answers, and a caller comparing against them
    /// would fall through every arm to the one that does nothing.
    fn default() -> DaemonState {
        DaemonState {
            status: String::new(),
            machine_id: None,
            claimed: None,
            config: CONFIG_NONE.to_string(),
            exit_code: None,
            stranger: false,
        }
    }
}

impl Supervisor {
    pub fn new() -> Supervisor {
        Supervisor {
            child: None,
            log: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            last_exit: None,
        }
    }

    /// Whether this app currently owns a running daemon.
    pub fn owns_running(&mut self) -> bool {
        let status = match self.child.as_mut() {
            None => return false,
            // `try_wait` reaps; `Ok(None)` is "still running".
            Some(child) => child.try_wait(),
        };
        match status {
            Ok(None) => true,
            Ok(Some(status)) => {
                /*
                 * ⚠ **Kept, because it is the only structured thing a dead child
                 * left behind.** `scripts/daemon.ts` exits `3` for an enrollment
                 * code the control plane refused and `4` for a control plane it
                 * could not reach, and those are the two cases where the caller's
                 * next move differs — mint a fresh code, or wait. Everything else
                 * is `2`, which is also a held database lock and a missing token,
                 * and re-minting for those re-enrolls a machine over a problem no
                 * new code can touch. The alternative was reading the log, and a
                 * supervisor that greps its child's output is one rewording away
                 * from silently doing nothing.
                 */
                self.last_exit = status.code();
                // The handle is spent: reaped once, it can answer nothing again.
                self.child = None;
                false
            }
            Err(_) => false,
        }
    }

    /// How the last child this app started went, once one has finished.
    pub fn exit_code(&self) -> Option<i32> {
        self.last_exit
    }

    /// Whether the child has printed anything at all, ever.
    ///
    /// ⚠ **The one thing `host_daemon_state` asks the ring, and it asks for a
    /// *bit*.** With no live child, a ring with something in it means one was
    /// started and is gone, and an empty one means nothing was ever tried here —
    /// which is the whole of `exited` against `absent`. It used to hand over the
    /// two hundred lines themselves, as `DaemonState.detail`, so that the setup
    /// notice could draw them; the notice draws a sentence now and the lines are
    /// Settings → Logs's (Q7.140), so what is left on the poll is this boolean.
    pub fn printed_anything(&self) -> bool {
        self.log
            .lock()
            .map(|held| !held.is_empty())
            .unwrap_or(false)
    }

    /// The whole ring, as lines, for the screen whose subject is the ring.
    ///
    /// ⚠ **A second reader rather than a wider `DaemonState`, and the split is the
    /// point.** `host_daemon_state` is on the setup screen's one-second poll and
    /// answers a word; putting two hundred lines on it so that one screen could
    /// have them is a log on a poll. `host_daemon_log` is the screen's own command.
    ///
    /// ⚠ **And `Vec<String>` rather than a joined string**, because the caller
    /// draws lines. Joining here and splitting there is a round trip through a
    /// separator a log line is allowed to contain.
    ///
    /// Empty where nothing was ever started here, where the app did not start it
    /// — a daemon from `deploy/install.sh` is somebody else's child and this app
    /// holds no pipe to it — and where it has printed nothing yet. All three are
    /// the same answer on purpose: this is what *this app's* child said, and the
    /// screen tells them apart from the status rather than from the shape of this.
    pub fn log_lines(&self) -> Vec<String> {
        match self.log.lock() {
            Ok(held) => held.clone(),
            // A poisoned mutex means a reader thread panicked while holding it.
            // Nothing here is worth taking the app down for: the log is evidence,
            // and no evidence is a survivable answer where a crash is not.
            Err(_) => Vec::new(),
        }
    }

    /// Start the daemon, with the environment it needs and nothing of ours.
    ///
    /// ⚠ **`node --import tsx`, never `node_modules/.bin/tsx`**, and this diverges
    /// from `deploy/run-daemon.sh` on purpose — `deploy/docker/Dockerfile` makes
    /// the same divergence and records why. tsx's CLI spawns a *child*: under a
    /// supervisor that is fine, but here it would mean the process this app holds
    /// a handle to is a wrapper, the daemon is a grandchild, and stopping the app
    /// would leave the real daemon reparented with nothing reaping it. `--import`
    /// runs the daemon in the process we spawned, so the handle is the daemon.
    ///
    /// **Three layers, and each wins over the one before.** A clean environment with
    /// who this process is (`USER`, `LOGNAME`); then the env file, so a line there
    /// beats anything this process guessed; then `spawn` — the state root, the
    /// server and, for a root of its own, the port — which beats the file, because
    /// those three are what make this child *this server's* daemon and the file is
    /// only a record of them (`Spawn` has why they are never written into it).
    ///
    /// The early return below is per root by construction: there is one of these
    /// per state root, so "already running" can only mean that root's child.
    pub fn start(
        &mut self,
        payload: &Payload,
        home: &Path,
        env: &BTreeMap<String, String>,
        spawn: &Spawn,
    ) -> Result<(), String> {
        if self.owns_running() {
            return Ok(());
        }
        // A new child's outcome is not the old one's; a stale code read as this
        // one's would send the caller down a branch for a failure that is over.
        self.last_exit = None;
        let path = daemon_path(
            payload,
            home,
            login_shell_path(std::env::var("SHELL").ok().as_deref()).as_deref(),
        );

        let mut command = Command::new(&payload.node);
        command
            .current_dir(&payload.root)
            .args([
                "--enable-source-maps",
                "--import",
                "tsx",
                "scripts/daemon.ts",
            ])
            /*
             * A clean environment, built rather than inherited. This process's own
             * is a GUI app's: it carries Tauri's variables, whatever launchd set,
             * and — if somebody started the app from a terminal inside a coding
             * agent — that agent's session variables, which `agentEnv()` in the
             * daemon strips for exactly this reason. Starting from empty means
             * there is nothing to strip.
             */
            .env_clear()
            .env("HOME", home)
            .env("PATH", path)
            .env("UV_THREADPOOL_SIZE", "64")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        /*
         * ⚠ **Who this process *is*, which `env_clear` above took away and which a
         * surprising amount of software reads.** See {@link login_name} for the
         * measurement: without `USER`, claude keys its Keychain lookup on the
         * literal `unknown`, writes an empty credential there, and every session
         * afterwards fails with `OAuth session expired and could not be refreshed`
         * while the same binary works in a terminal. Nothing in the daemon's own
         * logs can say that, because from the daemon's side the agent simply
         * refused.
         *
         * **Both spellings, because POSIX has two and tools pick either.**
         * `LOGNAME` is the standardised one and `USER` is the one everything
         * actually reads; setting one and not the other is the same bug waiting for
         * a different program.
         *
         * Set *before* the env file is applied, so a `USER=` line there still wins
         * — which is the rule the certificate block below states outright, and it
         * keeps the interim workaround somebody may already have written into
         * `~/.reemoat/daemon.env` from fighting this fix.
         */
        if let Some(name) = login_name() {
            command.env("USER", &name);
            command.env("LOGNAME", &name);
        }
        for (key, value) in env {
            command.env(key, value);
        }
        /*
         * ⚠ **After the file, so these win over it — and they are the whole of what
         * makes one child this server's daemon rather than another's.** The root
         * decides which database, worktrees and announcement it has; the origin is
         * the host's own, for `host_daemon_start`'s reason that a URL from anywhere
         * else is a different spelling waiting to become `elsewhere`; and the port is
         * the kernel's on a root of its own, since two daemons on 7887 is one of them
         * dying on `EADDRINUSE`. The legacy root keeps whatever port its file says.
         */
        command.env(STATE_ROOT_KEY, &spawn.root);
        command.env(CONTROL_PLANE_KEY, &spawn.control_plane);
        if spawn.ephemeral_port {
            command.env(PORT_KEY, "0");
        }
        // Inherited only when the user set it, because the daemon has no opinion
        // about a locale and a missing one makes git's output ASCII-mangled.
        if let Ok(lang) = std::env::var("LANG") {
            command.env("LANG", lang);
        }
        /*
         * ⚠ **How this process reaches a server and how the daemon reaches it are
         * two different trust stores, and the gap cost a whole debugging round.**
         *
         * `proxy.rs` uses `reqwest` with `default-tls`, which is Security.framework
         * — the macOS keychain — and `native-shell.md` chose it precisely because
         * *"a self-hosted control plane behind a private CA is an ordinary
         * deployment for this software"*. Node trusts none of that: it carries its
         * own root set, reads no keychain, and `--use-system-ca` did not close it
         * either when measured against a real dev CA that **was** in both
         * System.keychain and login.keychain.
         *
         * So without this the app creates the machine perfectly — its own request
         * is trusted — and then the daemon it starts dies on `enroll` with
         * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, which reads as "the daemon is broken"
         * rather than "Node cannot see your certificate". Measured 2026-09-15
         * against `https://app.reemoat.test`: refused without `NODE_EXTRA_CA_CERTS`,
         * `200` with it.
         *
         * Passed through rather than invented: this process cannot know where a
         * certificate lives, but whatever launched it may. A GUI launch usually has
         * none of these, which is why the env file is still the durable answer and
         * why the failure now has a screen to appear on.
         */
        /*
         * ⚠ **`SHELL` and `TMPDIR` are here for `USER`'s reason rather than for a
         * certificate's, and they are the neighbours that class of bug was hiding.**
         * Neither is a credential, and neither has been measured breaking anything
         * — they are listed because the failure above was *not* "claude is unusual",
         * it was "a clean environment is missing what every tool assumes a session
         * has", and these are the other two a spawned agent reads. `SHELL` decides
         * which shell a Bash tool runs rather than falling to `/bin/sh` — this
         * process already reads it, one function up, to compose the daemon's PATH.
         * `TMPDIR` on macOS is a per-user directory under `/var/folders`, and
         * without it every temporary file and socket an agent makes lands in the
         * world-writable `/tmp` instead.
         */
        for name in [
            "SHELL",
            "TMPDIR",
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
            "https_proxy",
            "http_proxy",
            "no_proxy",
        ] {
            /*
             * ⚠ The env file wins. It is the durable record and the one
             * `deploy/install.sh` also writes; this process's environment is
             * whatever happened to be exported by whoever double-clicked the app.
             */
            if env.contains_key(name) {
                continue;
            }
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("could not start the daemon: {e}"))?;
        for stream in [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let log = std::sync::Arc::clone(&self.log);
            // A thread per stream, because a pipe nobody drains fills and then the
            // daemon blocks on its own startup banner — the same hazard
            // `src/plugins/runtime.ts` names for a plugin's stdout.
            std::thread::spawn(move || {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(stream);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut held) = log.lock() {
                        held.push(line);
                        while held.len() > LOG_LINES {
                            held.remove(0);
                        }
                    }
                }
            });
        }
        self.child = Some(child);
        Ok(())
    }

    /// Stop the daemon this app started, and only that one.
    ///
    /// `SIGTERM` rather than a kill: `scripts/daemon.ts` has a real graceful stop
    /// — a 20s budget to close sessions, a hard exit at 25 — and skipping it means
    /// every live turn is interrupted and every pending approval dropped.
    ///
    /// {@link signal} and then {@link reap_by} one `STOP_DEADLINE` out. Split in
    /// two so that {@link stop_all} can signal every server's daemon before it waits
    /// on any: stopping them one after another would hand a quit up to one whole
    /// deadline *per server*.
    pub fn stop(&mut self) {
        self.signal();
        self.reap_by(std::time::Instant::now() + STOP_DEADLINE);
    }

    /// Ask the child to stop, and keep the handle so it can still be reaped.
    ///
    /// ⚠ **The handle stays in `self.child` on purpose.** It is what keeps the pid
    /// unreaped, and therefore unrecyclable, until {@link reap_by} waits on it — so
    /// the signal cannot land on a process the kernel handed the number to since.
    pub fn signal(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        #[cfg(unix)]
        {
            // SIGTERM by pid, then wait. `Child::kill` is SIGKILL and would skip
            // the shutdown the daemon implements.
            let pid = child.id() as i32;
            // Safe: `pid` is this process's own live child, taken from the handle
            // above, and `reap_by` reaps it. The signal cannot reach a recycled
            // pid because the handle keeps it unreaped until then.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
        /*
         * ⚠ **Windows gets no graceful stop, and this is a real gap on a real
         * target.** `docs/NATIVE.md` lists Windows as supported, and there is no
         * SIGTERM there — `Child::kill` is `TerminateProcess`, which gives
         * `scripts/daemon.ts` no chance to run its 20-second close, so every turn
         * in flight is interrupted and every pending approval dropped. Closing it
         * properly means a stop the daemon can be *asked* for rather than
         * signalled, which is a change to the daemon's own surface rather than to
         * this file. Named here so it is a known gap rather than a surprise.
         */
        #[cfg(not(unix))]
        {
            let _ = child.kill();
        }
    }

    /// Wait for the child until `deadline`, then kill it and reap it.
    ///
    /// A deadline rather than a duration, so that {@link stop_all} can hand every
    /// daemon the *same* instant and a quit waits once rather than once per server.
    pub fn reap_by(&mut self, deadline: std::time::Instant) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        /*
         * ⚠ **Bounded, because this runs on the way out of the main loop.** An
         * unbounded `wait` hands the daemon's shutdown budget to the quit gesture:
         * `scripts/daemon.ts` gives each session 20 s and caps itself at
         * `SHUTDOWN_HARD_LIMIT_MS` (25 s), so a machine with a busy session could
         * leave a dock icon unresponsive for that long. Measured with no sessions
         * it is 0.30 s, so the deadline is a backstop rather than the usual path.
         *
         * ⚠ **And waiting at all is the point, not politeness.** A quit that
         * signals and returns lets a relaunch start a second daemon while the first
         * still holds `reemoat.db`; the new one loses `claimDaemonLock` and exits,
         * and the setup flow reads that as a daemon that will not start. Waiting is
         * what makes "the app is gone" mean "the daemon is gone".
         */
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                // Already reaped, or a handle that cannot be waited on. Either way
                // there is nothing left to wait for.
                Err(_) => return,
                Ok(None) => {}
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(STOP_POLL);
        }
        // It outlasted its own hard limit, so it is wedged rather than finishing.
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Supervisor::new()
    }
}

/// Stop every daemon this app started, together, under one deadline.
///
/// ⚠ **Signal all, then wait once — never `stop()` each in turn.** With a daemon
/// per server, stopping them one after another would make a quit worth up to one
/// `STOP_DEADLINE` *per server*: three servers with a busy session each is well over
/// a minute of a dock icon that will not go away. Every child gets its `SIGTERM` in
/// the same breath, runs its own 20-second close in parallel with the others, and
/// the one deadline bounds the lot. `cargo test` drives it with children that
/// ignore the signal, which is the only shape that can tell the two apart.
pub fn stop_all<'a>(supervisors: impl IntoIterator<Item = &'a mut Supervisor>) {
    stop_all_by(supervisors, std::time::Instant::now() + STOP_DEADLINE);
}

/// {@link stop_all} with the deadline named, so a test can wait one second rather
/// than twenty-six.
fn stop_all_by<'a>(
    supervisors: impl IntoIterator<Item = &'a mut Supervisor>,
    deadline: std::time::Instant,
) {
    let mut all: Vec<&'a mut Supervisor> = supervisors.into_iter().collect();
    for supervisor in all.iter_mut() {
        supervisor.signal();
    }
    for supervisor in all.iter_mut() {
        supervisor.reap_by(deadline);
    }
}

#[cfg(test)]
mod tests {
    /// The account name is answered, and it is the one the session is running as.
    ///
    /// ⚠ **The regression this exists for is invisible from inside the daemon.**
    /// Without `USER`, `claude` keys its Keychain lookup on the literal `unknown`,
    /// writes an empty credential under that account, and then reports
    /// `OAuth session expired and could not be refreshed` on every turn — a
    /// sentence about a *login*, for a bug about a *name*, from a binary that works
    /// perfectly in a terminal. Nothing on the daemon's side can tell the two
    /// apart, which is why the assertion has to live here.
    ///
    /// Compared against `$USER` only when the environment has one: `getpwuid` is
    /// the authority and the variable is the fallback, so the useful property is
    /// that the two agree wherever both exist — under CI with no `USER` exported,
    /// the non-empty half is still asserted.
    #[test]
    fn login_name_is_this_account() {
        let answered =
            super::login_name().expect("a uid always has an account name on a developer machine");
        assert!(
            !answered.trim().is_empty(),
            "an empty name is the `unknown` bug with extra steps"
        );
        if let Ok(from_env) = std::env::var("USER") {
            if !from_env.trim().is_empty() {
                assert_eq!(
                    answered, from_env,
                    "getpwuid and $USER must not disagree about who this is"
                );
            }
        }
    }

    use super::*;

    #[test]
    fn a_certificate_path_reaches_the_daemon_when_this_process_has_one() {
        // SAFETY: set and removed within this single-threaded test body.
        unsafe { std::env::set_var("NODE_EXTRA_CA_CERTS", "/tmp/dev-ca.crt") };
        let text = env_contents("https://cp.example", "ec_abc");
        unsafe { std::env::remove_var("NODE_EXTRA_CA_CERTS") };
        assert!(text.contains("NODE_EXTRA_CA_CERTS=/tmp/dev-ca.crt"));
        // And it is still a file `run-daemon.sh` can source.
        assert_eq!(
            parse_env(&text)
                .get("NODE_EXTRA_CA_CERTS")
                .map(String::as_str),
            Some("/tmp/dev-ca.crt")
        );
    }

    #[test]
    fn a_value_carrying_a_newline_is_refused_rather_than_escaped() {
        // SAFETY: as above.
        unsafe {
            std::env::set_var(
                "NODE_EXTRA_CA_CERTS",
                "/tmp/ok.crt\nREEMOAT_AUTH=shared_secret",
            )
        };
        let text = env_contents("https://cp.example", "ec_abc");
        unsafe { std::env::remove_var("NODE_EXTRA_CA_CERTS") };
        // The whole value is dropped, so the injected assignment never lands and
        // the mode stays what this file says it is.
        assert!(!text.contains("shared_secret"));
        assert_eq!(
            parse_env(&text).get("REEMOAT_AUTH").map(String::as_str),
            Some("signed")
        );
    }

    #[test]
    fn the_env_file_is_the_one_the_installer_writes() {
        let text = env_contents("https://cp.example", "ec_abc");
        assert!(text.contains("REEMOAT_AUTH=signed"));
        assert!(text.contains("REEMOAT_CONTROL_PLANE=https://cp.example"));
        assert!(text.contains("REEMOAT_ENROLL_CODE=ec_abc"));
        // Round-trips through the reader that stands in for `run-daemon.sh`.
        let parsed = parse_env(&text);
        assert_eq!(
            parsed.get("REEMOAT_AUTH").map(String::as_str),
            Some("signed")
        );
        assert_eq!(
            parsed.get("REEMOAT_ENROLL_CODE").map(String::as_str),
            Some("ec_abc")
        );
    }

    #[test]
    fn the_reader_understands_what_install_sh_writes() {
        let parsed = parse_env(
            "# a comment\n\
             \n\
             REEMOAT_AUTH=signed\n\
             REEMOAT_TOKEN='quoted value'\n\
             REEMOAT_CONTROL_PLANE=\"https://cp.example\"\n\
             MALFORMED\n\
             =novalue\n",
        );
        assert_eq!(
            parsed.get("REEMOAT_TOKEN").map(String::as_str),
            Some("quoted value")
        );
        assert_eq!(
            parsed.get("REEMOAT_CONTROL_PLANE").map(String::as_str),
            Some("https://cp.example")
        );
        // A line with no `=` and a line with no key are skipped rather than
        // producing an entry nothing can use.
        assert!(!parsed.contains_key("MALFORMED"));
        assert!(!parsed.contains_key(""));
    }

    fn payload_at(root: &str) -> Payload {
        Payload {
            root: PathBuf::from(root),
            node: PathBuf::from("/nowhere/node"),
        }
    }

    #[test]
    fn the_payloads_bin_comes_first_so_npm_and_node_are_siblings() {
        let path = daemon_path(
            &payload_at("/app/daemon"),
            Path::new("/home/x"),
            Some("/usr/bin:/bin"),
        );
        // ⚠ Split with the platform's own separator rather than a literal `:`,
        // for the reason `daemon_path` itself now joins with one: a test that
        // hard-codes POSIX's is a test that cannot be right on Windows, which is
        // the platform this whole change is about.
        let parts: Vec<String> = std::env::split_paths(&path)
            .map(|p| p.display().to_string())
            .collect();
        // `agents.sh` resolves node as npm's sibling; if anything preceded the
        // payload's bin, the two could come from different installs.
        assert_eq!(
            parts.first().map(String::as_str),
            Some("/app/daemon/node_modules/.bin")
        );
    }

    #[test]
    fn the_users_own_path_is_kept_and_the_managed_dirs_are_appended() {
        let path = daemon_path(
            &payload_at("/app/daemon"),
            Path::new("/home/x"),
            Some("/opt/mine/bin"),
        );
        let parts: Vec<String> = std::env::split_paths(&path)
            .map(|p| p.display().to_string())
            .collect();
        assert!(parts.iter().any(|p| p == "/opt/mine/bin"));
        let mine = parts.iter().position(|p| p == "/opt/mine/bin").unwrap();
        let managed = parts
            .iter()
            .position(|p| p == "/home/x/.local/bin")
            .unwrap();
        // Appended, never prepended: a file dropped into a writable directory must
        // not win over what the person deliberately installed.
        assert!(mine < managed);
    }

    #[test]
    fn no_shell_is_not_an_empty_path() {
        let path = daemon_path(&payload_at("/app/daemon"), Path::new("/home/x"), None);
        assert!(path.contains("/usr/bin"));
        assert!(!path.contains("::"));
    }

    /// The user's answer is a **list**, and every entry of it survives.
    ///
    /// ⚠ This is the test that caught the join: pushing the shell's whole `PATH`
    /// as one component made `join_paths` refuse — a component may not contain the
    /// separator — and the daemon's PATH silently collapsed to the payload's own
    /// `.bin`, which is every agent CLI and `git` invisible on a machine that has
    /// them. Nothing else would have said so.
    #[test]
    fn every_entry_of_the_users_path_survives_the_join() {
        let path = daemon_path(
            &payload_at("/app/daemon"),
            Path::new("/home/x"),
            Some("/opt/a/bin:/opt/b/bin:/opt/c/bin"),
        );
        let parts: Vec<String> = std::env::split_paths(&path)
            .map(|p| p.display().to_string())
            .collect();
        for wanted in ["/opt/a/bin", "/opt/b/bin", "/opt/c/bin"] {
            assert!(
                parts.iter().any(|p| p == wanted),
                "{wanted} was lost: {path}"
            );
        }
    }

    #[test]
    fn a_blank_shell_answer_is_treated_as_no_answer() {
        let path = daemon_path(
            &payload_at("/app/daemon"),
            Path::new("/home/x"),
            Some("   "),
        );
        assert!(path.contains("/usr/bin"));
    }

    #[test]
    fn a_claim_is_scoped_to_the_server_it_was_made_against() {
        let dir = std::env::temp_dir().join(format!("reemoat-claim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_claim(&dir, "https://a.example", "m_aaaa").unwrap();
        assert_eq!(
            read_claim(&dir, "https://a.example").as_deref(),
            Some("m_aaaa")
        );
        // A machine created against one fleet is meaningless to another, and
        // handing it over would re-mint a code for somebody else's machine id.
        assert_eq!(read_claim(&dir, "https://b.example"), None);
        // ⚠ And a second server does not evict the first. This is the whole reason
        // the file is a map: somebody with a work fleet and a personal one would
        // otherwise spend a permanent machine slot on every switch between them.
        write_claim(&dir, "https://b.example", "m_bbbb").unwrap();
        assert_eq!(
            read_claim(&dir, "https://b.example").as_deref(),
            Some("m_bbbb")
        );
        assert_eq!(
            read_claim(&dir, "https://a.example").as_deref(),
            Some("m_aaaa")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A claim is per account: two people on one server have two machines, and
    /// the bare claim from before accounts is neither's until one proves it.
    #[test]
    fn a_claim_is_scoped_to_the_account() {
        let dir = std::env::temp_dir().join(format!("reemoat-claim-acct-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        write_claim(&dir, "https://a.example#u_a", "m_a").unwrap();
        write_claim(&dir, "https://a.example#u_b", "m_b").unwrap();
        write_claim(&dir, "https://a.example", "m_bare").unwrap();
        assert_eq!(
            read_claim(&dir, "https://a.example#u_a").as_deref(),
            Some("m_a")
        );
        assert_eq!(
            read_claim(&dir, "https://a.example#u_b").as_deref(),
            Some("m_b")
        );
        assert_eq!(
            read_claim(&dir, "https://a.example").as_deref(),
            Some("m_bare")
        );
        assert_eq!(read_claim(&dir, "https://a.example#u_c"), None);
        let mut scopes = claim_scopes(&dir);
        scopes.sort();
        assert_eq!(
            scopes,
            vec![
                "https://a.example".to_string(),
                "https://a.example#u_a".to_string(),
                "https://a.example#u_b".to_string()
            ]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ⚠ **Eight webviews setting up at launch, and every claim kept.** Without
    /// `CLAIM_LOCK` the read-modify-writes interleave and lose claims — each one a
    /// machine the next launch buys again. With it this passes totally; without,
    /// it fails with very high probability rather than certainly, which is the
    /// honest direction for a race (`config.rs`'s `two_writers_do_not_lose_one_another`).
    #[test]
    fn claims_written_together_are_all_kept() {
        let dir = std::env::temp_dir().join(format!("reemoat-claim-race-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let at = &dir;
        std::thread::scope(|scope| {
            for i in 0..8 {
                scope.spawn(move || {
                    write_claim(
                        at,
                        &format!("https://s{i}.example#u_{i}"),
                        &format!("m_{i}"),
                    )
                    .unwrap();
                });
            }
        });
        for i in 0..8 {
            assert_eq!(
                read_claim(&dir, &format!("https://s{i}.example#u_{i}")).as_deref(),
                Some(format!("m_{i}").as_str()),
                "claim {i}"
            );
        }
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp."))
            .collect();
        assert!(strays.is_empty(), "no temporary left behind: {strays:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The bare claim goes to the account proved to own it, once, and never over a
    /// claim that account already has.
    #[test]
    fn a_claim_moves_to_its_owner() {
        let dir = std::env::temp_dir().join(format!("reemoat-claim-move-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        write_claim(&dir, "https://a.example", "m_bare").unwrap();
        move_claim(&dir, "https://a.example", "https://a.example#u_a").unwrap();
        assert_eq!(read_claim(&dir, "https://a.example"), None);
        assert_eq!(
            read_claim(&dir, "https://a.example#u_a").as_deref(),
            Some("m_bare")
        );
        // Again, with nothing bare left: a no-op rather than an error.
        move_claim(&dir, "https://a.example", "https://a.example#u_a").unwrap();
        // And an account with a claim of its own keeps it.
        write_claim(&dir, "https://a.example", "m_other").unwrap();
        move_claim(&dir, "https://a.example", "https://a.example#u_a").unwrap();
        assert_eq!(
            read_claim(&dir, "https://a.example#u_a").as_deref(),
            Some("m_bare")
        );
        assert_eq!(
            read_claim(&dir, "https://a.example").as_deref(),
            Some("m_other")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_claim_is_no_claim_rather_than_a_refusal() {
        let dir = std::env::temp_dir().join(format!("reemoat-claim-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(claim_file(&dir), "not json").unwrap();
        assert_eq!(read_claim(&dir, "https://a.example"), None);
        // An empty id is not a claim either — it would send a re-mint at nothing.
        std::fs::write(claim_file(&dir), r#"{"machines":{"https://a.example":""}}"#).unwrap();
        assert_eq!(read_claim(&dir, "https://a.example"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The override is a development door, and this is the assertion that it is
    /// still only that. A release build must ignore the variable outright.
    #[test]
    fn the_checkout_override_is_a_development_door_only() {
        let dir = std::env::temp_dir().join(format!("reemoat-override-{}", std::process::id()));
        let checkout = dir.join("checkout");
        let bundle = dir.join("bundle");
        std::fs::create_dir_all(checkout.join("scripts")).unwrap();
        std::fs::write(checkout.join("scripts").join("daemon.ts"), "").unwrap();
        // A bundled payload beside a fake runtime, so `locate` can succeed either way.
        // The runtime goes wherever `runtime_beside` says for this platform, so the
        // test follows the layout rather than restating it.
        std::fs::create_dir_all(bundle.join("daemon").join("scripts")).unwrap();
        std::fs::write(bundle.join("daemon").join("scripts").join("daemon.ts"), "").unwrap();
        let exe = dir.join("bin").join("app");
        let runtime = runtime_beside(&exe).expect("an executable path has a runtime path");
        std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        std::fs::write(&runtime, "").unwrap();

        // SAFETY: single-threaded within this test, and the variable is removed
        // before it returns. `cargo test` runs tests in parallel, so the name is
        // process-unique by construction — no other test reads this one.
        unsafe { std::env::set_var(PAYLOAD_OVERRIDE, &checkout) };
        let found = Payload::locate(&bundle, &exe).expect("a payload is found either way");
        unsafe { std::env::remove_var(PAYLOAD_OVERRIDE) };

        if cfg!(debug_assertions) {
            assert_eq!(
                found.root, checkout,
                "a development build follows the checkout"
            );
        } else {
            assert_eq!(
                found.root,
                bundle.join("daemon"),
                "a release build ignores the variable"
            );
        }
        // ⚠ The runtime is the bundled one in both cases: what the override swaps
        // is the code, never the Node it runs under.
        assert_eq!(found.node, runtime);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_payload_missing_its_runtime_is_no_payload() {
        // Neither path exists, so `locate` must refuse rather than hand back a
        // root whose daemon cannot be started.
        let dir = std::env::temp_dir().join(format!("reemoat-payload-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("daemon").join("scripts")).unwrap();
        std::fs::write(dir.join("daemon").join("scripts").join("daemon.ts"), "").unwrap();
        // The runtime is looked for where `runtime_beside` says, which here is absent.
        assert!(Payload::locate(&dir, &dir.join("missing").join("app")).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ⚠ **One relative path reaches the runtime in a bundle and in a development
    /// build**, and this is the assertion that the staging directory still lines up.
    /// `build-daemon.mjs` stages the helper at `target/Helpers` because `target/`
    /// stands where `Contents/` stands; if either end moves, the bundle keeps working
    /// and `tauri dev` quietly answers "unsupported", which reads as a missing stage.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_runtime_helper_is_one_path_from_the_bundle_and_from_a_development_build() {
        let bundle = runtime_beside(Path::new(
            "/Applications/Reemoat.app/Contents/MacOS/reemoat-native",
        ));
        assert_eq!(
            bundle,
            Some(PathBuf::from(
                "/Applications/Reemoat.app/Contents/Helpers/Reemoat Runtime.app/Contents/MacOS/node"
            ))
        );
        let dev = runtime_beside(Path::new(
            "/src/packages/native/src-tauri/target/debug/reemoat-native",
        ));
        assert_eq!(
            dev,
            Some(PathBuf::from(
                "/src/packages/native/src-tauri/target/Helpers/Reemoat Runtime.app/Contents/MacOS/node"
            ))
        );
    }

    #[test]
    fn the_login_shell_is_asked_and_its_banner_is_not_the_answer() {
        // A shell that prints a banner before the value: the marker is what makes
        // the reading unambiguous, and this is the case that proves it.
        let path = login_shell_path(Some("/bin/sh"));
        // `/bin/sh -ilc` answers on every machine this builds on; the assertion is
        // that whatever comes back is a PATH rather than a banner.
        if let Some(value) = path {
            assert!(value.contains('/'));
            assert!(!value.contains("__reemoat_path__"));
        }
    }
    /* ── the env file that is already there ──────────────────────────────── */

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("reemoat-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join(".reemoat")).unwrap();
        dir
    }

    #[test]
    fn a_service_somebody_installed_by_hand_is_found_whatever_it_is_called() {
        let home = scratch("unit");
        let agents = home.join("Library").join("LaunchAgents");
        std::fs::create_dir_all(&agents).unwrap();
        assert!(
            managed_unit(&home).is_none(),
            "an empty directory is not a unit"
        );
        std::fs::write(agents.join("com.example.other.plist"), "").unwrap();
        assert!(
            managed_unit(&home).is_none(),
            "somebody else's agent is not ours"
        );
        // Renamed, because a unit somebody renamed still respawns.
        let ours = agents.join("io.Reemoat.daemon.plist");
        std::fs::write(&ours, "").unwrap();
        assert_eq!(managed_unit(&home), Some(ours));
        // And the remedy matches the supervisor the file belongs to.
        let plist = managed_unit_detail(Path::new("/x/com.reemoat.daemon.plist"));
        assert!(plist.contains("launchctl bootout gui/$(id -u)/com.reemoat.daemon"));
        let service = managed_unit_detail(Path::new("/x/reemoat.service"));
        assert!(service.contains("systemctl --user disable --now reemoat"));
        /*
         * ⚠ **The remedy must clear what this function detects.** The first one
         * only unloaded the service and left the file, so the very next check found
         * it again and offered the same command — a refusal its own instructions
         * could not end. Detection is by file, so the remedy has to move the file.
         */
        for detail in [&plist, &service] {
            assert!(
                detail.contains("mv "),
                "the remedy must remove what the check looks at: {detail}"
            );
        }
    }

    #[test]
    fn a_value_that_could_write_a_second_assignment_is_refused() {
        for bad in [
            "ec_a\nNODE_OPTIONS=--import=data:x",
            "ec_$(id)",
            "ec_`id`",
            "ec_a'b",
            "",
            "ec_a b",
        ] {
            assert!(!is_writable_value(bad), "{bad:?} should be refused");
        }
        for good in ["ec_AbC-123_x.y", "m_01HQ", "https://cp.example"] {
            assert!(is_writable_value(good), "{good:?} should be allowed");
        }
    }

    #[test]
    fn a_computer_with_no_env_file_is_an_empty_slot() {
        let root = legacy_root(&scratch("cfg-none"));
        assert_eq!(config_state(&root, Some("https://cp.example")), CONFIG_NONE);
    }

    #[test]
    fn a_file_this_app_wrote_itself_is_always_its_own() {
        /*
         * ⚠ **The round trip, because the two halves are written apart.** The host
         * writes `env_contents(origin)` and then, on the next launch, asks
         * `config_state` whether that file is its own. If the spelling written is
         * not the spelling compared, the app refuses a file it wrote itself — for
         * ever, since nothing rewrites a file it believes belongs to somebody else.
         */
        let root = legacy_root(&scratch("cfg-roundtrip"));
        for origin in [
            "https://cp.example",
            "http://127.0.0.1:7890",
            "https://cp.example:8443",
        ] {
            std::fs::write(env_path(&root), env_contents(origin, "ec_abc")).unwrap();
            assert_eq!(config_state(&root, Some(origin)), CONFIG_HERE, "{origin}");
            // And the same after a code refresh, which takes the other write path.
            let existing = std::fs::read_to_string(env_path(&root)).unwrap();
            std::fs::write(env_path(&root), env_rewritten(&existing, origin, "ec_next")).unwrap();
            assert_eq!(
                config_state(&root, Some(origin)),
                CONFIG_HERE,
                "{origin} rewritten"
            );
        }
    }

    /// Answer one request with `body`, then close. Returns the port.
    fn stub_health(body: &'static str) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let mut seen = [0u8; 1024];
            let read = socket.read(&mut seen).unwrap_or(0);
            // ⚠ The property this whole shape exists for: nothing is offered to
            // whatever answered. Asserted on the server side, where the bytes
            // actually arrive, rather than on the request string.
            let sent = String::from_utf8_lossy(&seen[..read]).to_lowercase();
            assert!(
                !sent.contains("authorization"),
                "the probe must carry no credential"
            );
            let _ = socket.write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}")
                    .as_bytes(),
            );
        });
        port
    }

    #[test]
    fn an_announce_file_is_not_evidence_that_the_daemon_is_alive() {
        let port = stub_health(r#"{"ok":true,"instanceId":"i_live"}"#);
        assert!(is_alive(&format!("http://127.0.0.1:{port}"), "i_live"));
    }

    #[test]
    fn a_stranger_on_the_port_is_not_this_daemon() {
        /*
         * The second half of the stale-announce bug. `REEMOAT_PORT` is fixed in the
         * env file, so the port a dead daemon named is an ordinary port anything may
         * hold afterwards — and a bare connect would call each of these alive.
         */
        let other = stub_health(r#"{"ok":true,"instanceId":"i_somebody_else"}"#);
        assert!(!is_alive(&format!("http://127.0.0.1:{other}"), "i_live"));
        let garbage = stub_health("not json at all");
        assert!(!is_alive(&format!("http://127.0.0.1:{garbage}"), "i_live"));
    }

    #[test]
    fn nothing_listening_is_nothing_running() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!is_alive(&format!("http://127.0.0.1:{port}"), "i_live"));
        assert!(
            !is_alive("http://127.0.0.1", "i_live"),
            "no port is not a daemon"
        );
        assert!(!is_alive("not a url", "i_live"));
    }

    #[test]
    fn a_file_naming_this_server_is_adopted_rather_than_provisioned() {
        let root = legacy_root(&scratch("cfg-here"));
        std::fs::write(
            env_path(&root),
            "REEMOAT_CONTROL_PLANE='https://cp.example'\n",
        )
        .unwrap();
        // Quoted, because `lib.sh`'s `sq` writes it that way — and the spelling is
        // compared after `normalize_origin`, so a trailing slash or a default port
        // is the same server rather than a different one.
        assert_eq!(config_state(&root, Some("https://cp.example")), CONFIG_HERE);
        std::fs::write(
            env_path(&root),
            "REEMOAT_CONTROL_PLANE=https://cp.example:443/\n",
        )
        .unwrap();
        assert_eq!(config_state(&root, Some("https://cp.example")), CONFIG_HERE);
    }

    #[test]
    fn a_file_naming_another_server_is_never_treated_as_an_empty_slot() {
        let root = legacy_root(&scratch("cfg-else"));
        for text in [
            "REEMOAT_CONTROL_PLANE=https://other.example\n",
            // Unreadable is *also* `elsewhere`: no control plane at all, and a value
            // no URL parser accepts. Answering `none` to either would invite the
            // caller to write over a file somebody else owns.
            "REEMOAT_AUTH=signed\n",
            "REEMOAT_CONTROL_PLANE=:::\n",
        ] {
            std::fs::write(env_path(&root), text).unwrap();
            assert_eq!(
                config_state(&root, Some("https://cp.example")),
                CONFIG_ELSEWHERE,
                "{text}"
            );
        }
        // And with no server chosen yet, every file is somebody else's.
        std::fs::write(
            env_path(&root),
            "REEMOAT_CONTROL_PLANE=https://cp.example\n",
        )
        .unwrap();
        assert_eq!(config_state(&root, None), CONFIG_ELSEWHERE);
    }

    #[test]
    fn a_fresh_code_keeps_every_key_this_app_does_not_own() {
        /*
         * The shape measured on a real machine 2026-09-15: an `install.sh` file,
         * mostly comments, single-quoted values, and a private CA path its owner
         * had added by hand. Losing that line turns a refused enrollment code into
         * a TLS failure, which is a worse bug than the one being fixed.
         */
        let existing = "# a comment\n\
                        REEMOAT_TOKEN=\n\
                        REEMOAT_HOST=127.0.0.1\n\
                        REEMOAT_PORT=7887\n\
                        REEMOAT_AUTH='signed'\n\
                        REEMOAT_CONTROL_PLANE='https://cp.example'\n\
                        REEMOAT_ENROLL_CODE='ec_old'\n\
                        NODE_EXTRA_CA_CERTS='/Users/x/.reemoat/dev-ca.crt'\n";
        let text = env_rewritten(existing, "https://cp.example", "ec_new");
        let parsed = parse_env(&text);
        assert_eq!(
            parsed.get("REEMOAT_ENROLL_CODE").map(String::as_str),
            Some("ec_new")
        );
        assert_eq!(
            parsed.get("REEMOAT_AUTH").map(String::as_str),
            Some("signed")
        );
        assert_eq!(
            parsed.get("NODE_EXTRA_CA_CERTS").map(String::as_str),
            Some("/Users/x/.reemoat/dev-ca.crt")
        );
        assert_eq!(parsed.get("REEMOAT_PORT").map(String::as_str), Some("7887"));
        assert!(
            text.contains("# a comment"),
            "the installer's own prose survives"
        );
        assert!(
            !text.contains("ec_old"),
            "the dead code is gone, not shadowed"
        );
    }

    #[test]
    fn a_duplicate_owned_key_is_dropped_rather_than_left_to_shadow() {
        // Both readers of this file take the *last* assignment, so a survivor below
        // the line just written would be the value that actually took effect.
        let text = env_rewritten(
            "REEMOAT_ENROLL_CODE=ec_one\nREEMOAT_TOKEN=\nREEMOAT_ENROLL_CODE=ec_two\n",
            "https://cp.example",
            "ec_new",
        );
        assert_eq!(text.matches("REEMOAT_ENROLL_CODE=").count(), 1);
        assert_eq!(
            parse_env(&text)
                .get("REEMOAT_ENROLL_CODE")
                .map(String::as_str),
            Some("ec_new")
        );
    }

    #[test]
    fn a_commented_out_assignment_is_prose_rather_than_a_key() {
        // `.env.example` ships `# REEMOAT_AUTH=shared_secret`, and rewriting that
        // into a live assignment would switch a mode nobody asked to switch.
        let text = env_rewritten(
            "# REEMOAT_AUTH=shared_secret\n",
            "https://cp.example",
            "ec_new",
        );
        assert!(text.contains("# REEMOAT_AUTH=shared_secret"));
        assert_eq!(
            parse_env(&text).get("REEMOAT_AUTH").map(String::as_str),
            Some("signed")
        );
    }

    #[test]
    fn a_file_missing_a_key_gains_it_rather_than_starting_without_it() {
        let text = env_rewritten("REEMOAT_HOST=127.0.0.1\n", "https://cp.example", "ec_new");
        let parsed = parse_env(&text);
        assert_eq!(
            parsed.get("REEMOAT_AUTH").map(String::as_str),
            Some("signed")
        );
        assert_eq!(
            parsed.get("REEMOAT_CONTROL_PLANE").map(String::as_str),
            Some("https://cp.example")
        );
        assert_eq!(
            parsed.get("REEMOAT_HOST").map(String::as_str),
            Some("127.0.0.1")
        );
    }

    /* ── a root per server, and per account on it ────────────────────────── */

    const DEV: &str = "https://app.reemoat.test";
    const PROD: &str = "https://app.reemoat.com";

    fn server_root(home: &Path, origin: &str) -> PathBuf {
        legacy_root(home).join("servers").join(server_slug(origin))
    }

    /// The shape this whole change was measured on: the launchd daemon's file names
    /// the dev stand, and the app is signed in to production.
    #[test]
    fn the_legacy_root_is_kept_for_the_server_its_file_names() {
        let home = scratch("root-legacy");
        std::fs::write(
            env_path(&legacy_root(&home)),
            format!("REEMOAT_CONTROL_PLANE='{DEV}'\nREEMOAT_PORT=7887\n"),
        )
        .unwrap();
        assert_eq!(
            state_root(&home, DEV),
            StateRoot {
                dir: legacy_root(&home),
                legacy: true
            },
            "the server launchd's daemon belongs to keeps it, untouched"
        );
        let prod = state_root(&home, PROD);
        assert_eq!(prod.dir, server_root(&home, PROD));
        assert!(!prod.legacy, "and it is the only one that does");
        // Which is exactly what used to be refused: prod read the dev file as its
        // own slot, answered `elsewhere`, and the computer could not be set up.
        assert_eq!(
            config_state(&prod.dir, Some(PROD)),
            CONFIG_NONE,
            "the other server's slot is empty rather than somebody else's"
        );
    }

    #[test]
    fn every_other_server_gets_a_root_of_its_own() {
        let home = scratch("root-others");
        std::fs::write(
            env_path(&legacy_root(&home)),
            format!("REEMOAT_CONTROL_PLANE={DEV}\n"),
        )
        .unwrap();
        let a = state_root(&home, PROD);
        let b = state_root(&home, "http://127.0.0.1:7890");
        assert_ne!(a.dir, b.dir, "two servers, two databases");
        assert_eq!(a.env_file(), server_root(&home, PROD).join("daemon.env"));
        for root in [&a, &b] {
            assert!(!root.legacy);
            assert!(root.dir.starts_with(legacy_root(&home).join("servers")));
        }
    }

    #[test]
    fn a_computer_with_nothing_on_it_gives_the_first_server_the_legacy_root() {
        let home = scratch("root-fresh");
        // An empty `~/.reemoat`, and none at all, are the same computer.
        assert!(state_root(&home, PROD).legacy);
        std::fs::remove_dir_all(legacy_root(&home)).unwrap();
        assert!(state_root(&home, PROD).legacy);
        // The toolchain is per user, not a daemon's state, and does not make the
        // slot taken.
        std::fs::create_dir_all(legacy_root(&home).join("toolchain").join("bin")).unwrap();
        assert!(state_root(&home, PROD).legacy);
    }

    /// ⚠ **"No env file" is not "nothing here".** A daemon run with its env file
    /// elsewhere — `REEMOAT_ENV_FILE`, a checkout's `.env` — still keeps its database
    /// in `~/.reemoat`, and handing that root to a new server would enroll the
    /// database a live daemon is using as a different machine.
    #[test]
    fn a_legacy_database_with_no_file_is_not_an_empty_slot() {
        for trace in ["reemoat.db", "daemon.json"] {
            let home = scratch(&format!("root-trace-{}", trace.replace('.', "-")));
            std::fs::write(legacy_root(&home).join(trace), "").unwrap();
            let root = state_root(&home, PROD);
            assert!(!root.legacy, "{trace} alone keeps the legacy root taken");
            assert_eq!(root.dir, server_root(&home, PROD));
        }
    }

    #[test]
    fn a_server_that_has_a_root_keeps_it() {
        let home = scratch("root-keeps");
        let own = server_root(&home, PROD);
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(env_path(&own), format!("REEMOAT_CONTROL_PLANE={PROD}\n")).unwrap();
        // The legacy root is empty now — somebody purged it — and rule 3 would
        // otherwise hand it over and strand this server's database in its folder.
        assert_eq!(
            state_root(&home, PROD),
            StateRoot {
                dir: own,
                legacy: false
            }
        );
    }

    /// ⚠ **The unit half of the empty-slot rule.** `host_daemon_start` refuses to
    /// rewrite a file a service owns, but only once the file exists — so a leftover
    /// plist beside an *empty*
    /// `~/.reemoat` would be handed the env file this app then writes, and launchd
    /// would respawn against it within ten seconds and race the child for the code.
    #[test]
    fn a_leftover_unit_sends_a_fresh_server_to_its_own_root() {
        let home = scratch("root-unit");
        let agents = home.join("Library").join("LaunchAgents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join("com.reemoat.daemon.plist"), "").unwrap();
        let root = state_root(&home, PROD);
        assert!(!root.legacy);
        assert_eq!(root.dir, server_root(&home, PROD));
    }

    #[test]
    fn the_slug_keeps_the_scheme_and_the_port() {
        assert_eq!(server_slug(PROD), "https_app.reemoat.com");
        assert_eq!(server_slug("http://127.0.0.1:7890"), "http_127.0.0.1_7890");
        // Two trust boundaries, two databases.
        assert_ne!(
            server_slug("http://cp.example"),
            server_slug("https://cp.example")
        );
        assert_ne!(
            server_slug("http://cp.example:7890"),
            server_slug("http://cp.example:7891")
        );
        /*
         * ⚠ **An underscore in the host may not stand in for a port.** Both
         * of these became `http_a.b_8080` before the doubling, and the second
         * server's permanent `elsewhere` would have told somebody to move the
         * first server's database aside.
         */
        assert_ne!(
            server_slug("http://a.b:8080"),
            server_slug("http://a.b_8080")
        );
        assert_eq!(server_slug("http://a.b_8080"), "http_a.b__8080");
        // And every canonical origin is one ordinary path component.
        for origin in [
            PROD,
            "http://127.0.0.1:7890",
            "http://[::1]:7890",
            "https://a_b.example",
        ] {
            let origin = crate::config::normalize_origin(origin).unwrap();
            let slug = server_slug(&origin);
            let mut parts = Path::new(&slug).components();
            assert!(
                matches!(parts.next(), Some(std::path::Component::Normal(_)))
                    && parts.next().is_none(),
                "{origin} → {slug} is not one component"
            );
        }
        let ipv6 = crate::config::normalize_origin("http://[::1]:7890").unwrap();
        assert_ne!(
            server_slug(&ipv6),
            server_slug(&crate::config::normalize_origin("http://127.0.0.1:7890").unwrap())
        );
    }

    #[test]
    fn the_host_reads_this_servers_announcement_before_the_legacy_one() {
        let home = scratch("root-announce");
        std::fs::write(
            env_path(&legacy_root(&home)),
            format!("REEMOAT_CONTROL_PLANE={DEV}\n"),
        )
        .unwrap();
        let prod = state_root(&home, PROD);
        assert_eq!(
            announce_roots(&home, Some(&prod.dir), true),
            vec![server_root(&home, PROD), legacy_root(&home)],
            "a server of its own first, and the install.sh daemon after it"
        );
        let dev = state_root(&home, DEV);
        assert_eq!(
            announce_roots(&home, Some(&dev.dir), true),
            vec![legacy_root(&home)],
            "the legacy root's own server is read once, not twice"
        );
        assert_eq!(announce_roots(&home, None, true), vec![legacy_root(&home)]);
    }

    /// ⚠ **A guest reads its own announcement and nobody else's.** `~/.reemoat` is
    /// its server's owner's, or install.sh's; a guest answered it would adopt
    /// another person's machine as its own.
    #[test]
    fn a_guest_is_answered_its_own_root_alone() {
        let home = scratch("root-guest-announce");
        std::fs::write(
            env_path(&legacy_root(&home)),
            format!("REEMOAT_CONTROL_PLANE={DEV}\n"),
        )
        .unwrap();
        let guest = guest_root(&home, DEV, "u_b");
        assert_eq!(
            announce_roots(&home, Some(&guest.dir), false),
            vec![guest.dir.clone()]
        );
        assert!(
            !announce_roots(&home, Some(&guest.dir), false).contains(&legacy_root(&home)),
            "the owner's daemon is not the guest's to find"
        );
    }

    #[test]
    fn a_second_account_gets_a_root_of_its_own() {
        let home = scratch("root-second");
        let owner = owner_root(&home, PROD, None);
        assert!(
            owner.legacy,
            "the first account on an empty computer: ~/.reemoat"
        );
        let second = guest_root(&home, PROD, "u_b");
        assert_ne!(second.dir, owner.dir);
        assert!(!second.legacy);
        assert_eq!(
            second.dir,
            legacy_root(&home)
                .join("servers")
                .join("https_app.reemoat.com@u_b")
        );
        assert_ne!(guest_root(&home, PROD, "u_c").dir, second.dir);
    }

    /// ⚠ **Never the legacy root, even on a computer where rule 3 would hand it
    /// out**: an empty `~/.reemoat` with no unit is the owner's to take, not a
    /// guest's.
    #[test]
    fn a_guest_is_never_handed_the_legacy_root() {
        let home = scratch("root-guest-empty");
        assert!(
            state_root(&home, PROD).legacy,
            "the precondition: it is free"
        );
        let guest = guest_root(&home, PROD, "u_a");
        assert!(!guest.legacy);
        assert_ne!(guest.dir, legacy_root(&home));
    }

    /// `@` is in no slug and in no user id, so a guest's folder can never be a
    /// server's own — whatever the two are called.
    #[test]
    fn a_guest_root_cannot_be_a_servers_own() {
        let home = scratch("root-guest-injective");
        for origin in [PROD, DEV, "http://127.0.0.1:7890", "http://a.b_8080"] {
            let own = server_root(&home, origin);
            for user in ["u_a", "u_0123456789abcdef"] {
                let guest = guest_root(&home, origin, user);
                assert_ne!(guest.dir, own);
                let name = guest
                    .dir
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                assert!(!server_slug(origin).contains('@'));
                assert_eq!(name, format!("{}@{user}", server_slug(origin)));
            }
        }
    }

    /// ⚠ **Rule 3 decided once.** Two owners of two servers set up over one empty
    /// computer: the first is handed `~/.reemoat` and recorded as its holder, and
    /// the second — asking before anything was written there — is sent to a folder
    /// of its own rather than answered the same root.
    #[test]
    fn the_empty_legacy_root_goes_to_one_origin_only() {
        let home = scratch("root-holder");
        assert!(owner_root(&home, PROD, None).legacy);
        assert!(owner_root(&home, PROD, Some(PROD)).legacy);
        let dev = owner_root(&home, DEV, Some(PROD));
        assert!(
            !dev.legacy,
            "held by another origin, so a folder of its own"
        );
        assert_eq!(dev.dir, server_root(&home, DEV));
        // A file that already names the server wins over any record.
        std::fs::write(
            env_path(&legacy_root(&home)),
            format!("REEMOAT_CONTROL_PLANE={DEV}\n"),
        )
        .unwrap();
        assert!(owner_root(&home, DEV, Some(PROD)).legacy);
    }

    /// Two origins starting over an empty home, together, end in two roots —
    /// the thing `lock_roots` and the holder record exist for.
    #[test]
    fn two_origins_over_an_empty_home_get_two_roots() {
        let home = scratch("root-race");
        let holder: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
        let chosen: std::sync::Mutex<Vec<StateRoot>> = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for origin in [PROD, DEV] {
                let (home, holder, chosen) = (&home, &holder, &chosen);
                scope.spawn(move || {
                    let _held = lock_roots();
                    let held = holder.lock().unwrap().clone();
                    let root = owner_root(home, origin, held.as_deref());
                    if root.legacy && config_state(&root.dir, Some(origin)) != CONFIG_HERE {
                        holder
                            .lock()
                            .unwrap()
                            .get_or_insert_with(|| origin.to_string());
                    }
                    std::fs::create_dir_all(&root.dir).unwrap();
                    std::fs::write(
                        env_path(&root.dir),
                        format!("REEMOAT_CONTROL_PLANE={origin}\n"),
                    )
                    .unwrap();
                    chosen.lock().unwrap().push(root);
                });
            }
        });
        let chosen = chosen.into_inner().unwrap();
        assert_eq!(chosen.len(), 2);
        assert_ne!(chosen[0].dir, chosen[1].dir, "two servers, two databases");
        assert_eq!(chosen.iter().filter(|root| root.legacy).count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_root_narrows_every_level_to_0700() {
        use std::os::unix::fs::PermissionsExt;
        let home = scratch("root-modes");
        let legacy = legacy_root(&home);
        // An upgrade: both ancestors already exist, and wide.
        std::fs::create_dir_all(legacy.join("servers")).unwrap();
        for dir in [&legacy, &legacy.join("servers")] {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let root = StateRoot {
            dir: server_root(&home, PROD),
            legacy: false,
        };
        ensure_root(&home, &root).unwrap();
        for dir in [legacy.clone(), legacy.join("servers"), root.dir.clone()] {
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{} is {mode:o}", dir.display());
        }
        // Twice is not an error.
        ensure_root(&home, &root).unwrap();
    }

    /// A child that ignores `SIGTERM`, which is what a daemon deep in its 20-second
    /// close looks like to this process.
    #[cfg(unix)]
    fn stubborn() -> Supervisor {
        let child = Command::new("sh")
            .args(["-c", "trap '' TERM; exec sleep 30"])
            .spawn()
            .unwrap();
        Supervisor {
            child: Some(child),
            ..Supervisor::new()
        }
    }

    /// ⚠ **The only shape that can tell "one deadline" from "one each".** A
    /// child that dies on `SIGTERM` is gone in milliseconds either way, so a test
    /// built from `sleep 30` alone passes for the sequential version too. These
    /// ignore the signal, so a quit that stopped them one after another would take
    /// a deadline apiece — two seconds here — and one that signals all and waits
    /// once takes one.
    #[cfg(unix)]
    #[test]
    fn a_quit_stops_every_daemon_under_one_deadline() {
        let mut first = stubborn();
        let mut second = stubborn();
        // Let `sh` install the trap before anything signals it.
        std::thread::sleep(Duration::from_millis(200));
        let began = std::time::Instant::now();
        stop_all_by(
            [&mut first, &mut second],
            began + Duration::from_millis(1000),
        );
        let took = began.elapsed();
        assert!(
            first.child.is_none() && second.child.is_none(),
            "both reaped"
        );
        assert!(
            took < Duration::from_millis(1900),
            "one deadline for both, not one each: {took:?}"
        );
        assert!(
            took >= Duration::from_millis(900),
            "and the deadline was waited out rather than skipped: {took:?}"
        );
    }

    /// And the other half: a daemon that does stop is not held to the deadline.
    #[cfg(unix)]
    #[test]
    fn a_daemon_that_stops_is_not_waited_for_past_its_exit() {
        let mut quick = Supervisor {
            child: Some(Command::new("sleep").arg("30").spawn().unwrap()),
            ..Supervisor::new()
        };
        let began = std::time::Instant::now();
        stop_all([&mut quick]);
        assert!(quick.child.is_none());
        assert!(began.elapsed() < Duration::from_secs(5));
    }

    /// The three spawn-time variables, read back out of a child's own environment.
    ///
    /// A stand-in `node` that prints its environment, so the assertion is about
    /// what a process actually received rather than about the builder's calls.
    #[cfg(unix)]
    #[test]
    fn a_root_of_its_own_gets_the_kernels_port_and_the_legacy_root_keeps_its_own() {
        use std::os::unix::fs::PermissionsExt;
        let home = scratch("spawn-env");
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, "#!/bin/sh\nenv\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let payload = Payload {
            root: home.clone(),
            node,
        };
        // The file says what `install.sh` writes, including a stale server.
        let file: BTreeMap<String, String> = [
            ("REEMOAT_PORT", "7887"),
            ("REEMOAT_CONTROL_PLANE", "https://stale.example/"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

        let seen = |ephemeral_port: bool, root: PathBuf| -> Vec<String> {
            let mut supervisor = Supervisor::new();
            supervisor
                .start(
                    &payload,
                    &home,
                    &file,
                    &Spawn {
                        root,
                        control_plane: PROD.to_string(),
                        ephemeral_port,
                    },
                )
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while std::time::Instant::now() < deadline
                && !supervisor
                    .log_lines()
                    .iter()
                    .any(|l| l.starts_with("REEMOAT_HOME="))
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            // The ring is filled by reader threads; give them the rest of `env`.
            std::thread::sleep(Duration::from_millis(100));
            supervisor.stop();
            supervisor.log_lines()
        };

        let own = server_root(&home, PROD);
        let lines = seen(true, own.clone());
        let has = |line: &str| lines.iter().any(|l| l == line);
        assert!(has(&format!("REEMOAT_HOME={}", own.display())), "{lines:?}");
        assert!(
            has(&format!("REEMOAT_CONTROL_PLANE={PROD}")),
            "the host's origin wins over the file's"
        );
        assert!(
            has("REEMOAT_PORT=0"),
            "a root of its own is on the kernel's port"
        );
        assert!(!has("REEMOAT_PORT=7887"));

        let lines = seen(false, legacy_root(&home));
        let has = |line: &str| lines.iter().any(|l| l == line);
        assert!(has(&format!(
            "REEMOAT_HOME={}",
            legacy_root(&home).display()
        )));
        assert!(
            has("REEMOAT_PORT=7887"),
            "the legacy root keeps the file's port, for pnpm client and lib.sh"
        );
        assert!(!has("REEMOAT_PORT=0"));
    }
}
