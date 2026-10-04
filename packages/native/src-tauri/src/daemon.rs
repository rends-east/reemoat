//! The daemon this app carries: a child process that dies with the app, one state root per
//! account (Q7.148, Q7.149). Unlike `local.rs` it says *why* there is no daemon, since this
//! app caused it. It never starts a daemon that is already there and never kills one it did
//! not start.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// One code path for the bundle and `tauri dev`: `resource_dir()` answers the right directory in both.
pub struct Payload {
    pub root: PathBuf,
    pub node: PathBuf,
}

/// Runs the daemon from a checkout, since `tauri dev` otherwise runs a stale snapshot.
/// Debug builds only: in a shipped app one variable would make it execute somebody else's code.
const PAYLOAD_OVERRIDE: &str = "REEMOAT_DAEMON_PAYLOAD";

/// Also in `build-daemon.mjs`, `build.rs` and `tauri.conf.json`; `nativecheck` compares all four.
/// macOS only, or the Android clippy job refuses it as dead code.
#[cfg(target_os = "macos")]
pub const RUNTIME_HELPER: &str = "Reemoat Runtime.app";

/// In a helper bundle with `LSUIElement`, or every `npx` child drew a blank Dock tile
/// (`build-daemon.mjs`). `<exe>/../../Helpers` is right in the bundle and in `target/` alike.
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

#[cfg(not(target_os = "macos"))]
pub fn runtime_beside(exe: &Path) -> Option<PathBuf> {
    Some(exe.parent()?.join("node"))
}

impl Payload {
    pub fn locate(resource_dir: &Path, exe: &Path) -> Option<Payload> {
        let node = runtime_beside(exe)?;
        // Only the code is swapped; the runtime stays the one that ships.
        if cfg!(debug_assertions) {
            if let Some(dir) = std::env::var_os(PAYLOAD_OVERRIDE) {
                let root = PathBuf::from(dir);
                if root.join("scripts").join("daemon.ts").is_file() && node.is_file() {
                    return Some(Payload { root, node });
                }
            }
        }
        let root = resource_dir.join("daemon");
        if !root.join("scripts").join("daemon.ts").is_file() || !node.is_file() {
            return None;
        }
        Some(Payload { root, node })
    }
}

/// The root install.sh, launchd and every hand-started daemon use.
pub fn legacy_root(home: &Path) -> PathBuf {
    home.join(".reemoat")
}

const SERVERS_DIR: &str = "servers";

/// `http://127.0.0.1:7890` → `http_127.0.0.1_7890`. Doubling `_` first keeps it injective, and
/// it never yields `@`, so no guest's folder is a server's own.
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateRoot {
    pub dir: PathBuf,
    /// `~/.reemoat` itself: the only root on port 7887 and the only one `managed_unit` is asked about.
    pub legacy: bool,
}

impl StateRoot {
    pub fn env_file(&self) -> PathBuf {
        env_path(&self.dir)
    }
}

/// An existence check that errors counts as present. `daemon.json` is the one trace a daemon
/// with `REEMOAT_ENV_FILE` and `REEMOAT_DB` elsewhere still leaves here.
pub fn holds_no_daemon(root: &Path) -> bool {
    ["daemon.env", "reemoat.db", "daemon.json"]
        .iter()
        .all(|name| matches!(root.join(name).try_exists(), Ok(false)))
}

/// First match: `~/.reemoat` if its env names this server; `servers/<server>` if it has an env;
/// an empty `~/.reemoat` with no leftover service unit; else `servers/<server>`. Never cached (Q7.148).
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

/// `state_root`, except an empty `~/.reemoat` goes only to `holder` (`legacy_root_holder`), so two
/// servers set up together cannot both be answered it.
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

/// Never the legacy root; injective because `@` is in no slug and no user id.
pub fn guest_root(home: &Path, origin: &str, user: &str) -> StateRoot {
    StateRoot {
        dir: legacy_root(home)
            .join(SERVERS_DIR)
            .join(format!("{}@{user}", server_slug(origin))),
        legacy: false,
    }
}

/// Own root, then `~/.reemoat` for an install.sh daemon. A guest gets its own root alone, or it
/// would adopt another person's machine (Q7.149).
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

/// Held from `state_root` through `Supervisor::start`, or two accounts can share one database.
/// Taken only off the main thread and never under a `Host` lock.
static ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Poison is ignored: the guarded value is `()`.
pub fn lock_roots() -> std::sync::MutexGuard<'static, ()> {
    ROOT_LOCK.lock().unwrap_or_else(|held| held.into_inner())
}

/// Adoption only, page alive or not: a hidden `WKWebView` is suspended, so the host owns the
/// daemons. Skips a root whose env names another server, or where a daemon it did not start is alive.
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

/// Every level `0700`, or another user could plant `servers/<server>` with an env and announcement
/// of their choosing. Created at the mode, then narrowed for one that existed wider.
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

pub fn env_path(root: &Path) -> PathBuf {
    root.join("daemon.env")
}

/// The three keys `deploy/install.sh` writes, in its format, so either can adopt the other's file
/// (only at `~/.reemoat`, Q7.148). The code goes in a `0600` file, never argv.
pub fn env_contents(control_plane: &str, enroll_code: &str) -> String {
    let mut text = format!(
        "# Written by Reemoat.app. The same file `deploy/install.sh` writes.\n\
         REEMOAT_AUTH=signed\n\
         REEMOAT_CONTROL_PLANE={control_plane}\n\
         REEMOAT_ENROLL_CODE={enroll_code}\n"
    );
    // Node reads no keychain, so a private CA this process trusts must be spelled out for the daemon.
    for name in [
        "NODE_EXTRA_CA_CERTS",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
    ] {
        if let Some(value) = std::env::var_os(name).and_then(|v| v.into_string().ok()) {
            // A newline would write a second assignment into a file `sh` sources.
            if !value.is_empty() && !value.contains('\n') && !value.contains('\r') {
                text.push_str(&format!("{name}={value}\n"));
            }
        }
    }
    text
}

/// Loopback, so this bounds a wedged socket rather than latency.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

const PROBE_LIMIT: u64 = 8 * 1024;

/// A stale announce file survives a crash, and a bare connect may reach a stranger on the port;
/// only `/health`'s `instanceId` proves it. Raw socket, so no client exists to attach a credential to.
pub fn is_alive(base: &str, instance_id: &str) -> bool {
    use std::io::{Read, Write};
    let Ok(url) = url::Url::parse(base) else {
        return false;
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port()) else {
        return false;
    };
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
    // HTTP/1.0 and close, so the answer ends at EOF with no chunked handling.
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

const CONTROL_PLANE_KEY: &str = "REEMOAT_CONTROL_PLANE";

/// Not `HOME`, which stays the real home so agents find their own sign-ins.
const STATE_ROOT_KEY: &str = "REEMOAT_HOME";

const PORT_KEY: &str = "REEMOAT_PORT";

/// Passed at spawn and never written, so `OWNED_KEYS` stays three.
pub struct Spawn {
    pub root: PathBuf,
    pub control_plane: String,
    /// `REEMOAT_PORT=0`. Never on the legacy root, which stays on 7887 for `pnpm client` (Q1.22).
    pub ephemeral_port: bool,
}

/// Only these are rewritten: a hand-edited install.sh file holds lines this app never wrote.
const OWNED_KEYS: [&str; 3] = ["REEMOAT_AUTH", CONTROL_PLANE_KEY, "REEMOAT_ENROLL_CODE"];

/// A leftover launchd/systemd unit respawns within seconds and races this app's child for the
/// single-use code, so its presence refuses the rewrite. Matched by glob, since a renamed unit still respawns.
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

/// The remedy must move the file: unloading alone leaves it to fail this check, and `RunAtLoad` reloads it.
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

/// The file is sourced by `sh` and every key reaches the daemon's env, so a newline or `$(…)` is
/// code. Refused rather than escaped, since `parse_env` would read an escape differently.
pub fn is_writable_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '/'))
}

pub const CONFIG_NONE: &str = "none";
pub const CONFIG_HERE: &str = "here";
pub const CONFIG_ELSEWHERE: &str = "elsewhere";

/// Without this a half-finished install read as `absent` and cost a machine quota slot per launch.
/// An unreadable file is `elsewhere`, never `none`: it is not evidence of an empty slot.
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

/// Line-preserving, keeping every line it does not own. A duplicate owned key is dropped, since
/// a later assignment wins in both readers.
pub fn env_rewritten(existing: &str, control_plane: &str, enroll_code: &str) -> String {
    // `both` survives, or shared-secret clients of a break-glass machine would be signed out.
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

/// `KEY=value`, `#` and blanks only; not a shell parser, and must not become one.
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
        // `install.sh` quotes some values, which `sh` would strip.
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

/// Machines this app created, so an interrupted setup never buys a second one: a machine holds a
/// quota slot until revoked. A map keyed by account scope, so no account's claim overwrites another's.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Claims {
    #[serde(default)]
    machines: BTreeMap<String, String>,
}

/// Every account's page sets up at launch, and two interleaved read-modify-writes lose a claim.
static CLAIM_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn claim_file(dir: &Path) -> PathBuf {
    dir.join("machine.json")
}

/// Every failure is `None`: one extra machine is cheaper than an app that will not start.
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
    let mut claims = read_claims(dir);
    claims
        .machines
        .insert(scope.to_string(), machine_id.to_string());
    write_claims(dir, &claims)
}

/// For `config::read_accounts`'s derivation: which bare origins had a machine before accounts.
pub fn claim_scopes(dir: &Path) -> Vec<String> {
    read_claims(dir)
        .machines
        .into_iter()
        .filter(|(_, id)| !id.is_empty())
        .map(|(scope, _)| scope)
        .collect()
}

/// Bare origin to the proved account; a no-op if the account has a claim or the bare one is gone.
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

/// Temp file and rename, since a truncate-then-crash would lose every claim.
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

/// Unsanitised: what a machine name may contain is the control plane's rule.
pub fn host_name() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = vec![0u8; 256];
        // SAFETY: the pointer and length describe `buf`, which outlives the call.
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

/// For the child's `USER`: without it claude keys its Keychain lookup on `unknown` and reads as an
/// expired login. `getpwuid` before the environment, which may be a stale export.
fn login_name() -> Option<String> {
    #[cfg(unix)]
    {
        // SAFETY: `getpwuid` points into libc's static storage, copied out before any other call; null falls through.
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

const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// A GUI app gets launchd's bare PATH, so the login shell is asked for the real one. Every
/// failure is `None` and the caller falls back to a composed list.
pub fn login_shell_path(shell: Option<&str>) -> Option<String> {
    const MARK: &str = "__reemoat_path__";
    // Unix by decision: Git Bash and MSYS2 set `SHELL` to a shell that knows nothing of the Windows PATH.
    if !cfg!(unix) {
        return None;
    }
    let shell = shell?;
    if shell.is_empty() {
        return None;
    }

    // On a deadline rather than `output()`: an interactive profile can block for ever.
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
    // The marker, or a profile's banner would be parsed as the PATH.
    let value = text.split(MARK).nth(1)?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

/// The payload's `.bin` first (`agents.sh` takes the node beside npm), the user's PATH, then the
/// managed install directories, appended so a dropped file never outranks a deliberate install.
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
        // Split: pushed whole, the separator inside makes `join_paths` refuse the lot.
        Some(p) if !p.trim().is_empty() => parts.extend(
            std::env::split_paths(p.trim())
                .map(|part| part.display().to_string())
                .filter(|part| !part.is_empty()),
        ),
        // Measured defaults only: Homebrew on macOS, no Linuxbrew, nothing for an unmeasured platform.
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
    // The platform's separator; a refusal keeps only the payload's `.bin`, which the daemon needs.
    match std::env::join_paths(parts.iter().map(std::ffi::OsString::from)) {
        Ok(joined) => joined.to_string_lossy().into_owned(),
        Err(_) => parts.first().cloned().unwrap_or_default(),
    }
}

/// The ring Settings → Logs reads; no per-line clip, unlike `src/plugins/runtime.ts`'s.
const LOG_LINES: usize = 200;

/// `scripts/daemon.ts`'s `SHUTDOWN_HARD_LIMIT_MS` plus a second, so its own timer usually wins.
const STOP_DEADLINE: std::time::Duration = std::time::Duration::from_millis(26_000);

const STOP_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// One per state root (Q7.148, Q7.149). The child handle is the identity, so a stop never hits a reused pid.
pub struct Supervisor {
    child: Option<std::process::Child>,
    log: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    last_exit: Option<i32>,
}

#[derive(serde::Serialize)]
pub struct DaemonState {
    /// `absent` · `starting` · `running` · `foreign` · `exited` · `unsupported`
    pub status: String,
    #[serde(rename = "machineId")]
    pub machine_id: Option<String>,
    /// What this app bought, up or not, unlike `machineId`; when set, re-mint rather than create.
    pub claimed: Option<String>,
    /// `3` a refused code, `4` an unreachable control plane; the two the caller acts on.
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    /// `none` · `here` · `elsewhere`, asked before a machine is created.
    pub config: String,
    /// A flag, never `absent`: a stranger's file in the shared root says nothing about this server's daemon.
    pub stranger: bool,
}

impl Default for DaemonState {
    /// An empty `config` is none of the three answers.
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

    pub fn owns_running(&mut self) -> bool {
        let status = match self.child.as_mut() {
            None => return false,
            // `try_wait` reaps; `Ok(None)` is "still running".
            Some(child) => child.try_wait(),
        };
        match status {
            Ok(None) => true,
            Ok(Some(status)) => {
                // The exit code, not the log, says whether to re-mint (3) or wait (4).
                self.last_exit = status.code();
                self.child = None;
                false
            }
            Err(_) => false,
        }
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.last_exit
    }

    /// `exited` against `absent`; the lines themselves stay off the poll (Q7.140).
    pub fn printed_anything(&self) -> bool {
        self.log
            .lock()
            .map(|held| !held.is_empty())
            .unwrap_or(false)
    }

    /// A second reader so the poll stays a word; lines rather than a joined string.
    pub fn log_lines(&self) -> Vec<String> {
        match self.log.lock() {
            Ok(held) => held.clone(),
            // Poisoned by a panicked reader; no log is survivable, a crash is not.
            Err(_) => Vec::new(),
        }
    }

    /// `node --import tsx`, never tsx's CLI, which would make the daemon an unreaped grandchild.
    /// Layers, each winning: a clean env with `USER`, then the env file, then `spawn`.
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
            // Built, not inherited: this process may carry Tauri's or an agent session's variables.
            .env_clear()
            .env("HOME", home)
            .env("PATH", path)
            .env("UV_THREADPOOL_SIZE", "64")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // Both spellings (see `login_name`), before the env file so a line there still wins.
        if let Some(name) = login_name() {
            command.env("USER", &name);
            command.env("LOGNAME", &name);
        }
        for (key, value) in env {
            command.env(key, value);
        }
        // After the file, so these win: they are what make this child this server's daemon.
        command.env(STATE_ROOT_KEY, &spawn.root);
        command.env(CONTROL_PLANE_KEY, &spawn.control_plane);
        if spawn.ephemeral_port {
            command.env(PORT_KEY, "0");
        }
        // Without a locale git's output is ASCII-mangled.
        if let Ok(lang) = std::env::var("LANG") {
            command.env("LANG", lang);
        }
        // Node reads no keychain, so certificate and proxy settings pass through; `SHELL` and
        // `TMPDIR` for `USER`'s reason (a per-user `TMPDIR`, not world-writable `/tmp`).
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
            // The env file wins over whatever this process happened to inherit.
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
            // An undrained pipe fills and blocks the daemon on its own banner.
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

    /// Split into `signal` and `reap_by` so `stop_all` can signal every daemon before waiting on any.
    pub fn stop(&mut self) {
        self.signal();
        self.reap_by(std::time::Instant::now() + STOP_DEADLINE);
    }

    /// The handle stays, keeping the pid unreaped and so unrecyclable until `reap_by`.
    pub fn signal(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        #[cfg(unix)]
        {
            // SIGTERM, not `Child::kill`'s SIGKILL, so the daemon's graceful stop runs.
            let pid = child.id() as i32;
            // SAFETY: our own live child, kept unreaped by the handle, so the pid cannot be recycled.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
        // Known gap: Windows has no SIGTERM, so every turn in flight is interrupted.
        #[cfg(not(unix))]
        {
            let _ = child.kill();
        }
    }

    /// A deadline, so `stop_all` hands every daemon the same instant. Waiting at all matters: a
    /// relaunch would otherwise lose `claimDaemonLock` to the old daemon.
    pub fn reap_by(&mut self, deadline: std::time::Instant) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => return,
                Ok(None) => {}
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(STOP_POLL);
        }
        // Past its own hard limit, so wedged.
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Supervisor::new()
    }
}

/// Signal all, then wait once; `stop()` in turn would cost a `STOP_DEADLINE` per daemon.
pub fn stop_all<'a>(supervisors: impl IntoIterator<Item = &'a mut Supervisor>) {
    stop_all_by(supervisors, std::time::Instant::now() + STOP_DEADLINE);
}

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
    /// Invisible from inside the daemon, so asserted here (see `login_name`).
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
        let parts: Vec<String> = std::env::split_paths(&path)
            .map(|p| p.display().to_string())
            .collect();
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
        assert!(mine < managed);
    }

    #[test]
    fn no_shell_is_not_an_empty_path() {
        let path = daemon_path(&payload_at("/app/daemon"), Path::new("/home/x"), None);
        assert!(path.contains("/usr/bin"));
        assert!(!path.contains("::"));
    }

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
        assert_eq!(read_claim(&dir, "https://b.example"), None);
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

    /// Without `CLAIM_LOCK` this fails with high probability, not certainty.
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
        move_claim(&dir, "https://a.example", "https://a.example#u_a").unwrap();
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
        std::fs::write(claim_file(&dir), r#"{"machines":{"https://a.example":""}}"#).unwrap();
        assert_eq!(read_claim(&dir, "https://a.example"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_checkout_override_is_a_development_door_only() {
        let dir = std::env::temp_dir().join(format!("reemoat-override-{}", std::process::id()));
        let checkout = dir.join("checkout");
        let bundle = dir.join("bundle");
        std::fs::create_dir_all(checkout.join("scripts")).unwrap();
        std::fs::write(checkout.join("scripts").join("daemon.ts"), "").unwrap();
        std::fs::create_dir_all(bundle.join("daemon").join("scripts")).unwrap();
        std::fs::write(bundle.join("daemon").join("scripts").join("daemon.ts"), "").unwrap();
        let exe = dir.join("bin").join("app");
        let runtime = runtime_beside(&exe).expect("an executable path has a runtime path");
        std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        std::fs::write(&runtime, "").unwrap();

        // SAFETY: removed before returning, and no other test reads this variable.
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
        assert_eq!(found.node, runtime);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_payload_missing_its_runtime_is_no_payload() {
        let dir = std::env::temp_dir().join(format!("reemoat-payload-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("daemon").join("scripts")).unwrap();
        std::fs::write(dir.join("daemon").join("scripts").join("daemon.ts"), "").unwrap();
        assert!(Payload::locate(&dir, &dir.join("missing").join("app")).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// If staging moves, the bundle still works and `tauri dev` quietly answers "unsupported".
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
        let path = login_shell_path(Some("/bin/sh"));
        if let Some(value) = path {
            assert!(value.contains('/'));
            assert!(!value.contains("__reemoat_path__"));
        }
    }

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
        let ours = agents.join("io.Reemoat.daemon.plist");
        std::fs::write(&ours, "").unwrap();
        assert_eq!(managed_unit(&home), Some(ours));
        let plist = managed_unit_detail(Path::new("/x/com.reemoat.daemon.plist"));
        assert!(plist.contains("launchctl bootout gui/$(id -u)/com.reemoat.daemon"));
        let service = managed_unit_detail(Path::new("/x/reemoat.service"));
        assert!(service.contains("systemctl --user disable --now reemoat"));
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
        // A spelling mismatch would refuse a file this app wrote, for ever.
        let root = legacy_root(&scratch("cfg-roundtrip"));
        for origin in [
            "https://cp.example",
            "http://127.0.0.1:7890",
            "https://cp.example:8443",
        ] {
            std::fs::write(env_path(&root), env_contents(origin, "ec_abc")).unwrap();
            assert_eq!(config_state(&root, Some(origin)), CONFIG_HERE, "{origin}");
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
        std::fs::write(
            env_path(&root),
            "REEMOAT_CONTROL_PLANE=https://cp.example\n",
        )
        .unwrap();
        assert_eq!(config_state(&root, None), CONFIG_ELSEWHERE);
    }

    #[test]
    fn a_fresh_code_keeps_every_key_this_app_does_not_own() {
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
        // `.env.example` ships `# REEMOAT_AUTH=shared_secret`.
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

    const DEV: &str = "https://app.reemoat.test";
    const PROD: &str = "https://app.reemoat.com";

    fn server_root(home: &Path, origin: &str) -> PathBuf {
        legacy_root(home).join("servers").join(server_slug(origin))
    }

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
        assert!(state_root(&home, PROD).legacy);
        std::fs::remove_dir_all(legacy_root(&home)).unwrap();
        assert!(state_root(&home, PROD).legacy);
        // The toolchain is per user, not a daemon's state.
        std::fs::create_dir_all(legacy_root(&home).join("toolchain").join("bin")).unwrap();
        assert!(state_root(&home, PROD).legacy);
    }

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
        assert_eq!(
            state_root(&home, PROD),
            StateRoot {
                dir: own,
                legacy: false
            }
        );
    }

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
        assert_ne!(
            server_slug("http://cp.example"),
            server_slug("https://cp.example")
        );
        assert_ne!(
            server_slug("http://cp.example:7890"),
            server_slug("http://cp.example:7891")
        );
        assert_ne!(
            server_slug("http://a.b:8080"),
            server_slug("http://a.b_8080")
        );
        assert_eq!(server_slug("http://a.b_8080"), "http_a.b__8080");
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
        std::fs::write(
            env_path(&legacy_root(&home)),
            format!("REEMOAT_CONTROL_PLANE={DEV}\n"),
        )
        .unwrap();
        assert!(owner_root(&home, DEV, Some(PROD)).legacy);
    }

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
        ensure_root(&home, &root).unwrap();
    }

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

    /// Children that ignore `SIGTERM`, the only shape that tells one deadline from one each.
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

    /// A stand-in `node` prints its environment, so this asserts what the child received.
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
            // Reader threads fill the ring; give them the rest of `env`.
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
