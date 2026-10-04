//! Where a local daemon listens, read from the file `src/announce.ts` writes in its `0700` root
//! rather than probed, since a probe hands a machine token to whoever answered (Q7.137, Q7.148).
//! Loopback is enforced here, out of the page's reach.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Any other version reads as "no local daemon", which degrades to the relay.
const ANNOUNCE_VERSION: u32 = 1;

/// Not `localhost`: a name is whatever the resolver says.
const LOOPBACK: [&str; 2] = ["127.0.0.1", "::1"];

/// Mirrors `LocalAnnounce` in `src/announce.ts`; `nativecheck` compares the keys, so one `rename` per field.
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
    /// `default` so an older daemon's file parses, on its own line so `nativecheck`'s census reads the `rename`.
    #[serde(default)]
    #[serde(rename = "controlPlane")]
    control_plane: Option<String>,
}

/// A finished `base`, so the page never composes an address for a credentialed request.
#[derive(Serialize)]
pub struct LocalDaemon {
    #[serde(rename = "machineId")]
    pub machine_id: String,
    pub base: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
}

/// The control plane stays host-side: only the host knows the origin to compare it with.
pub struct Announced {
    pub daemon: LocalDaemon,
    control_plane: Option<String>,
}

impl Announced {
    /// `~/.reemoat` is shared with any `pnpm daemon`, so its announcer may be another fleet's.
    /// Unparseable counts as another server; absent (an older daemon) does not.
    pub fn for_another_server(&self, origin: &str) -> bool {
        match self.control_plane.as_deref() {
            None => false,
            Some(raw) => !crate::config::normalize_origin(raw).is_ok_and(|named| named == origin),
        }
    }
}

pub fn announce_path(root: &Path) -> PathBuf {
    root.join("daemon.json")
}

/// Every failure is `None`, not an error: the only question is whether a daemon here is worth a token.
pub fn read(root: &Path) -> Option<LocalDaemon> {
    read_announced(root).map(|found| found.daemon)
}

pub fn read_announced(root: &Path) -> Option<Announced> {
    let raw = std::fs::read_to_string(announce_path(root)).ok()?;
    let stored: Stored = serde_json::from_str(&raw).ok()?;
    if stored.v != ANNOUNCE_VERSION {
        return None;
    }
    if stored.machine_id.is_empty() || stored.instance_id.is_empty() {
        return None;
    }
    // A `shared_secret` daemon would refuse every request this client could make.
    if stored.auth_mode != "signed" && stored.auth_mode != "both" {
        return None;
    }
    if stored.port == 0 || stored.port > 65535 {
        return None;
    }
    if !LOOPBACK.contains(&stored.host.as_str()) {
        return None;
    }
    // Unbracketed, `http://::1:7887` parses 7887 as part of the address.
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

    /// A counter, so parallel tests never share (and delete) one directory.
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

    #[test]
    fn everything_else_is_nothing() {
        assert!(at(&GOOD.replace("127.0.0.1", "192.168.1.5")).is_none());
        assert!(at(&GOOD.replace("127.0.0.1", "localhost")).is_none());
        assert!(at(&GOOD.replace("127.0.0.1", "evil.example")).is_none());
        assert!(at(&GOOD.replace("\"signed\"", "\"shared_secret\"")).is_none());
        assert!(at(&GOOD.replace("\"v\":1", "\"v\":2")).is_none());
        assert!(at(&GOOD.replace(":7887", ":0")).is_none());
        assert!(at(&GOOD.replace(":7887", ":70000")).is_none());
        assert!(at(&GOOD.replace("\"m_ab12\"", "\"\"")).is_none());
        assert!(at(&GOOD.replace("\"i_x\"", "\"\"")).is_none());
        assert!(at("{}").is_none());
        assert!(at("not json at all").is_none());
    }

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
        assert!(announced_at(&with("\"http://app.reemoat.com\""))
            .unwrap()
            .for_another_server(here));
        assert!(announced_at(&with("\"ftp://app.reemoat.com\""))
            .unwrap()
            .for_another_server(here));

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
