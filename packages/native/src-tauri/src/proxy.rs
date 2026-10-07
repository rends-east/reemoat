//! The one leg outside the webview, because the control plane mounts no CORS. The page hands
//! over a path, never a URL, so the credential's origin is decided where the page cannot reach.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;

/// Only a backstop for a socket that never answers; `CP_TIMEOUT_MS` in `cp.ts` is the policy.
const BACKSTOP: Duration = Duration::from_secs(30);

/// A connection the network dropped reports nothing, and every later request rode it: silent this long
/// it is pinged, and unanswered as long again it is closed, so the next request dials (Q3.716).
const PING: Duration = Duration::from_secs(5);

/// As long as the page waits for an answer: a dial still out past that is nobody's.
const CONNECT: Duration = Duration::from_secs(10);

/// Complete for `cp.ts`'s call sites, so the page cannot smuggle a header onto the credential.
const FORWARDED: [&str; 2] = ["authorization", "content-type"];

#[derive(Deserialize)]
pub struct CpRequest {
    pub path: String,
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    /// Only the server picker's probe sets it, and then a credential is refused; otherwise the seat's server.
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
        // A redirect would walk the credential to a host nobody chose.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(BACKSTOP)
        .connect_timeout(CONNECT)
        .http2_keep_alive_interval(PING)
        .http2_keep_alive_timeout(PING)
        // Idle too: the request that finds it dead is otherwise a sign-in or a token, ten seconds late.
        .http2_keep_alive_while_idle(true)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// `Url::join` replaces the origin for `//x` or `https://x`, so the comparison afterwards is the check.
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

/// `Err` only when nothing answered (the page's transport failure); a control-plane refusal is `Ok`.
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
    // `new Response` throws outside 200..=599, which the page would read as a transport failure.
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

/// Folds case and trims nothing, exactly as `send` forwards, so the two cannot disagree.
pub fn carries_credential(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
}

/// A `GET` the host makes with its own token; anything but a 2xx JSON is `Err`, since callers believe it.
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

/// Ends a sign-in the host refused to keep, so the page never holds an unbound bearer. Best effort.
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

/// Never the URL: an error string ends up in a screenshot.
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

    #[test]
    fn a_probe_carries_no_credential() {
        assert!(carries_credential(&headers(&["Authorization"])));
        assert!(carries_credential(&headers(&[
            "content-type",
            "authorization"
        ])));
        assert!(!carries_credential(&headers(&["content-type"])));
        assert!(!carries_credential(&[]));
        // Not forwarded by `send`, so it carries nothing.
        assert!(!carries_credential(&headers(&[" authorization"])));
    }

    #[test]
    fn a_path_stays_on_the_origin() {
        let url = target("https://a.example", "/v1/me").unwrap();
        assert_eq!(url.as_str(), "https://a.example/v1/me");
    }

    #[test]
    fn the_join_is_not_the_check() {
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
