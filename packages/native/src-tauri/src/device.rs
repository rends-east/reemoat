//! The device's X25519 static, one per account (`<origin>#<user id>`): one key on two users'
//! device rows would link them as one computer (Q1.651). The private half never crosses the bridge;
//! the page gets the public key and DH outputs only.

use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::config;
use crate::credential;

const KEY_BYTES: usize = 32;

/// Where the key is kept, shown to the page so a person on the file fallback is told.
pub const AT_REST_KEYRING: &str = "keyring";
pub const AT_REST_FILE: &str = "file";

#[derive(serde::Serialize)]
pub struct DeviceKey {
    #[serde(rename = "publicKey")]
    pub public_key: String,
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

/// Keyring first, so a fallback copy `store_secret` failed to erase is never read. Never promotes
/// a file-held key: this runs on every handshake, so a write here would ride every message.
fn read_secret(dir: &Path, scope: &str) -> Option<([u8; KEY_BYTES], &'static str)> {
    if let Some(found) = credential::read_device_key(scope).and_then(|v| decode_key(&v)) {
        return Some((found, AT_REST_KEYRING));
    }
    config::read_device_key_fallback(dir, scope)
        .and_then(|v| decode_key(&v))
        .map(|found| (found, AT_REST_FILE))
}

/// Verified by reading back, not by `Ok`: a locked store accepts a write and keeps nothing,
/// which would mint a fresh key and device row on every launch.
fn store_secret(dir: &Path, scope: &str, secret: &[u8; KEY_BYTES]) -> Result<&'static str, String> {
    let encoded = encode(secret);
    if credential::write_device_key(scope, &encoded).is_ok()
        && credential::read_device_key(scope).as_deref() == Some(encoded.as_str())
    {
        // A promotion, not a key given up: only `reset_key`'s `give_up_device_key` reaches the quarantine.
        let _ = config::erase_device_key_fallback(dir, scope);
        return Ok(AT_REST_KEYRING);
    }
    config::write_device_key_fallback(dir, scope, &encoded)?;
    Ok(AT_REST_FILE)
}

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

/// Per account, never a sweep; the quarantined copy only where it names this server (`config::discard_quarantine`).
pub fn reset_key(dir: &Path, scope: &str) -> Result<DeviceKey, String> {
    let _ = credential::erase_device_key(scope);
    let _ = config::give_up_device_key(dir, scope);
    ensure_key(dir, scope)
}

/// IK's `ss` and `se`. A non-contributory result (a low-order peer point) is refused, per the Noise spec.
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

/// Generates nothing: a fresh bare key on a legacy seat would be one nobody could prove theirs.
pub fn existing_key(dir: &Path, scope: &str) -> Option<DeviceKey> {
    let (secret, at_rest) = read_secret(dir, scope)?;
    let public = PublicKey::from(&StaticSecret::from(secret));
    Some(DeviceKey {
        public_key: encode(public.as_bytes()),
        at_rest: at_rest.to_string(),
    })
}

/// Proven moves only (`accounts::follow_claim`), never over an existing key. The caller erases the
/// source only on `Ok(true)`; a file-held key moves in `config`'s bind instead.
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
        assert!(decode_key("short").is_none());
        assert!(decode_key(&"A".repeat(43)).is_some());
    }

    #[test]
    fn encoding_is_url_safe_and_unpadded() {
        // The daemon's decoder re-encodes and compares, so padding would be refused there.
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
        let a = StaticSecret::from([1u8; KEY_BYTES]);
        let b = StaticSecret::from([2u8; KEY_BYTES]);
        let c = StaticSecret::from([3u8; KEY_BYTES]);
        let ab = a.diffie_hellman(&PublicKey::from(&b));
        let ba = b.diffie_hellman(&PublicKey::from(&a));
        let cb = c.diffie_hellman(&PublicKey::from(&b));
        assert_eq!(ab.as_bytes(), ba.as_bytes());
        assert_ne!(ab.as_bytes(), cb.as_bytes());
    }

    /// The test above exercises `x25519-dalek`; these drive `diffie_hellman` itself, through the
    /// file fallback, since no keyring knows these origins.
    fn keyed_scratch(name: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("reemoat-dh-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let origin = format!("https://dh-{name}-{}.invalid", std::process::id());
        (dir, origin)
    }

    #[test]
    fn a_low_order_peer_key_is_refused_by_this_module() {
        let (dir, origin) = keyed_scratch("loworder");
        crate::config::write_device_key_fallback(&dir, &origin, &encode(&[9u8; KEY_BYTES]))
            .unwrap();

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

        let expected = theirs.diffie_hellman(&PublicKey::from(&ours));
        assert_eq!(answered, encode(expected.as_bytes()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_origin_with_no_stored_key_says_so_rather_than_minting_one() {
        let (dir, origin) = keyed_scratch("nokey");
        assert_eq!(
            diffie_hellman(&dir, &origin, &encode(&[13u8; KEY_BYTES])),
            Err("this installation has no device key".to_string())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_peer_key_is_refused_before_the_key_is_read() {
        let (dir, origin) = keyed_scratch("malformed");
        // No stored key, so the message must name the peer. 43 characters is a well-formed key.
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
