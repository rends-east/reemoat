//! Which accounts this installation holds, on which control planes, and what each
//! server calls this installation.
//!
//! **Not a secret, and deliberately not in the keyring.** A server address and an
//! account list are preferences; the credential for each account is the secret,
//! and it lives in `credential.rs` keyed on the account (`<origin>#<user id>`)
//! this file lists. Keeping them apart is what makes a machine whose keyring is
//! unusable still remember *which* accounts it had — it just asks for the
//! password again.
//!
//! ⚠ **The list lives here because the keyring cannot be listed**, and that is a
//! refusal `credential.rs` makes on purpose. So `accounts` is the only record of
//! which `credential#…` entries exist, and losing this file orphans every one of
//! them until they expire — a limit recorded in Q7.149 rather than a reason to
//! grow a `list()`. A file written before accounts existed has no list; one is
//! **derived** from what it does have (`read_accounts`) and written down by the
//! first act that needs it, never at startup.
//!
//! **The device id is here for exactly that reason, and not beside the
//! credential**, one per account. It is an identifier the control plane handed
//! back, not a secret:
//! holding one authorizes nothing, because every request still carries the
//! session token and the id is only read *after* that token has resolved. Put it
//! in the keyring instead and the cost lands precisely on the machines
//! `credential::probe` exists to detect — a Linux box with no unlocked collection
//! silently discards every write, so that installation would register a brand new
//! device on every launch and burn through the account's device limit without ever
//! reading one back. It would also put a second keychain read on the first-paint
//! path, which on an ad-hoc-signed development build is a second prompt per build.
//!
//! ⚠ This reverses the narrowest half of the "no device id" position
//! `credential.rs` still states — *"a value generated at first run and persisted
//! **is** device identity, arriving by accident"*. What changed is that it is no
//! longer an accident: the control plane has a `devices` table, the id comes from
//! there rather than from a local generator, and a person can see and retire the
//! row. The three refusals that entry makes *at the interface* — no `list()`, no
//! private key through a `String`, no first-run generation — all still stand, and
//! the keyring seam stays reserved for the device **key** that has none of these
//! properties.
//!
//! ⚠ **The file itself is `0600` in a `0700` directory, and that is about the one
//! field above that *is* a secret.** `device_keys` holds an X25519 private key on
//! any machine whose keyring will not keep one, so the whole file is written at
//! the protection `~/.ssh/id_ed25519` has — the server origin and the device ids
//! ride along, which costs nothing, rather than being split into a second file
//! that could disagree with this one about which server this is. `write_stored`
//! is the single place that enforces it and the docblock there is the argument.
//!
//! ⚠ **There is a second file, and it appears only when something has gone
//! wrong.** `server.json.unreadable` is a `server.json` that would not parse,
//! moved aside by `quarantine` *before* the next write renames a fresh one over
//! it — because those bytes may be the only copy of a device key and answering
//! `Default` for them used to make this module the thing that destroyed them. It
//! is narrowed to `0600` on the way in, it is never read back by anything here,
//! and the **first** one wins: a later corruption is refused rather than allowed
//! to replace it.
//!
//! ⚠ **A stored file can be in five states that are not the ordinary one, and the
//! last of them is answered differently from the other four.** `read_stored` is
//! where they are implemented, one match arm each, and its docblock names the same
//! five members in the same order as this list:
//!
//!   1. **absent** (`NotFound`);
//!   2. a **directory** sitting where the file goes (`IsADirectory`);
//!   3. bytes that **will not decode as UTF-8** (`InvalidData`, which carries no
//!      errno and is therefore evidence about the bytes rather than a syscall
//!      saying no);
//!   4. a file this process **could not read at all** — `PermissionDenied`,
//!      `NotADirectory`, an I/O error, each *with* an errno;
//!   5. bytes that decoded and **will not deserialize**, which is serde's answer
//!      rather than the file system's.
//!
//! They do not map one-to-one onto answers, and writing the count down is what
//! made this paragraph wrong twice: 1 and 2 are replaced, 3 and 5 are quarantined,
//! and only 4 is refused. What holds the two lists to the six arms that implement
//! them is `scripts/nativecheck.ts`, which differences the arms out of this source
//! against a written-out list — so a member added here and nowhere else is prose,
//! and a member added to the code is a red line.
//!
//! ⚠ **This paragraph has been wrong about that list twice, in two different
//! ways.** It said "a third state" and enumerated three, which was true until the
//! `InvalidData` arm was split out of the catch-all and sent to `quarantine`; the
//! repair for that reconciled the *number* with `read_stored` and not the members,
//! enumerating a **directory** the function's docblock did not have and folding
//! "will not decode" into "will not parse", which the function keeps apart. A file
//! header that counts the states differently from the function implementing them
//! is how the next reader concludes there is no arm for the one they are looking
//! at — and a header that agrees on the count while naming different members is
//! the same defect with the evidence for it removed.
//!
//! Only the fourth has bytes nothing is known about, and it alone is neither moved
//! aside nor replaced. `read_stored` marks it unreplaceable, `write_stored`
//! refuses in its first statement with a sentence naming the path, and the app
//! still starts on the setup screen. That is a behaviour change with a real cost:
//! on a host where the state is permanent, every configuration write fails until a
//! person moves the file. What it replaces is this module renaming a fresh empty
//! file over a device key it never read.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use url::Url;

/// One number, so two writes in one process never share a temporary file.
///
/// ⚠ **This was documented as a redundant second line, and it is not one.** That
/// was true of `write_stored`, where `CONFIG_LOCK` and `Guarded` make a second
/// writer unreachable by construction — and false of the *other* writer that
/// reads this counter through `temp_name`. `commands.rs`'s `write_private` holds
/// no lock at all, its caller carries `(async)`, and for that pair this is not a
/// second line of defence but the only one. `temp_name` below carries what a
/// shared name costs there, which is a truncated `daemon.env` rather than an
/// untidy directory.
///
/// The pid half of the name is what covers a *second process* over the same
/// configuration directory, which no lock in this one can see. Neither half is
/// sufficient alone, and `temp_name` is the single place both are applied.
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// One writer of `server.json` at a time, for the whole process.
///
/// ⚠ **The race this closes is a *lost update*, not a torn file.** Every writer
/// here is read-modify-write — `read_stored`, one field changed, `write_stored` —
/// and the read and the write are separated by a serialize, a `create_dir_all`, an
/// open, a write, an `fsync` and a rename. Two of those interleaved means the
/// second writes a `Stored` built from bytes the first has already replaced, and
/// on a keyring-less host one of the two things lost that way is the only copy of
/// an X25519 private key. The comment inside `write_stored` used to wave that
/// residual off as acceptable while guarding the torn file that could not happen;
/// it was the wrong way round.
///
/// **A poisoned lock is taken anyway.** The guarded value is `()` — there is no
/// invariant a panicking writer could have left half-built, the file being written
/// by rename — so refusing every later write because one earlier call panicked
/// would turn a single failure into a permanent one, on a file this app needs to
/// remember which server it is on.
///
/// ⚠ **It says nothing about two processes.** Two copies of this app over one
/// configuration directory are still a lost update, and no in-process lock can
/// reach that; what covers *that* pair is the pid in the temporary name, which
/// keeps it from also being a torn file.
///
/// **What it can cost is bounded, which is what makes it safe to take from the
/// main thread.** Nothing holds this across a network call, a platform panel, a
/// keyring round trip or a child process — the whole critical section is a parse,
/// a field change, a serialize and a durable rename. ⚠ **No command reaches it
/// from the main thread any more.** `host_boot` did, and was the reason this
/// paragraph existed; it carries `(async)` since one webview per account boots at
/// launch (`commands.rs` has the census). What is left on the main thread is
/// `lib.rs`'s setup — `read_server`, `read_accounts` and `read_theme`, three
/// reads before any command can exist — and the evidence `read_accounts` is
/// handed is called with this lock held, so it may not reach for it: it is a
/// keyring read at setup and a map lookup in `Host` afterwards, and neither
/// touches this file.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// The whole file, read under `CONFIG_LOCK`, with the lock still held — and
/// whether it may be written back over, which `read_stored` decides and
/// `write_stored` obeys as its first statement.
///
/// ⚠ **The guard rides inside the value, and that is what makes the lock
/// impossible to forget.** `write_stored` takes a `&Guarded`; a `Guarded` comes
/// from nothing but `read_stored`; and `read_stored` is what acquires the lock. So
/// a read-modify-write is one critical section *by construction* rather than by
/// every future caller remembering a `lock()` statement — which is the same reason
/// `mintSession` takes `deviceId` as a required argument rather than an optional
/// one.
///
/// **A third argument would have been the obvious shape and is refused for a
/// reason outside this file.** `scripts/nativecheck.ts` reads the literal
/// `write_stored(dir, &stored)` out of `write_device_key_fallback` to prove a
/// device key goes through the one writer that narrows the mode; a guard passed as
/// an argument changes that call and turns an assertion in the `check` job red for
/// a change it is not about.
///
/// `Deref`/`DerefMut` so every call site reads exactly as it did before the lock
/// existed. The guard is dropped with the value, which is the end of the writer.
struct Guarded {
    file: Stored,
    /// Whether anything may be renamed over `server.json`.
    ///
    /// ⚠ **`false` means bytes are on disk that this process neither read nor put
    /// safely aside**, and it is the difference between the states `read_stored`
    /// used to collapse into one `Err` arm. `Stored::default()` is answered either
    /// way — an app that cannot start because of a file nobody can see is this
    /// file's worst failure, not its best — but `Default` for a file that *exists*
    /// is a guess, and every writer here is read-modify-write, so the next write
    /// would rename a fresh empty file over bytes that on a keyring-less host are
    /// the only copy of that installation's X25519 private key.
    ///
    /// Measured on this machine (macOS 15.6 / arm64 / APFS, rustc 1.95.0, uid
    /// 501): a `server.json` at mode `000` answers `PermissionDenied` (errno 13),
    /// a `~/.reemoat` replaced by a regular file answers `NotADirectory` (errno
    /// 20), and an absent file answers `NotFound` (errno 2). Three distinguishable
    /// states, of which the old code could see one.
    ///
    /// ⚠ **The second half is the *quarantine's* answer, and without it this bool
    /// authorized the destruction the quarantine exists to prevent.** Bytes that
    /// will not parse are moved aside and then written over — but where they could
    /// not be moved aside, because the slot is already taken by an earlier
    /// corruption or because the `rename` did not land, writing over them destroys
    /// the *current* key while the retained quarantine holds an obsolete one. So
    /// `quarantine` reports what it preserved and that report is this field.
    ///
    /// **It rides inside `Guarded` rather than arriving as a third argument**, for
    /// the same reason the guard does: `scripts/nativecheck.ts` reads the literal
    /// `write_stored(dir, &stored)` out of `write_device_key_fallback` to prove a
    /// device key goes through the one writer that narrows the mode, and a new
    /// argument would turn that assertion red for a change it is not about.
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
    /// ⚠ **`default` spelled out rather than left to serde's `Option` rule.** A
    /// struct carrying a `#[serde(flatten)]` field is deserialized through
    /// serde's buffering path rather than the ordinary one, which is the single
    /// place that rule is generated differently — and a `server` that stopped
    /// defaulting would make every file written before some later field existed
    /// refuse to parse, which this file answers by moving it aside.
    #[serde(default)]
    server: Option<String>,
    /// The device this app is registered as, per **account** — keyed on the
    /// scope, `<origin>#<user id>`, or the bare origin for an entry from before
    /// accounts that nothing has proved yet.
    ///
    /// ⚠ **Per account, because two accounts on one server are two people.** A
    /// device row names a user on the control plane (`cp-devices.md`'s owner
    /// clause), so one id offered for a second user registers a fresh row and the
    /// two accounts drift toward the twenty-device cap on every re-registration.
    ///
    /// **A map rather than one current value.** `host_set_server` used to erase
    /// the previous origin's *credential* and keeps it since Q7.148; it never
    /// touched a device id, and must not start, because on an id the erase would
    /// be destructive rather than tidy: the row on that server is not deleted by
    /// anything here, so forgetting the id leaves an installation the person can
    /// no longer recognise in their own list and spends a second slot the next
    /// time they point back. Retaining it leaks nothing, because it is not a
    /// secret — and forgetting an *account* keeps it too, so signing in as the
    /// same person again reuses the row.
    ///
    /// `BTreeMap` rather than `HashMap` so the file is stable on disk — a
    /// preferences file that reorders itself on every write is one nobody can
    /// diff. Absent in every file written before this field existed, which
    /// `Default` answers with an empty map: no migration, and an app that has
    /// never registered is indistinguishable from one upgrading, correctly.
    #[serde(default)]
    devices: BTreeMap<String, String>,
    /// The device's X25519 private key, per account — **only on a machine whose
    /// keyring will not keep one**. See `read_device_key_fallback` for why a
    /// private key is in a file at all, and `write_stored` for what stops that
    /// file being world-readable, which for four releases nothing did.
    #[serde(default)]
    device_keys: BTreeMap<String, String>,
    /// Every account on this computer, in the order they were added — the
    /// drawer's order. `None` is a file written before accounts existed, and is
    /// the one state `read_accounts` derives a list for rather than reading one.
    ///
    /// ⚠ **`skip_serializing_if`, so a file stays pre-accounts until an act
    /// changes that.** Serializing `None` as `null` would be indistinguishable
    /// from an empty list to an older build's `rest`, and would make "derived" a
    /// state no write could leave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accounts: Option<Vec<StoredAccount>>,
    /// The key of the account shown last, which is the one the next launch shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current: Option<String>,
    /// Which user owns each server's own daemon root: origin → user id, or `""`
    /// for "nobody may take it without proof".
    ///
    /// ⚠ **Kept when an account is forgotten**, so a person who signs out and in
    /// again gets their root — and the machine and database in it — back rather
    /// than a guest root and a second machine: `owner := roots[origin] == user` is
    /// recomputed on every bind. Q7.149.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    roots: BTreeMap<String, String>,
    /// Which origin holds `~/.reemoat`, once one has been handed it for being
    /// empty — `daemon::owner_root` reads it so that the rule is decided once. Two
    /// servers set up together over an empty computer would otherwise both be
    /// answered the legacy root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_root_holder: Option<String>,
    /// `"dark"` once the menu drawer's switch has chosen it; absent means light, which is
    /// the default. A `Value` rather than a `String`, so a shape this build cannot read is
    /// ignored instead of quarantining the whole file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    theme: Option<serde_json::Value>,
    /// Every key in this file that this build has never heard of.
    ///
    /// ⚠ **Without it, a read-modify-write by an older build is a downgrade that
    /// deletes data.** `read_stored` parses the whole file and `write_stored`
    /// writes the whole file, so a field a *later* build added — `device_keys` was
    /// exactly that, one release ago — is dropped the first time an older build
    /// changes the server address or records a device. There is no updater here
    /// (`native-shell.md` states that as a deliberate absence), so running an older
    /// bundle is somebody double-clicking the other icon rather than an event
    /// anything prevents, and the field it would silently drop is a private key.
    ///
    /// A `BTreeMap` for the reason `devices` is one: the file stays diffable
    /// instead of reordering itself on every write.
    #[serde(flatten)]
    rest: BTreeMap<String, serde_json::Value>,
}

/// One account as `server.json` holds it.
///
/// ⚠ **`rest` for `Stored.rest`'s reason**: an account written by a later build
/// with a field this one has never heard of keeps it through this build's
/// read-modify-write rather than losing it.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct StoredAccount {
    origin: String,
    /// `None` for an entry from before accounts that nothing has attributed yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    /// The name the control plane last answered, cached for the drawer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// Whether this account's device id is bound to its current sign-in —
    /// `Boot.deviceBound`, and what tells the page it need not register again.
    #[serde(default)]
    bound: bool,
    /// Whether a credential for it is in the keyring, as last known.
    ///
    /// ⚠ **Persisted so that listing accounts reads no keyring.** The drawer asks
    /// for every account; a keychain read per row, on an ad-hoc-signed build, is a
    /// prompt per row.
    #[serde(default)]
    signed_in: bool,
    /// A counter, larger for the more recently shown — "back" and the forget
    /// fallback are the largest other than the caller's.
    #[serde(default)]
    seen: u64,
    /// A proof about this origin's bare items could not be reached when it was
    /// bound, so `Boot.legacy` asks again at the next bootstrap.
    #[serde(default, skip_serializing_if = "is_false")]
    pending_proof: bool,
    /// Whether this account's device came from the bare, pre-accounts entry by
    /// proof — which is what makes a quarantine naming the bare origin this
    /// account's to discard (`quarantine_is_only_about`).
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

/// The server a build was pointed at, or `None`.
///
/// ⚠ **Absent in this repository, deliberately, and that is the same rule
/// `signingIdentity` and `providerShortName` follow one file over.** This is AGPL
/// software and forks run their own control planes, so a value compiled in here
/// would be one deployment's address in everybody's binary — the argument
/// `cp-accounts.md` already makes for `REEMOAT_CP_PLUGIN_CATALOGUE_URL` and
/// `REEMOAT_CP_APP_DOWNLOAD_URL`, which have no compiled-in default for exactly
/// this reason. `nativecheck` asserts no file here sets it.
///
/// **Environment at compile time rather than at run time**, which is the one
/// departure from those two: a bundle has no environment to read — it is launched
/// by Finder, by Explorer or by a desktop entry — so the only moment a fork can
/// say which fleet its build joins is while it is being built.
///
/// `build.rs` carries `cargo:rerun-if-env-changed` for this name. Without it
/// `option_env!` is baked into a cached object file and a fork that changes the
/// value gets a binary that silently keeps the previous address.
///
/// ⚠ **This repository's own releases set it, from a repository variable** —
/// `release.yml` forwards `${{ vars.… }}`, which is not a value in any file here,
/// and `nativecheck` allows that one line and no other (Q4.127). Where the
/// variable is unset the expansion is the **empty string**, so this answers
/// `Some("")` rather than `None`, and `default_server` below turns that into no
/// default, which is right.
const DEFAULT_SERVER: Option<&str> = option_env!("REEMOAT_DEFAULT_SERVER");

/// The server a build suggests, normalized — or `None`.
///
/// ⚠ **A suggestion for the field, never a value this writes down.** The first
/// draft seeded it: first run with a default wrote it to `server.json` and
/// answered it, so the app opened straight on the sign-in screen. That is wrong
/// twice. It skips the setup screen somebody should see once — the app decided
/// which fleet they joined and told them afterwards — and it makes a keyring
/// account (`credential#<origin>`) for an origin nobody confirmed.
///
/// As a suggestion both go away. Nothing is stored until somebody presses
/// **Continue**, which is the act that adopts it; a later build changing the
/// default changes only what the field opens on, which is harmless because the
/// file already won. `read_server` stays the single reader of *which server*.
///
/// A malformed default is no default: the field opens empty and the setup screen
/// asks, which is this file's posture everywhere — an app that cannot start
/// because of a value one form re-enters is the worse failure. **An empty one is
/// no default either**, and that is the ordinary case rather than a typo: it is
/// what an unset repository variable arrives as.
pub fn default_server() -> Option<String> {
    normalize_origin(DEFAULT_SERVER?).ok()
}

/// The stored origin, or `None` — the server the account shown last is on, or,
/// with no account at all, the one a first run chose. `lib.rs` reads it for the
/// second: a pending seat's server when there is nothing else to open.
///
/// Every failure answers `None` — an unreadable or corrupt file is "no server
/// chosen", which lands on the setup screen. The alternative is an app that
/// cannot be started at all because of a file nobody can see, for a value one
/// form re-enters.
///
/// ⚠ **It parses through `read_stored` rather than opening the file itself, and
/// that stopped being a tidiness.** A second parser is a second place that decides
/// what an unparseable file means, and this is the reader the *first* launch
/// reaches — so bytes nothing can read are moved aside here, at the first moment
/// anything knows they were there, rather than at whichever later write would have
/// renamed a fresh file over them.
pub fn read_server(dir: &Path) -> Option<String> {
    let server = read_stored(dir).server.clone()?;
    // Re-normalized on the way out rather than trusted: the file is on disk and a
    // person can edit it, and every other rule here keys on the canonical form.
    normalize_origin(&server).ok()
}

/// The server a first run chose, written before any account exists.
///
/// ⚠ **It pins the accounts era.** A file with no `accounts` is read as one from
/// before accounts and has a list derived for it, so a first-run choice written
/// without one would come back on the next launch as a derived legacy entry for a
/// server nobody has signed in to. Materializing the (empty) list here is what
/// makes a relaunch find a pending seat instead.
pub fn write_server(dir: &Path, origin: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    stored.server = Some(origin.to_string());
    accounts_mut(&mut stored, dir);
    write_stored(dir, &stored)
}

/// Where bytes that will not parse are put, rather than overwritten.
const UNREADABLE: &str = "server.json.unreadable";

fn unreadable_file(dir: &Path) -> PathBuf {
    dir.join(UNREADABLE)
}

/// Move a `server.json` nothing can parse aside, before anything overwrites it —
/// and **say whether those bytes actually landed there**.
///
/// ⚠ **Those bytes may still hold a private key.** `read_stored` answered
/// `Default` for an unparseable file and the next write renamed a fresh one over
/// it, so a truncated, a half-copied or a hand-edited file took `device_keys` with
/// it — on exactly the machines where that map is the only copy of the device's
/// X25519 static, a keyring-less host, which is the population the fallback exists
/// for. Nothing here can repair those bytes; what it can do is stop being the
/// thing that destroys them, and leave a file a person can open.
///
/// **The first one wins.** A second corruption is refused rather than allowed to
/// replace the quarantine, because the copy most likely to hold a key is the one
/// taken from the file that was whole longest — a later one is a copy of whatever
/// the first failure already reduced it to.
///
/// ⚠ **And that refusal used to authorize the destruction it was written to
/// prevent.** This answered nothing at all, so both of the paths that preserve
/// nothing — the slot already taken, and a `rename` that did not land — left the
/// caller marking the file *replaceable*, and the next write renamed a fresh one
/// over it. After one recovery the arithmetic is exactly backwards: the retained
/// quarantine holds whatever the **first** failure reduced the file to, while the
/// bytes being overwritten are the current ones, which on a keyring-less host are
/// the only copy of this installation's current X25519 private key. So `true` is
/// answered only where the current bytes are now under `UNREADABLE`, and
/// `read_stored` hands that straight to `replaceable`: **nothing preserved,
/// nothing replaced**.
///
/// That the `rename` can fail at all is not hypothetical — it needs write
/// permission on the *directory* rather than on the file — which is why its
/// `Result` is read here instead of discarded.
///
/// Narrowed to `0600` on the way in: `rename` carries the inode and therefore
/// whatever mode it had, and an installation written by a build from before
/// `write_stored` set one carried `0644`.
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
        // Ignored for the reason every other mode call in this file is: a
        // filesystem with no POSIX modes is not a reason to report bytes as
        // unpreserved when they are sitting exactly where this put them.
        let _ = fs::set_permissions(&aside, fs::Permissions::from_mode(0o600));
    }
    true
}

/// Forget a quarantined `server.json`, once what it was kept for is superseded —
/// and only where it can be about nothing else.
///
/// ⚠ **The quarantine exists for one field, and that field goes out of date.**
/// `UNREADABLE` is kept because those bytes may be the only copy of this
/// installation's X25519 device private key — nothing here ever reads it back, so
/// the whole of its value is that a person can open it and put the key back by
/// hand. The moment this installation has *deliberately given that key up* — the
/// Devices screen's **Re-key**, which reaches `give_up_device_key` through
/// `device::reset_key` — those bytes stop being a recovery and become a superseded
/// secret in cleartext, on precisely the shared keyring-less host the mode bits
/// are about. Nothing removed it: before this, every path that gave a key up
/// rewrote `server.json` alone and `UNREADABLE` was named nowhere outside this
/// module and its own tests.
///
/// ⚠ **It was the whole file for one release, and that departure is withdrawn.**
/// The argument for sweeping it ran: a quarantined file cannot be *edited*,
/// because it is by definition one serde could not deserialize, so there is no
/// `device_keys` map in it to take one entry out of; and a second server can only
/// lose a copy "already unreadable to this app and already superseded — after a
/// corruption `read_device_key_fallback` answers `None` for every origin, so each
/// one is regenerated the first time it is used". **The last clause is where it
/// fails.** *The first time it is used* may be long after this call: a server this
/// installation has not opened since the corruption has regenerated nothing, so
/// the quarantine is still the only hand-recoverable copy of its key. A person
/// pressing **Re-key** for server A is not consenting to lose server B's, and
/// `device::reset_key` says *per origin, never a sweep*. This belongs inside that
/// rule rather than beside it as an exception.
///
/// **So the bytes are read before they are removed, and a server named in them
/// that is not this one is a refusal.** The first half of the old argument stands
/// — they cannot be edited — but what can always be done to bytes nobody can parse
/// is to *look* at them. `quarantine_is_only_about` walks every `scheme://host`
/// token in the raw file and answers whether they are all this origin. The
/// measured corruption shape is what makes that sound rather than clever: a
/// truncation *past* the base64, which leaves the key legible to a person and the
/// JSON unparseable to serde — and serde writes a map entry's origin immediately
/// before the key it maps to, so bytes that survived for a key have survived for
/// the origin naming it.
///
/// ⚠ **It fails closed in every direction.** A file that cannot be read, a token
/// that is not UTF-8, a token naming another server, and a file naming no server
/// at all are each answered by *keeping* the quarantine. The two sides are not the
/// same size: keeping costs a superseded key at `0600` beside the live one at
/// `0600` in a directory at `0700`, and removing costs bytes somebody needed.
///
/// **Only ever after a write that landed**, which is what keeps this on the right
/// side of `quarantine`'s own rule: a refusal must never be the thing that
/// removes the copy it refused on behalf of.
///
/// ⚠ **Per account now rather than per server, and the owner allowance is the
/// one departure.** A key is kept per `<origin>#<user id>`, so a Re-key for one
/// account supersedes that account's copies and nobody else's — including a
/// second account on the *same* server. What makes that hard is the bare origin:
/// a quarantined file from before accounts names a device key under
/// `https://a.example`, and whether those bytes are this account's depends on who
/// inherited the bare device. `quarantine_is_only_about` answers it from the live
/// file's `inherited` flag, and anything it cannot settle is a refusal — so a
/// guest, or any account on a server another account also holds, keeps the
/// quarantine. That regresses the discard for them only, and in the direction
/// that costs a superseded key at `0600` rather than somebody's last copy.
fn discard_quarantine(dir: &Path, scope: &str) {
    if !quarantine_is_only_about(dir, scope) {
        return;
    }
    // Ignored rather than propagated: there is nothing a caller could do with it
    // and nothing it could mean, and a removal that fails leaves exactly what was
    // there before — the state this is improving on rather than one it can make
    // worse.
    //
    // ⚠ **This carried a sentence saying the file is absent on almost every call
    // and `remove_file` answers `NotFound` for it.** The guard above made that
    // dead in the same change that wrote it: `quarantine_is_only_about` answers
    // `false` when its own `fs::read` fails, and an absent file is one of the ways
    // it fails, so an ordinary call returns before reaching this line. What is
    // left to fail here is narrower — the file going away between that read and
    // this removal, or a directory this process may read and not write.
    let _ = fs::remove_file(unreadable_file(dir));
}

/// Whether every server a quarantined `server.json` names is this one.
///
/// ⚠ **`false` is the answer to every question this cannot settle**, and "there
/// is no such file" is one of them — the caller's next statement is a removal, and
/// there is nothing to remove either way. The scan is over raw bytes rather than a
/// string because the quarantine's own fourth state is *not valid UTF-8*, which is
/// exactly the file a `read_to_string` here would refuse to look at and then, on
/// the wrong default, authorize the destruction of.
///
/// The token is delimited the way a URL is and nothing more: scheme characters
/// leftwards from `://`, then host and port rightwards — **and then an account's
/// `#` and user id**, so `https://a.example#u_b` is one token rather than a bare
/// origin followed by noise — stopping at the quote serde put there. A truncated
/// token simply is not equal to `scope` and keeps the file, which is the
/// direction that costs nobody anything.
///
/// A token counts as this scope's when it **is** the scope, or when it is the
/// scope's bare origin and either the scope is itself that bare origin (a legacy
/// entry's Re-key) or the live file records this account as having `inherited`
/// the bare device by proof. Everything else — another account on the same
/// server, the bare origin for an account that inherited nothing — is a refusal.
fn quarantine_is_only_about(dir: &Path, scope: &str) -> bool {
    let Ok(bytes) = fs::read(unreadable_file(dir)) else {
        return false;
    };
    let (origin, bare) = match scope.split_once('#') {
        Some((origin, _)) => (origin, false),
        None => (scope, true),
    };
    // Asked lazily, and only for an account's own scope: `read_stored` takes
    // `CONFIG_LOCK`, which every caller of this function has already released.
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
            // Another server, another account, a truncated spelling of this one,
            // or bytes that are not text at all: none of those is this call's to
            // give up.
            _ => return false,
        }
        i = end;
    }
    // A file naming nothing is not thereby about this origin. It is a file this
    // scan learned nothing from, and the conservative direction is to keep it.
    named > 0
}

fn is_scheme_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')
}

/// Host and port, including the brackets an IPv6 literal is written in.
fn is_authority_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':' | b'[' | b']')
}

/// A user id after an account's `#` — `accounts::is_user_id`'s alphabet.
fn is_user_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')
}

/// The whole file, or its defaults — with `CONFIG_LOCK` held.
///
/// Every failure answers `Default`, which is `read_server`'s posture applied one
/// level up and for its reason: an unreadable or hand-edited file must land on
/// the picker and an empty device map, never stop the app starting. It is read
/// whole and written whole because the two fields are written by different acts —
/// choosing a server and registering a device — and a partial write would be the
/// one that silently discards the other.
///
/// ⚠ **Five states that are not the ordinary one, and this function once could
/// see one of them.** "Absent", "will not parse" and "will not read" were a
/// single `Err`/`.ok()` answer, which made this the first half of a data loss:
/// every writer here is read-modify-write, so the very next write renamed a fresh
/// `Stored::default()` over whatever was there. The fix arrived in three halves,
/// and the census it was built from had only the three errnos below in it.
///
/// The five are the match arms below in source order, with `Ok(parsed)` — the
/// ordinary state — left out, and they answer **three** things between them
/// rather than one each. The file header states the same five members; neither
/// list is what keeps them honest. `scripts/nativecheck.ts` is: it strips the
/// comments, differences the arms out of the source and compares them against a
/// written-out list, so an arm added, removed, reordered or given a different
/// answer is a red line rather than a paragraph nobody re-read.
///
/// - **Absent** (`NotFound`) is the whole truth. `Default`, and a write proceeds.
/// - **A directory where the file goes** (`IsADirectory`) is answered the same
///   way, and the arm carries the argument: POSIX refuses `rename(file,
///   directory)`, so nothing this app wrote can be in there to lose and the one
///   statement that could destroy anything cannot run.
/// - **Will not decode** (`InvalidData`) is *evidence* the bytes are unusable,
///   arriving one layer below serde — and it is the state that had no arm at all.
///   `quarantine` moves them aside and a write proceeds **only where that
///   landed**. See below.
/// - **Will not read** — `PermissionDenied`, `NotADirectory`, an I/O error on a
///   dying volume — is evidence of nothing at all about the bytes. So they are
///   neither moved nor replaced: `replaceable` is `false` and `write_stored`
///   refuses with a sentence naming the path.
/// - **Will not parse** — bytes that decoded and that serde refused — is the same
///   evidence as the third, and takes the same answer: `quarantine` moves them
///   aside — from *here*, because this is the only moment anything in this process
///   knows they were ever on disk — and a write proceeds only where that landed,
///   which is what `quarantine` now answers. It is last because it is the last
///   arm: it sits inside `Ok(text)`, after the read succeeded.
///
/// ⚠ **`InvalidData` carries no errno, and that is the whole of why it belongs
/// with "will not parse" rather than with "will not read".** `read_to_string`
/// runs the UTF-8 check itself and reports a failure of it as `InvalidData` with
/// `raw_os_error()` of `None` — measured on this machine (macOS 15.6 / arm64 /
/// APFS, rustc 1.95.0): `kind=InvalidData raw_os=None`, against errno 13, 20 and
/// 2 for the three states the bullets above were built from. **The read failures
/// the refusal protects are the ones *with* an errno**: a syscall said no, and a
/// syscall saying no can be transient. Bytes that are not UTF-8 are not a syscall
/// saying anything — they are evidence about the bytes, exactly as a serde error
/// is, and they never become valid on their own.
///
/// Classified as a read failure it was permanent in the worst direction:
/// `replaceable` stayed `false` for ever, so `write_stored` refused **every**
/// configuration write on that installation, `quarantine` was never reached, and
/// the file was therefore neither moved aside *nor* replaced. On the population
/// this file exists for — a keyring-less host — that is `write_device_key_fallback`
/// and `write_server` failing on every launch, with `host_device_set` and
/// `host_device_clear` failing *silently* because `setNativeDevice` is
/// `void invoke(...).catch(() => undefined)`. Nothing the app can do recovers it.
///
/// ⚠ **Refusing rather than quarantining the unread file is a decision on the
/// merits and not a limitation.** Measured here: `fs::rename` on a mode-`000`
/// file *succeeds*, so a quarantine would land. It is declined because a read
/// failure *with an errno* can be transient — an `EIO` on a network volume, a
/// mode somebody is about to correct — and moving a perfectly good file into a
/// slot named `unreadable` that nothing here ever reads back turns a recoverable
/// error into exactly the permanent first run this section exists to prevent.
/// Where the quarantine's own rename fails — it needs write permission on the
/// directory rather than on the file — the answer is the same refusal by the
/// other route, `quarantine` reporting `false`.
///
/// ⚠ **The returned value carries the lock.** The caller's `write_stored` is part
/// of the same critical section as this read; see `Guarded`.
fn read_stored(dir: &Path) -> Guarded {
    let lock = CONFIG_LOCK.lock().unwrap_or_else(|held| held.into_inner());
    let (file, replaceable) = match fs::read_to_string(server_file(dir)) {
        // Nothing is there — a first run, or a configuration directory this app
        // has not created yet. `Default` is the whole truth about it.
        Err(e) if e.kind() == ErrorKind::NotFound => (Stored::default(), true),
        /*
         * ⚠ **A directory sitting where the file goes, and the one state other
         * than `NotFound` that is safe to answer `Default` for.** Measured here:
         * `read_to_string` on a directory is `IsADirectory` (errno 21), and POSIX
         * refuses `rename(file, directory)` with `EISDIR` whether or not it is
         * empty — so nothing this app ever wrote is in there to lose, and the one
         * statement that could destroy what is cannot run.
         *
         * ⚠ **Carved out rather than folded into the refusal below, and the
         * reason is an assertion in this file.** The refusal returns *before* a
         * temporary file is created, and
         * `a_write_that_cannot_land_takes_its_temporary_with_it` injects its
         * failure in exactly this way — a directory at the target — because
         * `EISDIR` is the one rename failure that can be provoked without a full
         * disk or a read-only mount. Folded in, that test would go on passing
         * while covering a `remove_file` nothing executes: the shape of green
         * assertion this repository has shipped six times and has a standing rule
         * against.
         */
        Err(e) if e.kind() == ErrorKind::IsADirectory => (Stored::default(), true),
        /*
         * ⚠ **Bytes that are not UTF-8: the unparseable case, never the unread
         * one.** `read_to_string` does the decoding, so this is the *only* read
         * failure that is evidence about the bytes rather than about a syscall —
         * it has no errno at all, and it never becomes valid on its own. It sat
         * in the `Err(_)` arm below, where `replaceable` is `false` for ever: no
         * quarantine, no replacement, and every configuration write on that
         * installation refused until somebody moved the file by hand. The
         * docblock above carries the measurement and what it cost.
         */
        Err(e) if e.kind() == ErrorKind::InvalidData => (Stored::default(), quarantine(dir)),
        /*
         * ⚠ **Bytes are there and this process could not read them**, which is
         * the case the single `Err` arm here used to answer `Default` for while
         * a comment claimed there was nothing to save. `Default` is still what is
         * *answered*, so the app starts on the setup screen rather than refusing
         * to launch; what changes is that nothing may be renamed over the file.
         */
        Err(_) => (Stored::default(), false),
        Ok(text) => match serde_json::from_str::<Stored>(&text) {
            Ok(parsed) => (parsed, true),
            // Bytes that will not deserialize are evidence that they are unusable,
            // which is what makes moving them aside worth doing and makes a write
            // over the gap they leave the right next act — but only where they are
            // genuinely aside, which is the one thing `quarantine` answers.
            Err(_) => (Stored::default(), quarantine(dir)),
        },
    };
    Guarded {
        file,
        replaceable,
        _lock: lock,
    }
}

/// Make a rename durable: the directory entry, not only the bytes it names.
///
/// ⚠ **An `fsync` on the file closes half of a crash and reads as all of it.**
/// `sync_all` on the temporary puts its *contents* on the device; the directory
/// entry that gives those contents a name is a separate write, and an un-synced
/// one can leave neither the new name nor the old after a power cut or a panic.
/// On a keyring-less host what is lost that way is the only copy of the device's
/// X25519 private key, and the installation comes back as a first run: the setup
/// screen, a fresh key, and a brand new `devices` row spending one of the
/// account's twenty slots for an installation that already had one. That is the
/// same failure `write_stored`'s docblock describes under *the truncate*,
/// arriving through the one statement that shape does not cover.
///
/// ⚠ **One copy for two writers, on purpose.** `commands.rs`'s `write_private` is
/// the shape `write_stored` was modelled on and had the identical gap; two fixes
/// that drift apart is how one of them quietly stops being a fix. It lives here
/// rather than there because `commands.rs` already depends on this module and
/// nothing here depends on it.
///
/// **Best effort at both call sites, which is still the whole of the policy**: a
/// platform that will not open a directory as a file is not a reason to report a
/// write that landed as one that did not — the judgement every mode call in this
/// file already makes. What moved is the `let _`. The value is returned rather
/// than swallowed in here, so each caller discards it *out loud* and a test can
/// reach what the platform answered.
///
/// ⚠ **What this does per platform, measured rather than reasoned where it could
/// be.** The paragraph that used to be here argued about durability and said
/// nothing about *reachability*, which is the half that can be wrong in silence.
///
/// - **macOS: reached, and it answers success.** Measured on this machine
///   (Darwin 24.6.0 / macOS 15.6 / arm64 / APFS, rustc 1.95.0). `File::open` on a
///   directory succeeds and `sync_all` on that handle answers `Ok`; under it, on
///   a directory descriptor opened `O_RDONLY`, `fcntl(F_FULLFSYNC)` — which is
///   what `sync_all` issues on this platform — answers `0` with `errno` `0`, and
///   so do plain `fsync(2)` and `fcntl(F_BARRIERFSYNC)`. So nothing is being
///   swallowed here on the platform this app is developed on, which is what the
///   discarded `Result` was open to being accused of.
/// - **Windows: not reached at all.** `File::open` passes no
///   `FILE_FLAG_BACKUP_SEMANTICS`, without which opening a directory fails with
///   `ERROR_ACCESS_DENIED` — so this function does nothing there and the
///   directory half of the durability argument is simply absent. ⚠ **Read off
///   std's implementation rather than run**, there being no Windows machine here,
///   and labelled so nobody later cites it as a measurement. It is stated instead
///   of ignored because `Cargo.toml` already treats Windows as *"a real gap on a
///   real target platform, not a platform this project does not have"*.
///
/// ⚠ **Whether the flush is *effective* on a directory inode is a different
/// question, and that one has no in-process observable at all**: the only party
/// that can tell is a power cut. So the test in this file is deliberately about
/// **reachability** — that this opens the path it was handed and reports what the
/// platform said — and says so rather than pretending to be about durability. A
/// test that wrote a file and read it back would pass identically with this call
/// deleted, which is precisely the shape of assertion this codebase has shipped
/// green six times and has a standing rule against.
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    fs::File::open(dir).and_then(|handle| handle.sync_all())
}

/// A temporary name no other write in this process will pick.
///
/// ⚠ **One counter for two writers, which is the precedent `sync_dir` above set
/// for this same pair of files.** `commands.rs`'s `write_private` is the other
/// copy of this shape — create at `0600`, fill, flush, rename — and it built its
/// temporary name from the pid **alone**. That was survivable while its caller
/// ran on the main thread and so could not overlap itself. It is not now:
/// `host_daemon_start` carries `(async)`, two of them can be in flight in one
/// process, and nothing serialises that path — `CONFIG_LOCK` covers `server.json`
/// and nothing at all covers `daemon.env`.
///
/// **What a shared temporary name costs there is a torn file, not an untidy
/// directory.** Both writers open the same path with `truncate(true)`, so the
/// second open empties the bytes the first has already flushed; the first then
/// renames whatever is in the file at that instant over the target, and the
/// second's rename fails with `ENOENT`. For `daemon.env` what can land that way
/// is an env file with no `REEMOAT_CONTROL_PLANE`, which `daemon::config_state`
/// reads as
/// `elsewhere` — the app refusing to touch a file it corrupted itself while
/// telling the person their computer belongs to another server, which is the
/// worst outcome that function has and the one its own docblock names twice.
///
/// The **pid** is the half no counter in this process can cover, two copies of
/// the app over one directory being invisible to it; the **counter** is the half
/// no pid can, two writes inside one process sharing one. Neither is sufficient
/// alone, which is why the name is built from both rather than fixed.
///
/// `Relaxed` because nothing is ordered against the value: the only property
/// wanted is that no two `fetch_add`s answer the same number, which is
/// `fetch_add`'s own guarantee at every ordering.
pub fn temp_name(name: &str) -> String {
    format!(
        "{name}.tmp.{}.{}",
        std::process::id(),
        WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// A temporary file at `0600`, flushed, then renamed over `server.json` — and the
/// rename itself flushed.
///
/// ⚠ **`fs::write` was wrong here twice over, and this file has the same two
/// reasons to care that `commands.rs`'s `write_private` does — plus a third that
/// is only a problem for installations that already exist.**
///
/// *The mode.* `fs::write` creates at `0666 & !umask`, which is `0644` under the
/// usual one, and nothing in this file ever set a mode. `device_keys` is an
/// X25519 **private key**, and the machines it is written on are by definition
/// the ones with no usable keyring — a shared Linux host with no unlocked
/// collection, which is exactly where "world-readable" has somebody in it to
/// read. Two docblocks said `0600` — this file's own `read_device_key_fallback`
/// and `packages/web/src/native.ts` — `.claude/rules/e2ee.md` said `0600`, and no
/// line of code anywhere said it.
///
/// *The truncate.* `fs::write` truncates before it writes, so a crash or a full
/// disk in between loses the server origin, every device id **and**, on those
/// same keyring-less machines, the only copy of the device key — in one act. That
/// installation comes back as a first run: the setup screen, a fresh key, and a
/// brand new `devices` row spending one of the account's twenty slots for an
/// installation that already had one. It is `write_private`'s env-file failure
/// arriving at the file that can least afford it.
///
/// *The upgrade.* A `server.json` an earlier build already created at `0644`
/// **keeps that mode for ever** through `fs::write`, which opens the existing
/// inode rather than making one — so a fix that only set a mode at creation would
/// leave every machine in the field world-readable and look green in a test that
/// started from an empty directory. The rename replaces the inode, so the first
/// write after this change is what narrows the file, with no separate `chmod`
/// pass and no installation left behind. The same applies one level up: the mode
/// is put on the directory on **every** write rather than only when it is
/// created, because `create_dir_all` left it at `0755` on every machine so far.
///
/// *The entry.* The three above are about the file; the fourth is about its
/// **name**. `sync_all` on the temporary is a promise about bytes, and the rename
/// that gives those bytes a path is a separate directory write which nothing here
/// flushed — so a crash immediately after a first write left neither the
/// temporary's entry nor the target's guaranteed, which is *the truncate* again
/// with the same cost and none of this shape's protection. `sync_dir` above is
/// that half, and it is the last thing this function does.
///
/// The mode is set **twice**, at creation and again on the open handle. Creation
/// is what closes the window in which the bytes exist at the umask's mode — the
/// ordering bug `write_private` records. `set_permissions` is what makes it
/// exactly `0600` rather than `0600 & !umask`: a umask with owner bits in it
/// leaves `0400` at `0277` and nothing at all at `0677`, and a key file this same
/// user cannot read back on the next launch is the "regenerate on every launch"
/// failure `read_device_key_fallback` exists to prevent.
///
/// ⚠ **And the first statement is a refusal, which is a behaviour change and the
/// right one.** Where `read_stored` could neither read the file that is already
/// there *nor put it safely aside*, `replaceable` is `false` and this writes
/// **nothing at all** — no directory, no temporary, no rename — and answers a
/// sentence naming the path. What shipped instead was `Default` for an unreadable
/// file and a rename over bytes nobody had looked at, which is *the truncate*
/// above arriving through the one door that shape does not cover.
///
/// What the refusal costs is real and is stated rather than hidden: on a host
/// where that state is permanent — a mode nobody corrects, a `~/.reemoat` that is
/// a regular file, a dying volume, a second corruption over a quarantine slot
/// that is already taken — the app still *starts*, `read_server` answering `None`
/// onto the setup screen, and then every configuration write fails until a person
/// moves the files aside. What the other answer costs is an X25519 private key
/// and one of the account's twenty device slots, on precisely the keyring-less
/// machines this file exists for.
fn write_stored(dir: &Path, stored: &Guarded) -> Result<(), String> {
    use std::io::Write;

    /*
     * ⚠ **Before `create_dir_all`, so nothing at all is created on this path.**
     * `read_stored` answers `Default` for bytes it could not read — an app that
     * will not start is the worse failure — and every writer here is
     * read-modify-write, so going on would rename a fresh empty file over a
     * `server.json` nobody has looked at. The sentence names the path because
     * that is the only thing a person can act on.
     *
     * ⚠ **It does not reach a person from every writer.** `host_set_server`
     * (`native.ts`'s `setNativeServer`, awaited), `host_device_key_reset`
     * (`hostDeviceKeyReset`, awaited and drawn by the Devices screen's re-key
     * toast) and the account acts — a sign-in's bind, a confirm, a forget —
     * surface it, each through a command the page awaits. What a sign-out, a boot
     * and a switch record afterwards — the signed-in flag, the account shown last
     * — is written with the refusal discarded: a note the drawer reads is not worth
     * failing the act it is about. `host_device_set` and
     * `host_device_clear` do not: their only caller is `setNativeDevice`, which is
     * `void invoke(...).catch(() => undefined)` — deliberately fire-and-forget,
     * because it runs inside sign-in and sign-out where a device id is
     * bookkeeping and a rejection must not become a failed sign-in. So on those
     * two paths the refusal is correct and silent, and the person learns about the
     * unreadable file from whichever awaited writer they reach next. Answering
     * `Result<_, String>` is what makes the sentence *available*; it is not what
     * makes it seen.
     */
    if !stored.replaceable {
        // "read or safely kept" rather than "read": the two states that reach here
        // are a file this process could not open at all, and one it could open and
        // could not put under `UNREADABLE` — and the remedy a person has is the
        // same sentence for both.
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
        // Ignored rather than propagated, which is the judgement `write_private`
        // and `store/sqlite.ts` already make: a filesystem with no POSIX modes is
        // not a reason to refuse to remember which server this is.
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let text = serde_json::to_string_pretty(&stored.file).map_err(|e| e.to_string())?;
    let target = server_file(dir);
    // The commands that reach this writer run on the async runtime — every
    // account act, `host_set_server`, `host_credential_clear`, the device
    // commands, and `host_boot` where it generates a key or corrects a signed-in
    // flag — and with a webview per account booting at launch they genuinely do
    // overlap. `CONFIG_LOCK` is what makes that
    // safe and the name is the second line behind it. Built by `temp_name` rather
    // than spelled out here, because `commands.rs`'s writer needs the same
    // discipline and has no lock at all: two copies of one rule is how one of
    // them quietly stops being a rule.
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
    // `sync_all` rather than a plain close: a rename that beats its own contents
    // to disk is this shape's own version of the failure it exists to prevent —
    // a whole file that is whole zeroes.
    if let Err(e) = file
        .write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
    {
        let _ = fs::remove_file(&tmp);
        return Err(format!("could not write {}: {e}", tmp.display()));
    }
    drop(file);
    fs::rename(&tmp, &target).map_err(|e| {
        // A temporary file left behind is a second copy of the private key sitting
        // beside the first, so it goes even on the path where nothing worked.
        let _ = fs::remove_file(&tmp);
        format!("could not write the server file: {e}")
    })?;
    // ⚠ **The flush above is the bytes; this is the name.** A directory entry is
    // its own write, so a crash or a power cut right after the rename can leave
    // neither the new name nor the old — and on a keyring-less host the file that
    // vanishes is the only copy of the device key. Best effort, because a
    // directory handle is not openable everywhere — `sync_dir` names the platform
    // where it is not — and a write that landed must never be reported as one
    // that did not. The `let _` is that policy said out loud rather than hidden
    // inside the function.
    let _ = sync_dir(dir);
    Ok(())
}

/// The device this installation is registered as for one account — `scope` is
/// `<origin>#<user id>`, or a bare origin from before accounts — or `None`.
///
/// Keyed on the **canonical** origin, exactly as the keyring account is, so one
/// server is one entry however its address was typed. A value stored under a
/// spelling `normalize_origin` no longer produces is simply never read — which is
/// the same cost a credential under a stale key already carries.
pub fn read_device(dir: &Path, scope: &str) -> Option<String> {
    read_stored(dir).devices.get(scope).cloned()
}

/// Record the device this account registered as — which also records that it is
/// bound to the account's current sign-in, since registering is what binds it.
///
/// ⚠ **A derived list is not materialized for this**: an entry from before
/// accounts reads its `bound` off `devices` anyway, so the map entry is the whole
/// of the record until an account act writes the list down.
pub fn write_device(dir: &Path, scope: &str, device: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    stored.devices.insert(scope.to_string(), device.to_string());
    mark_bound(&mut stored, scope, true);
    write_stored(dir, &stored)
}

/// Flip an existing entry's `bound`, where the list has been written down.
fn mark_bound(stored: &mut Stored, scope: &str, bound: bool) {
    if let Some(entry) = stored
        .accounts
        .as_mut()
        .and_then(|list| list.iter_mut().find(|account| account.key() == scope))
    {
        entry.bound = bound;
    }
}

/// Give up the device recorded for one account — and with it the account's
/// record that a device is bound to its sign-in.
///
/// Called when the control plane says that installation has been retired — at
/// which point keeping the id is actively harmful, because the next sign-in would
/// offer it again. The server refuses to bind a retired id and registers a fresh
/// device instead, so this is belt rather than the only guard; what it buys is
/// that the app stops presenting something it has been told is finished.
pub fn erase_device(dir: &Path, scope: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    /*
     * ⚠ **The `replaceable` half is what stops "nothing to remove" being said
     * about a file nothing read.** On the path where `server.json` exists and
     * could not be opened, this map is empty because *nothing was parsed* rather
     * than because the id is gone — so the old shape answered `Ok(())` and
     * `host_device_clear` reported success over an id still on disk. Falling
     * through hands it to `write_stored`, whose refusal says which file and why.
     */
    if stored.replaceable && stored.devices.remove(scope).is_none() {
        return Ok(());
    }
    mark_bound(&mut stored, scope, false);
    write_stored(dir, &stored)
}

/// The device's private key, where the keyring will not keep one.
///
/// ⚠ **This is a private key in a plaintext file, and it is here because the
/// alternative is worse rather than because it is good.** `credential::probe`
/// exists to detect a machine whose store silently discards writes — a Linux box
/// with no D-Bus session or no unlocked collection. On such a machine a
/// keyring-only device key would be regenerated on **every launch**, and because
/// a new key means a new registration, that installation would burn through the
/// account's twenty-device limit in a fortnight and never once read a key back.
/// That is precisely the failure this file already avoids for the device *id*,
/// arriving one field later for the key.
///
/// So: the keyring first, always, and this only when it will not answer. The file
/// is 0600 in a directory this process creates, which is the protection
/// `~/.ssh/id_ed25519` has and the one the daemon's own machine key has inside
/// `~/.reemoat/reemoat.db`. ⚠ **That sentence was false when it was written** —
/// `write_stored` used `fs::write` and set no mode anywhere, so this key shipped
/// at `0644` on precisely the shared hosts the fallback exists for. It is
/// `write_stored` that makes it true now, and the tests at the foot of this file
/// are what keep it from quietly becoming prose again. The app **says which of
/// the two it used**, per account, so a person on such a machine is told rather
/// than having it decided for them that they get no remote access at all.
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

/// Take the file-held device key for one account out of `server.json`.
///
/// Reached from exactly two places: `device::store_secret`, once a keyring write
/// has been read back and verified, and `device::reset_key`, arriving through
/// `give_up_device_key` below, which is the Devices screen's **Re-key**. **The two
/// mean different things**, and collapsing them is what put a quarantine removal
/// on this statement.
///
/// ⚠ **The sentence that used to be here was false, and it was the load-bearing
/// one.** It read *"`device::ensure_key`'s first-use path never comes here, which
/// is what makes the last statement safe"*. `ensure_key` reaches this on **every**
/// keyring-verified first use: `ensure_key` → `store_secret` → here, immediately
/// after the keyring write is read back. It was wrong the day it was written, and
/// what it was defending was a `discard_quarantine` that is no longer on this
/// statement at all.
///
/// ⚠ **The promotion path could reach that removal, which is the hole the split
/// closes.** `store_secret` runs only where `read_secret` answered `None`, which
/// normally means there is no entry here and the early return below fires — the
/// shape the old sentence was reaching for. But `read_secret` also answers `None`
/// for an entry `device::decode_key` **rejects**: a value that is not 32 base64url
/// bytes, from a hand-edit or a half-written file. There `remove` answers `Some`,
/// the early return does not fire, and the old shape discarded the quarantine over
/// a key nobody gave up — while those very bytes may have held the legible copy.
///
/// So this writes `server.json` and nothing else, and `give_up_device_key` is the
/// statement a deliberate give-up goes through.
pub fn erase_device_key_fallback(dir: &Path, scope: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    // `replaceable` for `erase_device`'s reason, and it matters more here: an
    // empty map on the unread path would report a key given up while the bytes
    // holding it are still on disk.
    if stored.replaceable && stored.device_keys.remove(scope).is_none() {
        return Ok(());
    }
    write_stored(dir, &stored)
}

/// The Devices screen's **Re-key**: this installation is giving up its key for one
/// server, on purpose and because somebody asked.
///
/// ⚠ **This is the one moment a quarantined copy of that key stops being a
/// recovery.** `server.json.unreadable` is retained because it may hold the only
/// copy of this installation's X25519 static, and a re-key supersedes it; nothing
/// removed it, so Re-key gave up both live copies and left the superseded private
/// key in cleartext on disk indefinitely, on exactly the keyring-less host it was
/// written down for. `discard_quarantine` is that half, and its docblock carries
/// the weighing — including why it is now *this origin's* quarantine rather than
/// the whole file, which is a departure taken back out.
///
/// **After the write, never before.** On the path where `write_stored` refuses,
/// the old key is still in place and the quarantine is still the thing standing
/// behind it. The early return inside `erase_device_key_fallback` is different: it
/// writes nothing *and changes nothing*, so a re-key of a server whose key was
/// only ever in the keyring still supersedes the quarantined copy. **The act is
/// what supersedes those bytes, not the removal of a map entry** — which is also
/// why this is a second function rather than a flag on the first.
pub fn give_up_device_key(dir: &Path, scope: &str) -> Result<(), String> {
    erase_device_key_fallback(dir, scope)?;
    discard_quarantine(dir, scope);
    Ok(())
}

/// What somebody typed, turned into the one canonical spelling — or a sentence
/// saying why it is not an address.
///
/// **The canonical form is an origin**: scheme, host and a port only where it is
/// not the scheme's default. Everything else is dropped, because a path, a query
/// or a fragment on a control-plane address is a value that would make one server
/// look like two — and two spellings of one server means two credentials, one of
/// which a sign-out would not reach.
///
/// A missing scheme is **filled in** rather than refused. `isAbsoluteHttpUrl` in
/// `packages/web/src/instance.ts` refuses one, and it is right to: a scheme-less
/// value there becomes a *relative href* on the page's own origin. Here the value
/// can never become one — it is joined in this process against nothing — and a
/// form that refuses `my.server.example` refuses what everybody types.
///
/// The scheme is never normalized away. `http://` and `https://` are different
/// trust boundaries, and letting them share a credential key would hand a
/// plaintext origin the session minted for a TLS one.
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
    // A URL carrying a username or a password is refused rather than stripped:
    // silently dropping half of what somebody pasted is how a credential ends up
    // somewhere nobody meant to put it.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Leave the username and password out of the address.".into());
    }
    if parsed.host_str().is_none() {
        return Err("That address names no host.".into());
    }
    // `Url::origin()` answers a tuple that serializes to exactly scheme://host[:port],
    // with a default port omitted — which is the whole normalization, done by the
    // parser rather than by string work.
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err("That address names no host.".into());
    }
    Ok(origin)
}

/* ── the accounts on this computer ────────────────────────────────────────── */

/// origin → the user id that owns that server's own daemon root, or `""`.
pub type Roots = BTreeMap<String, String>;

/// One account, as the host reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub origin: String,
    /// `None` for an entry from before accounts that nothing has attributed yet.
    pub user: Option<String>,
    pub name: Option<String>,
    pub bound: bool,
    pub signed_in: bool,
    pub seen: u64,
    pub pending_proof: bool,
}

impl Account {
    /// `<origin>#<user id>`, or the bare origin for a legacy entry — the scope,
    /// and the key the page is shown.
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

/// What `server.json` says about accounts, read once.
#[derive(Clone, Debug, Default)]
pub struct Roster {
    pub accounts: Vec<Account>,
    /// The key of the account shown last.
    pub current: Option<String>,
    /// A server a file from before accounts was pointed at with **no evidence of
    /// an account on it** — chosen and never signed in to. It opens as a pending
    /// seat, which keeps its `‹ Server` rather than inventing an account somebody
    /// would have to remove.
    pub pending: Option<String>,
    pub roots: Roots,
    pub legacy_root_holder: Option<String>,
    /// Whether `accounts` was derived from a file from before accounts rather
    /// than read — nothing about it is on disk yet.
    pub derived: bool,
}

impl Roster {
    pub fn find(&self, key: &str) -> Option<&Account> {
        self.accounts.iter().find(|account| account.key() == key)
    }

    /// The most recently shown account other than `except`.
    pub fn recent(&self, except: Option<&str>) -> Option<&Account> {
        self.accounts
            .iter()
            .filter(|account| except != Some(account.key().as_str()))
            .max_by_key(|account| account.seen)
    }

    /// The account a launch shows: the one shown last where the file names one,
    /// otherwise the most recent.
    pub fn shown(&self) -> Option<&Account> {
        self.current
            .as_deref()
            .and_then(|key| self.find(key))
            .or_else(|| self.recent(None))
    }
}

/// Every account on this computer — **and it writes nothing**.
///
/// A file written by this build is read as it is. A file from before accounts
/// has a list **derived** for it, in memory, from what it holds as evidence that
/// somebody signed in:
///
/// 1. `server`, but only where `devices` names it, `machine.json` claims a
///    machine on it, or `evidence(server)` — the keyring holding a
///    `credential#<server>` — says so. A server that was chosen and never signed
///    in to is `pending` instead, so it opens as the sign-in it was.
/// 2. Every other bare origin `devices` names, then every bare origin
///    `machine.json` claims a machine on.
///
/// Deduplicated and capped at `MAX_ACCOUNTS`, each as a legacy entry with no
/// user. `evidence` also answers each one's `signed_in`, once per origin.
///
/// ⚠ **`evidence` is what keeps this pure while still asking the keyring.** The
/// read happens in the caller — `lib.rs` at setup, once, for a file from before
/// accounts, and `Host`'s memory of that answer afterwards — so this function is
/// a function of its arguments and a test can drive every derivation without a
/// keychain. It is called with `CONFIG_LOCK` held, so it must not reach for it.
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

/// The list a file from before accounts implies. See `read_accounts`.
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
    // A key counts as an origin only where it is already the one spelling
    // `normalize_origin` gives it — a hand-edited key is not an account.
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

/// The list, written down: a no-op where it already is.
///
/// Called by the host before the first act of the accounts era changes anything,
/// with the same `evidence` the launch derived from, so what is written is what
/// the drawer was already showing.
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

/// The list, materialized if it was not — with no keyring evidence, so a
/// derived entry reads as signed out. The host materializes with its evidence
/// first (`materialize_accounts`); this is the backstop for a writer that did not.
fn accounts_mut<'a>(stored: &'a mut Stored, dir: &Path) -> &'a mut Vec<StoredAccount> {
    if stored.accounts.is_none() {
        let claims = crate::daemon::claim_scopes(dir);
        let (list, current, _) = derive(stored, &claims, &|_| false);
        stored.current = current;
        stored.accounts = Some(list);
    }
    stored.accounts.get_or_insert_with(Vec::new)
}

/// A proof about a bare item, as the host found it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proof {
    /// Nothing bare to prove, or nothing this account could take.
    NotAsked,
    /// The control plane says it is this user's.
    Proven,
    /// It answered, and it is not.
    Disproven,
    /// It could not be asked; `Boot.legacy` asks again next time.
    Unreachable,
}

/// What the host learned about an origin's bare items before binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Evidence {
    /// The server's own root holds no daemon and no machine was claimed for it:
    /// nothing in it for anybody to lose.
    pub root_empty: bool,
    /// Its claimed or announced machine id is one this user owns.
    pub root: Proof,
    /// The bare device id is this user's.
    pub device: Proof,
    /// …and it is the one bound to the session being bound.
    pub device_current: bool,
}

impl Evidence {
    /// Nothing known and nothing to take — a bind that inherits nothing.
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
    /// The server's own root, and with it the bare machine claim.
    pub root: bool,
    /// The bare device id and, where it is file-held, its key.
    pub device: bool,
    /// A proof could not be reached, so this is not settled.
    pub pending: bool,
}

/// Take what `evidence` allows for `key`, inside one read-modify-write.
///
/// ⚠ **The root is taken only by proof, or where there is nothing in it**, and
/// never from another user: a server's root is its owner's for good, which is
/// what gives a returning owner their machine back. "Nothing in it" also needs no
/// other unconfirmed legacy entry on the origin (`free`), whose owner may be the
/// person that root was about to be set up for.
///
/// ⚠ **The device moves only by proof, and only into an account that has none.**
/// Moving it anywhere else is the linkage `credential.rs`'s `DEVICE_KEY` block
/// forbids: one key on two users' rows.
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

/// A verified sign-in to bind.
pub struct BindRequest<'a> {
    /// The legacy entry being attributed, for a legacy seat; `None` for a new one.
    pub from: Option<&'a str>,
    pub origin: &'a str,
    pub user: &'a str,
    pub name: &'a str,
    /// A sign-in that just happened, whose session has no device bound yet.
    pub fresh: bool,
    pub evidence: &'a Evidence,
}

/// An account bound to this computer.
#[derive(Debug, PartialEq, Eq)]
pub struct BoundAccount {
    pub key: String,
    pub owner: bool,
    pub claimed: Claimed,
}

/// What `bind_account` came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Bind {
    /// That user is already here, and nothing was written.
    Existing {
        key: String,
        signed_in: bool,
    },
    Bound(BoundAccount),
}

/// Bind a verified sign-in: re-key the legacy entry it came from, or add one.
///
/// One read-modify-write, and the one place the cap is enforced for a new
/// entry — `MAX_ACCOUNTS`, refused as `account_limit` rather than evicting
/// anybody. A legacy entry being attributed is re-keyed in place, so it does not
/// count twice.
///
/// ⚠ **`owner` is recomputed, never inherited from the call**:
/// `roots[origin] == user` after whatever `claim_into` took. That is what gives a
/// person who forgot their account and signs in again their root back, and what
/// keeps a second user on the same server a guest whatever order things happened
/// in.
///
/// `bound` is `false` for a fresh sign-in — its session has no device yet, and
/// the page registers one — and for a move, is whether the proven device is the
/// one bound to the session being moved.
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

/// Give an account already here what `evidence` proves is its — the second half
/// of finding a legacy sign-in to be somebody already on this computer, and the
/// retry for an account whose proof could not be reached at bind time.
///
/// `from` is a legacy entry the same person's token came through, which does not
/// count against taking an empty root. `bound` is what to record where the
/// device moves in, which is `false` unless the proof was made with this
/// account's own session.
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

/// Refresh a cached name. Writes only where it changed, and answers whether it
/// did.
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

/// Record that an account is the one on screen: the next launch shows it, and
/// "back" from any other is it.
///
/// ⚠ **Only ever after the switch has happened.** The file decides which account
/// opens next time and nothing else, so a failure here is not a failed switch.
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

/// Whether an account's device is bound to its current sign-in.
pub fn set_bound(dir: &Path, key: &str, bound: bool) -> Result<(), String> {
    update(dir, key, |entry| {
        let changed = entry.bound != bound;
        entry.bound = bound;
        changed
    })
}

/// Whether an account is signed in, as the drawer is told without a keyring
/// read. Signing out also unbinds its device: the session that device was bound
/// to is the one that ended.
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

/// One entry's read-modify-write, skipping the write where nothing changed.
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

/// Take an account off this computer, and answer the one to show instead.
///
/// ⚠ **The device id, the key and the root record are kept**, so a person who
/// signs in as the same user again reuses their device row and gets their root —
/// and the machine and database in it — back. What goes is the entry, and with it
/// the account's place in the drawer and at launch.
///
/// ⚠ **A legacy entry that nobody confirmed leaves its root to nobody.** Where the
/// origin has no owner recorded, it is written as `""`: that root's owner was
/// never proved, and without the record the next new account on that server would
/// be free to take a root that may hold somebody else's database. A later proof
/// still takes it (`claim_into`).
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

/// Record that `origin` has been handed `~/.reemoat`, where nobody holds it yet.
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

/// The switch's theme: dark once it has chosen dark, and light for anything else.
pub fn read_theme(dir: &Path) -> Theme {
    theme_of(&read_stored(dir))
}

/// Record the switch's theme, answering whether anything changed: the page says it at
/// every boot, so an unchanged one writes nothing. Light is written as no key at all. Not
/// an account act, so a file from before accounts stays one.
pub fn write_theme(dir: &Path, theme: Theme) -> Result<bool, String> {
    let mut stored = read_stored(dir);
    // `replaceable` for `erase_device`'s reason: an unread file's light is not a light
    // known to be recorded.
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

    /// The mode of a path, as the nine permission bits alone.
    #[cfg(unix)]
    fn mode_of(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .unwrap_or_else(|e| panic!("{} should exist: {e}", path.display()))
            .permissions()
            .mode()
            & 0o777
    }

    /// Whatever `write_stored` may have left beside the file it wrote.
    ///
    /// Named by substring rather than by the exact temporary name, because the
    /// assertion is *nothing is left behind* rather than *this particular name is
    /// absent* — a later change to how the name is built must not make this
    /// vacuous.
    fn strays(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp."))
            .collect()
    }

    /// A directory of this test's own. The one below keys on the process id
    /// alone, which is fine while it is the only test writing — it is not any
    /// more, and two tests sharing a directory is a pass that depends on order.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("reemoat-cfg-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// A default is a suggestion and writes nothing.
    ///
    /// ⚠ This is the assertion the first draft failed: it seeded, so first run
    /// with a default wrote the file and skipped the setup screen entirely. The
    /// property that matters is that **nothing is on disk until somebody presses
    /// Continue**, which is what makes a keyring account exist only for an origin
    /// a person confirmed.
    #[test]
    fn a_default_is_a_suggestion_and_writes_nothing() {
        let dir = scratch("suggest");
        assert_eq!(read_server(&dir), None);
        assert!(!dir.join("server.json").exists());
    }

    /// A choice already made is what `read_server` answers, default or no default.
    #[test]
    fn a_chosen_server_is_what_is_read_back() {
        let dir = scratch("chosen");
        write_server(&dir, "https://chosen.example").unwrap();
        assert_eq!(read_server(&dir).as_deref(), Some("https://chosen.example"));
    }

    /// ⚠ **Vacuous here and loud in a fork**, which is the only place it can be
    /// either: `option_env!` is evaluated in *this* build, so a repository with no
    /// default asserts over `None` while a fork that typed its address wrong fails
    /// this test on its own `cargo test`. It is the one thing standing between
    /// that typo and a build that silently has no default at all.
    ///
    /// ⚠ **A blank value is skipped, because it is what an unset repository
    /// variable arrives as.** `release.yml` forwards `${{ vars.… }}`, which expands
    /// to the empty string where the variable does not exist, so `option_env!`
    /// answers `Some("")` rather than `None` — and `default_server()` already turns
    /// that into no default, which is the behaviour wanted. Asserted on, the
    /// release of any fork that has not set the variable would fail here for
    /// being exactly right. Q4.127.
    ///
    /// The message names the value without the variable's own name beside an `=`,
    /// because `nativecheck` sweeps every tracked file for that shape as a setter.
    #[test]
    fn a_compiled_default_is_an_address() {
        if let Some(raw) = DEFAULT_SERVER.filter(|raw| !raw.trim().is_empty()) {
            assert!(
                default_server().is_some(),
                "the compiled-in default server {raw} is not an address this can reach"
            );
        }
    }

    /// The property the map exists for: two servers, two devices, neither
    /// reachable from the other's origin.
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
        // And the server survives a device write — the two fields are written by
        // different acts and a partial write is the one that loses the other.
        assert_eq!(read_server(&dir).as_deref(), Some("https://a.example"));

        // Changing servers keeps both: the row on the old server still exists, so
        // forgetting its id would spend a second slot on the way back.
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
        // Erasing what is not there is the outcome the caller wanted.
        erase_device(&dir, "https://a.example").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ── accounts ─────────────────────────────────────────────────────────── */

    const A: &str = "https://a.example";
    const B: &str = "https://b.example";

    /// A request as the tests below mean it; each overrides what it is about.
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

    /// ⚠ **The upgrade, read and not written.** A file from before accounts has a
    /// list derived for it — its server, then every other origin a device id or a
    /// machine claim names — and the bytes on disk are exactly what they were:
    /// nothing is written at startup.
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

    /// ⚠ **A server that was chosen and never signed in to is not an account.**
    /// Deriving one would open the upgrade on a sign-in form whose only way out is
    /// "Remove account" for an account that never existed; a pending seat keeps
    /// `‹ Server`. The keyring is the evidence that decides, handed in.
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

    /// The first account on a server with nothing in its root takes that root;
    /// the second is a guest, whatever it proves about nothing.
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

    /// ⚠ **Forgetting keeps the root record, so the owner comes back an owner.**
    /// Computing `owner` from what a bind *took* would hand a returning owner a
    /// guest root: a new machine, a spent quota slot and their database orphaned.
    #[test]
    fn a_returning_user_gets_its_root_back() {
        let dir = scratch("return");
        write_server(&dir, A).unwrap();
        assert!(bound(bind_account(&dir, &request(None, "u_a", true, &EMPTY))).owner);
        forget_account(&dir, "https://a.example#u_a").unwrap();
        // The root is no longer empty — the owner's daemon lived there — and
        // nothing was asked: the record alone is the answer.
        let again = bound(bind_account(
            &dir,
            &request(None, "u_a", true, &Evidence::NONE),
        ));
        assert!(again.owner && !again.claimed.root);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A legacy seat whose token's user is proved to own the bare device and the
    /// root: the device id and a file-held key move to the account, it is bound
    /// where the proof says the device is this session's, and the entry is
    /// re-keyed rather than added.
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

    /// ⚠ **Without proof nothing moves**: the account gets a guest root and no
    /// device, and the bare items stay for whoever can prove them. A proof that
    /// could not be reached is marked so the next bootstrap asks again.
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

        // The retry: proved this time, so what was waiting is handed over.
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

    /// ⚠ **A new sign-in beside an unconfirmed legacy entry takes nothing of it**
    /// — not the device, and not an empty root either: the legacy entry's owner may
    /// be the person that root was about to be set up for.
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

    /// Already here is answered, never added twice — with whether it is signed in,
    /// which is the difference between `existing` and `adopted`.
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

    /// ⚠ **An unconfirmed legacy entry's root goes to nobody on a forget** — its
    /// owner was never proved — until somebody proves it.
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

    /// `StoredAccount.rest`, for `Stored.rest`'s reason one level down.
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

    /// Two people on one server are two devices, and neither is the bare,
    /// pre-accounts one.
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

    /// A file written before this field existed, and one somebody edited into
    /// nonsense: both answer "no device" rather than stopping the app.
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
        // And a device can still be added to it, which is the migration.
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

    /// ⚠ **The assertion this file went four releases without.** `device_keys` is
    /// an X25519 private key and `fs::write` created it at `0644`, on exactly the
    /// machines the fallback exists for: a shared host with no unlocked keyring,
    /// which is a host with other people on it. Two docblocks and
    /// `.claude/rules/e2ee.md` said `0600` and nothing asserted it — which is how
    /// prose becomes the only thing holding a private key closed.
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

    /// ⚠ **Both halves of that mode answer `0600` under this machine's umask, so
    /// the test above cannot tell whether either of them is there.** Measured by
    /// deleting each in turn: without `OpenOptions::mode(0o600)` every test in
    /// this file stays green, and without the `set_permissions` on the open
    /// handle they stay green too — at the usual `022`, a creation mode of
    /// `0600` already *is* `0600`.
    ///
    /// The cost of the second one being missing is not a wide file but a narrow
    /// one. `mode()` is masked like every creation mode, so a umask with owner
    /// bits in it lands the key at `0400` under `0277` and at `0000` under
    /// `0677` — and a key file this same user cannot read back on the next
    /// launch is precisely the regenerate-on-every-launch failure
    /// `read_device_key_fallback` exists to prevent, one fresh device row per
    /// launch against an account allowed twenty. `create_dir_all` is masked the
    /// same way, which is the directory's half of it.
    ///
    /// A umask is process-wide and `cargo test` runs these on threads, so it is
    /// set in a **child**: this same binary, re-executed for this one test under
    /// `sh -c 'umask 0277'`. `REEMOAT_TEST_UMASK` is what tells the child it is
    /// the child, and is the whole of the recursion guard.
    ///
    /// ⚠ **The child's exit status alone would be a vacuous pass.** A filter
    /// matching nothing runs zero tests and exits `0`, so renaming this function
    /// and not the literal beside it would leave a green test asserting nothing —
    /// which is the shape this file's own history is made of. What is asserted
    /// is the count in the child's summary.
    #[cfg(unix)]
    #[test]
    fn the_mode_is_not_the_umask_s() {
        const NAME: &str = "config::tests::the_mode_is_not_the_umask_s";

        if std::env::var_os("REEMOAT_TEST_UMASK").is_some() {
            let dir = scratch("umask");
            write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();
            assert_eq!(mode_of(&server_file(&dir)), 0o600, "the file");
            assert_eq!(mode_of(&dir), 0o700, "the directory");
            // The half a mode alone does not say: this same user can still open
            // what was just written, which is what a `0400` or a `0000` costs.
            assert_eq!(
                read_device_key_fallback(&dir, "https://a.example").as_deref(),
                Some("AAAA"),
                "and it is readable by the process that wrote it"
            );
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let exe = std::env::current_exe().expect("a test binary knows its own path");
        // `"$0"` and `"$1"` rather than interpolation: a path with a space in it
        // is the ordinary case on macOS and there is nothing to quote this way.
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

    /// The directory is narrowed **on every write**, not only when it is created.
    ///
    /// `create_dir_all` leaves `0755`, so every installation in the field already
    /// has one — a fix that only set the mode on the creating call would be green
    /// here from an empty directory and would change nothing on any machine that
    /// exists.
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

    /// ⚠ **The upgrade, which is the half a fresh-directory test cannot see.** An
    /// existing `server.json` keeps its `0644` through `fs::write` for ever,
    /// because `fs::write` opens the inode that is there rather than making one.
    /// The rename is what replaces the inode, so the *first write after this
    /// change* is what narrows a machine already in the field — and the contents
    /// it was carrying have to survive that, or the fix is a data loss.
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

    /// A temporary file left behind is a second copy of the private key sitting
    /// beside the first, at whatever mode it was created with, for ever.
    #[test]
    fn nothing_is_left_beside_the_file() {
        let dir = scratch("strays");
        write_server(&dir, "https://a.example").unwrap();
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();
        write_device(&dir, "https://a.example", "dv_aaa").unwrap();

        assert_eq!(strays(&dir), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⚠ **The cleanup on the path where nothing worked, which every successful
    /// write hides.** The test above only ever sees the happy path, and the
    /// temporary is gone there because the rename *consumed* it rather than
    /// because anything removed it — so the three `remove_file` calls on the
    /// failure branches were executed by nothing at all. What one of them leaves
    /// behind is a second copy of an X25519 private key sitting beside the
    /// first — `0600` like the first, so this is not a disclosure, it is a copy
    /// nothing can ever reach: `read_stored` never opens that name again, and
    /// neither statement that gives a key up names a temporary at all —
    /// `erase_device_key_fallback` rewrites `server.json`, `give_up_device_key`
    /// adds a removal of `server.json.unreadable` to it — so a key somebody reset
    /// from the Devices screen would go on existing next to the one that replaced
    /// it.
    ///
    /// The failure is injected by putting a **directory** where the file goes.
    /// POSIX refuses `rename(file, directory)` with `EISDIR` whether or not it
    /// is empty, and that is the one failure this shape can be made to take
    /// without a full disk or a read-only mount.
    ///
    /// ⚠ **That injection depends on a carve-out in `read_stored`, which is what
    /// makes the carve-out load-bearing rather than tidy.** A directory at that
    /// path answers `IsADirectory`, not `NotFound`, so folding it into the
    /// unreadable-file refusal `write_stored` now opens with would return
    /// *before* a temporary file ever existed — and this test would go on passing
    /// while covering a `remove_file` nothing executes. `read_stored` names this
    /// test at the arm for exactly that reason.
    ///
    /// The other half — that the bytes already at the target survive a failed
    /// write — is structural rather than asserted here, and deliberately so:
    /// `rename` is the last statement in `write_stored` and nothing above it
    /// names `target` at all, so every earlier failure returns with the old
    /// file untouched by construction. The test below — the one about truncating
    /// — is what holds that reasoning up.
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

    /// A reader sees the whole old file or the whole new one, never a truncated
    /// one — and this is what tells the two shapes apart.
    ///
    /// A handle opened **before** the write still reads the bytes that were there:
    /// the rename replaced the directory entry and left the old inode alone. Under
    /// `fs::write` that same handle reads the *new* file, and in the window
    /// between its truncate and its write it reads nothing at all — which is the
    /// crash that comes back as a first run: setup screen, fresh key, a brand new
    /// `devices` row spending one of the account's twenty slots.
    ///
    /// ⚠ `#[cfg(unix)]` for the mechanism rather than for the mode: renaming over
    /// a file another handle holds open is a POSIX guarantee and not a Windows
    /// one, so this asserts where it means something.
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

        // And the file at the path is the new one, with both keys in it.
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

    /// ⚠ **The half of that shape that was still a data loss: bytes nothing can
    /// parse used to be indistinguishable from no bytes at all.** `read_stored`
    /// was one `.ok()` chain, so a truncated or hand-edited `server.json` answered
    /// `Default` and the very next write — every writer here being
    /// read-modify-write — renamed a fresh file over it. On a keyring-less host
    /// what went with it was the only copy of the device's X25519 private key, so
    /// the installation came back as a first run and spent another of the
    /// account's twenty device slots.
    ///
    /// The quarantine cannot repair those bytes and does not try. What it buys is
    /// that this app stops being the thing that destroys them, and that a person
    /// has a file to open.
    ///
    /// ⚠ **The mode is asserted against a stated `0644` precondition rather than
    /// against whatever the umask happened to give.** `std::fs::write` creates at
    /// `0666 & !umask`, so on a machine running `umask 0077` the corrupt file
    /// would already be `0600` and the `set_permissions` inside `quarantine` could
    /// be deleted with this test still green — the vacuous shape this file's own
    /// history is made of. Narrowed by hand first, it goes red on every umask.
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

        /*
         * **The first one wins**, and this is the half that fails if the
         * `exists()` guard alone is removed. A second corruption is a copy of
         * whatever the first failure already reduced the file to, so replacing
         * the quarantine with it would throw away the copy most likely to hold a
         * key.
         *
         * ⚠ **And keeping the first is not on its own a licence to destroy the
         * second, which is what this used to assert.** The write was `.unwrap()`ed
         * here: the quarantine slot was taken, nothing at all was preserved, and
         * the next write renamed a fresh file over the *current* bytes — which on
         * a keyring-less host are the only copy of the key in use **now**, while
         * the retained quarantine holds the obsolete one. `quarantine` reports
         * what it preserved and `replaceable` is that report, so a second
         * corruption is the same refusal an unreadable file gets.
         */
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

    /// ⚠ **The fourth state, which had no arm and no errno.** `read_to_string`
    /// runs the UTF-8 check itself, so a `server.json` carrying a byte no UTF-8
    /// sequence has answers `InvalidData` — measured by the precondition below,
    /// `raw_os_error()` of `None` against errno 13, 20 and 2 for the three states
    /// this function's census was built from. It fell past `NotFound` and
    /// `IsADirectory` into the catch-all, which marks the file **unreplaceable for
    /// ever**: the quarantine was never reached, so the bytes were neither moved
    /// aside nor replaced, and every configuration write on that installation was
    /// refused until a person moved the file by hand — `write_server` and
    /// `write_device_key_fallback` on every launch, and `host_device_set` and
    /// `host_device_clear` silently, their caller discarding the rejection.
    ///
    /// HOW IT GOES RED: delete the `ErrorKind::InvalidData` arm and the `unwrap`
    /// below panics with the refusal's own sentence, which is the production
    /// failure exactly.
    #[test]
    fn a_file_that_is_not_utf8_is_moved_aside_rather_than_freezing_every_write() {
        let dir = scratch("notutf8");
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();

        // A lone `0xFF` begins no UTF-8 sequence, which is the ordinary way this
        // arrives: a half-written file, a byte flipped on a dying volume.
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

    /// ⚠ **The quarantine's `rename` can fail, and a failed one used to authorize
    /// the overwrite anyway.** The slot-already-taken half is asserted above; this
    /// is the other one, and it is a different statement — `let _ = fs::rename`,
    /// whose answer was thrown away. That rename needs write permission on the
    /// **directory**, not on the file, so a `0500` `~/.reemoat` with a corrupt
    /// `server.json` in it is a real state: the bytes cannot be moved and, before
    /// this, were replaced regardless.
    ///
    /// HOW IT GOES RED: put the `let _ =` back and the first assertion fails —
    /// `write_device` answers `Ok` — and the last one fails with it, the key
    /// having been renamed away.
    ///
    /// ⚠ **The precondition is checked rather than assumed, because a `0500`
    /// directory stops nobody as root** — the valve `a_file_this_process_cannot_read_is_never_overwritten`
    /// already carries, for the same reason.
    #[cfg(unix)]
    #[test]
    fn a_quarantine_that_cannot_land_does_not_authorize_the_overwrite() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("noquarantine");
        write_device_key_fallback(&dir, "https://a.example", "AAAA").unwrap();
        std::fs::write(server_file(&dir), "{not json").unwrap();

        // No write bit on the directory: the file can still be opened and read,
        // and no entry in it can be created or renamed.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        if std::fs::rename(server_file(&dir), dir.join("probe")).is_ok() {
            // Root, or a filesystem with no modes: there is no failing rename
            // here to assert anything about.
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

    /// ⚠ **A superseded device private key used to be retained for ever.** On a
    /// keyring-less host `device_keys` is the only copy of the installation's
    /// X25519 static, so a quarantined `server.json` can hold a *recoverable* one:
    /// a truncation past the base64 leaves the key legible and the JSON
    /// unparseable, which is the shape reproduced here. Nothing removed it —
    /// `erase_device_key_fallback` and `device::reset_key` rewrite `server.json`
    /// alone — so the Devices screen's **Re-key**, which exists precisely for a
    /// credential store that was reset out from under the app, gave up the keyring
    /// copy and the `server.json` copy and left the quarantined private key on
    /// disk indefinitely.
    ///
    /// This drives `give_up_device_key`, which is the statement `device::reset_key`
    /// reaches — rather than `reset_key` itself, which would write this machine's
    /// real keychain from a test.
    ///
    /// HOW IT GOES RED: drop `discard_quarantine(dir, origin)` and the last
    /// assertion fails; move it above the `?` and the refusal path stops being
    /// covered by `a_file_this_process_cannot_read_is_never_overwritten`.
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

    /// ⚠ **A promotion to the keyring is not a key given up, and it reached the
    /// removal anyway.** `erase_device_key_fallback` carried
    /// `discard_quarantine` for one release under a docblock claiming
    /// *"`device::ensure_key`'s first-use path never comes here"* — which is false:
    /// `ensure_key` → `store_secret` → here runs on **every** keyring-verified
    /// first use. What made it *usually* harmless was the early return, because
    /// `store_secret` is reached only where `read_secret` answered `None` and that
    /// normally means there is no entry to remove.
    ///
    /// **Normally.** `read_secret` also answers `None` for an entry
    /// `device::decode_key` rejects — a value that is not 32 base64url bytes,
    /// reproduced here as the hand-edit it would be. There `remove` answers `Some`,
    /// the early return does not fire, and the quarantine was discarded over a key
    /// nobody gave up, while those very bytes may be the legible copy of it.
    ///
    /// HOW IT GOES RED: put `discard_quarantine(dir, origin)` back on
    /// `erase_device_key_fallback` after its write and the last assertion fails.
    #[test]
    fn a_promotion_to_the_keyring_keeps_the_quarantine() {
        let dir = scratch("promotion");
        let quarantined = quarantine_holding_a_key(&dir, &[("https://a.example", "AAAA")]);
        assert!(quarantined.contains("AAAA"), "the precondition");

        // What `store_secret` finds after `read_secret` answered `None` over an
        // entry the decoder refused: a live entry, and nothing usable in it.
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

    /// ⚠ **Re-key is per origin and the quarantine removal was per *file*.** A
    /// person pressing Re-key for server A is not consenting to lose the last
    /// hand-recoverable copy of their key for server B — and on a keyring-less host
    /// that is exactly what a quarantined `server.json` holding both is. The old
    /// argument for sweeping it said a second server could only lose something
    /// "already superseded, because each origin is regenerated the first time it is
    /// used"; the failure is in *the first time it is used*, which for a server
    /// nobody has opened since the corruption has not happened yet.
    ///
    /// The bytes cannot be edited — serde could not read them, which is why they
    /// are here — but they can be *looked at*, and a server named in them that is
    /// not this one is a refusal.
    ///
    /// HOW IT GOES RED: make `quarantine_is_only_about` answer `true`
    /// unconditionally, or drop the `origin` argument and remove the file the way
    /// the shipped release did, and the last two assertions fail.
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

        /*
         * And the scan is a scan rather than a "more than one origin" count: the
         * *same* single foreign origin is still a refusal, which is the shape a
         * cheaper guard would let through.
         */
        give_up_device_key(&dir, "https://b.example").unwrap();
        assert!(
            unreadable_file(&dir).exists(),
            "a.example is named in there too, and b.example's re-key does not supersede it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⚠ **Per account, and a second account on the same server is "another".**
    /// The token scan reads `https://a.example#u_b` as one token, so the other
    /// account's key is seen for what it is rather than as this server's origin
    /// followed by noise.
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

    /// The owner's Re-key, where the owner inherited the bare key by proof: a
    /// quarantine naming only it and its server's bare origin is superseded.
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

    /// ⚠ **A guest's Re-key keeps a quarantine naming its server bare** — the bare
    /// key in there is somebody's who is not proved to be this account. Fails
    /// closed, which regresses the discard for guests and costs a superseded key at
    /// `0600`, rather than a person's last recoverable copy.
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

    /// The state every test above starts from: a `server.json` truncated *past* the
    /// base64, so serde refuses it and a person can still read the key, moved aside
    /// by the next write. Answers the quarantined bytes.
    fn quarantine_holding_a_key(dir: &Path, keys: &[(&str, &str)]) -> String {
        for (origin, key) in keys {
            write_device_key_fallback(dir, origin, key).unwrap();
        }
        let whole = std::fs::read_to_string(server_file(dir)).unwrap();
        let last = keys.last().expect("at least one key").1;
        let cut = whole.rfind(last).expect("the key is in the file") + last.len();
        std::fs::write(server_file(dir), &whole[..cut]).unwrap();

        // The launch after that corruption: a fresh key is written, and the bytes
        // holding the old one are kept. This is the state the findings are about.
        write_device_key_fallback(dir, keys[0].0, "ZZZZ").unwrap();
        std::fs::read_to_string(unreadable_file(dir)).expect("the bytes were put aside")
    }

    /// ⚠ **A downgrade must not delete data, and without `rest` it silently
    /// did.** Serde ignores unknown keys by default, so a field a *later* build
    /// added parsed fine, never reached `Stored`, and was dropped the first time
    /// an older bundle recorded a device — `device_keys` was exactly that field
    /// one release ago. There is no updater here, so running the older bundle is
    /// somebody double-clicking the other icon.
    ///
    /// The pair of asserts is what stops this passing over a write that did
    /// nothing: the unknown key survived **and** the new device is in the same
    /// bytes. The third says the unknown key was not treated as corruption —
    /// an unrecognised field is not an unparseable file, and quarantining it
    /// would be the data loss arriving through the other door.
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

    /// ⚠ **Two writers, and what they used to lose was a private key.** Every
    /// writer in this file is read-modify-write, and the read and the write are
    /// separated by a serialize, a `create_dir_all`, an open, a write, an `fsync`
    /// and a rename. Interleaved, the second writes a `Stored` built from bytes
    /// the first has already replaced.
    ///
    /// ⚠ **Honest about which direction is a guarantee.** With `CONFIG_LOCK` this
    /// passes *totally*: eight writers are serialized, so eight entries is the
    /// only outcome there is. With the lock removed it fails *probabilistically* —
    /// a window that wide loses entries with very high probability on any machine
    /// and on every run measured, but nothing here can promise it. The reason to
    /// keep it anyway is that the failure it names is the one the unlocked code
    /// actually has, and the passing direction is deterministic; it is not a
    /// coin-flip that could ship green over a defect.
    ///
    /// The comment this replaces claimed Tauri ran these on a pool and therefore
    /// guarded the wrong thing. They ran on the main thread and now carry
    /// `(async)`, so they genuinely do overlap — which is what makes this test
    /// about production rather than about a test harness.
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
        // A non-default port stays, because it is part of which server this is.
        assert_eq!(
            normalize_origin("https://a.example:8443").unwrap(),
            "https://a.example:8443"
        );
        assert_eq!(
            normalize_origin("http://a.example:80").unwrap(),
            "http://a.example"
        );
    }

    /// ⚠ **The half of the quarantine work that was still open: a file that
    /// exists and cannot be *read* is not a file with nothing in it.**
    /// `read_stored` answered `Default` for every `Err` — a mode nobody can open,
    /// an `EIO` on a dying volume, a `~/.reemoat` replaced by a regular file — and
    /// since every writer here is read-modify-write, the next write renamed a
    /// fresh empty file over it. On a keyring-less host those bytes are the only
    /// copy of the device's X25519 private key, so the installation came back as a
    /// first run and spent another of the account's twenty device slots. The
    /// comment above that arm asserted the opposite of what the code did.
    ///
    /// **Two of these go red independently with the fix reverted.** With
    /// `Err(_) => Stored::default()` back, `write_device` answers `Ok` — the first
    /// assertion — and renames a file holding only `dv_new` over the original, so
    /// `AAAA` is gone once the mode is restored — the last two. The middle pair is
    /// about the *choice* rather than the bug: the bytes are not quarantined
    /// either, a read failure being evidence of nothing about them, and nothing at
    /// all is created because the refusal is `write_stored`'s first statement.
    ///
    /// ⚠ **The precondition is checked rather than assumed, because mode `000`
    /// stops nobody as root** — and a test that silently passed over a file it
    /// could still read is exactly the vacuous shape this file has a standing rule
    /// about. Root and a filesystem with no modes are the only two states that
    /// reach the early return; both CI runners are non-root, so it is a valve
    /// rather than the normal path.
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
            // Root, or a filesystem with no modes: there is no unreadable file
            // here to assert anything about.
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

    /// ⚠ **A pair, because either half alone is the shape that cannot fail.**
    ///
    /// The first says `sync_dir` reaches the platform on a real directory and the
    /// platform answers success — measured on macOS, and the reason this is
    /// `#[cfg(unix)]`: on Windows `File::open` carries no
    /// `FILE_FLAG_BACKUP_SEMANTICS`, so the call cannot be reached at all there.
    /// The second says it reports what the platform said about the path it was
    /// *handed*, which is the only one of the two that could catch a body stubbed
    /// to `Ok(())` — and a stub is precisely what the first alone would go on
    /// passing over.
    ///
    /// ⚠ **This is about reachability and never about durability.** Whether an
    /// `fsync` on a directory inode is *effective* has no in-process observable at
    /// all; the only party that can tell is a power cut. Saying so at the test is
    /// the point, because the assertions this repository has shipped that could
    /// not fail were all written as though they measured the thing they were
    /// named after.
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

    /// ⚠ **The property `write_private` lost by copying this file's temporary
    /// name without the counter behind it.**
    ///
    /// `commands.rs` built `{name}.tmp.{pid}`, which was indistinguishable from
    /// this one while its caller could not overlap itself. `host_daemon_start`
    /// carries `(async)` now, so two can be in flight in one process, and both
    /// opens carry `truncate(true)`: a shared temporary path is the second writer
    /// emptying bytes the first has already flushed, and what can land that way
    /// is a `daemon.env` with no `REEMOAT_CONTROL_PLANE`.
    ///
    /// HOW IT GOES RED: with the pid alone, every name is the same string — the
    /// `starts_with` fails on the trailing separator at the first iteration and
    /// the insert is refused at the second. It covers `write_private` as much as
    /// `write_stored` precisely because both now call this one function, which is
    /// the whole reason it is shared rather than copied.
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

    /* ── the theme ────────────────────────────────────────────────────────── */

    /// Light until dark is written, and going back to light takes the key out rather than
    /// writing a second spelling of the default.
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

    /// The page says its theme at every boot. HOW IT GOES RED: without the early return
    /// every call is a rename, which the inode sees — and a first run in light would
    /// create a file it has no reason to.
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

    /// A file from before the field reads as light, and so does one holding anything but
    /// `"dark"` — with the rest of the file intact, not moved aside.
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

    /// A pin is one field of a read-modify-write: accounts, devices, keys and a field from
    /// a later build all survive it, and a file from before accounts is still one after.
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
