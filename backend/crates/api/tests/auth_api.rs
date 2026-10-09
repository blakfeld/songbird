mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use api::auth::session::{hash_token, ABSOLUTE_LIFETIME};
use api::auth::throttle::{client_key, LoginThrottle};
use api::clock::now_ms;
use api::config::{COOKIE_SECURE, TRUST_PROXY};
use api::users;
use axum::http::{header, StatusCode};
use common::app::{
    cookie_pair, fast_passwords, login_request, login_request_with, request, TestApp,
    ALLOWED_ORIGIN,
};
use common::session::login_as;
use futures_util::future::join_all;
use serde_json::json;
use sqlx::Row;

const PASSWORD: &str = "correct horse battery";

async fn session_count(app: &TestApp) -> i64 {
    sqlx::query("SELECT COUNT(*) FROM sessions")
        .fetch_one(app.db().pool())
        .await
        .unwrap()
        .get::<i64, _>(0)
}

async fn app_with_ana(extra: &[(&str, &str)]) -> TestApp {
    let app = TestApp::new(extra).await;
    app.create_user("ana@example.com", PASSWORD).await;
    app
}

async fn me_status(app: &TestApp, cookie: &str) -> StatusCode {
    app.send(request("GET", "/api/v1/auth/me", Some(cookie), None))
        .await
        .status
}

#[tokio::test]
async fn successful_login_returns_the_user_and_sets_a_host_prefixed_cookie() {
    let app = app_with_ana(&[]).await;
    let user = users::find_by_email(app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();

    let response = app.send(login_request("ana@example.com", PASSWORD)).await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        response.body,
        json!({"user": {"id": user.id, "email": "ana@example.com"}})
    );
    let set_cookie = response.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(
        set_cookie.starts_with("__Host-songbird_session="),
        "{set_cookie}"
    );
    for attribute in ["HttpOnly", "SameSite=Lax", "Path=/", "Secure"] {
        assert!(set_cookie.contains(attribute), "{set_cookie}");
    }
    assert!(!set_cookie.contains("Domain"), "{set_cookie}");

    let me = app
        .send(request(
            "GET",
            "/api/v1/auth/me",
            Some(&cookie_pair(&response)),
            None,
        ))
        .await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.body, response.body);
}

#[tokio::test]
async fn insecure_cookie_setting_uses_the_plain_name_without_secure() {
    let app = app_with_ana(&[(COOKIE_SECURE, "false")]).await;
    let response = app.send(login_request("ana@example.com", PASSWORD)).await;
    let set_cookie = response.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(set_cookie.starts_with("songbird_session="), "{set_cookie}");
    assert!(!set_cookie.contains("Secure"), "{set_cookie}");
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Lax"));
    assert_eq!(
        me_status(&app, &cookie_pair(&response)).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn email_matching_ignores_case_and_surrounding_whitespace() {
    let app = app_with_ana(&[]).await;
    let response = app
        .send(login_request("  ANA@Example.COM ", PASSWORD))
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["user"]["email"], "ana@example.com");
}

#[tokio::test]
async fn wrong_password_unknown_email_and_disabled_account_look_identical() {
    let app = app_with_ana(&[]).await;
    app.create_user("off@example.com", PASSWORD).await;
    users::set_disabled(app.db(), "off@example.com", true)
        .await
        .unwrap();

    let wrong = app
        .send(login_request("ana@example.com", "wrong password here"))
        .await;
    let unknown = app
        .send(login_request("nobody@example.com", PASSWORD))
        .await;
    let disabled = app.send(login_request("off@example.com", PASSWORD)).await;

    for response in [&wrong, &unknown, &disabled] {
        assert_eq!(response.status, StatusCode::UNAUTHORIZED);
        assert_eq!(response.body["error"]["code"], "invalid_credentials");
        assert!(response.headers.get(header::SET_COOKIE).is_none());
    }
    assert_eq!(wrong.body, unknown.body);
    assert_eq!(wrong.body, disabled.body);
    assert_eq!(session_count(&app).await, 0);
}

#[tokio::test]
async fn login_replaces_the_carried_session() {
    let app = app_with_ana(&[]).await;
    let first = app.send(login_request("ana@example.com", PASSWORD)).await;
    let old = cookie_pair(&first);

    let mut second = login_request("ana@example.com", PASSWORD);
    second
        .headers_mut()
        .insert(header::COOKIE, old.parse().unwrap());
    let second = app.send(second).await;
    let new = cookie_pair(&second);

    assert_eq!(second.status, StatusCode::OK);
    assert_ne!(old, new);
    assert_eq!(me_status(&app, &old).await, StatusCode::UNAUTHORIZED);
    assert_eq!(me_status(&app, &new).await, StatusCode::OK);
    assert_eq!(session_count(&app).await, 1);
}

#[tokio::test]
async fn a_failed_login_does_not_delete_the_carried_session() {
    let app = app_with_ana(&[]).await;
    let ok = app.send(login_request("ana@example.com", PASSWORD)).await;
    let cookie = cookie_pair(&ok);

    let mut bad = login_request("ana@example.com", "wrong password here");
    bad.headers_mut()
        .insert(header::COOKIE, cookie.parse().unwrap());
    assert_eq!(app.send(bad).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(me_status(&app, &cookie).await, StatusCode::OK);
}

#[tokio::test]
async fn an_old_hash_is_upgraded_on_login_without_ending_sessions() {
    let current = api::auth::password::PasswordService::with_params(
        argon2::Params::new(16, 1, 1, None).unwrap(),
        2,
    );
    let app = TestApp::with_state(&[], |state| state.passwords = current.clone()).await;
    // Hashed with cheaper parameters than the app's service now uses.
    let old_hash = fast_passwords(2)
        .hash(&secrecy::SecretString::from(PASSWORD.to_string()))
        .await
        .unwrap();
    users::create(app.db(), "ana@example.com", &old_hash)
        .await
        .unwrap();
    let carried = login_as(app.db(), "ana@example.com").await;

    let response = app.send(login_request("ana@example.com", PASSWORD)).await;
    assert_eq!(response.status, StatusCode::OK);

    let stored = users::find_by_email(app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    assert!(
        stored.password_hash.contains("m=16,t=1,p=1"),
        "{}",
        stored.password_hash
    );
    assert_eq!(me_status(&app, &carried).await, StatusCode::OK);
    let again = app.send(login_request("ana@example.com", PASSWORD)).await;
    assert_eq!(again.status, StatusCode::OK);
}

#[tokio::test]
async fn me_without_a_session_is_401_in_the_standard_shape() {
    let app = app_with_ana(&[]).await;
    let response = app
        .send(request("GET", "/api/v1/auth/me", None, None))
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.body["error"]["code"], "unauthenticated");
}

#[tokio::test]
async fn logout_ends_the_session_and_clears_the_cookie_with_matching_attributes() {
    let app = app_with_ana(&[]).await;
    let login = app.send(login_request("ana@example.com", PASSWORD)).await;
    let cookie = cookie_pair(&login);

    let out = app
        .send(request("POST", "/api/v1/auth/logout", Some(&cookie), None))
        .await;

    assert_eq!(out.status, StatusCode::NO_CONTENT);
    let cleared = out.headers[header::SET_COOKIE].to_str().unwrap();
    for attribute in [
        "__Host-songbird_session=;",
        "Path=/",
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0",
    ] {
        assert!(cleared.contains(attribute), "{cleared}");
    }
    assert_eq!(me_status(&app, &cookie).await, StatusCode::UNAUTHORIZED);
    assert_eq!(session_count(&app).await, 0);
}

#[tokio::test]
async fn logout_without_a_session_is_still_204() {
    let app = app_with_ana(&[]).await;
    let out = app
        .send(request("POST", "/api/v1/auth/logout", None, None))
        .await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn disable_new_password_and_delete_end_sessions_on_the_next_request() {
    let app = app_with_ana(&[]).await;
    app.create_user("bo@example.com", PASSWORD).await;
    app.create_user("cy@example.com", PASSWORD).await;

    let ana_one = cookie_pair(&app.send(login_request("ana@example.com", PASSWORD)).await);
    let ana_two = cookie_pair(&app.send(login_request("ana@example.com", PASSWORD)).await);
    let bo = cookie_pair(&app.send(login_request("bo@example.com", PASSWORD)).await);
    let cy = cookie_pair(&app.send(login_request("cy@example.com", PASSWORD)).await);

    users::set_password(app.db(), "ana@example.com", "$argon2id$unused")
        .await
        .unwrap();
    users::set_disabled(app.db(), "bo@example.com", true)
        .await
        .unwrap();
    users::delete(app.db(), "cy@example.com").await.unwrap();

    for cookie in [&ana_one, &ana_two, &bo, &cy] {
        let response = app
            .send(request("GET", "/api/v1/auth/me", Some(cookie), None))
            .await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED);
        assert_eq!(response.body["error"]["code"], "unauthenticated");
    }
}

#[tokio::test]
async fn an_idle_session_expires_and_is_deleted_when_presented() {
    let app = app_with_ana(&[]).await;
    let cookie = cookie_pair(&app.send(login_request("ana@example.com", PASSWORD)).await);
    let token = cookie.split_once('=').unwrap().1.to_string();
    sqlx::query("UPDATE sessions SET expires_at = $1")
        .bind(now_ms() - 1)
        .execute(app.db().pool())
        .await
        .unwrap();

    assert_eq!(me_status(&app, &cookie).await, StatusCode::UNAUTHORIZED);
    assert_eq!(session_count(&app).await, 0, "lazily deleted");
    let _ = token;
}

#[tokio::test]
async fn the_absolute_cap_ends_a_session_that_keeps_being_used() {
    let app = app_with_ana(&[]).await;
    let cookie = cookie_pair(&app.send(login_request("ana@example.com", PASSWORD)).await);
    let cap_ms = i64::try_from(ABSOLUTE_LIFETIME.as_millis()).unwrap();
    sqlx::query("UPDATE sessions SET created_at = $1, last_seen_at = $2, expires_at = $3")
        .bind(now_ms() - cap_ms - 1000)
        .bind(now_ms())
        .bind(now_ms() + 3_600_000)
        .execute(app.db().pool())
        .await
        .unwrap();

    assert_eq!(me_status(&app, &cookie).await, StatusCode::UNAUTHORIZED);
    assert_eq!(session_count(&app).await, 0);
}

#[tokio::test]
async fn use_slides_the_idle_window_at_most_once_a_minute() {
    let app = app_with_ana(&[]).await;
    let cookie = cookie_pair(&app.send(login_request("ana@example.com", PASSWORD)).await);
    let token = cookie.split_once('=').unwrap().1;

    let last_seen = || async {
        sqlx::query("SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = $1")
            .bind(hash_token(token))
            .fetch_one(app.db().pool())
            .await
            .map(|r| (r.get::<i64, _>(0), r.get::<i64, _>(1)))
            .unwrap()
    };
    let (seen, expires) = last_seen().await;

    me_status(&app, &cookie).await;
    assert_eq!(last_seen().await, (seen, expires));

    sqlx::query("UPDATE sessions SET last_seen_at = $1, expires_at = $2")
        .bind(seen - 120_000)
        .bind(expires - 120_000)
        .execute(app.db().pool())
        .await
        .unwrap();
    me_status(&app, &cookie).await;
    let (bumped_seen, bumped_expires) = last_seen().await;
    assert!(bumped_seen >= seen);
    assert!(bumped_expires >= expires);
}

#[tokio::test]
async fn the_sweep_removes_ended_sessions_only() {
    let app = app_with_ana(&[]).await;
    let live = cookie_pair(&app.send(login_request("ana@example.com", PASSWORD)).await);
    let dead = cookie_pair(&app.send(login_request("ana@example.com", PASSWORD)).await);
    let dead_token = dead.split_once('=').unwrap().1;
    sqlx::query("UPDATE sessions SET expires_at = 1 WHERE token_hash = $1")
        .bind(hash_token(dead_token))
        .execute(app.db().pool())
        .await
        .unwrap();

    let removed = api::auth::session::delete_ended(app.db(), now_ms())
        .await
        .unwrap();

    assert_eq!(removed, 1);
    assert_eq!(me_status(&app, &live).await, StatusCode::OK);
}

async fn fail_logins(app: &TestApp, email: &str, count: usize, headers: &[(&str, &str)]) {
    for _ in 0..count {
        let response = app
            .send(login_request_with(email, "wrong password here", headers))
            .await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn five_failures_for_an_email_and_address_refuse_even_the_right_password() {
    let app = app_with_ana(&[]).await;
    fail_logins(&app, "ana@example.com", 5, &[]).await;

    let response = app.send(login_request("ana@example.com", PASSWORD)).await;

    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.body["error"]["code"], "too_many_requests");
    let retry: u64 = response.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=900).contains(&retry));
}

#[tokio::test]
async fn throttling_applies_to_unknown_emails_too_and_is_checked_before_hashing() {
    // With every permit held, a login that reached hashing would answer 503.
    let app = TestApp::with_state(&[], |s| s.passwords = fast_passwords(1)).await;
    fail_logins(&app, "ghost@example.com", 5, &[]).await;

    let held = app
        .state
        .passwords
        .permits()
        .clone()
        .try_acquire_owned()
        .unwrap();
    let response = app.send(login_request("ghost@example.com", PASSWORD)).await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    drop(held);
}

#[tokio::test]
async fn another_address_is_not_blocked() {
    let app = app_with_ana(&[(TRUST_PROXY, "true")]).await;
    fail_logins(
        &app,
        "ana@example.com",
        5,
        &[("x-forwarded-for", "198.51.100.1")],
    )
    .await;

    let blocked = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("x-forwarded-for", "198.51.100.1")],
        ))
        .await;
    let elsewhere = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("x-forwarded-for", "198.51.100.2")],
        ))
        .await;

    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(elsewhere.status, StatusCode::OK);
}

#[tokio::test]
async fn twenty_failures_across_emails_refuse_the_address() {
    let app = app_with_ana(&[]).await;
    for i in 0..20 {
        fail_logins(&app, &format!("user{}@example.com", i / 4), 1, &[]).await;
    }
    let response = app.send(login_request("ana@example.com", PASSWORD)).await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_spoofed_forwarding_header_is_ignored_when_the_proxy_is_not_trusted() {
    let app = app_with_ana(&[]).await;
    for i in 0..20 {
        fail_logins(&app, &format!("user{}@example.com", i / 4), 1, &[]).await;
    }
    let response = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("x-forwarded-for", "203.0.113.9")],
        ))
        .await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn ipv6_neighbours_share_a_limit_and_only_the_last_forwarded_entry_counts() {
    let app = app_with_ana(&[(TRUST_PROXY, "true")]).await;
    for i in 0..20 {
        let address = format!("2001:db8:1:2::{:x}", i + 1);
        fail_logins(
            &app,
            &format!("user{}@example.com", i / 4),
            1,
            &[("x-forwarded-for", &address)],
        )
        .await;
    }
    let same_prefix = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("x-forwarded-for", "10.0.0.1, 2001:db8:1:2:ffff::9")],
        ))
        .await;
    assert_eq!(same_prefix.status, StatusCode::TOO_MANY_REQUESTS);

    let other_prefix = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("x-forwarded-for", "2001:db8:1:3::1")],
        ))
        .await;
    assert_eq!(other_prefix.status, StatusCode::OK);
}

#[tokio::test]
async fn a_forged_leftmost_forwarded_entry_cannot_change_the_bucket() {
    let app = app_with_ana(&[(TRUST_PROXY, "true")]).await;
    for i in 0..20 {
        let forged = format!("203.0.113.{}, 198.51.100.50", i + 1);
        fail_logins(
            &app,
            &format!("user{}@example.com", i / 4),
            1,
            &[("x-forwarded-for", &forged)],
        )
        .await;
    }
    let response = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("x-forwarded-for", "192.0.2.77, 198.51.100.50")],
        ))
        .await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn fly_client_ip_mode_counts_that_header_and_ignores_forwarded_for() {
    let app = app_with_ana(&[(TRUST_PROXY, "fly-client-ip")]).await;
    for i in 0..20 {
        let forged = format!("203.0.113.{}", i + 1);
        fail_logins(
            &app,
            &format!("user{}@example.com", i / 4),
            1,
            &[
                ("fly-client-ip", "198.51.100.50"),
                ("x-forwarded-for", &forged),
            ],
        )
        .await;
    }
    let same_fly_address = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[
                ("fly-client-ip", "198.51.100.50"),
                ("x-forwarded-for", "192.0.2.1"),
            ],
        ))
        .await;
    assert_eq!(same_fly_address.status, StatusCode::TOO_MANY_REQUESTS);

    let other_fly_address = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[
                ("fly-client-ip", "198.51.100.51"),
                ("x-forwarded-for", "198.51.100.50"),
            ],
        ))
        .await;
    assert_eq!(other_fly_address.status, StatusCode::OK);
}

#[tokio::test]
async fn a_missing_or_malformed_address_header_falls_back_to_the_peer_bucket() {
    for (mode, header) in [
        ("fly-client-ip", None),
        ("fly-client-ip", Some(("fly-client-ip", "not-an-ip"))),
        (
            "x-forwarded-for",
            Some(("x-forwarded-for", "1.2.3.4, junk")),
        ),
    ] {
        let app = app_with_ana(&[(TRUST_PROXY, mode)]).await;
        for i in 0..20 {
            fail_logins(&app, &format!("user{}@example.com", i / 4), 1, &[]).await;
        }
        let headers: Vec<(&str, &str)> = header.into_iter().collect();
        let response = app
            .send(login_request_with("ana@example.com", PASSWORD, &headers))
            .await;
        assert_eq!(
            response.status,
            StatusCode::TOO_MANY_REQUESTS,
            "{mode} {header:?}"
        );
    }
}

#[tokio::test]
async fn many_addresses_slow_an_email_down_without_refusing_it() {
    let throttle = Arc::new(LoginThrottle::new(Duration::from_millis(10)));
    let app = TestApp::with_state(&[(TRUST_PROXY, "true")], |s| {
        s.login_throttle = throttle.clone();
    })
    .await;
    app.create_user("ana@example.com", PASSWORD).await;
    // Dropped unfinished, so each counts as a failure from its own address.
    for i in 0..60 {
        let address = client_key(format!("10.1.{}.{}", i / 250, i % 250).parse().unwrap());
        throttle.begin("ana@example.com", &address).unwrap();
    }

    let started = Instant::now();
    let response = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("x-forwarded-for", "198.51.100.77")],
        ))
        .await;

    assert_eq!(response.status, StatusCode::OK);
    assert!(
        started.elapsed() >= Duration::from_millis(150),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn parallel_wrong_passwords_are_counted_before_any_has_finished() {
    let app = app_with_ana(&[]).await;
    let responses = join_all(
        (0..10).map(|_| app.send(login_request("ana@example.com", "wrong password here"))),
    )
    .await;

    let checked = responses
        .iter()
        .filter(|r| {
            r.status == StatusCode::UNAUTHORIZED || r.status == StatusCode::SERVICE_UNAVAILABLE
        })
        .count();
    let refused = responses
        .iter()
        .filter(|r| r.status == StatusCode::TOO_MANY_REQUESTS)
        .count();
    assert_eq!(checked, 5);
    assert_eq!(refused, 5);
}

#[tokio::test]
async fn a_login_burst_never_hashes_more_than_the_permit_count_at_once() {
    // Default cost so each hash lasts long enough for the burst to overlap it.
    let app = TestApp::with_state(&[(TRUST_PROXY, "true")], |s| {
        s.passwords =
            api::auth::password::PasswordService::with_params(argon2::Params::default(), 4);
    })
    .await;
    let responses = join_all((0..50).map(|i| {
        let address = format!("198.51.100.{}", i + 1);
        let email = format!("user{i}@example.com");
        let app = &app;
        async move {
            app.send(login_request_with(
                &email,
                "wrong password here",
                &[("x-forwarded-for", &address)],
            ))
            .await
        }
    }))
    .await;

    assert!(app.state.passwords.peak_in_flight() <= 4);
    let busy: Vec<_> = responses
        .iter()
        .filter(|r| r.status == StatusCode::SERVICE_UNAVAILABLE)
        .collect();
    assert!(!busy.is_empty(), "a burst of 50 must overflow 4 permits");
    for response in &busy {
        assert_eq!(response.body["error"]["code"], "server_busy");
        assert_eq!(response.headers[header::RETRY_AFTER], "1");
    }
    for response in &responses {
        assert!(
            matches!(
                response.status,
                StatusCode::UNAUTHORIZED | StatusCode::SERVICE_UNAVAILABLE
            ),
            "{}",
            response.status
        );
    }
}

#[tokio::test]
async fn a_busy_server_does_not_count_the_attempt_against_the_client() {
    let app = TestApp::with_state(&[], |s| s.passwords = fast_passwords(1)).await;
    app.create_user("ana@example.com", PASSWORD).await;
    let held = app
        .state
        .passwords
        .permits()
        .clone()
        .try_acquire_owned()
        .unwrap();
    for _ in 0..8 {
        let busy = app.send(login_request("ana@example.com", PASSWORD)).await;
        assert_eq!(busy.status, StatusCode::SERVICE_UNAVAILABLE);
    }
    drop(held);
    let ok = app.send(login_request("ana@example.com", PASSWORD)).await;
    assert_eq!(ok.status, StatusCode::OK);
}

#[tokio::test]
async fn generation_without_a_session_is_401_and_calls_no_provider() {
    let app = app_with_ana(&[]).await;
    let response = app
        .send(request(
            "POST",
            "/api/v1/patterns/generate",
            None,
            Some(json!({"instrument": "drums", "prompt": "four on the floor", "measures": 4})),
        ))
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.body["error"]["code"], "unauthenticated");
    assert_eq!(app.calls(), 0);
}

#[tokio::test]
async fn instruments_need_a_session_and_health_does_not() {
    let app = app_with_ana(&[]).await;
    let instruments = app
        .send(request("GET", "/api/v1/instruments", None, None))
        .await;
    assert_eq!(instruments.status, StatusCode::UNAUTHORIZED);
    for path in ["/healthz", "/readyz"] {
        let response = app.send(request("GET", path, None, None)).await;
        assert_eq!(response.status, StatusCode::OK, "{path}");
    }
    let cookie = app.cookie_for("ana@example.com").await;
    let signed_in = app
        .send(request("GET", "/api/v1/instruments", Some(&cookie), None))
        .await;
    assert_eq!(signed_in.status, StatusCode::OK);
}

#[tokio::test]
async fn a_cross_site_write_with_a_valid_session_is_forbidden_and_stores_nothing() {
    let app = app_with_ana(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let mut req = request(
        "POST",
        "/api/v1/projects",
        Some(&cookie),
        Some(json!({"song": common::app::song("Late Train", 1)})),
    );
    req.headers_mut()
        .insert(header::ORIGIN, "https://evil.example".parse().unwrap());

    let response = app.send(req).await;

    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.body["error"]["code"], "forbidden");
    let stored: i64 = sqlx::query("SELECT COUNT(*) FROM projects")
        .fetch_one(app.db().pool())
        .await
        .unwrap()
        .get(0);
    assert_eq!(stored, 0);
}

#[tokio::test]
async fn a_cross_site_login_is_forbidden_and_sets_no_cookie_or_session() {
    let app = app_with_ana(&[]).await;
    let response = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("origin", "https://evil.example")],
        ))
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.body["error"]["code"], "forbidden");
    assert!(response.headers.get(header::SET_COOKIE).is_none());
    assert_eq!(session_count(&app).await, 0);
}

#[tokio::test]
async fn the_backends_own_host_is_not_an_allowed_origin() {
    let app = app_with_ana(&[]).await;
    let response = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("host", "backend:8080"), ("origin", "http://backend:8080")],
        ))
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_configured_origin_and_a_missing_origin_are_allowed_and_reads_ignore_origin() {
    let app = app_with_ana(&[]).await;
    let with_origin = app
        .send(login_request_with(
            "ana@example.com",
            PASSWORD,
            &[("origin", ALLOWED_ORIGIN)],
        ))
        .await;
    assert_eq!(with_origin.status, StatusCode::OK);

    let mut get = request(
        "GET",
        "/api/v1/auth/me",
        Some(&cookie_pair(&with_origin)),
        None,
    );
    get.headers_mut()
        .insert(header::ORIGIN, "https://evil.example".parse().unwrap());
    assert_eq!(app.send(get).await.status, StatusCode::OK);
}

#[tokio::test]
async fn cors_preflight_allows_put_and_delete() {
    let app = app_with_ana(&[]).await;
    for method in ["PUT", "DELETE"] {
        let mut req = request("OPTIONS", "/api/v1/projects/x", None, None);
        req.headers_mut()
            .insert(header::ORIGIN, ALLOWED_ORIGIN.parse().unwrap());
        req.headers_mut().insert(
            header::ACCESS_CONTROL_REQUEST_METHOD,
            method.parse().unwrap(),
        );
        let response = app.send(req).await;
        let allowed = response.headers[header::ACCESS_CONTROL_ALLOW_METHODS]
            .to_str()
            .unwrap()
            .to_string();
        assert!(allowed.contains(method), "{allowed}");
    }
}

#[tokio::test]
async fn every_api_response_is_no_store_including_errors() {
    let app = app_with_ana(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    for response in [
        app.send(request("GET", "/api/v1/auth/me", Some(&cookie), None))
            .await,
        app.send(request("GET", "/api/v1/auth/me", None, None))
            .await,
        app.send(request("GET", "/api/v1/nothing-here", None, None))
            .await,
        app.send(login_request("ana@example.com", "wrong password here"))
            .await,
    ] {
        assert_eq!(
            response.headers[header::CACHE_CONTROL],
            "no-store",
            "{}",
            response.status
        );
    }
    let health = app.send(request("GET", "/healthz", None, None)).await;
    assert!(health.headers.get(header::CACHE_CONTROL).is_none());
}
