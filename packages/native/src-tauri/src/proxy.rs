//! The one leg of this client that does not run in the webview.
//!
//! **It is here because the control plane mounts no CORS at all**, and that is
//! deliberate on its side: `packages/web/vite.config.ts` says `/v1` is proxied in
//! dev *"instead of making dev the one place a CORS rule has to exist for the
//! control plane"*. The daemon and the relay both answer
//! `access-control-allow-origin: *` (`src/cors.ts`), so those legs stay in the
//! webview exactly as they are — see `.claude/rules/native-shell.md` for the four
//! reasons that is not an accident.
//!
//! **The webview hands over a path, never a URL.** The base is read from this
//! process's state, so "the credential goes to this origin and nowhere else" —
//! `packages/web/src/cp.ts`'s oldest rule — is enforced in a process the page
//! cannot reach, which is stronger than same-origin rather than weaker.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;

/// A backstop, deliberately generous, and **never a second policy**.
///
/// `CP_TIMEOUT_MS` in `packages/web/src/cp.ts` is 10 s and is the one number that
/// decides how long a control-plane call may take; the webview passes its own
/// `AbortSignal` and `packages/web/src/native.ts` races it. This exists only so a
/// socket that neither answers nor closes cannot pin a thread for ever.
const BACKSTOP: Duration = Duration::from_secs(30);

/// The only two headers this proxy will carry.
///
/// An allowlist rather than a pass-through: the four call sites in `cp.ts` send
/// `authorization`, `content-type`, or nothing, so this list is complete — and a
/// complete allowlist means the webview cannot smuggle a header into a request
/// made with the fleet's credential.
const FORWARDED: [&str; 2] = ["authorization", "content-type"];

#[derive(Deserialize)]
pub struct CpRequest {
    pub path: String,
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    /// Set only by the server picker, to try a candidate before adopting it.
    /// Every other call leaves it out and gets **the calling webview's own
    /// server** — the host resolves it from the seat, never from the page.
    ///
    /// ⚠ **A request carrying it is refused if it would carry a credential**
    /// (`carries_credential`). `GET /v1/instance` and `GET /v1/jwks`, the two
    /// questions a probe asks, are both above the control plane's auth gate, so a
    /// probe has no use for a bearer — and a bearer sent to an address somebody
    /// is still deciding about is the fleet's session handed to a stranger.
    #[serde(default)]
    pub origin: Option<String>,
}

#[derive(Serialize)]
pub struct CpAnswer {
    pub status: u16,
    #[serde(rename = "statusText")]
    pub status_text: String,
    pub body: String,
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        // **Never followed.** A redirect is how a request made with the fleet's
        // credential walks to a host nobody chose; the control plane issues none
        // on `/v1`, so following one would only ever be somebody else's idea.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(BACKSTOP)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Join a path onto the base and refuse anything that left the origin.
///
/// ⚠ **The join is not the check.** `Url::join` happily replaces the whole origin
/// for `//evil.example` or `https://evil.example`, both of which are things a
/// string starting with `/` can be made to look like. Comparing origins
/// afterwards is what actually holds, and the `/v1/` prefix test in front of it is
/// what keeps this from being a general-purpose proxy for the page.
fn target(base: &str, path: &str) -> Result<Url, String> {
    if !path.starts_with("/v1/") && path != "/v1" {
        return Err("refused: not a control-plane path".into());
    }
    let base = Url::parse(base).map_err(|_| "the stored server is not an address".to_string())?;
    let joined = base
        .join(path)
        .map_err(|_| "refused: not a path".to_string())?;
    if joined.origin() != base.origin() {
        return Err("refused: that path leaves the server's origin".into());
    }
    Ok(joined)
}

/// Send it, and answer what came back.
///
/// **An `Err` means the request was never answered**, and the caller turns it into
/// a `TypeError` so `isTransportFailure` in `packages/web/src/http.ts` — which is
/// a *negation*, "anything that is not an `ApiError`" — lands on it. A refusal the
/// control plane authored comes back as an `Ok` carrying its status and its body,
/// so `parseBody` reads the error envelope exactly as it does in a browser. Get
/// that backwards and either every subway tunnel signs the fleet out, or a real
/// `401 session_expired` never signs anybody out at all.
pub async fn send(
    client: &reqwest::Client,
    base: &str,
    req: &CpRequest,
) -> Result<CpAnswer, String> {
    let url = target(base, &req.path)?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|_| format!("refused: {} is not a method", req.method))?;
    let mut builder = client.request(method, url);
    for (name, value) in &req.headers {
        let lower = name.to_ascii_lowercase();
        if FORWARDED.contains(&lower.as_str()) {
            builder = builder.header(lower, value);
        }
    }
    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }
    let response = builder.send().await.map_err(|e| describe(&e))?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let body = response.text().await.map_err(|e| describe(&e))?;
    // ⚠ Clamped, because `new Response(...)` in the webview throws a `RangeError`
    // outside 200..=599 — and a throw inside the bridge would be reported as a
    // *transport* failure about a request that was answered.
    let code = status.as_u16();
    if !(200..=599).contains(&code) {
        return Err(format!("the server answered {code}, which is not a status"));
    }
    Ok(CpAnswer {
        status: code,
        status_text,
        body,
    })
}

/// Whether a request would carry a credential: any header this proxy forwards as
/// `authorization`.
///
/// ⚠ **The same normalization `send` forwards by — ASCII case folded, nothing
/// trimmed — so the refusal and the allowlist cannot disagree.** A name `send`
/// would drop (` authorization`, with a space) carries nothing and is not
/// counted; one it would forward (`Authorization`) is. A predicate that trimmed
/// would refuse a header that never leaves; one that did not fold case would pass
/// one that does.
pub fn carries_credential(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
}

/// A `GET` this **host** makes with a token it holds — never the page's request.
///
/// For the identity questions `accounts.rs` asks before binding anything: whose
/// token this is, which devices and which machines are that user's. The same
/// `target` join, the same client with no redirects, and an `Err` for anything
/// but a 2xx with a JSON body, because every caller's next act is to *believe* the
/// answer.
pub async fn get_json(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    token: &str,
) -> Result<serde_json::Value, String> {
    let answer = send(client, base, &bearer(path, "GET", token)).await?;
    if !(200..300).contains(&answer.status) {
        return Err(format!("the server answered {}", answer.status));
    }
    serde_json::from_str(&answer.body).map_err(|_| "the server's answer was not JSON".to_string())
}

/// End the session a token names, on the server that issued it.
///
/// For a sign-in the host refused to keep — a duplicate of an account already
/// here, or a different person on a signed-out account's seat. Revoking it here
/// rather than handing it back to the page is what means no page path ever holds
/// a bearer the host did not bind. Best effort: the caller has already decided,
/// and an unrevoked session expires on its own.
pub async fn revoke(client: &reqwest::Client, base: &str, token: &str) -> Result<(), String> {
    let answer = send(
        client,
        base,
        &bearer("/v1/me/sessions/current", "DELETE", token),
    )
    .await?;
    if !(200..300).contains(&answer.status) {
        return Err(format!("the server answered {}", answer.status));
    }
    Ok(())
}

fn bearer(path: &str, method: &str, token: &str) -> CpRequest {
    CpRequest {
        path: path.to_string(),
        method: method.to_string(),
        headers: vec![("authorization".to_string(), format!("Bearer {token}"))],
        body: None,
        origin: None,
    }
}

/// One sentence, and never the URL.
///
/// The path is in it and the address is not, for the reason the relay logs a path
/// rather than a URL: a control-plane call carries its credential in a header, but
/// an address in an error string ends up in a screenshot.
fn describe(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "the server did not answer".to_string()
    } else if error.is_connect() {
        "could not reach the server".to_string()
    } else {
        "the request did not complete".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{carries_credential, target};

    fn headers(names: &[&str]) -> Vec<(String, String)> {
        names
            .iter()
            .map(|name| (name.to_string(), "x".to_string()))
            .collect()
    }

    /// The probe refusal and the forwarding allowlist read one name the same way.
    #[test]
    fn a_probe_carries_no_credential() {
        assert!(carries_credential(&headers(&["Authorization"])));
        assert!(carries_credential(&headers(&[
            "content-type",
            "authorization"
        ])));
        assert!(!carries_credential(&headers(&["content-type"])));
        assert!(!carries_credential(&[]));
        // Not forwarded by `send`, so it carries nothing — and a refusal that
        // counted it would disagree with the allowlist it exists to match.
        assert!(!carries_credential(&headers(&[" authorization"])));
    }

    #[test]
    fn a_path_stays_on_the_origin() {
        let url = target("https://a.example", "/v1/me").unwrap();
        assert_eq!(url.as_str(), "https://a.example/v1/me");
    }

    #[test]
    fn the_join_is_not_the_check() {
        // Every one of these is a string a caller could pass where a path is
        // expected, and `Url::join` resolves each one off this origin.
        for escape in [
            "/v1/../../x",
            "//evil.example/v1/me",
            "https://evil.example/v1/me",
            "/v1/me/../../../v1/me",
        ] {
            let joined = target("https://a.example", escape);
            match joined {
                Err(_) => {}
                Ok(url) => assert_eq!(
                    url.origin(),
                    url::Url::parse("https://a.example").unwrap().origin(),
                    "{escape} left the origin"
                ),
            }
        }
        assert!(target("https://a.example", "//evil.example/v1/me").is_err());
        assert!(target("https://a.example", "https://evil.example/v1/me").is_err());
    }

    #[test]
    fn only_v1_is_reachable() {
        for path in [
            "/",
            "/install.sh",
            "/health",
            "/assets/index.js",
            "v1/me",
            "",
        ] {
            assert!(target("https://a.example", path).is_err(), "{path}");
        }
    }
}
