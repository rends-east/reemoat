//! The device's own cryptographic identity.
//!
//! An app installation holds one X25519 static per **account** — per
//! `<origin>#<user id>`, the scope `credential.rs` keys everything on. The
//! Authority records the public half against the `devices` row it already keeps,
//! names it in every capability it mints for this installation, and the daemon
//! compares that name against the key the Noise handshake actually authenticated.
//! The effect is the one this whole phase is for: **a capability copied off this
//! device — out of a log, a proxy, a query string — cannot be used from anywhere
//! else**, because the copier cannot produce the key.
//!
//! ⚠ **Per account rather than per server, and two accounts on one server no
//! longer share a public key.** One key on two users' device rows is the linkage
//! `credential.rs`'s `DEVICE_KEY` block forbids — anybody who can see both rows
//! learns they are one computer — and the control plane has no uniqueness on the
//! column to refuse it. The one key that moves between scopes is a pre-accounts
//! key under the bare origin, and only to the account proved to own it
//! (`copy_key`).
//!
//! ⚠ **The private half never crosses the bridge, and that is the whole of what
//! this module is arranged around.** The page gets a public key and, on request,
//! the *output* of a Diffie-Hellman; it never gets the key. `credential.rs`
//! wrote that requirement down before there was anything to put behind it, and
//! its docblock carries the honest amendment: the Secure Enclave does P-256 only,
//! so a non-extractable X25519 static does not exist on this platform. What the
//! refusal buys is that the one place somebody else's JavaScript could run cannot
//! read the key — not that this process cannot.

use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::config;
use crate::credential;

/// X25519 keys are 32 bytes, in both halves, always.
const KEY_BYTES: usize = 32;

/// Where a device key is kept on this machine, as a word the page can show.
///
/// Two values and no third: the platform store, or a file beside the server
/// address. A person on the second should be told, which is why this travels to
/// the page at all rather than staying an implementation detail.
pub const AT_REST_KEYRING: &str = "keyring";
pub const AT_REST_FILE: &str = "file";

/// What the page is told about this installation's key. Never the key itself.
#[derive(serde::Serialize)]
pub struct DeviceKey {
    /// base64url, 32 raw bytes.
    #[serde(rename = "publicKey")]
    pub public_key: String,
    /// `AT_REST_KEYRING` or `AT_REST_FILE`.
    #[serde(rename = "atRest")]
    pub at_rest: String,
}

fn decode_key(value: &str) -> Option<[u8; KEY_BYTES]> {
    let raw = URL_SAFE_NO_PAD.decode(value.trim()).ok()?;
    let bytes: [u8; KEY_BYTES] = raw.try_into().ok()?;
    Some(bytes)
}

fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Read the stored secret for one account, from wherever it actually is.
///
/// The keyring first on every read, not only on the write that created it, so a
/// value in the file is ignored the moment the keyring answers — which is also
/// what makes `store_secret`'s erase of the fallback safe to lose: that call is
/// `let _ =`, and a copy it failed to remove is one nothing will read again.
///
/// ⚠ **It does not *promote*, and the sentence here used to say it did** —
/// *"a machine whose store was locked at first run and unlocked later should
/// start using it"*. Nothing writes the keyring except `store_secret`, and
/// `ensure_key` reaches that only where this function answered `None`; a key
/// that has only ever been in the file therefore keeps being read out of the
/// file for ever, however healthy the collection becomes. Recovering it takes a
/// `reset_key` from the Devices screen, which is a new key and a new
/// registration rather than a move. Promoting cannot live *here*:
/// `diffie_hellman` calls this on every handshake, so a keyring write and its
/// read-back would ride every message rather than a launch. `ensure_key` is
/// where it would go, and it is not built.
fn read_secret(dir: &Path, scope: &str) -> Option<([u8; KEY_BYTES], &'static str)> {
    if let Some(found) = credential::read_device_key(scope).and_then(|v| decode_key(&v)) {
        return Some((found, AT_REST_KEYRING));
    }
    config::read_device_key_fallback(dir, scope)
        .and_then(|v| decode_key(&v))
        .map(|found| (found, AT_REST_FILE))
}

/// Write a secret to the best place this machine has, and say which that was.
///
/// ⚠ **The keyring write is verified by reading it back, not by its `Ok`.** That
/// is `credential::probe`'s whole finding one module over: a store with no
/// unlocked collection accepts a write, returns success and keeps nothing. Trusting
/// the `Ok` here would put this installation in the worst of the two states — a
/// fresh key and a fresh device row on every single launch, with nothing in the
/// file to fall back to and no signal that anything was wrong.
fn store_secret(dir: &Path, scope: &str, secret: &[u8; KEY_BYTES]) -> Result<&'static str, String> {
    let encoded = encode(secret);
    if credential::write_device_key(scope, &encoded).is_ok()
        && credential::read_device_key(scope).as_deref() == Some(encoded.as_str())
    {
        // Give up any earlier fallback: two copies of one secret is two places to
        // get wrong, and the keyring is the one that will now be read. ⚠ This is a
        // **promotion** and not a key given up, which is why it is the statement
        // that rewrites `server.json` alone — `reset_key` takes the second route,
        // `config::give_up_device_key`, and only that one reaches the quarantine.
        let _ = config::erase_device_key_fallback(dir, scope);
        return Ok(AT_REST_KEYRING);
    }
    config::write_device_key_fallback(dir, scope, &encoded)?;
    Ok(AT_REST_FILE)
}

/// This installation's key for one account, generating it on first use.
pub fn ensure_key(dir: &Path, scope: &str) -> Result<DeviceKey, String> {
    if let Some((secret, at_rest)) = read_secret(dir, scope) {
        let public = PublicKey::from(&StaticSecret::from(secret));
        return Ok(DeviceKey {
            public_key: encode(public.as_bytes()),
            at_rest: at_rest.to_string(),
        });
    }

    let mut secret = [0u8; KEY_BYTES];
    getrandom::fill(&mut secret).map_err(|e| format!("no randomness available: {e}"))?;
    let at_rest = store_secret(dir, scope, &secret)?;
    let public = PublicKey::from(&StaticSecret::from(secret));
    Ok(DeviceKey {
        public_key: encode(public.as_bytes()),
        at_rest: at_rest.to_string(),
    })
}

/// Start this installation over with a fresh key for one account.
///
/// For the two cases that are the same act from the outside: a keychain that was
/// reset, and somebody deliberately re-keying from the Devices screen. **Per
/// account, never a sweep** — `credential.rs`'s refusal to grow a `list` is what
/// stops this becoming an enumeration, and one account at a time is also the only
/// shape that matches what a person is looking at when they ask for it. A Re-key
/// under one account leaves every other account's key alone, including another
/// account on the same server.
///
/// ⚠ **That rule reaches a third place now, and for one release it did not hold
/// there.** This gives up three copies, not two: the keyring's, `server.json`'s,
/// and — through `config::give_up_device_key` — a quarantined
/// `server.json.unreadable`, which on a keyring-less host may be the last
/// *hand-recoverable* copy of a device private key. That third removal was the
/// whole file, so Re-keying server A could destroy the only remaining copy of
/// server B's key: per origin at this end, a sweep at the other. It now reads the
/// quarantined bytes and refuses to remove a file naming any server but this one;
/// `config.rs`'s `discard_quarantine` carries the measurement and the argument for
/// both halves.
pub fn reset_key(dir: &Path, scope: &str) -> Result<DeviceKey, String> {
    let _ = credential::erase_device_key(scope);
    let _ = config::give_up_device_key(dir, scope);
    ensure_key(dir, scope)
}

/// One Diffie-Hellman with this installation's static, for the Noise handshake.
///
/// The page runs the handshake — `native-shell.md` gives four reasons the daemon
/// leg may not leave the webview, and one of them is that an encrypted stream
/// with two decryptors is not a design — so the two operations that need the
/// static key come back here and nothing else does. `ss` and `se` in the IK
/// pattern; every other operation in the handshake uses an ephemeral the page
/// generated and holds.
///
/// ⚠ **A non-contributory result is refused.** A peer offering a low-order point
/// forces a shared secret of all zeros, which both ends would then agree on
/// without either having proved anything. `x25519-dalek` answers that question
/// directly and the Noise specification says to ask it; the cost of not asking is
/// a handshake that completes with an attacker who knows no key at all.
pub fn diffie_hellman(dir: &Path, scope: &str, peer_public: &str) -> Result<String, String> {
    let peer = decode_key(peer_public)
        .ok_or_else(|| "the peer key is not 32 base64url bytes".to_string())?;
    let (secret, _) =
        read_secret(dir, scope).ok_or_else(|| "this installation has no device key".to_string())?;

    let shared = StaticSecret::from(secret).diffie_hellman(&PublicKey::from(peer));
    if !shared.was_contributory() {
        return Err("the peer offered a key that contributes nothing".to_string());
    }
    Ok(encode(shared.as_bytes()))
}

/// This account's key if it has one, **generating nothing**.
///
/// For a legacy seat's boot: its key is the bare, pre-accounts one, and minting a
/// fresh bare key for a seat that has none would be a key nobody can ever prove is
/// theirs, left behind for the account the seat becomes.
pub fn existing_key(dir: &Path, scope: &str) -> Option<DeviceKey> {
    let (secret, at_rest) = read_secret(dir, scope)?;
    let public = PublicKey::from(&StaticSecret::from(secret));
    Some(DeviceKey {
        public_key: encode(public.as_bytes()),
        at_rest: at_rest.to_string(),
    })
}

/// Copy the keyring's device key from one scope to another, verified — and only
/// where the destination has none.
///
/// **A proven move only**: the caller is `accounts::follow_claim`, after
/// `server.json` recorded that the bare device was proved to be this account's
/// (`GET /v1/me/devices` listed its id). Copying it anywhere else would put one
/// key on two users' rows. It lives here because this module owns every decision
/// about what the value means — and `webcheck.devices.ts` forbids reading a device
/// key in any command body.
///
/// Answers `Ok(true)` where a key was copied, `Ok(false)` where there was nothing
/// to copy or the destination already had one, and `Err` where the copy did not
/// read back — the caller erases the source only on `Ok(true)`, so a failure here
/// leaves the bare key exactly where it was. A file-held key is moved by
/// `config`'s bind instead, inside the same write that moved the id.
pub fn copy_key(from: &str, to: &str) -> Result<bool, String> {
    if credential::read_device_key(to)
        .and_then(|value| decode_key(&value))
        .is_some()
    {
        return Ok(false);
    }
    let Some(secret) = credential::read_device_key(from).and_then(|value| decode_key(&value))
    else {
        return Ok(false);
    };
    let encoded = encode(&secret);
    credential::write_device_key(to, &encoded)?;
    if credential::read_device_key(to).as_deref() != Some(encoded.as_str()) {
        return Err("the device key did not read back where it was copied".into());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_key_of_the_wrong_length_is_refused() {
        // Not a panic and not a zero key: the one caller is the page, and a short
        // value there is a bug to report rather than a handshake to attempt.
        assert!(decode_key("short").is_none());
        assert!(decode_key(&"A".repeat(43)).is_some());
    }

    #[test]
    fn encoding_is_url_safe_and_unpadded() {
        // The daemon reads these with a strict base64url decoder that re-encodes
        // and compares, so padding or a `+` here would be refused at the far end
        // rather than fixed up.
        let encoded = encode(&[251u8; KEY_BYTES]);
        assert!(!encoded.contains('='));
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
    }

    #[test]
    fn a_key_round_trips_through_its_encoding() {
        let secret = [7u8; KEY_BYTES];
        assert_eq!(decode_key(&encode(&secret)), Some(secret));
    }

    #[test]
    fn two_installations_agree_and_a_third_does_not() {
        // The property the handshake rests on, at the one layer that can be
        // tested without a server: a DH is symmetric, and an unrelated key gets
        // a different answer.
        let a = StaticSecret::from([1u8; KEY_BYTES]);
        let b = StaticSecret::from([2u8; KEY_BYTES]);
        let c = StaticSecret::from([3u8; KEY_BYTES]);
        let ab = a.diffie_hellman(&PublicKey::from(&b));
        let ba = b.diffie_hellman(&PublicKey::from(&a));
        let cb = c.diffie_hellman(&PublicKey::from(&b));
        assert_eq!(ab.as_bytes(), ba.as_bytes());
        assert_ne!(ab.as_bytes(), cb.as_bytes());
    }

    /* ── and the same questions asked of *this* module ───────────────────── */

    /// ⚠ **Everything above this line tests `x25519-dalek`, not this file.**
    ///
    /// `two_installations_agree_and_a_third_does_not` builds `StaticSecret`s and
    /// calls the library's own `diffie_hellman` method; it asserts that the
    /// library is symmetric, which it is, and would go on passing with
    /// `device::diffie_hellman` deleted. The refusal below it — the one with the
    /// Noise specification behind it — was executed by nothing at all, and the
    /// only other thing watching it is a `/was_contributory\(\)/` grep in
    /// `webcheck.devices.ts`, which cannot tell a live refusal from a call whose
    /// result is discarded.
    ///
    /// These drive the exported function against a directory of their own. The
    /// keyring is consulted first by `read_secret` and will not know these
    /// origins, so the file fallback is the path under test — which is also the
    /// path that actually ships on a host with no unlocked collection.
    fn keyed_scratch(name: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("reemoat-dh-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // An origin no keyring on this machine can have an entry for, so
        // `read_secret` falls to the file this test wrote.
        let origin = format!("https://dh-{name}-{}.invalid", std::process::id());
        (dir, origin)
    }

    #[test]
    fn a_low_order_peer_key_is_refused_by_this_module() {
        let (dir, origin) = keyed_scratch("loworder");
        crate::config::write_device_key_fallback(&dir, &origin, &encode(&[9u8; KEY_BYTES]))
            .unwrap();

        // The all-zero point. A peer offering it forces a shared secret of zeros
        // that both ends would agree on with neither having proved anything.
        let refused = diffie_hellman(&dir, &origin, &encode(&[0u8; KEY_BYTES]));
        assert_eq!(
            refused,
            Err("the peer offered a key that contributes nothing".to_string()),
            "a low-order point must be refused, not agreed with"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn this_modules_dh_is_symmetric_against_a_real_stored_key() {
        let (dir, origin) = keyed_scratch("symmetric");
        let ours = StaticSecret::from([11u8; KEY_BYTES]);
        crate::config::write_device_key_fallback(&dir, &origin, &encode(&ours.to_bytes())).unwrap();

        let theirs = StaticSecret::from([12u8; KEY_BYTES]);
        let answered = diffie_hellman(&dir, &origin, &encode(PublicKey::from(&theirs).as_bytes()))
            .expect("a well-formed peer key is answered");

        // What the far end computes with the halves swapped.
        let expected = theirs.diffie_hellman(&PublicKey::from(&ours));
        assert_eq!(answered, encode(expected.as_bytes()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_origin_with_no_stored_key_says_so_rather_than_minting_one() {
        let (dir, origin) = keyed_scratch("nokey");
        // Nothing written. The message is the one `e2ee.ts` surfaces, so a change
        // here is a change to what a person is told.
        assert_eq!(
            diffie_hellman(&dir, &origin, &encode(&[13u8; KEY_BYTES])),
            Err("this installation has no device key".to_string())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_peer_key_is_refused_before_the_key_is_read() {
        let (dir, origin) = keyed_scratch("malformed");
        // Deliberately no stored key: a peer key this shape must be refused on its
        // own account, so the message names the peer rather than the installation.
        // ⚠ Not `"A".repeat(43)`: 43 base64url characters is exactly 32 bytes, so
        // that one is a *well-formed* key and this table's first draft failed on
        // it — correctly. The malformed shapes are the wrong lengths and the
        // characters base64url does not have (`+` and `/`, which the standard
        // alphabet does).
        for bad in [
            "",
            "short",
            &"A".repeat(42),
            &"A".repeat(44),
            &format!("{}+", "A".repeat(42)),
            &format!("{}/", "A".repeat(42)),
        ] {
            assert_eq!(
                diffie_hellman(&dir, &origin, bad),
                Err("the peer key is not 32 base64url bytes".to_string()),
                "{bad:?} is not a peer key"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
