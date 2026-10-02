//! Lets tests act as a signed-in user without paying for an argon2 hash or a
//! login round trip.

use std::time::Duration;

use api::auth::session::{self, SECURE_COOKIE_NAME};
use api::clock::now_ms;
use api::db::Db;
use api::users::{self, User};
use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::Router;
use secrecy::ExposeSecret;

/// Never matches any password, so a seeded user cannot be logged into by accident.
const UNUSABLE_PASSWORD_HASH: &str = "!";

const SESSION_IDLE: Duration = Duration::from_secs(168 * 3600);

pub async fn seed_user(db: &Db, email: &str) -> User {
    users::create(db, email, UNUSABLE_PASSWORD_HASH)
        .await
        .expect("seed user")
}

/// Returns a `Cookie` header value for a config with the default `Secure` cookie.
pub async fn login_as(db: &Db, email: &str) -> String {
    let user = match users::find_by_email(db, email).await.expect("find user") {
        Some(existing) => existing,
        None => seed_user(db, email).await,
    };
    let token = session::create(db, &user.id, now_ms(), SESSION_IDLE)
        .await
        .expect("seed session");
    format!("{SECURE_COOKIE_NAME}={}", token.expose_secret())
}

/// Adds the cookie to every request that has none, so existing endpoint tests
/// can run as a signed-in user without threading a header through each call.
pub fn with_cookie(router: Router, cookie: String) -> Router {
    let cookie = HeaderValue::from_str(&cookie).expect("cookie is a valid header value");
    router.layer(axum::middleware::map_request(
        move |mut request: Request| {
            let cookie = cookie.clone();
            async move {
                request
                    .headers_mut()
                    .entry(header::COOKIE)
                    .or_insert(cookie);
                request
            }
        },
    ))
}

/// For tests of an endpoint's own behaviour, where authentication is incidental.
pub async fn signed_in(db: &Db, router: Router) -> Router {
    let cookie = login_as(db, "tester@example.com").await;
    with_cookie(router, cookie)
}
