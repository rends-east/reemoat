//! `server.json`: the accounts, their device ids and the chosen server. Preferences, not
//! secrets, so not in the keyring, which also cannot be listed (Q7.149, Q1.651). The file is
//! `0600` because `device_keys` may hold a private key; `read_stored` decides, per unreadable
//! state, whether anything may be written over it.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use url::Url;

/// The only defence for `commands.rs`'s unlocked `write_private`; the pid in `temp_name` covers a second process.
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Closes a lost update between read-modify-writes, which could drop a fallback private key.
/// Poison is ignored (the value is `()`); held across no network, keyring or panel call.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// The file with `CONFIG_LOCK` held inside it, so a read-modify-write is one critical section by
/// construction. Not a third argument: `nativecheck` greps `write_stored(dir, &stored)` literally.
struct Guarded {
    file: Stored,
    /// `false`: bytes on disk this process neither read nor safely quarantined, so nothing may replace them.
    replaceable: bool,
    _lock: MutexGuard<'static, ()>,
}

impl Deref for Guarded {
    type Target = Stored;
    fn deref(&self) -> &Stored {
        &self.file
    }
}

impl DerefMut for Guarded {
    fn deref_mut(&mut self) -> &mut Stored {
        &mut self.file
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    /// `default` spelled out: under `flatten` serde's `Option` rule is generated differently.
    #[serde(default)]
    server: Option<String>,
    /// Per account scope, since a device row names one user. Never forgotten but by
    /// `device_revoked`, not even on a server change, or a slot is spent again (Q7.148).
    #[serde(default)]
    devices: BTreeMap<String, String>,
    /// Only where the keyring will not keep the key; see `read_device_key_fallback`.
    #[serde(default)]
    device_keys: BTreeMap<String, String>,
    /// `None` is a pre-accounts file, which `read_accounts` derives a list for; skipped when
    /// `None` so the file stays pre-accounts until an act changes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accounts: Option<Vec<StoredAccount>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current: Option<String>,
    /// Origin → the user owning that server's own root (`""`: nobody without proof). Kept on forget (Q7.149).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    roots: BTreeMap<String, String>,
    /// So an empty `~/.reemoat` is handed to one origin only (`daemon::owner_root`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_root_holder: Option<String>,
    /// A `Value`, so a shape this build cannot read is ignored rather than quarantining the file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    theme: Option<serde_json::Value>,
    /// Keys from a later build, kept so an older build's write does not drop them.
    #[serde(flatten)]
    rest: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct StoredAccount {
    origin: String,
    /// `None` for a pre-accounts entry nothing has attributed yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default)]
    bound: bool,
    /// Persisted so listing accounts reads no keyring (a prompt per row on an unsigned build).
    #[serde(default)]
    signed_in: bool,
    #[serde(default)]
    seen: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pending_proof: bool,
    /// The device came from the bare entry by proof (`quarantine_is_only_about`).
    #[serde(default, skip_serializing_if = "is_false")]
    inherited: bool,
    #[serde(flatten)]
    rest: BTreeMap<String, serde_json::Value>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl StoredAccount {
    fn key(&self) -> String {
        match &self.user {
            Some(user) => crate::accounts::scope_of(&self.origin, user),
            None => self.origin.clone(),
        }
    }
}

pub fn server_file(dir: &Path) -> PathBuf {
    dir.join("server.json")
}

/// Set by no file here, so a fork inherits no address; releases forward a repository variable,
/// which unset arrives as `Some("")` (Q4.127).
const DEFAULT_SERVER: Option<&str> = option_env!("REEMOAT_DEFAULT_SERVER");

/// A suggestion for the field, never written down; Continue adopts it (Q4.121).
pub fn default_server() -> Option<String> {
    normalize_origin(DEFAULT_SERVER?).ok()
}

/// Every failure is `None`, the setup screen. Through `read_stored`, so the first launch already
/// quarantines bytes nothing can read.
pub fn read_server(dir: &Path) -> Option<String> {
    let server = read_stored(dir).server.clone()?;
    // Re-normalized: the file may have been hand-edited.
    normalize_origin(&server).ok()
}

/// Materializes the empty list, or a relaunch would derive a legacy entry for an unsigned server.
pub fn write_server(dir: &Path, origin: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    stored.server = Some(origin.to_string());
    accounts_mut(&mut stored, dir);
    write_stored(dir, &stored)
}

const UNREADABLE: &str = "server.json.unreadable";

fn unreadable_file(dir: &Path) -> PathBuf {
    dir.join(UNREADABLE)
}

/// Moves unparseable bytes (maybe the only copy of a key) aside, first one wins. `true` only where
/// they landed, since that becomes `replaceable`: nothing preserved, nothing replaced.
fn quarantine(dir: &Path) -> bool {
    let aside = unreadable_file(dir);
    if aside.exists() {
        return false;
    }
    if fs::rename(server_file(dir), &aside).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // A filesystem without modes still preserved the bytes.
        let _ = fs::set_permissions(&aside, fs::Permissions::from_mode(0o600));
    }
    true
}

/// After a Re-key the quarantine is a superseded secret; removed only after a write that landed,
/// and only where it names this scope alone, since another account's key may live only there.
fn discard_quarantine(dir: &Path, scope: &str) {
    if !quarantine_is_only_about(dir, scope) {
        return;
    }
    // A failed removal leaves what was there; nothing for a caller to do.
    let _ = fs::remove_file(unreadable_file(dir));
}

/// Scans raw bytes (the file may not be UTF-8) for `scheme://host[#user]` tokens; `false` for
/// anything it cannot settle. The bare origin counts only for a legacy scope or an `inherited` account.
fn quarantine_is_only_about(dir: &Path, scope: &str) -> bool {
    let Ok(bytes) = fs::read(unreadable_file(dir)) else {
        return false;
    };
    let (origin, bare) = match scope.split_once('#') {
        Some((origin, _)) => (origin, false),
        None => (scope, true),
    };
    // Lazily: `read_stored` takes `CONFIG_LOCK`, which every caller has released.
    let mut inherited: Option<bool> = None;
    let mut owns_bare = || {
        *inherited.get_or_insert_with(|| {
            read_stored(dir).accounts.as_ref().is_some_and(|list| {
                list.iter()
                    .any(|account| account.key() == scope && account.inherited)
            })
        })
    };
    const MARK: &[u8] = b"://";
    let mut named = 0usize;
    let mut i = 0usize;
    while i + MARK.len() <= bytes.len() {
        if &bytes[i..i + MARK.len()] != MARK {
            i += 1;
            continue;
        }
        let mut start = i;
        while start > 0 && is_scheme_byte(bytes[start - 1]) {
            start -= 1;
        }
        let mut end = i + MARK.len();
        while end < bytes.len() && is_authority_byte(bytes[end]) {
            end += 1;
        }
        if end < bytes.len() && bytes[end] == b'#' {
            end += 1;
            while end < bytes.len() && is_user_byte(bytes[end]) {
                end += 1;
            }
        }
        match std::str::from_utf8(&bytes[start..end]) {
            Ok(token) if token == scope => named += 1,
            Ok(token) if token == origin && (bare || owns_bare()) => named += 1,
            _ => return false,
        }
        i = end;
    }
    // Naming nothing is not being about this scope.
    named > 0
}

fn is_scheme_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')
}

fn is_authority_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':' | b'[' | b']')
}

/// `accounts::is_user_id`'s alphabet.
fn is_user_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')
}

/// Every failure answers `Default` so the app still starts; `replaceable` says whether a write may
/// follow. `nativecheck` holds the arms below, in order, to a written-out list.
fn read_stored(dir: &Path) -> Guarded {
    let lock = CONFIG_LOCK.lock().unwrap_or_else(|held| held.into_inner());
    let (file, replaceable) = match fs::read_to_string(server_file(dir)) {
        Err(e) if e.kind() == ErrorKind::NotFound => (Stored::default(), true),
        // POSIX refuses `rename(file, dir)`, so nothing can be lost; also what
        // `a_write_that_cannot_land_takes_its_temporary_with_it` provokes.
        Err(e) if e.kind() == ErrorKind::IsADirectory => (Stored::default(), true),
        // Not UTF-8: no errno, never transient, evidence about the bytes like a serde error.
        Err(e) if e.kind() == ErrorKind::InvalidData => (Stored::default(), quarantine(dir)),
        // A read with an errno may be transient, so the bytes are neither moved nor replaced.
        Err(_) => (Stored::default(), false),
        Ok(text) => match serde_json::from_str::<Stored>(&text) {
            Ok(parsed) => (parsed, true),
            Err(_) => (Stored::default(), quarantine(dir)),
        },
    };
    Guarded {
        file,
        replaceable,
        _lock: lock,
    }
}

/// Flushes the directory entry a rename wrote, which `sync_all` on the file does not. Callers treat
/// it as best effort. Measured to succeed on macOS; on Windows (read off std) the open fails.
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    fs::File::open(dir).and_then(|handle| handle.sync_all())
}

/// Pid for another process, counter for another write in this one: a shared name truncates the
/// other writer's bytes, a torn `daemon.env` that reads as `elsewhere`.
pub fn temp_name(name: &str) -> String {
    format!(
        "{name}.tmp.{}.{}",
        std::process::id(),
        WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// A `0600` temporary, flushed, renamed over (which narrows a file an older build left `0644`),
/// then the directory flushed. Mode set at creation and again on the handle, since `mode()` is
/// masked by the umask. Refuses outright when `replaceable` is `false`.
fn write_stored(dir: &Path, stored: &Guarded) -> Result<(), String> {
    use std::io::Write;

    // Before `create_dir_all`, so nothing is created. Some callers discard the refusal
    // (`setNativeDevice` is fire-and-forget); the awaited writers show it.
    if !stored.replaceable {
        return Err(format!(
            "{} could not be read or safely kept, so nothing was written over it. \
             Move it aside by hand and try again.",
            server_file(dir).display()
        ));
    }

    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // A filesystem without modes is no reason to refuse.
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let text = serde_json::to_string_pretty(&stored.file).map_err(|e| e.to_string())?;
    let target = server_file(dir);
    let tmp = dir.join(temp_name("server.json"));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("could not write {}: {e}", tmp.display()));
        }
    }
    // Or the rename can beat the contents to disk: a whole file of zeroes.
    if let Err(e) = file
        .write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
    {
        let _ = fs::remove_file(&tmp);
        return Err(format!("could not write {}: {e}", tmp.display()));
    }
    drop(file);
    fs::rename(&tmp, &target).map_err(|e| {
        // A leftover temporary is a second copy of the private key.
        let _ = fs::remove_file(&tmp);
        format!("could not write the server file: {e}")
    })?;
    // Best effort: a write that landed is never reported as one that did not.
    let _ = sync_dir(dir);
    Ok(())
}

pub fn read_device(dir: &Path, scope: &str) -> Option<String> {
    read_stored(dir).devices.get(scope).cloned()
}

/// Also marks it bound, since registering binds. A derived list is not materialized for this.
pub fn write_device(dir: &Path, scope: &str, device: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    stored.devices.insert(scope.to_string(), device.to_string());
    mark_bound(&mut stored, scope, true);
    write_stored(dir, &stored)
}

fn mark_bound(stored: &mut Stored, scope: &str, bound: bool) {
    if let Some(entry) = stored
        .accounts
        .as_mut()
        .and_then(|list| list.iter_mut().find(|account| account.key() == scope))
    {
        entry.bound = bound;
    }
}

/// For a retired device (`device_revoked`).
pub fn erase_device(dir: &Path, scope: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    // On an unread file the map is empty because nothing was parsed; let `write_stored` refuse.
    if stored.replaceable && stored.devices.remove(scope).is_none() {
        return Ok(());
    }
    mark_bound(&mut stored, scope, false);
    write_stored(dir, &stored)
}

/// A private key in a `0600` file, only where the keyring discards writes; otherwise every launch
/// would regenerate it and burn a device slot. The app says which store it used.
pub fn read_device_key_fallback(dir: &Path, scope: &str) -> Option<String> {
    read_stored(dir).device_keys.get(scope).cloned()
}

pub fn write_device_key_fallback(dir: &Path, scope: &str, key: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    stored
        .device_keys
        .insert(scope.to_string(), key.to_string());
    write_stored(dir, &stored)
}

/// A keyring promotion as well as a Re-key, so it touches `server.json` only and never the
/// quarantine; `give_up_device_key` is the deliberate give-up.
pub fn erase_device_key_fallback(dir: &Path, scope: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    // As in `erase_device`: an unread file's empty map is not a key given up.
    if stored.replaceable && stored.device_keys.remove(scope).is_none() {
        return Ok(());
    }
    write_stored(dir, &stored)
}

/// Re-key: the one moment a quarantined copy is superseded. Discarded after the write, never before.
pub fn give_up_device_key(dir: &Path, scope: &str) -> Result<(), String> {
    erase_device_key_fallback(dir, scope)?;
    discard_quarantine(dir, scope);
    Ok(())
}

/// The one canonical origin, or a sentence: two spellings of one server would be two credential
/// keys. A missing scheme is filled in; `http` and `https` are never merged.
pub fn normalize_origin(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Type the address of a Reemoat server.".into());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = Url::parse(&candidate)
        .map_err(|_| format!("{trimmed} is not an address this can reach."))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "{other}: is not a scheme this can reach. A Reemoat server is http or https."
            ))
        }
    }
    // Refused rather than silently stripped.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Leave the username and password out of the address.".into());
    }
    if parsed.host_str().is_none() {
        return Err("That address names no host.".into());
    }
    // scheme://host[:port] with a default port omitted: the whole normalization.
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err("That address names no host.".into());
    }
    Ok(origin)
}

/// origin → the user id that owns that server's own daemon root, or `""`.
pub type Roots = BTreeMap<String, String>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub origin: String,
    pub user: Option<String>,
    pub name: Option<String>,
    pub bound: bool,
    pub signed_in: bool,
    pub seen: u64,
    pub pending_proof: bool,
}

impl Account {
    /// `<origin>#<user id>`, or the bare origin for a legacy entry.
    pub fn key(&self) -> String {
        match &self.user {
            Some(user) => crate::accounts::scope_of(&self.origin, user),
            None => self.origin.clone(),
        }
    }

    fn from_stored(stored: &StoredAccount) -> Account {
        Account {
            origin: stored.origin.clone(),
            user: stored.user.clone(),
            name: stored.name.clone(),
            bound: stored.bound,
            signed_in: stored.signed_in,
            seen: stored.seen,
            pending_proof: stored.pending_proof,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Roster {
    pub accounts: Vec<Account>,
    pub current: Option<String>,
    /// A pre-accounts server with no evidence of a sign-in: opens as a pending seat, not an account.
    pub pending: Option<String>,
    pub roots: Roots,
    pub legacy_root_holder: Option<String>,
    /// Derived from a pre-accounts file; nothing of it is on disk yet.
    pub derived: bool,
}

impl Roster {
    pub fn find(&self, key: &str) -> Option<&Account> {
        self.accounts.iter().find(|account| account.key() == key)
    }

    pub fn recent(&self, except: Option<&str>) -> Option<&Account> {
        self.accounts
            .iter()
            .filter(|account| except != Some(account.key().as_str()))
            .max_by_key(|account| account.seen)
    }

    pub fn shown(&self) -> Option<&Account> {
        self.current
            .as_deref()
            .and_then(|key| self.find(key))
            .or_else(|| self.recent(None))
    }
}

/// Writes nothing. A pre-accounts file gets a list derived from its evidence of sign-ins
/// (`server` only on evidence, else `pending`). `evidence` runs under `CONFIG_LOCK`, so must not take it.
pub fn read_accounts(dir: &Path, evidence: &dyn Fn(&str) -> bool) -> Roster {
    let stored = read_stored(dir);
    let (list, current, pending, derived) = match &stored.accounts {
        Some(list) => (list.clone(), stored.current.clone(), None, false),
        None => {
            let claims = crate::daemon::claim_scopes(dir);
            let (list, current, pending) = derive(&stored, &claims, evidence);
            (list, current, pending, true)
        }
    };
    Roster {
        accounts: list.iter().map(Account::from_stored).collect(),
        current,
        pending,
        roots: stored.roots.clone(),
        legacy_root_holder: stored.legacy_root_holder.clone(),
        derived,
    }
}

fn derive(
    stored: &Stored,
    claims: &[String],
    evidence: &dyn Fn(&str) -> bool,
) -> (Vec<StoredAccount>, Option<String>, Option<String>) {
    let mut asked: BTreeMap<String, bool> = BTreeMap::new();
    let mut ask = |origin: &str| -> bool {
        *asked
            .entry(origin.to_string())
            .or_insert_with(|| evidence(origin))
    };
    // Only a key already in canonical spelling; a hand-edited key is not an account.
    let bare = |key: &str| !key.contains('#') && normalize_origin(key).ok().as_deref() == Some(key);
    let server = stored
        .server
        .as_deref()
        .and_then(|raw| normalize_origin(raw).ok());

    let mut candidates: Vec<String> = Vec::new();
    let mut pending = None;
    if let Some(server) = &server {
        if stored.devices.contains_key(server) || claims.contains(server) || ask(server) {
            candidates.push(server.clone());
        } else {
            pending = Some(server.clone());
        }
    }
    for key in stored.devices.keys().chain(claims.iter()) {
        if bare(key) && !candidates.contains(key) {
            candidates.push(key.clone());
        }
    }
    candidates.truncate(crate::accounts::MAX_ACCOUNTS);

    let count = candidates.len() as u64;
    let list = candidates
        .iter()
        .enumerate()
        .map(|(index, origin)| StoredAccount {
            origin: origin.clone(),
            bound: stored.devices.contains_key(origin),
            signed_in: ask(origin),
            // `server` first and most recent: it is what that build was showing.
            seen: count - index as u64,
            ..StoredAccount::default()
        })
        .collect();
    let current = server.filter(|server| candidates.contains(server));
    (list, current, pending)
}

/// With the launch's `evidence`, so what is written is what the drawer showed.
pub fn materialize_accounts(dir: &Path, evidence: &dyn Fn(&str) -> bool) -> Result<(), String> {
    let mut stored = read_stored(dir);
    if stored.accounts.is_some() {
        return Ok(());
    }
    let claims = crate::daemon::claim_scopes(dir);
    let (list, current, _) = derive(&stored, &claims, evidence);
    stored.accounts = Some(list);
    stored.current = current;
    write_stored(dir, &stored)
}

/// Backstop with no evidence, so a derived entry reads as signed out.
fn accounts_mut<'a>(stored: &'a mut Stored, dir: &Path) -> &'a mut Vec<StoredAccount> {
    if stored.accounts.is_none() {
        let claims = crate::daemon::claim_scopes(dir);
        let (list, current, _) = derive(stored, &claims, &|_| false);
        stored.current = current;
        stored.accounts = Some(list);
    }
    stored.accounts.get_or_insert_with(Vec::new)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proof {
    NotAsked,
    Proven,
    Disproven,
    /// `Boot.legacy` asks again next time.
    Unreachable,
}

/// What the host learned about an origin's bare items before binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Evidence {
    /// No daemon in the server's own root and no claim for it: nothing to lose.
    pub root_empty: bool,
    pub root: Proof,
    pub device: Proof,
    /// The bare device is the one bound to the session being bound.
    pub device_current: bool,
}

impl Evidence {
    pub const NONE: Evidence = Evidence {
        root_empty: false,
        root: Proof::NotAsked,
        device: Proof::NotAsked,
        device_current: false,
    };
}

/// What was inherited by proof.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Claimed {
    pub root: bool,
    pub device: bool,
    pub pending: bool,
}

/// The root only by proof or when empty and `free` (no other unconfirmed legacy entry), never from
/// another user. The device only by proof into an account with none: one key on two rows links them.
fn claim_into(
    stored: &mut Stored,
    key: &str,
    origin: &str,
    user: &str,
    evidence: &Evidence,
    free: bool,
) -> Claimed {
    let record = stored.roots.get(origin).cloned();
    let mine = record.as_deref() == Some(user);
    let someone_elses =
        matches!(record.as_deref(), Some(owner) if !owner.is_empty() && owner != user);
    let root = !mine
        && !someone_elses
        && (evidence.root == Proof::Proven || (evidence.root_empty && free));
    if root {
        stored.roots.insert(origin.to_string(), user.to_string());
    }

    let device = evidence.device == Proof::Proven
        && stored.devices.contains_key(origin)
        && !stored.devices.contains_key(key);
    if device {
        if let Some(id) = stored.devices.remove(origin) {
            stored.devices.insert(key.to_string(), id);
        }
        if !stored.device_keys.contains_key(key) {
            if let Some(held) = stored.device_keys.remove(origin) {
                stored.device_keys.insert(key.to_string(), held);
            }
        }
    }

    let owned = mine || root;
    Claimed {
        root,
        device,
        pending: (evidence.root == Proof::Unreachable && !owned && !someone_elses)
            || evidence.device == Proof::Unreachable,
    }
}

pub struct BindRequest<'a> {
    /// The legacy entry being attributed; `None` for a new one.
    pub from: Option<&'a str>,
    pub origin: &'a str,
    pub user: &'a str,
    pub name: &'a str,
    /// A sign-in that just happened, whose session has no device bound yet.
    pub fresh: bool,
    pub evidence: &'a Evidence,
}

#[derive(Debug, PartialEq, Eq)]
pub struct BoundAccount {
    pub key: String,
    pub owner: bool,
    pub claimed: Claimed,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Bind {
    /// Already here; nothing was written.
    Existing {
        key: String,
        signed_in: bool,
    },
    Bound(BoundAccount),
}

/// The one place `MAX_ACCOUNTS` is enforced, refusing rather than evicting. `owner` is recomputed as
/// `roots[origin] == user`, so a returning owner gets the root back and a second user stays a guest.
pub fn bind_account(dir: &Path, request: &BindRequest<'_>) -> Result<Bind, String> {
    let mut stored = read_stored(dir);
    accounts_mut(&mut stored, dir);
    let key = crate::accounts::scope_of(request.origin, request.user);
    let list = stored.accounts.as_deref().unwrap_or_default();
    if let Some(found) = list.iter().find(|account| {
        account.origin == request.origin && account.user.as_deref() == Some(request.user)
    }) {
        return Ok(Bind::Existing {
            key,
            signed_in: found.signed_in,
        });
    }
    let from = request.from.and_then(|from| {
        list.iter()
            .position(|account| account.user.is_none() && account.origin == from)
    });
    if from.is_none() && list.len() >= crate::accounts::MAX_ACCOUNTS {
        return Err(format!(
            "account_limit: this computer holds {} accounts, which is the most it keeps. Remove one first.",
            crate::accounts::MAX_ACCOUNTS
        ));
    }
    let free = !list.iter().enumerate().any(|(index, account)| {
        Some(index) != from && account.user.is_none() && account.origin == request.origin
    });
    let seen = list.iter().map(|account| account.seen).max().unwrap_or(0) + 1;
    let rest = from
        .and_then(|index| list.get(index))
        .map(|account| account.rest.clone())
        .unwrap_or_default();

    let claimed = claim_into(
        &mut stored,
        &key,
        request.origin,
        request.user,
        request.evidence,
        free,
    );
    let entry = StoredAccount {
        origin: request.origin.to_string(),
        user: Some(request.user.to_string()),
        name: Some(request.name.to_string()).filter(|name| !name.is_empty()),
        bound: !request.fresh && claimed.device && request.evidence.device_current,
        signed_in: true,
        seen,
        pending_proof: claimed.pending,
        inherited: claimed.device,
        rest,
    };
    let list = stored.accounts.get_or_insert_with(Vec::new);
    match from {
        Some(index) => list[index] = entry,
        None => list.push(entry),
    }
    stored.current = Some(key.clone());
    stored.server = Some(request.origin.to_string());
    let owner = stored.roots.get(request.origin).map(String::as_str) == Some(request.user);
    write_stored(dir, &stored)?;
    Ok(Bind::Bound(BoundAccount {
        key,
        owner,
        claimed,
    }))
}

/// What `evidence` proves for an account already here, or a retry of an unreachable proof.
/// `from` does not count against an empty root; `bound` only if proved with this account's session.
pub fn claim_bare(
    dir: &Path,
    key: &str,
    from: Option<&str>,
    evidence: &Evidence,
    bound: bool,
) -> Result<Claimed, String> {
    let mut stored = read_stored(dir);
    accounts_mut(&mut stored, dir);
    let list = stored.accounts.as_deref().unwrap_or_default();
    let Some(index) = list.iter().position(|account| account.key() == key) else {
        return Err("that account is not on this computer".into());
    };
    let (origin, Some(user)) = (list[index].origin.clone(), list[index].user.clone()) else {
        return Err("an account from before accounts has nobody to give anything to".into());
    };
    let free = !list.iter().enumerate().any(|(other, account)| {
        other != index
            && account.user.is_none()
            && account.origin == origin
            && Some(account.origin.as_str()) != from
    });
    let before = list[index].pending_proof;
    let claimed = claim_into(&mut stored, key, &origin, &user, evidence, free);
    let entry = &mut stored.accounts.get_or_insert_with(Vec::new)[index];
    entry.pending_proof = claimed.pending;
    if claimed.device {
        entry.inherited = true;
        entry.bound = bound;
    }
    if !claimed.root && !claimed.device && before == claimed.pending {
        return Ok(claimed);
    }
    write_stored(dir, &stored)?;
    Ok(claimed)
}

pub fn rename_account(dir: &Path, key: &str, name: &str) -> Result<bool, String> {
    let mut stored = read_stored(dir);
    accounts_mut(&mut stored, dir);
    let Some(entry) = stored
        .accounts
        .as_mut()
        .and_then(|list| list.iter_mut().find(|account| account.key() == key))
    else {
        return Err("that account is not on this computer".into());
    };
    let wanted = Some(name.to_string()).filter(|name| !name.is_empty());
    if entry.name == wanted {
        return Ok(false);
    }
    entry.name = wanted;
    write_stored(dir, &stored)?;
    Ok(true)
}

/// Only after the switch happened: a failure here is not a failed switch.
pub fn show_account(dir: &Path, key: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    accounts_mut(&mut stored, dir);
    let list = stored.accounts.get_or_insert_with(Vec::new);
    let seen = list.iter().map(|account| account.seen).max().unwrap_or(0) + 1;
    let Some(entry) = list.iter_mut().find(|account| account.key() == key) else {
        return Err("that account is not on this computer".into());
    };
    entry.seen = seen;
    let origin = entry.origin.clone();
    stored.current = Some(key.to_string());
    stored.server = Some(origin);
    write_stored(dir, &stored)
}

pub fn set_bound(dir: &Path, key: &str, bound: bool) -> Result<(), String> {
    update(dir, key, |entry| {
        let changed = entry.bound != bound;
        entry.bound = bound;
        changed
    })
}

/// Signing out also unbinds the device: its session is the one that ended.
pub fn set_signed_in(dir: &Path, key: &str, signed_in: bool) -> Result<(), String> {
    update(dir, key, |entry| {
        let changed = entry.signed_in != signed_in || (!signed_in && entry.bound);
        entry.signed_in = signed_in;
        if !signed_in {
            entry.bound = false;
        }
        changed
    })
}

fn update(
    dir: &Path,
    key: &str,
    change: impl FnOnce(&mut StoredAccount) -> bool,
) -> Result<(), String> {
    let mut stored = read_stored(dir);
    accounts_mut(&mut stored, dir);
    let Some(entry) = stored
        .accounts
        .as_mut()
        .and_then(|list| list.iter_mut().find(|account| account.key() == key))
    else {
        return Ok(());
    };
    if !change(entry) {
        return Ok(());
    }
    write_stored(dir, &stored)
}

/// Keeps the device id, key and root record, so signing in again reuses them. An unconfirmed
/// legacy entry leaves its root recorded as `""`, so no new account takes it without proof.
pub fn forget_account(dir: &Path, key: &str) -> Result<Option<String>, String> {
    let mut stored = read_stored(dir);
    accounts_mut(&mut stored, dir);
    let list = stored.accounts.get_or_insert_with(Vec::new);
    let Some(index) = list.iter().position(|account| account.key() == key) else {
        return Ok(list
            .iter()
            .max_by_key(|account| account.seen)
            .map(StoredAccount::key));
    };
    let gone = list.remove(index);
    let next = list
        .iter()
        .max_by_key(|account| account.seen)
        .map(StoredAccount::key);
    if gone.user.is_none() {
        stored.roots.entry(gone.origin.clone()).or_default();
    }
    if stored.current.as_deref() == Some(key) {
        stored.current = next.clone();
    }
    write_stored(dir, &stored)?;
    Ok(next)
}

pub fn set_legacy_root_holder(dir: &Path, origin: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    if stored.legacy_root_holder.is_some() {
        return Ok(());
    }
    stored.legacy_root_holder = Some(origin.to_string());
    write_stored(dir, &stored)
}

/// A palette, in the page's own spelling (Q3.671).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
    Light,
    Dark,
}

impl Theme {
    pub fn parse(name: &str) -> Option<Theme> {
        match name {
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        }
    }
}

fn theme_of(stored: &Stored) -> Theme {
    match stored.theme.as_ref().and_then(serde_json::Value::as_str) {
        Some("dark") => Theme::Dark,
        _ => Theme::Light,
    }
}

pub fn read_theme(dir: &Path) -> Theme {
    theme_of(&read_stored(dir))
}

/// The page says it every boot, so an unchanged theme writes nothing. Not an account act, so a
/// pre-accounts file stays one.
pub fn write_theme(dir: &Path, theme: Theme) -> Result<bool, String> {
    let mut stored = read_stored(dir);
    // An unread file's light is not a light known to be recorded.
    if stored.replaceable && theme_of(&stored) == theme {
        return Ok(false);
    }
    stored.theme = (theme == Theme::Dark).then(|| serde_json::Value::from("dark"));
    write_stored(dir, &stored)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        bind_account, claim_bare, default_server, erase_device, erase_device_key_fallback,
        forget_account, give_up_device_key, materialize_accounts, normalize_origin, read_accounts,
        read_device, read_device_key_fallback, read_server, read_theme, rename_account,
        server_file, set_bound, set_signed_in, show_account, temp_name, unreadable_file,
        write_device, write_device_key_fallback, write_server, write_theme, Bind, BindRequest,
        Evidence, Proof, Theme, DEFAULT_SERVER,
    };
    use std::path::Path;

    #[cfg(unix)]
    fn mode_of(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .unwrap_or_else(|e| panic!("{} should exist: {e}", path.display()))
            .permissions()
            .mode()
            & 0o777
    }

    /// By substring, so a change to the temporary's name cannot make this vacuous.
    fn strays(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp."))
            .collect()
    }

    /// Per test, so a pass never depends on order.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("reemoat-cfg-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_default_is_a_suggestion_and_writes_nothing() {
        let dir = scratch("suggest");
        assert_eq!(read_server(&dir), None);
        assert!(!dir.join("server.json").exists());
    }

    #[test]
    fn a_chosen_server_is_what_is_read_back() {
        let dir = scratch("chosen");
        write_server(&dir, "https://chosen.example").unwrap();
        assert_eq!(read_server(&dir).as_deref(), Some("https://chosen.example"));
    }

    /// Vacuous here, loud in a fork with a typo; blank is skipped, being an unset variable (Q4.127).
    /// The message avoids the variable's name beside `=`, which `nativecheck` sweeps for as a setter.
    #[test]
    fn a_compiled_default_is_an_address() {
        if let Some(raw) = DEFAULT_SERVER.filter(|raw| !raw.trim().is_empty()) {
            assert!(
                default_server().is_some(),
                "the compiled-in default server {raw} is not an address this can reach"
            );
        }
    }

    #[test]
    fn a_device_is_scoped_to_its_server() {
        let dir = std::env::temp_dir().join(format!("reemoat-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_server(&dir, "https://a.example").unwrap();
        write_device(&dir, "https://a.example", "dv_aaa").unwrap();
        write_device(&dir, "https://b.example", "dv_bbb").unwrap();

        assert_eq!(
            read_device(&dir, "https://a.example").as_deref(),
            Some("dv_aaa")
        );
        assert_eq!(
            read_device(&dir, "https://b.example").as_deref(),
            Some("dv_bbb")
        );
        assert_eq!(read_device(&dir, "https://c.example"), None);
        assert_eq!(read_server(&dir).as_deref(), Some("https://a.example"));

        // The old server's row still exists, so its id is kept.
        write_server(&dir, "https://b.example").unwrap();
        assert_eq!(
            read_device(&dir, "https://a.example").as_deref(),
            Some("dv_aaa")
        );

        erase_device(&dir, "https://a.example").unwrap();
        assert_eq!(read_device(&dir, "https://a.example"), None);
        assert_eq!(
            read_device(&dir, "https://b.example").as_deref(),
            Some("dv_bbb")
        );
        erase_device(&dir, "https://a.example").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    const A: &str = "https://a.example";
    const B: &str = "https://b.example";

    fn request<'a>(
        from: Option<&'a str>,
        user: &'a str,
        fresh: bool,
        evidence: &'a Evidence,
    ) -> BindRequest<'a> {
        BindRequest {
            from,
            origin: A,
            user,
            name: user,
            fresh,
            evidence,
        }
    }

    fn bound(result: Result<Bind, String>) -> super::BoundAccount {
        match result {
            Ok(Bind::Bound(bound)) => bound,
            Ok(Bind::Existing { key, .. }) => panic!("{key} was answered as already here"),
            Err(e) => panic!("{e}"),
        }
    }

    const EMPTY: Evidence = Evidence {
        root_empty: true,
        root: Proof::NotAsked,
        device: Proof::NotAsked,
        device_current: false,
    };

    #[test]
    fn a_file_from_before_accounts_reads_as_legacy_accounts_and_writes_nothing() {
        let dir = scratch("derive");
        std::fs::create_dir_all(&dir).unwrap();
        let text = format!(
            r#"{{"server":"{A}","devices":{{"{A}":"dv_a","{B}":"dv_b","not an origin":"x"}}}}"#
        );
        std::fs::write(server_file(&dir), &text).unwrap();
        std::fs::write(
            dir.join("machine.json"),
            r#"{"machines":{"https://c.example":"m_c"}}"#,
        )
        .unwrap();

        let roster = read_accounts(&dir, &|_| false);
        assert!(roster.derived);
        let keys: Vec<String> = roster.accounts.iter().map(|a| a.key()).collect();
        assert_eq!(keys, vec![A, B, "https://c.example"]);
        assert!(roster.accounts.iter().all(|a| a.user.is_none()));
        assert_eq!(roster.current.as_deref(), Some(A));
        assert_eq!(roster.shown().map(|a| a.key()).as_deref(), Some(A));
        assert!(roster.accounts[0].bound && roster.accounts[1].bound);
        assert!(!roster.accounts[2].bound, "a claim is not a bound device");
        assert_eq!(
            std::fs::read_to_string(server_file(&dir)).unwrap(),
            text,
            "derivation wrote nothing"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_phantom_server_is_a_pending_sign_in() {
        let dir = scratch("phantom");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(server_file(&dir), format!(r#"{{"server":"{A}"}}"#)).unwrap();

        let without = read_accounts(&dir, &|_| false);
        assert!(without.accounts.is_empty());
        assert_eq!(without.pending.as_deref(), Some(A));

        let with = read_accounts(&dir, &|origin| origin == A);
        assert_eq!(with.accounts.len(), 1);
        assert_eq!(with.pending, None);
        assert!(
            with.accounts[0].signed_in,
            "and the evidence is its signed-in flag"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_first_run_derives_no_account_and_a_chosen_server_pins_the_accounts_era() {
        let dir = scratch("firstrun");
        let fresh = read_accounts(&dir, &|_| true);
        assert!(fresh.accounts.is_empty() && fresh.pending.is_none());
        assert!(!server_file(&dir).exists());

        write_server(&dir, A).unwrap();
        let text = std::fs::read_to_string(server_file(&dir)).unwrap();
        assert!(text.contains("\"accounts\": []"), "{text}");
        let pinned = read_accounts(&dir, &|_| true);
        assert!(!pinned.derived);
        assert!(
            pinned.accounts.is_empty(),
            "a relaunch finds a pending seat, never a derived legacy one"
        );
        assert_eq!(read_server(&dir).as_deref(), Some(A));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_first_account_on_a_server_owns_it_and_the_second_is_a_guest() {
        let dir = scratch("owner");
        write_server(&dir, A).unwrap();
        let first = bound(bind_account(&dir, &request(None, "u_a", true, &EMPTY)));
        assert!(first.owner && first.claimed.root);
        let second = bound(bind_account(&dir, &request(None, "u_b", true, &EMPTY)));
        assert!(!second.owner && !second.claimed.root);
        let proven = Evidence {
            root: Proof::Proven,
            ..EMPTY
        };
        let third = bound(bind_account(&dir, &request(None, "u_c", true, &proven)));
        assert!(
            !third.owner,
            "a root already somebody's is theirs for good, proof or no proof"
        );
        let roster = read_accounts(&dir, &|_| false);
        assert_eq!(roster.roots.get(A).map(String::as_str), Some("u_a"));
        assert_eq!(roster.current.as_deref(), Some("https://a.example#u_c"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_returning_user_gets_its_root_back() {
        let dir = scratch("return");
        write_server(&dir, A).unwrap();
        assert!(bound(bind_account(&dir, &request(None, "u_a", true, &EMPTY))).owner);
        forget_account(&dir, "https://a.example#u_a").unwrap();
        // Nothing asked and the root not empty: the record alone answers.
        let again = bound(bind_account(
            &dir,
            &request(None, "u_a", true, &Evidence::NONE),
        ));
        assert!(again.owner && !again.claimed.root);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_proven_inherit_moves_what_the_server_held() {
        let dir = scratch("proven");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            server_file(&dir),
            format!(
                r#"{{"server":"{A}","devices":{{"{A}":"dv_a"}},"device_keys":{{"{A}":"KEY"}}}}"#
            ),
        )
        .unwrap();
        materialize_accounts(&dir, &|_| true).unwrap();
        let proven = Evidence {
            root_empty: false,
            root: Proof::Proven,
            device: Proof::Proven,
            device_current: true,
        };
        let moved = bound(bind_account(&dir, &request(Some(A), "u_a", false, &proven)));
        assert!(moved.owner && moved.claimed.root && moved.claimed.device);
        let key = "https://a.example#u_a";
        assert_eq!(read_device(&dir, key).as_deref(), Some("dv_a"));
        assert_eq!(
            read_device(&dir, A),
            None,
            "the bare id is gone, not copied"
        );
        assert_eq!(read_device_key_fallback(&dir, key).as_deref(), Some("KEY"));
        assert_eq!(read_device_key_fallback(&dir, A), None);
        let roster = read_accounts(&dir, &|_| false);
        assert_eq!(roster.accounts.len(), 1, "re-keyed in place");
        assert!(roster.accounts[0].bound);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unproven_inherit_takes_nothing() {
        let dir = scratch("unproven");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            server_file(&dir),
            format!(r#"{{"server":"{A}","devices":{{"{A}":"dv_a"}}}}"#),
        )
        .unwrap();
        materialize_accounts(&dir, &|_| true).unwrap();
        let disproven = Evidence {
            root_empty: false,
            root: Proof::Disproven,
            device: Proof::Unreachable,
            device_current: false,
        };
        let moved = bound(bind_account(
            &dir,
            &request(Some(A), "u_b", true, &disproven),
        ));
        assert!(!moved.owner && !moved.claimed.root && !moved.claimed.device);
        assert!(moved.claimed.pending, "an unreachable proof is asked again");
        assert_eq!(read_device(&dir, A).as_deref(), Some("dv_a"));
        assert_eq!(read_device(&dir, "https://a.example#u_b"), None);
        let roster = read_accounts(&dir, &|_| false);
        assert!(roster.accounts[0].pending_proof);
        assert_eq!(roster.roots.get(A), None, "and the root is still nobody's");

        let proven = Evidence {
            root_empty: false,
            root: Proof::NotAsked,
            device: Proof::Proven,
            device_current: false,
        };
        let later = claim_bare(&dir, "https://a.example#u_b", None, &proven, false).unwrap();
        assert!(later.device && !later.pending);
        assert_eq!(
            read_device(&dir, "https://a.example#u_b").as_deref(),
            Some("dv_a")
        );
        assert!(!read_accounts(&dir, &|_| false).accounts[0].pending_proof);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_bind_beside_a_legacy_entry_leaves_its_items_alone() {
        let dir = scratch("beside");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            server_file(&dir),
            format!(
                r#"{{"server":"{A}","devices":{{"{A}":"dv_a"}},"device_keys":{{"{A}":"KEY"}}}}"#
            ),
        )
        .unwrap();
        materialize_accounts(&dir, &|_| true).unwrap();
        let fresh = bound(bind_account(&dir, &request(None, "u_b", true, &EMPTY)));
        assert!(!fresh.owner && !fresh.claimed.root && !fresh.claimed.device);
        assert_eq!(read_device(&dir, A).as_deref(), Some("dv_a"));
        assert_eq!(read_device_key_fallback(&dir, A).as_deref(), Some("KEY"));
        assert_eq!(read_accounts(&dir, &|_| false).accounts.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `signed_in` is the difference between `existing` and `adopted`.
    #[test]
    fn an_account_already_here_is_answered_rather_than_added_twice() {
        let dir = scratch("existing");
        write_server(&dir, A).unwrap();
        bound(bind_account(&dir, &request(None, "u_a", true, &EMPTY)));
        let key = "https://a.example#u_a".to_string();
        assert_eq!(
            bind_account(&dir, &request(None, "u_a", true, &EMPTY)),
            Ok(Bind::Existing {
                key: key.clone(),
                signed_in: true
            })
        );
        set_signed_in(&dir, &key, false).unwrap();
        assert_eq!(
            bind_account(&dir, &request(None, "u_a", true, &EMPTY)),
            Ok(Bind::Existing {
                key,
                signed_in: false
            })
        );
        assert_eq!(read_accounts(&dir, &|_| false).accounts.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ten_accounts_is_the_most() {
        let dir = scratch("cap");
        write_server(&dir, A).unwrap();
        for i in 0..crate::accounts::MAX_ACCOUNTS {
            bound(bind_account(
                &dir,
                &request(None, &format!("u_{i}"), true, &EMPTY),
            ));
        }
        let refused = bind_account(&dir, &request(None, "u_x", true, &EMPTY)).unwrap_err();
        assert!(refused.starts_with("account_limit"), "{refused}");
        assert_eq!(
            read_accounts(&dir, &|_| false).accounts.len(),
            crate::accounts::MAX_ACCOUNTS
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forgetting_an_account_keeps_its_device_and_its_root() {
        let dir = scratch("forget");
        write_server(&dir, A).unwrap();
        bound(bind_account(&dir, &request(None, "u_a", true, &EMPTY)));
        let key = "https://a.example#u_a";
        write_device(&dir, key, "dv_a").unwrap();
        assert_eq!(forget_account(&dir, key).unwrap(), None);
        let roster = read_accounts(&dir, &|_| false);
        assert!(roster.accounts.is_empty() && roster.current.is_none());
        assert_eq!(read_device(&dir, key).as_deref(), Some("dv_a"));
        assert_eq!(roster.roots.get(A).map(String::as_str), Some("u_a"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forgetting_an_unconfirmed_legacy_account_leaves_its_root_to_nobody() {
        let dir = scratch("tombstone");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            server_file(&dir),
            format!(r#"{{"server":"{A}","devices":{{"{A}":"dv_a"}}}}"#),
        )
        .unwrap();
        materialize_accounts(&dir, &|_| true).unwrap();
        forget_account(&dir, A).unwrap();
        assert_eq!(
            read_accounts(&dir, &|_| false)
                .roots
                .get(A)
                .map(String::as_str),
            Some("")
        );
        let occupied = Evidence {
            root_empty: false,
            ..Evidence::NONE
        };
        assert!(!bound(bind_account(&dir, &request(None, "u_b", true, &occupied))).owner);
        let proven = Evidence {
            root: Proof::Proven,
            ..occupied
        };
        assert!(
            bound(bind_account(&dir, &request(None, "u_c", true, &proven))).owner,
            "a proof still takes it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_forget_returns_to_the_account_shown_last() {
        let dir = scratch("back");
        write_server(&dir, A).unwrap();
        for user in ["u_a", "u_b", "u_c"] {
            bound(bind_account(&dir, &request(None, user, true, &EMPTY)));
        }
        show_account(&dir, "https://a.example#u_a").unwrap();
        assert_eq!(
            forget_account(&dir, "https://a.example#u_c")
                .unwrap()
                .as_deref(),
            Some("https://a.example#u_a")
        );
        let roster = read_accounts(&dir, &|_| false);
        assert_eq!(
            roster
                .recent(Some("https://a.example#u_a"))
                .map(|a| a.key())
                .as_deref(),
            Some("https://a.example#u_b")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_device_write_marks_its_account_bound_and_set_bound_clears_it() {
        let dir = scratch("bound");
        write_server(&dir, A).unwrap();
        bound(bind_account(&dir, &request(None, "u_a", true, &EMPTY)));
        let key = "https://a.example#u_a";
        let is_bound = || read_accounts(&dir, &|_| false).accounts[0].bound;
        assert!(!is_bound(), "a fresh sign-in has no device bound");
        write_device(&dir, key, "dv_a").unwrap();
        assert!(is_bound());
        set_bound(&dir, key, false).unwrap();
        assert!(!is_bound());
        write_device(&dir, key, "dv_a").unwrap();
        erase_device(&dir, key).unwrap();
        assert!(!is_bound());
        write_device(&dir, key, "dv_a").unwrap();
        set_signed_in(&dir, key, false).unwrap();
        assert!(!is_bound(), "a session that ended took its binding with it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_account_field_another_build_wrote_survives() {
        let dir = scratch("tomorrow-account");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            server_file(&dir),
            format!(r#"{{"server":"{A}","accounts":[{{"origin":"{A}","user":"u_a","tomorrow":{{"k":1}}}}]}}"#),
        )
        .unwrap();
        assert!(rename_account(&dir, "https://a.example#u_a", "ada").unwrap());
        assert!(!rename_account(&dir, "https://a.example#u_a", "ada").unwrap());
        let text = std::fs::read_to_string(server_file(&dir)).unwrap();
        assert!(text.contains("tomorrow") && text.contains("ada"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_device_is_scoped_to_its_account() {
        let dir = scratch("device-account");
        write_device(&dir, "https://a.example#u_a", "dv_a").unwrap();
        write_device(&dir, "https://a.example#u_b", "dv_b").unwrap();
        write_device(&dir, A, "dv_bare").unwrap();
        assert_eq!(
            read_device(&dir, "https://a.example#u_a").as_deref(),
            Some("dv_a")
        );
        assert_eq!(
            read_device(&dir, "https://a.example#u_b").as_deref(),
            Some("dv_b")
        );
        assert_eq!(read_device(&dir, A).as_deref(), Some("dv_bare"));
        erase_device(&dir, "https://a.example#u_a").unwrap();
        assert_eq!(read_device(&dir, A).as_deref(), Some("dv_bare"));
        assert_eq!(
            read_device(&dir, "https://a.example#u_b").as_deref(),
            Some("dv_b")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_without_devices_reads_as_none() {
        let dir = std::env::temp_dir().join(format!("reemoat-cfg-old-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            super::server_file(&dir),
            r#"{"server":"https://a.example"}"#,
        )
        .unwrap();
        assert_eq!(read_server(&dir).as_deref(), Some("https://a.example"));
        assert_eq!(read_device(&dir, "https://a.example"), None);
        write_device(&dir, "https://a.example", "dv_new").unwrap();
        assert_eq!(
            read_device(&dir, "https://a.example").as_deref(),
            Some("dv_new")
        );
        assert_eq!(read_server(&dir).as_deref(), Some("https://a.example"));

        std::fs::write(super::server_file(&dir), "not json at all").unwrap();
        assert_eq!(read_device(&dir, "https://a.example"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_device_key_is_not_world_readable() {
        let dir = scratch("modes");
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();

        assert_eq!(mode_of(&server_file(&dir)), 0o600, "the file");
        assert_eq!(mode_of(&dir), 0o700, "the directory");
        assert_eq!(
            read_device_key_fallback(&dir, "https://a.example").as_deref(),
            Some("AAAA")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// At umask `022` either half of the mode alone passes, so this re-runs itself in a child under
    /// `umask 0277` (process-wide, hence a child). The child's test count is asserted, not just its exit.
    #[cfg(unix)]
    #[test]
    fn the_mode_is_not_the_umask_s() {
        const NAME: &str = "config::tests::the_mode_is_not_the_umask_s";

        if std::env::var_os("REEMOAT_TEST_UMASK").is_some() {
            let dir = scratch("umask");
            write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();
            assert_eq!(mode_of(&server_file(&dir)), 0o600, "the file");
            assert_eq!(mode_of(&dir), 0o700, "the directory");
            // What a `0400` or `0000` would cost.
            assert_eq!(
                read_device_key_fallback(&dir, "https://a.example").as_deref(),
                Some("AAAA"),
                "and it is readable by the process that wrote it"
            );
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let exe = std::env::current_exe().expect("a test binary knows its own path");
        // Positional, since a macOS path often has a space.
        let child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("umask 0277; exec \"$0\" \"$1\" --exact --nocapture")
            .arg(&exe)
            .arg(NAME)
            .env("REEMOAT_TEST_UMASK", "1")
            .output()
            .expect("the child test process runs");
        let said = String::from_utf8_lossy(&child.stdout).into_owned();
        assert!(
            child.status.success(),
            "the same assertions under `umask 0277`: {said}{}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(
            said.contains("1 passed"),
            "the child ran {NAME} and not zero tests: {said}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_that_already_exists_is_narrowed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("widedir");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(mode_of(&dir), 0o755, "the precondition");

        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();
        assert_eq!(mode_of(&dir), 0o700);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn an_installation_written_by_an_older_build_is_narrowed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("upgrade");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            server_file(&dir),
            r#"{"server":"https://a.example","devices":{"https://a.example":"dv_old"}}"#,
        )
        .unwrap();
        std::fs::set_permissions(server_file(&dir), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert_eq!(mode_of(&server_file(&dir)), 0o644, "the precondition");

        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();

        assert_eq!(mode_of(&server_file(&dir)), 0o600);
        assert_eq!(mode_of(&dir), 0o700);
        assert_eq!(read_server(&dir).as_deref(), Some("https://a.example"));
        assert_eq!(
            read_device(&dir, "https://a.example").as_deref(),
            Some("dv_old")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_left_beside_the_file() {
        let dir = scratch("strays");
        write_server(&dir, "https://a.example").unwrap();
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();
        write_device(&dir, "https://a.example", "dv_aaa").unwrap();

        assert_eq!(strays(&dir), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A directory at the target makes the rename fail (`EISDIR`), reaching the failure-path
    /// cleanup; this depends on `read_stored`'s `IsADirectory` arm.
    #[cfg(unix)]
    #[test]
    fn a_write_that_cannot_land_takes_its_temporary_with_it() {
        let dir = scratch("refused");
        std::fs::create_dir_all(server_file(&dir)).unwrap();

        let refused = write_device_key_fallback(&dir, "https://a.example", "AAAA");
        assert!(refused.is_err(), "a rename onto a directory cannot succeed");

        assert_eq!(strays(&dir), Vec::<String>::new());
        assert!(server_file(&dir).is_dir(), "and the target is as it was");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A handle opened before the write still reads the old inode whole, which truncation would not.
    #[cfg(unix)]
    #[test]
    fn a_write_replaces_the_file_rather_than_truncating_it() {
        use std::io::Read;
        let dir = scratch("atomic");
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();

        let mut before = std::fs::File::open(server_file(&dir)).unwrap();
        write_device_key_fallback(&dir, "https://b.example", "BBBB").unwrap();

        let mut old = String::new();
        before.read_to_string(&mut old).unwrap();
        assert!(old.contains("AAAA"), "the old bytes are whole: {old}");
        assert!(!old.contains("BBBB"), "and they are the old ones: {old}");
        serde_json::from_str::<super::Stored>(&old).expect("the old file still parses whole");

        assert_eq!(
            read_device_key_fallback(&dir, "https://a.example").as_deref(),
            Some("AAAA")
        );
        assert_eq!(
            read_device_key_fallback(&dir, "https://b.example").as_deref(),
            Some("BBBB")
        );
        assert_eq!(mode_of(&server_file(&dir)), 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The corrupt file is set to `0644` first, so the quarantine's narrowing is tested on any umask.
    #[test]
    fn a_file_that_cannot_be_parsed_is_moved_aside_before_it_is_overwritten() {
        let dir = scratch("unreadable");
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();
        let whole = std::fs::read_to_string(server_file(&dir)).unwrap();
        assert!(whole.contains("AAAA"), "the precondition: {whole}");

        std::fs::write(server_file(&dir), "{not json").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(server_file(&dir), std::fs::Permissions::from_mode(0o644))
                .unwrap();
            assert_eq!(mode_of(&server_file(&dir)), 0o644, "the precondition");
        }

        write_device(&dir, "https://a.example", "dv_new").unwrap();

        assert!(
            unreadable_file(&dir).exists(),
            "the bytes that would not parse were kept"
        );
        assert_eq!(
            std::fs::read_to_string(unreadable_file(&dir)).unwrap(),
            "{not json",
            "and they are the bytes that were there, rather than some other file"
        );
        assert_eq!(
            read_device(&dir, "https://a.example").as_deref(),
            Some("dv_new"),
            "and the write that triggered it still landed"
        );
        #[cfg(unix)]
        assert_eq!(
            mode_of(&unreadable_file(&dir)),
            0o600,
            "narrowed on the way in, because rename carries the old inode's mode"
        );

        // The first quarantine wins, and a second corruption is then refused, not overwritten.
        std::fs::write(server_file(&dir), "also not json").unwrap();
        let refused = write_device(&dir, "https://a.example", "dv_later");
        assert!(
            refused.is_err(),
            "nothing was preserved, so nothing may be written over"
        );
        assert_eq!(
            std::fs::read_to_string(unreadable_file(&dir)).unwrap(),
            "{not json",
            "the first quarantine is the one that survives"
        );
        assert_eq!(
            std::fs::read_to_string(server_file(&dir)).unwrap(),
            "also not json",
            "and the current bytes are still where they were"
        );
        assert_eq!(
            strays(&dir),
            Vec::<String>::new(),
            "and nothing at all was created"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Without the `InvalidData` arm the file is unreplaceable for ever and every write is refused.
    #[test]
    fn a_file_that_is_not_utf8_is_moved_aside_rather_than_freezing_every_write() {
        let dir = scratch("notutf8");
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();

        // A lone `0xFF` begins no UTF-8 sequence.
        let corrupt: [u8; 3] = [b'{', 0xFF, b'}'];
        std::fs::write(server_file(&dir), corrupt).unwrap();
        let err = std::fs::read_to_string(server_file(&dir)).unwrap_err();
        assert_eq!(
            err.kind(),
            std::io::ErrorKind::InvalidData,
            "the precondition: this is the fourth state"
        );
        assert!(
            err.raw_os_error().is_none(),
            "and it is the one with no errno, which is why it is not a read failure"
        );

        write_device(&dir, "https://a.example", "dv_new").unwrap();

        assert_eq!(
            read_device(&dir, "https://a.example").as_deref(),
            Some("dv_new"),
            "the write landed rather than being refused for ever"
        );
        assert_eq!(
            std::fs::read(unreadable_file(&dir)).unwrap(),
            corrupt,
            "and the bytes it replaced are aside, byte for byte"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The quarantine's rename needs a writable directory. Skipped where `0500` stops nobody (root).
    #[cfg(unix)]
    #[test]
    fn a_quarantine_that_cannot_land_does_not_authorize_the_overwrite() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("noquarantine");
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();
        std::fs::write(server_file(&dir), "{not json").unwrap();

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        if std::fs::rename(server_file(&dir), dir.join("probe")).is_ok() {
            // Root, or a filesystem with no modes: nothing to assert.
            let _ = std::fs::rename(dir.join("probe"), server_file(&dir));
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let refused = write_device(&dir, "https://a.example", "dv_new");
        assert!(
            refused.is_err(),
            "the bytes could not be put aside, so they may not be written over"
        );
        assert!(!unreadable_file(&dir).exists(), "and nothing was put aside");

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            std::fs::read_to_string(server_file(&dir)).unwrap(),
            "{not json",
            "and the bytes a person can still open the key out of are there"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Drives `give_up_device_key` rather than `device::reset_key`, which would touch the real keychain.
    #[test]
    fn a_re_key_takes_the_superseded_quarantined_copy_with_it() {
        let dir = scratch("superseded");
        let quarantined = quarantine_holding_a_key(&dir, &[("https://a.example", "AAAA")]);
        assert!(
            quarantined.contains("AAAA"),
            "the precondition: a recoverable private key is sitting in the quarantine"
        );

        give_up_device_key(&dir, "https://a.example").unwrap();
        assert_eq!(read_device_key_fallback(&dir, "https://a.example"), None);
        assert!(
            !unreadable_file(&dir).exists(),
            "the superseded copy went with the key it is a copy of"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `read_secret` answers `None` for an entry `decode_key` rejects, so a promotion can find one to remove.
    #[test]
    fn a_promotion_to_the_keyring_keeps_the_quarantine() {
        let dir = scratch("promotion");
        let quarantined = quarantine_holding_a_key(&dir, &[("https://a.example", "AAAA")]);
        assert!(quarantined.contains("AAAA"), "the precondition");

        write_device_key_fallback(&dir, "https://a.example", "not-a-key").unwrap();

        erase_device_key_fallback(&dir, "https://a.example").unwrap();
        assert_eq!(
            read_device_key_fallback(&dir, "https://a.example"),
            None,
            "the unusable entry is gone, which is the whole of what this statement does"
        );
        assert!(
            unreadable_file(&dir).exists(),
            "and the bytes a person could still read a key out of are not this call's to take"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_re_key_for_one_server_keeps_a_quarantine_naming_another() {
        let dir = scratch("othertenant");
        let quarantined = quarantine_holding_a_key(
            &dir,
            &[("https://a.example", "AAAA"), ("https://b.example", "BBBB")],
        );
        assert!(
            quarantined.contains("https://b.example") && quarantined.contains("BBBB"),
            "the precondition: a second server's key is in those bytes too"
        );

        give_up_device_key(&dir, "https://a.example").unwrap();
        assert!(
            unreadable_file(&dir).exists(),
            "the file names a server this call is not about, so it is not this call's to remove"
        );
        assert!(
            std::fs::read_to_string(unreadable_file(&dir))
                .unwrap()
                .contains("BBBB"),
            "and the other server's key is still hand-recoverable out of it"
        );

        // A scan, not a count of origins: one foreign origin is still a refusal.
        give_up_device_key(&dir, "https://b.example").unwrap();
        assert!(
            unreadable_file(&dir).exists(),
            "a.example is named in there too, and b.example's re-key does not supersede it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_re_key_for_one_account_keeps_a_quarantine_naming_another_on_its_server() {
        let dir = scratch("otheraccount");
        let quarantined = quarantine_holding_a_key(
            &dir,
            &[
                ("https://a.example#u_a", "AAAA"),
                ("https://a.example#u_b", "BBBB"),
            ],
        );
        assert!(
            quarantined.contains("https://a.example#u_b"),
            "the precondition"
        );
        give_up_device_key(&dir, "https://a.example#u_a").unwrap();
        assert!(
            unreadable_file(&dir).exists(),
            "the other account's key is not this re-key's to take"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_owners_re_key_takes_a_quarantine_naming_only_it_and_its_server() {
        let dir = scratch("inheritor");
        quarantine_holding_a_key(&dir, &[(A, "AAAA"), ("https://a.example#u_a", "CCCC")]);
        std::fs::write(
            server_file(&dir),
            format!(r#"{{"accounts":[{{"origin":"{A}","user":"u_a","inherited":true}}]}}"#),
        )
        .unwrap();
        give_up_device_key(&dir, "https://a.example#u_a").unwrap();
        assert!(!unreadable_file(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_guests_re_key_keeps_a_quarantine_naming_its_server_bare() {
        let dir = scratch("guestkey");
        quarantine_holding_a_key(&dir, &[(A, "AAAA"), ("https://a.example#u_b", "BBBB")]);
        std::fs::write(
            server_file(&dir),
            format!(r#"{{"accounts":[{{"origin":"{A}","user":"u_b"}}]}}"#),
        )
        .unwrap();
        give_up_device_key(&dir, "https://a.example#u_b").unwrap();
        assert!(unreadable_file(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Truncated past the base64, so serde refuses it and a person can still read the key.
    fn quarantine_holding_a_key(dir: &Path, keys: &[(&str, &str)]) -> String {
        for (origin, key) in keys {
            write_device_key_fallback(dir, origin, key).unwrap();
        }
        let whole = std::fs::read_to_string(server_file(dir)).unwrap();
        let last = keys.last().expect("at least one key").1;
        let cut = whole.rfind(last).expect("the key is in the file") + last.len();
        std::fs::write(server_file(dir), &whole[..cut]).unwrap();

        // The next launch writes a fresh key and quarantines the old bytes.
        write_device_key_fallback(dir, keys[0].0, "ZZZZ").unwrap();
        std::fs::read_to_string(unreadable_file(dir)).expect("the bytes were put aside")
    }

    #[test]
    fn a_field_another_build_wrote_survives_a_read_modify_write() {
        let dir = scratch("tomorrow");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            server_file(&dir),
            r#"{"server":"https://a.example","devices":{},"device_keys":{},"tomorrow":{"k":1}}"#,
        )
        .unwrap();

        write_device(&dir, "https://a.example", "dv_new").unwrap();

        let text = std::fs::read_to_string(server_file(&dir)).unwrap();
        assert!(text.contains("dv_new"), "the write landed: {text}");
        assert!(
            text.contains("tomorrow"),
            "and kept the key it has never heard of: {text}"
        );
        assert!(
            !unreadable_file(&dir).exists(),
            "an unknown field is not a file that will not parse"
        );
        assert_eq!(read_server(&dir).as_deref(), Some("https://a.example"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Passes deterministically with `CONFIG_LOCK`; without it fails with high probability, not certainty.
    #[test]
    fn two_writers_do_not_lose_one_another() {
        let dir = scratch("concurrent");
        std::fs::create_dir_all(&dir).unwrap();
        let at = &dir;
        std::thread::scope(|scope| {
            for i in 0..8 {
                scope.spawn(move || {
                    write_device(at, &format!("https://s{i}.example"), &format!("dv_{i}")).unwrap();
                });
            }
        });

        for i in 0..8 {
            let want = format!("dv_{i}");
            assert_eq!(
                read_device(&dir, &format!("https://s{i}.example")).as_deref(),
                Some(want.as_str()),
                "writer {i}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_server_is_one_spelling() {
        for raw in [
            "https://a.example",
            "https://a.example/",
            "https://a.example/v1/login",
            "  https://a.example  ",
            "https://A.EXAMPLE",
            "https://a.example:443",
            "a.example",
            "https://a.example?x=1#y",
        ] {
            assert_eq!(normalize_origin(raw).unwrap(), "https://a.example", "{raw}");
        }
    }

    #[test]
    fn the_scheme_is_part_of_the_identity() {
        assert_eq!(
            normalize_origin("http://a.example").unwrap(),
            "http://a.example"
        );
        assert_ne!(
            normalize_origin("http://a.example").unwrap(),
            normalize_origin("https://a.example").unwrap()
        );
        assert_eq!(
            normalize_origin("https://a.example:8443").unwrap(),
            "https://a.example:8443"
        );
        assert_eq!(
            normalize_origin("http://a.example:80").unwrap(),
            "http://a.example"
        );
    }

    /// Skipped where mode `000` stops nobody (root, or no modes); CI runs non-root.
    #[cfg(unix)]
    #[test]
    fn a_file_this_process_cannot_read_is_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("unread");
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();
        let whole = std::fs::read_to_string(server_file(&dir)).unwrap();
        assert!(whole.contains("AAAA"), "the precondition: {whole}");

        std::fs::set_permissions(server_file(&dir), std::fs::Permissions::from_mode(0o000))
            .unwrap();
        if std::fs::read_to_string(server_file(&dir)).is_ok() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let refused = write_device(&dir, "https://a.example", "dv_new");
        assert!(
            refused.is_err(),
            "a file that cannot be read is not written over"
        );
        assert!(
            !unreadable_file(&dir).exists(),
            "and it is not moved aside either: a read failure is evidence of nothing"
        );
        assert_eq!(
            strays(&dir),
            Vec::<String>::new(),
            "and nothing at all was created"
        );

        std::fs::set_permissions(server_file(&dir), std::fs::Permissions::from_mode(0o600))
            .unwrap();
        let back = std::fs::read_to_string(server_file(&dir)).unwrap();
        assert!(back.contains("AAAA"), "the key is still on disk: {back}");
        assert_eq!(
            read_device_key_fallback(&dir, "https://a.example").as_deref(),
            Some("AAAA"),
            "and the file still parses whole"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Reachability, never durability, which only a power cut can observe. The pair catches a stubbed `Ok(())`.
    #[cfg(unix)]
    #[test]
    fn the_directory_flush_reaches_the_platform() {
        let dir = scratch("flush");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(super::sync_dir(&dir).is_ok(), "a real directory is flushed");
        assert_eq!(
            super::sync_dir(&dir.join("gone")).unwrap_err().kind(),
            std::io::ErrorKind::NotFound,
            "and it is the path it was handed rather than a stub answering Ok"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_temporary_name_is_never_reused() {
        let mut seen = std::collections::BTreeSet::new();
        let prefix = format!("daemon.env.tmp.{}.", std::process::id());
        for i in 0..64 {
            let name = temp_name("daemon.env");
            assert!(name.starts_with(&prefix), "the pid is still in it: {name}");
            assert!(
                seen.insert(name.clone()),
                "name {i} was handed out twice: {name}"
            );
        }
    }

    #[test]
    fn a_theme_is_read_back_and_light_takes_it_out() {
        let dir = scratch("theme");
        assert_eq!(read_theme(&dir), Theme::Light);
        assert!(write_theme(&dir, Theme::Dark).unwrap());
        assert_eq!(read_theme(&dir), Theme::Dark);
        assert!(write_theme(&dir, Theme::Light).unwrap());
        assert_eq!(read_theme(&dir), Theme::Light);
        let text = std::fs::read_to_string(server_file(&dir)).unwrap();
        assert!(!text.contains("theme"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Without the early return every boot is a rename, which the inode shows.
    #[test]
    fn a_theme_is_written_only_when_it_changes() {
        let dir = scratch("theme-once");
        assert!(!write_theme(&dir, Theme::Light).unwrap());
        assert!(
            !server_file(&dir).exists(),
            "a boot in the default writes nothing"
        );
        assert!(write_theme(&dir, Theme::Dark).unwrap());
        #[cfg(unix)]
        let inode = || {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(server_file(&dir)).unwrap().ino()
        };
        #[cfg(unix)]
        let before = inode();
        assert!(!write_theme(&dir, Theme::Dark).unwrap());
        #[cfg(unix)]
        assert_eq!(inode(), before, "the same theme again is not a write");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_theme_this_build_cannot_read_is_light() {
        let dir = scratch("theme-junk");
        std::fs::create_dir_all(&dir).unwrap();
        for theme in [
            "",
            r#","theme":"blue""#,
            r#","theme":5"#,
            r#","theme":{"mode":"dark"}"#,
            r#","theme":null"#,
            r#","theme":"light""#,
        ] {
            std::fs::write(server_file(&dir), format!(r#"{{"server":"{A}"{theme}}}"#)).unwrap();
            assert_eq!(read_theme(&dir), Theme::Light, "{theme}");
            assert_eq!(read_server(&dir).as_deref(), Some(A), "{theme}");
            assert!(
                !unreadable_file(&dir).exists(),
                "{theme} is not a file that will not parse"
            );
        }
        assert!(
            !write_theme(&dir, Theme::Light).unwrap(),
            "what cannot be read is light already, so nothing is written"
        );
        assert!(write_theme(&dir, Theme::Dark).unwrap());
        assert_eq!(read_theme(&dir), Theme::Dark);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_theme_write_keeps_everything_else() {
        let dir = scratch("theme-keeps");
        write_server(&dir, A).unwrap();
        bound(bind_account(&dir, &request(None, "u_a", true, &EMPTY)));
        let key = "https://a.example#u_a";
        write_device(&dir, key, "dv_a").unwrap();
        write_device_key_fallback(&dir, key, "AAAA").unwrap();
        let text = std::fs::read_to_string(server_file(&dir)).unwrap();
        let text = text.replacen('{', r#"{"tomorrow":{"k":1},"#, 1);
        std::fs::write(server_file(&dir), text).unwrap();

        assert!(write_theme(&dir, Theme::Dark).unwrap());
        let roster = read_accounts(&dir, &|_| false);
        assert_eq!(
            roster.accounts.iter().map(|a| a.key()).collect::<Vec<_>>(),
            vec![key]
        );
        assert_eq!(roster.current.as_deref(), Some(key));
        assert_eq!(read_device(&dir, key).as_deref(), Some("dv_a"));
        assert_eq!(read_device_key_fallback(&dir, key).as_deref(), Some("AAAA"));
        assert_eq!(read_server(&dir).as_deref(), Some(A));
        assert!(std::fs::read_to_string(server_file(&dir))
            .unwrap()
            .contains("tomorrow"));

        let old = scratch("theme-era");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(
            server_file(&old),
            format!(r#"{{"server":"{A}","devices":{{"{A}":"dv_a"}}}}"#),
        )
        .unwrap();
        assert!(write_theme(&old, Theme::Dark).unwrap());
        assert!(
            read_accounts(&old, &|_| false).derived,
            "a theme does not write the accounts era down"
        );
        assert!(!std::fs::read_to_string(server_file(&old))
            .unwrap()
            .contains("accounts"));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&old);
    }

    #[test]
    fn what_is_refused() {
        for raw in [
            "",
            "   ",
            "ftp://a.example",
            "file:///etc/passwd",
            "https://u:p@a.example",
        ] {
            assert!(normalize_origin(raw).is_err(), "{raw} should be refused");
        }
    }
}
