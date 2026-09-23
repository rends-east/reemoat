//! Where a daemon on *this computer* is listening, if one has said so.
//!
//! The file is written by `src/announce.ts` in the daemon, into its own `0700`
//! state root — `~/.reemoat`, or `~/.reemoat/servers/<server>/` for a daemon this
//! app runs for a second server (`daemon::state_root`, Q7.148) — and that
//! ownership is the whole of the security argument: the app
//! has to carry a machine token to prove anything to a daemon, and a token handed
//! to the wrong listener is a 300-second bearer spendable through the relay from
//! anywhere. Probing a well-known port would hand one to whichever process won the
//! race for it. A file in a directory only the daemon's own user can write cannot
//! be planted by another user on a shared host.
//!
//! **Loopback is enforced here rather than in the page**, for the reason `proxy.rs`
//! enforces the control-plane origin here: a rule the webview cannot reach is a
//! rule a page that renders agent output cannot be talked into breaking. The page
//! receives a finished origin and never the parts it was built from.
//!
//! What this is *not* is a credential. Every field is either public — the port,
//! visible to anything on the host with `lsof` — or already sitting in the
//! `reemoat.db` beside it, which this uid can read and which holds the machine
//! id, the signing keys and every transcript. Nothing here is new authority; it is
//! a statement about which of the things this user already has is listening where.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The only version this reads. A later daemon bumping it reads as "no local
/// daemon", which degrades to the relay — the same answer as a daemon that is not
/// running, and the one this client already handles everywhere.
const ANNOUNCE_VERSION: u32 = 1;

/// The two addresses a daemon may announce, and there is no third.
///
/// Not `localhost`: that is a *name*, resolved by whatever the host's resolver
/// says, and a name that can be pointed elsewhere is exactly what "loopback only"
/// exists to refuse. `src/announce.ts`'s writer never produces one — `localAddress`
/// in `scripts/daemon.ts` maps a wildcard bind to a literal — so refusing it costs
/// nothing and closes the case where somebody edits the file by hand.
const LOOPBACK: [&str; 2] = ["127.0.0.1", "::1"];

/// The file as written. Field names are the JSON's, spelled out.
///
/// ⚠ **The shape is written down twice** — here and as `LocalAnnounce` in
/// `src/announce.ts`, its only writer. A field renamed on one side is a local
/// route that stops being offered with no error anywhere, so `nativecheck` reads
/// both off disk and asserts the key sets match. `#[serde(rename)]` rather than
/// `rename_all`, so each name is a literal a driver can find.
#[derive(Deserialize)]
struct Stored {
    v: u32,
    #[serde(rename = "machineId")]
    machine_id: String,
    host: String,
    port: u32,
    #[serde(rename = "instanceId")]
    instance_id: String,
    #[serde(rename = "authMode")]
    auth_mode: String,
    /// The control plane the daemon enrolled with, as it wrote it.
    ///
    /// ⚠ **`default` on its own line, and both halves of that are load-bearing.**
    /// The default is what lets a file from a daemon older than this field — no such
    /// key — parse exactly as it did; the separate line is what `nativecheck`'s
    /// census reads past, since it takes a `rename` only when it is the whole
    /// attribute.
    #[serde(default)]
    #[serde(rename = "controlPlane")]
    control_plane: Option<String>,
}

/// What the page is told, and it is deliberately less than the file holds.
///
/// A finished `base` rather than a host and a port, so nothing in the webview ever
/// composes an address for a request that carries the fleet's credential. The
/// machine id is here because the client has to check it against the machine it
/// wants before it spends a token; `instanceId` is here because `GET /health`
/// answers the same value and a client can tell a restart from a reconnect.
#[derive(Serialize)]
pub struct LocalDaemon {
    #[serde(rename = "machineId")]
    pub machine_id: String,
    pub base: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
}

/// What the file says, with the one field the page is never handed.
///
/// ⚠ **The control plane stays on this side of the bridge**, for the reason
/// `daemon::config_state` answers a word rather than handing the page the env
/// file: deciding whether a daemon belongs to *this* server means comparing
/// origins, and the origin is something only the host knows. So `LocalDaemon`
/// keeps its three fields and `host_daemon_state` asks
/// [`Announced::for_another_server`] instead.
pub struct Announced {
    pub daemon: LocalDaemon,
    control_plane: Option<String>,
}

impl Announced {
    /// Whether the daemon says it enrolled with a control plane other than
    /// `origin` — a canonical origin, `host.origin()`.
    ///
    /// ⚠ **Why a shared root needs asking.** `~/.reemoat` is the root of every
    /// daemon started without `REEMOAT_HOME`, and the announcement there is
    /// last-writer-wins, so the daemon in the root this app gives a server can be
    /// a `pnpm daemon` from a checkout enrolled somewhere else entirely. Its
    /// machine id is in no list this account has, and without this the page told
    /// somebody a daemon *for this server* was running as a machine they could not
    /// see.
    ///
    /// Both sides through `normalize_origin`, so a trailing slash or a default
    /// port is not a stranger. **A value that does not parse is one**, for
    /// `config_state`'s reason — "I could not read it" is not evidence that it is
    /// this server's — and the cost of that direction is a silence where a
    /// sentence might have been true. **No value at all is not one**: a daemon
    /// older than the field is taken at its root's word, as every file was before
    /// it existed.
    pub fn for_another_server(&self, origin: &str) -> bool {
        match self.control_plane.as_deref() {
            None => false,
            Some(raw) => !crate::config::normalize_origin(raw).is_ok_and(|named| named == origin),
        }
    }
}

/// `<root>/daemon.json`, for a state root `daemon::announce_roots` names.
///
/// A root rather than a home, because there is one announcement per root now and
/// the caller is the one that knows which it is asking about — this module still
/// answers only *is there a daemon here*, for one directory at a time.
pub fn announce_path(root: &Path) -> PathBuf {
    root.join("daemon.json")
}

/// Read it, or answer `None`.
///
/// **Every failure is `None` and none of them is an error.** No file is the
/// ordinary case — no daemon here, or one running under `shared_secret`, which
/// announces nothing. A malformed file, an unknown version, a non-loopback host,
/// an impossible port and an `authMode` that cannot accept a control-plane token
/// are all the same answer to the only question the caller has, which is *"is
/// there a daemon here worth showing a token to?"*. Reporting them separately
/// would put a diagnostic on a path whose correct behaviour is silence.
pub fn read(root: &Path) -> Option<LocalDaemon> {
    read_announced(root).map(|found| found.daemon)
}

/// [`read`], keeping the control plane for the host's own comparison.
///
/// Every refusal is `read`'s — this is the same function with one more field kept
/// — so a file one of them declines is a file both decline.
pub fn read_announced(root: &Path) -> Option<Announced> {
    let raw = std::fs::read_to_string(announce_path(root)).ok()?;
    let stored: Stored = serde_json::from_str(&raw).ok()?;
    if stored.v != ANNOUNCE_VERSION {
        return None;
    }
    if stored.machine_id.is_empty() || stored.instance_id.is_empty() {
        return None;
    }
    // Only the two modes that verify a control-plane token at all. A
    // `shared_secret` daemon would refuse every request this client could make,
    // so offering it as a route is offering a screen full of refusals.
    if stored.auth_mode != "signed" && stored.auth_mode != "both" {
        return None;
    }
    if stored.port == 0 || stored.port > 65535 {
        return None;
    }
    if !LOOPBACK.contains(&stored.host.as_str()) {
        return None;
    }
    // `[::1]` bracketed, because an IPv6 literal in an authority is ambiguous
    // without it — `http://::1:7887` parses with 7887 as part of the address.
    let host = if stored.host.contains(':') {
        format!("[{}]", stored.host)
    } else {
        stored.host.clone()
    };
    Some(Announced {
        daemon: LocalDaemon {
            machine_id: stored.machine_id,
            base: format!("http://{host}:{}", stored.port),
            instance_id: stored.instance_id,
        },
        control_plane: stored.control_plane,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠ **A counter, not a hash of the body.** `cargo test` runs these in parallel
    /// and the first version derived the directory from `body.len()` — so two
    /// bodies of equal length in different tests shared a home, and whichever
    /// finished first deleted it under the other. Intermittent, and it failed once
    /// before it was noticed.
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    fn at(body: &str) -> Option<LocalDaemon> {
        read_with(body, read)
    }

    fn announced_at(body: &str) -> Option<Announced> {
        read_with(body, read_announced)
    }

    fn read_with<T>(body: &str, reader: fn(&Path) -> Option<T>) -> Option<T> {
        let nth = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let home = std::env::temp_dir().join(format!("reemoat-local-{}-{nth}", std::process::id()));
        let root = home.join(".reemoat");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(announce_path(&root), body).unwrap();
        let answer = reader(&root);
        std::fs::remove_dir_all(&home).ok();
        answer
    }

    const GOOD: &str = r#"{"v":1,"machineId":"m_ab12","host":"127.0.0.1","port":7887,"instanceId":"i_x","authMode":"signed"}"#;

    #[test]
    fn a_daemon_that_announced_itself_is_found() {
        let found = at(GOOD).expect("the good file is read");
        assert_eq!(found.machine_id, "m_ab12");
        assert_eq!(found.base, "http://127.0.0.1:7887");
        assert_eq!(found.instance_id, "i_x");
    }

    #[test]
    fn both_is_a_mode_that_accepts_a_token() {
        assert!(at(&GOOD.replace("\"signed\"", "\"both\"")).is_some());
    }

    #[test]
    fn ipv6_loopback_is_bracketed() {
        let found = at(&GOOD.replace("127.0.0.1", "::1")).expect("::1 is loopback");
        assert_eq!(found.base, "http://[::1]:7887");
    }

    /// Every one of these is the same answer, and that is the point: the caller
    /// has one question and it is not "why not".
    #[test]
    fn everything_else_is_nothing() {
        // A host that is not loopback — the rule the whole file exists for.
        assert!(at(&GOOD.replace("127.0.0.1", "192.168.1.5")).is_none());
        // …including a *name*, which a resolver decides.
        assert!(at(&GOOD.replace("127.0.0.1", "localhost")).is_none());
        assert!(at(&GOOD.replace("127.0.0.1", "evil.example")).is_none());
        // A mode that would refuse every request this client can make.
        assert!(at(&GOOD.replace("\"signed\"", "\"shared_secret\"")).is_none());
        // A version this reader does not know.
        assert!(at(&GOOD.replace("\"v\":1", "\"v\":2")).is_none());
        // Ports that are not ports.
        assert!(at(&GOOD.replace(":7887", ":0")).is_none());
        assert!(at(&GOOD.replace(":7887", ":70000")).is_none());
        // Nothing to name.
        assert!(at(&GOOD.replace("\"m_ab12\"", "\"\"")).is_none());
        assert!(at(&GOOD.replace("\"i_x\"", "\"\"")).is_none());
        // Not a file this reader wrote.
        assert!(at("{}").is_none());
        assert!(at("not json at all").is_none());
    }

    /// ⚠ **Whose daemon this is.** `~/.reemoat` is shared by every daemon started
    /// without `REEMOAT_HOME`, so the one announced there can be another fleet's —
    /// and the page told somebody it was a daemon *for this server* they could not
    /// see. Compared after `normalize_origin` on both sides, so a spelling is not a
    /// stranger; a value that does not parse is one; no value is not.
    #[test]
    fn a_daemon_says_which_control_plane_it_enrolled_with() {
        let here = "https://app.reemoat.com";
        let with = |control_plane: &str| {
            GOOD.replace(
                "\"signed\"",
                &format!("\"signed\",\"controlPlane\":{control_plane}"),
            )
        };

        let same = announced_at(&with("\"https://app.reemoat.com/\"")).expect("the field parses");
        assert!(
            !same.for_another_server(here),
            "a trailing slash is the same server"
        );
        assert!(!announced_at(&with("\"HTTPS://APP.REEMOAT.COM:443\""))
            .unwrap()
            .for_another_server(here));

        let other = announced_at(&with("\"http://127.0.0.1:7890\"")).unwrap();
        assert!(
            other.for_another_server(here),
            "another fleet's daemon is a stranger"
        );
        // `http` and `https` are different trust boundaries, and so different servers.
        assert!(announced_at(&with("\"http://app.reemoat.com\""))
            .unwrap()
            .for_another_server(here));
        // "I could not read it" is not evidence that it is this server's.
        assert!(announced_at(&with("\"ftp://app.reemoat.com\""))
            .unwrap()
            .for_another_server(here));

        // A daemon older than the field, or one that knows no address: taken at its
        // root's word, as every file was before this. And the page's answer is the
        // same file read the same way either way.
        let older = announced_at(GOOD).expect("a file with no such key still parses");
        assert!(!older.for_another_server(here));
        assert!(!announced_at(&with("null"))
            .unwrap()
            .for_another_server(here));
        assert_eq!(
            at(&with("\"http://127.0.0.1:7890\"")).unwrap().machine_id,
            "m_ab12"
        );
    }

    #[test]
    fn no_file_is_the_ordinary_case() {
        let nth = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let home =
            std::env::temp_dir().join(format!("reemoat-absent-{}-{nth}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        assert!(read(&home.join(".reemoat")).is_none());
        std::fs::remove_dir_all(&home).ok();
    }
}
