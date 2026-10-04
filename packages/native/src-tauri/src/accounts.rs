//! Which account a webview is, and the acts spanning the keyring, `server.json` and
//! `machine.json`. An account is `<origin>#<user id>` (Q1.651); the host decides it, with the
//! user id from `GET /v1/me`. Nothing bare from before accounts is inherited without proof.

use std::path::Path;

use crate::config::{self, Evidence, Proof};
use crate::credential;
use crate::daemon;
use crate::device;
use crate::local;
use crate::proxy;

/// Each account costs a `WebContent` process and maybe a ~136 MB daemon (Q7.148): a laptop's bound, not a product limit.
pub const MAX_ACCOUNTS: usize = 10;

/// `Pending` has no scope, so nothing is read or written for it. `Account.owner` is
/// `roots[origin] == user`, recomputed on every bind, never remembered.
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
    pub fn origin(&self) -> Option<&str> {
        match self {
            Slot::Pending { origin } => origin.as_deref(),
            Slot::Legacy { origin } | Slot::Account { origin, .. } => Some(origin),
        }
    }

    /// An account scope always carries `#` and a normalized origin never does, so a legacy
    /// scope can never equal an account's.
    pub fn scope(&self) -> Option<String> {
        match self {
            Slot::Pending { .. } => None,
            Slot::Legacy { origin } => Some(origin.clone()),
            Slot::Account { origin, user, .. } => Some(scope_of(origin, user)),
        }
    }

    /// The owner and a legacy seat share the server's own root; every other account gets
    /// `servers/<slug>@<user id>`, never the legacy root (Q7.149).
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

pub fn scope_of(origin: &str, user: &str) -> String {
    format!("{origin}#{user}")
}

/// Keeps the scope, the keyring account and the guest root's folder name injective: no `#`, `@`,
/// or anything that walks a path. Refuses nothing the control plane mints.
pub fn is_user_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 64
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A drawer label only, never compared: the user id is what identifies.
pub fn clamp_name(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(128)
        .collect::<String>()
        .trim()
        .to_string()
}

pub struct Me {
    pub id: String,
    pub name: String,
}

/// Every `Err` means "adopt nothing": a transport failure, a 401 and an unusable id alike.
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

/// The proofs, gathered before any lock is held. `Unreachable` binds without the item and is
/// asked again next bootstrap. A non-legacy sign-in leaves the bare device to an unconfirmed
/// legacy entry's own confirm: they may be different people.
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

    // "Could not tell" is not empty, and a bare claim counts as occupied.
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
            // A root whose file names this server may not have announced yet.
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

/// Owned, not merely listed: a guest's grant is not ownership of the root.
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

/// Retired rows count: a retired device is still that person's.
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

/// `Move` is the bare legacy credential, written, read back, and only then erased.
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

pub enum Binding {
    Bound(Slot),
    /// Not `adopted`: the caller revokes the token, a second session nobody holds.
    Existing {
        key: String,
        adopted: bool,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    New,
    Same,
    Existing { key: String, signed_in: bool },
    Refused,
}

/// Pure. `bound` is `New` or `Same`, `adopted` is `Existing` signed out, `existing` signed in.
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

/// Every keyring act happens outside `CONFIG_LOCK`, and nothing bare is erased before its
/// verified copy has landed. The caller holds `Host::changing`, which makes `decide` and the
/// insert one decision.
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
        // Not recorded as bound: that account's session never listed the device.
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
            // A writer outside this process, since `decide` ran under the same `changing`.
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
        let _ = credential::erase(&origin);
    }
    Ok(Binding::Bound(Slot::Account {
        origin,
        user: user.to_string(),
        owner: bound.owner,
    }))
}

/// After `server.json`'s record, never before, and each erase only after its copy is verified.
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
        assert_eq!(
            decide(
                &pending,
                "u_a",
                &roster_with(vec![account("https://b.example", Some("u_a"), true)])
            ),
            Decision::New
        );
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
