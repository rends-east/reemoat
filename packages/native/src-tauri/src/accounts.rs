//! Which account a webview is, and the acts that span the keyring, `server.json`
//! and `machine.json` at once.
//!
//! **An account is a (normalized origin, control-plane user id) pair**, and its
//! key is `<origin>#<user id>`. That key is the keyring scope
//! (`credential#<origin>#<user id>`, `device_key#<origin>#<user id>` — the
//! extension `credential::account_for`'s docblock reserved), the key of
//! `server.json`'s `devices` and `device_keys` maps and of `machine.json`'s
//! claims. Q1.651.
//!
//! ⚠ **The host decides which account a webview is, never the page.** A command
//! resolves its account from the calling webview's label and the per-document
//! generation it presents (`commands.rs`), and the user id comes from the control
//! plane's own `GET /v1/me`, asked by this process with the token it was handed —
//! so a page that is wrong, or hostile, cannot file one person's token under
//! another person's name. Nothing here takes an account from the page except
//! `host_account_switch`'s choice among the keys `host_accounts` listed.
//!
//! **Nothing is inherited without proof.** What an installation from before
//! accounts held under the bare origin — its credential, its device id and key,
//! its machine claim and the per-server daemon root — belonged to *somebody*, and
//! the first launch after the update does not know who. `GET /v1/me` names the
//! credential's owner, `GET /v1/me/devices` proves the device, and
//! `GET /v1/machines` proves the root: its claimed or announced machine id is one
//! that user owns. Without a proof an account gets a fresh key, a fresh device and
//! a root of its own, and the bare items are left for whoever can prove them.

use std::path::Path;

use crate::config::{self, Evidence, Proof};
use crate::credential;
use crate::daemon;
use crate::device;
use crate::local;
use crate::proxy;

/// The most accounts one installation holds.
///
/// ⚠ **Every account costs a webview and, where it is set up, a daemon**: on
/// macOS a hidden `WebContent` process each, and a daemon measured at about
/// 136 MB (Q7.148's measurement) per root. Ten is a bound on what a laptop is
/// asked to keep alive rather than a product limit anybody asked for. It is a
/// `usize` rather than an `&str`, so `credential.rs`'s set of two `pub const &str`
/// secrets — which `webcheck.devices.ts` counts — is untouched.
pub const MAX_ACCOUNTS: usize = 10;

/// What a webview is bound to in the host.
///
/// - **`Pending`** — somebody signing in to an account this installation does
///   not have yet. It has no scope, so nothing is read or written for it; its
///   `origin` is the server chosen so far, if any.
/// - **`Legacy`** — a sign-in from before accounts existed, still under the bare
///   origin because nothing has proved whose it is. Its scope is that origin.
/// - **`Account`** — `owner` is whether this user holds that server's own daemon
///   root (`server.json`'s `roots`), which is recomputed on every bind rather
///   than remembered: `owner := roots[origin] == user`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Slot {
    Pending {
        origin: Option<String>,
    },
    Legacy {
        origin: String,
    },
    Account {
        origin: String,
        user: String,
        owner: bool,
    },
}

impl Slot {
    /// The server this slot is about, if one has been chosen.
    pub fn origin(&self) -> Option<&str> {
        match self {
            Slot::Pending { origin } => origin.as_deref(),
            Slot::Legacy { origin } | Slot::Account { origin, .. } => Some(origin),
        }
    }

    /// The keyring and `server.json` scope — and the account's key.
    ///
    /// ⚠ **An account scope always carries `#`, and a normalized origin never
    /// does**, which is what keeps a legacy entry's bare origin from ever being
    /// read as an account's, and one account's from ever being another's: the
    /// user id is refused by {@link is_user_id} if it could carry a `#` of its own.
    pub fn scope(&self) -> Option<String> {
        match self {
            Slot::Pending { .. } => None,
            Slot::Legacy { origin } => Some(origin.clone()),
            Slot::Account { origin, user, .. } => Some(scope_of(origin, user)),
        }
    }

    /// Which daemon root this slot's machine lives in, or `None` for a sign-in
    /// with no account yet.
    ///
    /// **The server's owner keeps the root `state_root` gives that server** —
    /// the install.sh-compatible `~/.reemoat` where it is theirs — and so does a
    /// legacy seat, which is exactly what it had before accounts. **Every other
    /// account gets a root of its own**, `servers/<slug>@<user id>`, which is never
    /// the legacy root. `holder` is `server.json`'s record of which origin holds
    /// `~/.reemoat` (`daemon::owner_root` has why it is consulted).
    pub fn root(&self, home: &Path, holder: Option<&str>) -> Option<daemon::StateRoot> {
        match self {
            Slot::Pending { .. } => None,
            Slot::Legacy { origin }
            | Slot::Account {
                origin,
                owner: true,
                ..
            } => Some(daemon::owner_root(home, origin, holder)),
            Slot::Account {
                origin,
                user,
                owner: false,
            } => Some(daemon::guest_root(home, origin, user)),
        }
    }

    /// The slot a stored account opens as.
    pub fn from_account(account: &config::Account, roots: &config::Roots) -> Slot {
        match &account.user {
            None => Slot::Legacy {
                origin: account.origin.clone(),
            },
            Some(user) => Slot::Account {
                origin: account.origin.clone(),
                user: user.clone(),
                owner: roots.get(&account.origin).map(String::as_str) == Some(user.as_str()),
            },
        }
    }
}

/// `<origin>#<user id>`.
pub fn scope_of(origin: &str, user: &str) -> String {
    format!("{origin}#{user}")
}

/// Whether a user id may become part of a key, a keyring account and a folder
/// name: 1 to 64 bytes of `[A-Za-z0-9_-]`.
///
/// The control plane's ids are `u_` and sixteen hex digits (`keys.ts`), so this
/// refuses nothing it mints. What it refuses is everything that would stop the
/// three names built from it being **injective**: `#` (a second scope
/// delimiter), `@` (the guest root's `<slug>@<user id>`), and `/`, `.`, `:` and
/// `\`, any of which could walk a path or collide a slug.
pub fn is_user_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 64
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A cached account name: at most 128 characters, with control characters taken
/// out.
///
/// It is a label for the drawer and never a path, a key or anything compared —
/// the user id is what identifies. 128 is the control plane's own clamp for a
/// device name (`cp-devices.md`); a login name is 64 there, so this never cuts a
/// real one.
pub fn clamp_name(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(128)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Who a token belongs to, as the control plane answers `GET /v1/me`.
pub struct Me {
    pub id: String,
    pub name: String,
}

/// Ask the control plane whose token this is — with that token, at the seat's own
/// origin, from this process.
///
/// ⚠ **An `Err` for anything but a 2xx carrying a user id this host can use**, and
/// the caller treats every `Err` as "adopt nothing": a transport failure, a `401`
/// and an answer whose `id` could escape a key are all the same refusal. The page
/// then fails the sign-in rather than holding a token nobody identified.
pub async fn me(client: &reqwest::Client, origin: &str, token: &str) -> Result<Me, String> {
    let body = proxy::get_json(client, origin, "/v1/me", token).await?;
    let id = body
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "the server did not say whose sign-in this is".to_string())?;
    if !is_user_id(id) {
        return Err("the server named an account this app cannot keep".into());
    }
    let name = body
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    Ok(Me {
        id: id.to_string(),
        name: clamp_name(name),
    })
}

/// What the bare items on an origin would take to inherit, gathered before any
/// lock is held.
///
/// ⚠ **The requests are made here, with the credential being bound, to the
/// seat's own origin** — `GET /v1/machines` for the root and `GET /v1/me/devices`
/// for the device — and only where something bare could be inherited at all. A
/// proof that could not be reached is `Unreachable` rather than a refusal, so the
/// account binds without it and `Boot.legacy` asks again at the next bootstrap.
///
/// `from_legacy` is whether the binding seat was a legacy one. A new sign-in on
/// a server that still has an unconfirmed legacy entry leaves the bare device to
/// that entry's own confirm, since the two may be different people.
pub async fn gather(
    client: &reqwest::Client,
    dir: &Path,
    home: Option<&Path>,
    holder: Option<&str>,
    origin: &str,
    token: &str,
    from_legacy: bool,
) -> Evidence {
    let roster = config::read_accounts(dir, &|_| false);
    let record = roster.roots.get(origin).cloned();
    let bare_claim = daemon::read_claim(dir, origin);

    /*
     * ⚠ **"Empty" is about the disk, and "could not tell" is not empty** —
     * `daemon::holds_no_daemon`'s rule. A bare claim counts as occupied too: a
     * machine was bought for that root even if nothing was written there yet.
     */
    let (root_empty, root_here, announced) = match home {
        Some(home) => {
            let per_server = daemon::owner_root(home, origin, holder);
            (
                daemon::holds_no_daemon(&per_server.dir) && bare_claim.is_none(),
                daemon::config_state(&per_server.dir, Some(origin)) == daemon::CONFIG_HERE,
                local::read_announced(&per_server.dir).map(|found| found.daemon.machine_id),
            )
        }
        None => (true, false, None),
    };

    let settled = matches!(record.as_deref(), Some(owner) if !owner.is_empty());
    let root = if settled || root_empty {
        Proof::NotAsked
    } else {
        let ids: Vec<String> = bare_claim.iter().chain(announced.iter()).cloned().collect();
        if ids.is_empty() {
            // Nothing to present. A root whose file names this server may simply
            // not have announced yet, which is worth asking again; anything else
            // has nothing this user could ever prove.
            if root_here {
                Proof::Unreachable
            } else {
                Proof::Disproven
            }
        } else {
            match owned_machines(client, origin, token).await {
                Ok(owned) if ids.iter().any(|id| owned.contains(id)) => Proof::Proven,
                Ok(_) => Proof::Disproven,
                Err(_) => Proof::Unreachable,
            }
        }
    };

    let bare_device = config::read_device(dir, origin);
    let legacy_waits = roster
        .accounts
        .iter()
        .any(|account| account.user.is_none() && account.origin == origin);
    let (device, device_current) = match bare_device {
        Some(id) if from_legacy || !legacy_waits => match devices(client, origin, token).await {
            Ok(listed) => match listed.iter().find(|(listed, _)| *listed == id) {
                Some((_, current)) => (Proof::Proven, *current),
                None => (Proof::Disproven, false),
            },
            Err(_) => (Proof::Unreachable, false),
        },
        _ => (Proof::NotAsked, false),
    };

    Evidence {
        root_empty,
        root,
        device,
        device_current,
    }
}

/// The machines this token's user **owns**, by id.
///
/// Owned rather than merely listed: `GET /v1/machines` also lists machines
/// somebody else shared, and a grant on the owner's machine is not ownership of
/// its database — a guest holding one would otherwise take the root.
async fn owned_machines(
    client: &reqwest::Client,
    origin: &str,
    token: &str,
) -> Result<Vec<String>, String> {
    let body = proxy::get_json(client, origin, "/v1/machines", token).await?;
    let listed = body
        .get("machines")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "the server listed no machines".to_string())?;
    Ok(listed
        .iter()
        .filter(|row| row.get("owned").and_then(|value| value.as_bool()) == Some(true))
        .filter_map(|row| row.get("id").and_then(|value| value.as_str()))
        .map(str::to_string)
        .collect())
}

/// The devices this token's user has registered, each with whether it is the one
/// bound to *this* session.
///
/// Retired rows are listed too, and count: the question is whose device the id
/// is, and a retired one is still that person's.
async fn devices(
    client: &reqwest::Client,
    origin: &str,
    token: &str,
) -> Result<Vec<(String, bool)>, String> {
    let body = proxy::get_json(client, origin, "/v1/me/devices", token).await?;
    let listed = body
        .get("devices")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "the server listed no devices".to_string())?;
    Ok(listed
        .iter()
        .filter_map(|row| {
            let id = row.get("id").and_then(|value| value.as_str())?;
            let current = row.get("current").and_then(|value| value.as_bool()) == Some(true);
            Some((id.to_string(), current))
        })
        .collect())
}

/// Where a token came from.
///
/// - **`Move`** — the bare legacy credential, being attributed to the user
///   `GET /v1/me` named. It is written to the account's scope, **read back**,
///   and only then is the bare entry erased: a crash between the two leaves a
///   stale bare copy and loses nothing.
/// - **`Fresh`** — a sign-in that just happened on this seat.
pub enum Token<'a> {
    Move(&'a str),
    Fresh(&'a str),
}

impl Token<'_> {
    fn value(&self) -> &str {
        match self {
            Token::Move(value) | Token::Fresh(value) => value,
        }
    }
}

/// What a bind came to.
pub enum Binding {
    /// This seat is now that account.
    Bound(Slot),
    /// The account is already on this computer, under `key`. `adopted` is whether
    /// the token was written into it because it was signed out — otherwise the
    /// caller revokes the token, which is a second session nobody holds.
    Existing { key: String, adopted: bool },
}

/// What the page is told about a sign-in against the account it was already, or
/// against somebody else's signed-out place.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// A pending or legacy seat, and nobody by that name is here yet.
    New,
    /// The seat's own account, signed in again.
    Same,
    /// That account is already on this computer.
    Existing { key: String, signed_in: bool },
    /// A signed-out account's seat, and a different person signed in on it.
    Refused,
}

/// The one decision about a verified sign-in, before anything is written.
///
/// Pure, so the four outcomes are testable without a keyring: `bound` is `New` or
/// `Same`, `adopted` is `Existing` with `signed_in == false`, `existing` is
/// `Existing` signed in, and `refused` is `Refused`.
pub fn decide(slot: &Slot, user: &str, roster: &config::Roster) -> Decision {
    if let Slot::Account { user: own, .. } = slot {
        return if own == user {
            Decision::Same
        } else {
            Decision::Refused
        };
    }
    let Some(origin) = slot.origin() else {
        return Decision::New;
    };
    match roster
        .accounts
        .iter()
        .find(|account| account.origin == origin && account.user.as_deref() == Some(user))
    {
        Some(found) => Decision::Existing {
            key: found.key(),
            signed_in: found.signed_in,
        },
        None => Decision::New,
    }
}

/// Bind a verified sign-in to a pending or legacy seat, or find it already here.
///
/// **The one orchestration behind `host_credential_set` (`Fresh`) and a legacy
/// `host_account_confirm` (`Move`)**, and its order is the whole point: every
/// keyring act happens outside `CONFIG_LOCK`, and nothing is erased before a
/// verified copy has landed.
///
/// 1. `Existing`: the account is here. What the proofs in `evidence` allow is
///    handed to *it* (`config::claim_bare`), and a token is written into it only
///    where it is signed out — otherwise nothing is written and the caller revokes.
/// 2. `Move` only: the token is written to the account's scope and read back.
/// 3. `config::bind_account`, one read-modify-write that re-keys the legacy entry
///    or adds one, and takes the root and the device where `evidence` proves them.
/// 4. `Fresh` only: the token is written, and a failure is ignored — that is the
///    `durable: false` state, which the page already draws a sentence for.
/// 5. A taken root takes the bare machine claim with it; a taken device copies the
///    keyring's key (`device::copy_key`, **a proven move only**).
/// 6. Only now is anything bare erased: the credential, and the device key where
///    the copy landed.
///
/// The caller holds `Host::changing`, which is what makes the `Existing` check in
/// step 1 and the insert in step 3 one decision.
pub fn bind(
    dir: &Path,
    slot: &Slot,
    user: &str,
    name: &str,
    token: Token<'_>,
    evidence: &Evidence,
) -> Result<Binding, String> {
    let (origin, from) = match slot {
        Slot::Pending {
            origin: Some(origin),
        } => (origin.clone(), None),
        Slot::Legacy { origin } => (origin.clone(), Some(origin.clone())),
        Slot::Pending { origin: None } => {
            return Err("pending_seat: no server has been chosen".into())
        }
        Slot::Account { .. } => return Err("this seat is already an account".into()),
    };
    let scope = scope_of(&origin, user);
    let roster = config::read_accounts(dir, &|_| false);

    if let Decision::Existing { key, signed_in } = decide(slot, user, &roster) {
        // The device moves into an account whose own session never listed it, so
        // it is not recorded as bound: the page registers it against that session.
        let claimed = config::claim_bare(dir, &key, from.as_deref(), evidence, false)?;
        follow_claim(dir, &origin, &key, &claimed);
        let adopted = !signed_in
            && credential::write(&key, token.value()).is_ok()
            && credential::read(&key).as_deref() == Some(token.value());
        if adopted {
            config::set_signed_in(dir, &key, true)?;
            config::set_bound(dir, &key, false)?;
            if matches!(token, Token::Move(_)) {
                let _ = credential::erase(&origin);
            }
        }
        return Ok(Binding::Existing { key, adopted });
    }

    if let Token::Move(value) = token {
        if credential::write(&scope, value).is_err()
            || credential::read(&scope).as_deref() != Some(value)
        {
            let _ = credential::erase(&scope);
            return Err(
                "the sign-in could not be moved to its account, so it was left where it was".into(),
            );
        }
    }

    let bound = match config::bind_account(
        dir,
        &config::BindRequest {
            from: from.as_deref(),
            origin: &origin,
            user,
            name,
            fresh: matches!(token, Token::Fresh(_)),
            evidence,
        },
    ) {
        Ok(config::Bind::Bound(bound)) => bound,
        Ok(config::Bind::Existing { .. }) => {
            // `decide` above said otherwise under the same `changing`, so this is
            // a second writer outside this process. Nothing of ours to undo but
            // the copy step 2 made.
            if matches!(token, Token::Move(_)) {
                let _ = credential::erase(&scope);
            }
            return Err("that account appeared on this computer while it was being added".into());
        }
        Err(e) => {
            if matches!(token, Token::Move(_)) {
                let _ = credential::erase(&scope);
            }
            return Err(e);
        }
    };

    if let Token::Fresh(value) = token {
        let _ = credential::write(&scope, value);
    }
    follow_claim(dir, &origin, &scope, &bound.claimed);
    if from.is_some() {
        // The legacy seat's own entry: moved above for `Move`, and superseded by
        // a fresh sign-in for `Fresh`. Either way nothing reads it again.
        let _ = credential::erase(&origin);
    }
    Ok(Binding::Bound(Slot::Account {
        origin,
        user: user.to_string(),
        owner: bound.owner,
    }))
}

/// The keyring and `machine.json` halves of what `server.json` just recorded as
/// inherited.
///
/// ⚠ **After the record, never before**, and each erase only after its copy is
/// verified: a crash here leaves a bare copy beside the new one, which the next
/// proof finds and moves again, rather than neither.
pub fn follow_claim(dir: &Path, origin: &str, scope: &str, claimed: &config::Claimed) {
    if claimed.root {
        let _ = daemon::move_claim(dir, origin, scope);
    }
    if claimed.device && matches!(device::copy_key(origin, scope), Ok(true)) {
        let _ = credential::erase_device_key(origin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_is_the_origin_and_the_user() {
        let slot = Slot::Account {
            origin: "https://a.example".into(),
            user: "u_0123456789abcdef".into(),
            owner: false,
        };
        assert_eq!(
            slot.scope().as_deref(),
            Some("https://a.example#u_0123456789abcdef")
        );
        assert_eq!(slot.origin(), Some("https://a.example"));
        assert_eq!(Slot::Pending { origin: None }.scope(), None);
        assert_eq!(
            Slot::Pending {
                origin: Some("https://a.example".into())
            }
            .scope(),
            None,
            "a sign-in with no account has nothing to read or write"
        );
    }

    /// ⚠ **The property the whole key shape rests on.** A legacy entry's scope is
    /// the bare origin, and it must never be equal to an account's — or a legacy
    /// confirm could read one person's credential as another's.
    #[test]
    fn a_legacy_scope_is_the_origin_alone_and_cannot_equal_an_account_scope() {
        let origin = crate::config::normalize_origin("https://a.example").unwrap();
        let legacy = Slot::Legacy {
            origin: origin.clone(),
        };
        assert_eq!(legacy.scope().as_deref(), Some("https://a.example"));
        assert!(!origin.contains('#'), "a normalized origin never carries #");
        for user in ["u_1", "u_2", "a"] {
            let account = scope_of(&origin, user);
            assert!(account.contains('#'));
            assert_ne!(Some(account), legacy.scope());
        }
        // The durability probe's scope is neither: it has no scheme at all.
        assert!(!"probe.invalid".contains("://"));
    }

    #[test]
    fn a_user_id_that_could_escape_is_refused() {
        for bad in [
            "",
            "u#1",
            "u@1",
            "../u",
            "a:b",
            "a/b",
            "a.b",
            "a\\b",
            "u 1",
            &"a".repeat(65),
        ] {
            assert!(!is_user_id(bad), "{bad:?} must be refused");
        }
        for good in ["u_0123456789abcdef", "u-1", "A", &"a".repeat(64)] {
            assert!(is_user_id(good), "{good:?} must be accepted");
        }
    }

    #[test]
    fn a_name_is_clamped() {
        assert_eq!(clamp_name("  ada  "), "ada");
        assert_eq!(clamp_name("a\u{0}d\na\u{7}"), "ada");
        assert_eq!(clamp_name(&"x".repeat(300)).chars().count(), 128);
        assert_eq!(clamp_name("ümlaut"), "ümlaut");
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("reemoat-acct-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".reemoat")).unwrap();
        dir
    }

    /// The three root arms, written out: a pending seat has none, a legacy seat
    /// and the server's owner share the server's own root, and anybody else has a
    /// root of their own that is never `~/.reemoat`.
    #[test]
    fn each_kind_of_seat_gets_the_root_the_rule_gives_it() {
        let home = scratch("roots");
        let origin = "https://a.example";
        assert_eq!(Slot::Pending { origin: None }.root(&home, None), None);
        assert_eq!(
            Slot::Pending {
                origin: Some(origin.into())
            }
            .root(&home, None),
            None
        );
        let legacy = Slot::Legacy {
            origin: origin.into(),
        }
        .root(&home, None)
        .unwrap();
        let owner = Slot::Account {
            origin: origin.into(),
            user: "u_a".into(),
            owner: true,
        }
        .root(&home, None)
        .unwrap();
        assert_eq!(
            legacy, owner,
            "the legacy seat and the owner share one root"
        );
        assert_eq!(legacy, daemon::state_root(&home, origin));
        assert!(legacy.legacy, "on an empty computer that is ~/.reemoat");

        let guest = Slot::Account {
            origin: origin.into(),
            user: "u_b".into(),
            owner: false,
        }
        .root(&home, None)
        .unwrap();
        assert!(!guest.legacy);
        assert_ne!(guest.dir, legacy.dir);
        assert!(guest.dir.ends_with("servers/https_a.example@u_b"));
        let _ = std::fs::remove_dir_all(&home);
    }

    fn roster_with(accounts: Vec<config::Account>) -> config::Roster {
        config::Roster {
            accounts,
            ..Default::default()
        }
    }

    fn account(origin: &str, user: Option<&str>, signed_in: bool) -> config::Account {
        config::Account {
            origin: origin.into(),
            user: user.map(str::to_string),
            name: None,
            bound: false,
            signed_in,
            seen: 1,
            pending_proof: false,
        }
    }

    /// The four answers a verified sign-in can get, decided before anything is
    /// written. `adopted` and `existing` differ only in whether the account
    /// already here is signed in; `refused` is the one that would otherwise put a
    /// second person's session in a signed-out account's place.
    #[test]
    fn a_sign_in_is_bound_adopted_existing_or_refused() {
        let origin = "https://a.example";
        let pending = Slot::Pending {
            origin: Some(origin.into()),
        };
        assert_eq!(decide(&pending, "u_a", &roster_with(vec![])), Decision::New);
        assert_eq!(
            decide(
                &pending,
                "u_a",
                &roster_with(vec![account(origin, Some("u_a"), false)])
            ),
            Decision::Existing {
                key: "https://a.example#u_a".into(),
                signed_in: false
            },
            "adopted: here and signed out"
        );
        assert_eq!(
            decide(
                &pending,
                "u_a",
                &roster_with(vec![account(origin, Some("u_a"), true)])
            ),
            Decision::Existing {
                key: "https://a.example#u_a".into(),
                signed_in: true
            },
            "existing: here and signed in"
        );
        // The same user on another server is another account.
        assert_eq!(
            decide(
                &pending,
                "u_a",
                &roster_with(vec![account("https://b.example", Some("u_a"), true)])
            ),
            Decision::New
        );
        // A legacy entry has no user yet, so it is never the account found here.
        assert_eq!(
            decide(
                &Slot::Legacy {
                    origin: origin.into()
                },
                "u_a",
                &roster_with(vec![account(origin, None, true)])
            ),
            Decision::New
        );
        let seat = Slot::Account {
            origin: origin.into(),
            user: "u_a".into(),
            owner: true,
        };
        let roster = roster_with(vec![account(origin, Some("u_a"), false)]);
        assert_eq!(decide(&seat, "u_a", &roster), Decision::Same, "bound");
        assert_eq!(decide(&seat, "u_b", &roster), Decision::Refused, "refused");
    }
}
