use std::net::{IpAddr, SocketAddr};

use axum::extract::connect_info::ConnectInfo;
use axum::extract::rejection::ExtensionRejection;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use serde_json::json;

use crate::auth::password::{PasswordError, Verification};
use crate::auth::session::{self, cookie_name, sha256_hex};
use crate::auth::throttle::client_key;
use crate::clock::now_ms;
use crate::config::ClientAddressSource;
use crate::error::{ApiError, ApiJson};
use crate::state::AppState;
use crate::users;

/// Longer than any real email, so a hostile one cannot bloat the throttle's keys.
const MAX_THROTTLE_KEY_CHARS: usize = 254;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentUser {
    pub id: String,
    pub email: String,
}

impl<S: Send + Sync> FromRequestParts<S> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        parts
            .extensions
            .get::<CurrentUser>()
            .cloned()
            .ok_or(ApiError::Unauthenticated)
    }
}

/// Login and logout are open to anyone, so they sit outside the session layer
/// but still behind the origin check.
pub fn public_router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/logout", post(logout))
}

pub fn me_router() -> Router<AppState> {
    Router::new().route("/api/v1/auth/me", get(me))
}

fn session_token(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(cookie, value)| *cookie == name && !value.is_empty())
        .map(|(_, value)| value.to_string())
}

/// Enforces authentication before any handler runs, so a new route cannot forget it.
pub async fn require_session(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let name = cookie_name(state.config.cookie_secure);
    let token = session_token(request.headers(), name).ok_or(ApiError::Unauthenticated)?;
    let user = session::lookup(&state.db, &token, now_ms(), state.config.session_idle)
        .await
        .map_err(|error| {
            tracing::error!(%error, "session lookup failed");
            ApiError::Internal
        })?
        .ok_or(ApiError::Unauthenticated)?;

    // The user id, never the email, so logs shipped elsewhere hold no personal data.
    tracing::Span::current().record("user_id", user.id.as_str());
    request.extensions_mut().insert(CurrentUser {
        id: user.id,
        email: user.email,
    });
    Ok(next.run(request).await)
}

/// Compares against the configured origins only. Behind the frontend's proxy
/// the backend's own `Host` is an internal name, and trusting it would let a
/// request vouch for itself.
pub async fn check_origin(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let reads_only = matches!(*request.method(), Method::GET | Method::HEAD);
    if !reads_only {
        if let Some(origin) = request.headers().get(header::ORIGIN) {
            let allowed = origin.to_str().is_ok_and(|origin| {
                state
                    .config
                    .cors_origins
                    .iter()
                    .any(|configured| configured == origin.trim_end_matches('/'))
            });
            if !allowed {
                return Err(ApiError::Forbidden);
            }
        }
    }
    Ok(next.run(request).await)
}

fn user_json(id: &str, email: &str) -> serde_json::Value {
    json!({"user": {"id": id, "email": email}})
}

async fn me(user: CurrentUser) -> Json<serde_json::Value> {
    Json(user_json(&user.id, &user.email))
}

#[derive(Deserialize)]
struct LoginBody {
    email: String,
    // A `SecretString` so a stray `{:?}` cannot put it in a log.
    password: SecretString,
}

pub(crate) fn client_address(
    source: ClientAddressSource,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> IpAddr {
    let peer_ip = peer.map_or(IpAddr::from([0, 0, 0, 0]), |p| p.ip());
    match source {
        ClientAddressSource::Peer => peer_ip,
        // The last line and its last entry are what the trusted proxy appended; everything
        // to their left is client-controlled.
        ClientAddressSource::XForwardedFor => headers
            .get_all("x-forwarded-for")
            .iter()
            .next_back()
            .and_then(|value| value.to_str().ok())
            .and_then(|line| line.rsplit(',').next())
            .and_then(|entry| entry.trim().parse::<IpAddr>().ok())
            .unwrap_or(peer_ip),
        ClientAddressSource::FlyClientIp => headers
            .get("fly-client-ip")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
            .unwrap_or_else(|| {
                // Health checks and operators inside the private network carry no header, so
                // rejecting would break them; the peer is still a correct throttle key there.
                tracing::debug!("fly-client-ip missing or invalid; using the peer address");
                peer_ip
            }),
    }
}

fn password_failure(error: PasswordError) -> ApiError {
    match error {
        PasswordError::Busy => ApiError::ServerBusy { retry_after: 1 },
        PasswordError::Length | PasswordError::Internal => {
            tracing::error!("password verification failed unexpectedly");
            ApiError::Internal
        }
    }
}

fn internal(context: &'static str) -> impl FnOnce(sqlx::Error) -> ApiError {
    move |error| {
        tracing::error!(%error, context);
        ApiError::Internal
    }
}

/// Order matters: throttle, record the attempt, serve any delay, then take a
/// hashing permit. Recording first stops parallel requests from all passing
/// the throttle before any has failed, and delaying first stops delayed
/// requests from holding a permit while they sleep.
async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Result<ConnectInfo<SocketAddr>, ExtensionRejection>,
    ApiJson(body): ApiJson<LoginBody>,
) -> Result<Response, ApiError> {
    let address = client_key(client_address(
        state.config.client_address_source,
        &headers,
        peer.ok().map(|ConnectInfo(addr)| addr),
    ));
    let email_key: String = body
        .email
        .trim()
        .to_lowercase()
        .chars()
        .take(MAX_THROTTLE_KEY_CHARS)
        .collect();

    let attempt = state
        .login_throttle
        .begin(&email_key, &address)
        .map_err(|t| ApiError::TooManyRequests {
            retry_after: t.retry_after_secs,
        })?;
    if !attempt.delay.is_zero() {
        tokio::time::sleep(attempt.delay).await;
    }

    let account = match users::find_by_email(&state.db, &body.email).await {
        Ok(found) => found.filter(|user| !user.disabled),
        // A malformed email is just an account that cannot exist.
        Err(users::UserError::InvalidEmail(_)) => None,
        Err(error) => {
            tracing::error!(%error, "could not look up the account");
            return Err(ApiError::Internal);
        }
    };
    let verification = state
        .passwords
        .verify(
            account.as_ref().map(|user| user.password_hash.as_str()),
            &body.password,
        )
        .await;

    let (user, upgraded_hash) = match (verification, account) {
        (Ok(Verification::Match { upgraded_hash }), Some(user)) => (user, upgraded_hash),
        (Err(error), _) => {
            if error == PasswordError::Busy {
                attempt.cancel();
            }
            return Err(password_failure(error));
        }
        _ => {
            tracing::warn!(
                client = %address,
                email_sha256 = %sha256_hex(&email_key),
                "login failed"
            );
            return Err(ApiError::InvalidCredentials);
        }
    };

    // Verification takes tens of milliseconds, during which an operator may reset
    // the password or disable the account. Both writes below are therefore
    // conditional on the state that was verified, so a login cannot outlive that.
    let mut verified_hash = user.password_hash.clone();
    if let Some(upgraded) = upgraded_hash {
        let replaced = users::replace_hash_if(&state.db, &user.id, &verified_hash, &upgraded)
            .await
            .map_err(|error| {
                tracing::error!(%error, "could not store the upgraded password hash");
                ApiError::Internal
            })?;
        if !replaced {
            return Err(ApiError::InvalidCredentials);
        }
        verified_hash = upgraded;
    }

    // Always a fresh token, and any carried one is deleted, so a token planted
    // before login never becomes authenticated.
    let secure = state.config.cookie_secure;
    if let Some(carried) = session_token(&headers, cookie_name(secure)) {
        session::delete_by_token(&state.db, &carried)
            .await
            .map_err(internal("could not delete the carried session"))?;
    }
    let token = session::create_if_credentials_unchanged(
        &state.db,
        &user.id,
        &verified_hash,
        now_ms(),
        state.config.session_idle,
    )
    .await
    .map_err(internal("could not create a session"))?
    .ok_or(ApiError::InvalidCredentials)?;
    attempt.succeed();

    let cookie = HeaderValue::from_str(&session::set_cookie_header(secure, token.expose_secret()))
        .map_err(|_| ApiError::Internal)?;
    Ok((
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(user_json(&user.id, &user.email)),
    )
        .into_response())
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let secure = state.config.cookie_secure;
    if let Some(token) = session_token(&headers, cookie_name(secure)) {
        session::delete_by_token(&state.db, &token)
            .await
            .map_err(internal("could not delete the session"))?;
    }
    let cleared = HeaderValue::from_str(&session::clear_cookie_header(secure))
        .map_err(|_| ApiError::Internal)?;
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, cleared)]).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_is_found_among_others_and_only_by_exact_name() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            "a=1; songbird_session=tok; b=2".parse().unwrap(),
        );
        assert_eq!(
            session_token(&headers, "songbird_session").as_deref(),
            Some("tok")
        );
        assert_eq!(session_token(&headers, "__Host-songbird_session"), None);
        assert_eq!(session_token(&headers, "session"), None);
    }

    const PEER: &str = "192.0.2.1:4000";

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn resolve(source: ClientAddressSource, pairs: &[(&'static str, &str)]) -> IpAddr {
        client_address(source, &headers(pairs), Some(PEER.parse().unwrap()))
    }

    #[test]
    fn fly_client_ip_identifies_the_client_over_forwarding_headers() {
        let ip = resolve(
            ClientAddressSource::FlyClientIp,
            &[
                ("fly-client-ip", "198.51.100.7"),
                ("x-forwarded-for", "203.0.113.9"),
            ],
        );
        assert_eq!(ip, "198.51.100.7".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn missing_fly_header_falls_back_to_the_peer() {
        let ip = resolve(
            ClientAddressSource::FlyClientIp,
            &[("x-forwarded-for", "203.0.113.9")],
        );
        assert_eq!(ip, "192.0.2.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn malformed_fly_header_falls_back_to_the_peer() {
        for bad in ["not-an-ip", "198.51.100.7, 203.0.113.9", ""] {
            let ip = resolve(ClientAddressSource::FlyClientIp, &[("fly-client-ip", bad)]);
            assert_eq!(ip, "192.0.2.1".parse::<IpAddr>().unwrap(), "{bad:?}");
        }
    }

    #[test]
    fn peer_source_ignores_every_forwarding_header() {
        let ip = resolve(
            ClientAddressSource::Peer,
            &[
                ("x-forwarded-for", "203.0.113.9"),
                ("fly-client-ip", "198.51.100.7"),
            ],
        );
        assert_eq!(ip, "192.0.2.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn x_forwarded_for_source_uses_the_last_entry() {
        let ip = resolve(
            ClientAddressSource::XForwardedFor,
            &[("x-forwarded-for", "10.0.0.1, 203.0.113.9")],
        );
        assert_eq!(ip, "203.0.113.9".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn x_forwarded_for_source_ignores_a_forged_leading_entry() {
        let ip = resolve(
            ClientAddressSource::XForwardedFor,
            &[("x-forwarded-for", "9.9.9.9, 203.0.113.9")],
        );
        assert_eq!(ip, "203.0.113.9".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn x_forwarded_for_source_uses_the_last_header_line() {
        let mut map = HeaderMap::new();
        map.append("x-forwarded-for", HeaderValue::from_static("9.9.9.9"));
        map.append("x-forwarded-for", HeaderValue::from_static("203.0.113.9"));
        let ip = client_address(
            ClientAddressSource::XForwardedFor,
            &map,
            Some(PEER.parse().unwrap()),
        );
        assert_eq!(ip, "203.0.113.9".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn x_forwarded_for_source_falls_back_to_the_peer_when_the_last_entry_is_junk() {
        let ip = resolve(
            ClientAddressSource::XForwardedFor,
            &[("x-forwarded-for", "1.2.3.4, junk")],
        );
        assert_eq!(ip, "192.0.2.1".parse::<IpAddr>().unwrap());
    }
}
