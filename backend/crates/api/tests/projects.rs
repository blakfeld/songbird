mod common;

use api::project_store::{MAX_PROJECTS_PER_USER, MAX_STORED_BYTES_PER_USER};
use axum::http::{header, StatusCode};
use common::app::{request, song, Response, TestApp};
use futures_util::future::join;
use serde_json::{json, Value};
use sqlx::Row;

async fn create(app: &TestApp, cookie: &str, song: Value) -> Response {
    app.send(request(
        "POST",
        "/api/v1/projects",
        Some(cookie),
        Some(json!({"song": song})),
    ))
    .await
}

fn project_id(response: &Response) -> String {
    response.body["project"]["id"].as_str().unwrap().to_string()
}

async fn open(app: &TestApp, cookie: &str, id: &str) -> Response {
    app.send(request(
        "GET",
        &format!("/api/v1/projects/{id}"),
        Some(cookie),
        None,
    ))
    .await
}

async fn save(app: &TestApp, cookie: &str, id: &str, song: Value, revision: i64) -> Response {
    app.send(request(
        "PUT",
        &format!("/api/v1/projects/{id}"),
        Some(cookie),
        Some(json!({"song": song, "revision": revision})),
    ))
    .await
}

async fn remove(app: &TestApp, cookie: &str, id: &str) -> Response {
    app.send(request(
        "DELETE",
        &format!("/api/v1/projects/{id}"),
        Some(cookie),
        None,
    ))
    .await
}

/// Saves are refused within a second of the last one, so tests that save twice
/// move the last-save time back instead of sleeping.
async fn age_saves(app: &TestApp) {
    sqlx::query("UPDATE projects SET updated_at = updated_at - 5000")
        .execute(app.db().pool())
        .await
        .unwrap();
}

async fn project_count(app: &TestApp) -> i64 {
    sqlx::query("SELECT COUNT(*) FROM projects")
        .fetch_one(app.db().pool())
        .await
        .unwrap()
        .get(0)
}

fn with_id(mut song: Value, id: &str) -> Value {
    song["id"] = json!(id);
    song
}

fn song_with_audio_track() -> Value {
    let mut value = song("Breaks", 1);
    value["samples"] = json!([{
        "id": "s1", "name": "Break", "sample_rate": 48000, "channels": 2,
        "length_samples": 120000, "origin": "import",
    }]);
    value["tracks"].as_array_mut().unwrap().push(json!({
        "id": "t9", "name": "Loops", "instrument": "audio",
        "volume_db": 0, "pan": 0, "muted": false, "soloed": false,
        "loops": [], "clips": [],
        "audio_clips": [{
            "id": "a1", "sample_id": "s1", "start_ticks": 0, "offset_samples": 0,
            "slice_samples": 120000, "length_samples": 120000,
        }],
    }));
    value
}

#[tokio::test]
async fn a_song_with_an_audio_track_can_be_created_saved_and_reopened() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;

    let created = create(&app, &cookie, song_with_audio_track()).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let id = project_id(&created);

    age_saves(&app).await;
    let saved = save(&app, &cookie, &id, with_id(song_with_audio_track(), &id), 1).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);

    let opened = open(&app, &cookie, &id).await;
    assert_eq!(
        opened.body["project"]["song"]["tracks"][1]["audio_clips"][0]["sample_id"],
        "s1"
    );
}

#[tokio::test]
async fn create_returns_201_with_a_server_id_revision_1_and_the_id_inside_the_song() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;

    let response = create(&app, &cookie, song("Late Train", 2)).await;

    assert_eq!(response.status, StatusCode::CREATED);
    let id = project_id(&response);
    assert_ne!(id, "client-chosen-id");
    assert_eq!(response.body["project"]["revision"], 1);
    assert!(response.body["project"]["updated_at"].as_i64().unwrap() > 0);
    assert_eq!(response.body["project"]["song"]["id"], id);
    assert_eq!(response.body["project"]["song"]["name"], "Late Train");

    let list = app
        .send(request("GET", "/api/v1/projects", Some(&cookie), None))
        .await;
    assert_eq!(list.status, StatusCode::OK);
    let entry = &list.body["projects"][0];
    assert_eq!(entry["id"], id);
    assert_eq!(entry["name"], "Late Train");
    assert_eq!(entry["time_signature"], "4/4");
    assert_eq!(entry["track_count"], 2);
    assert_eq!(entry["revision"], 1);
    assert!(
        entry.get("song").is_none(),
        "the list carries no song contents"
    );
}

#[tokio::test]
async fn a_client_chosen_id_cannot_collide_with_another_users_project() {
    let app = TestApp::new(&[]).await;
    let ana = app.cookie_for("ana@example.com").await;
    let bo = app.cookie_for("bo@example.com").await;
    let anas = project_id(&create(&app, &ana, song("Ana", 1)).await);

    let bos = create(&app, &bo, with_id(song("Bo", 1), &anas)).await;

    assert_eq!(bos.status, StatusCode::CREATED);
    assert_ne!(project_id(&bos), anas);
    let still = open(&app, &ana, &anas).await;
    assert_eq!(still.body["project"]["song"]["name"], "Ana");
    assert_eq!(still.body["project"]["revision"], 1);
}

#[tokio::test]
async fn list_has_only_my_projects_newest_first() {
    let app = TestApp::new(&[]).await;
    let ana = app.cookie_for("ana@example.com").await;
    let bo = app.cookie_for("bo@example.com").await;
    create(&app, &ana, song("Late Train", 1)).await;
    age_saves(&app).await;
    create(&app, &ana, song("Second", 1)).await;
    create(&app, &bo, song("Morning", 1)).await;

    let list = app
        .send(request("GET", "/api/v1/projects", Some(&ana), None))
        .await;

    let names: Vec<&str> = list.body["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Second", "Late Train"]);
}

#[tokio::test]
async fn unknown_song_fields_survive_storage() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let mut with_extra = song("Late Train", 1);
    with_extra["mood"] = json!("wistful");
    with_extra["tracks"][0]["future_field"] = json!({"nested": [1, 2, 3]});

    let id = project_id(&create(&app, &cookie, with_extra).await);
    let opened = open(&app, &cookie, &id).await;

    assert_eq!(opened.body["project"]["song"]["mood"], "wistful");
    assert_eq!(
        opened.body["project"]["song"]["tracks"][0]["future_field"],
        json!({"nested": [1, 2, 3]})
    );
}

#[tokio::test]
async fn a_song_with_no_tracks_is_a_valid_project() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let response = create(&app, &cookie, song("Empty", 0)).await;
    assert_eq!(response.status, StatusCode::CREATED);
    assert_eq!(response.body["project"]["song"]["tracks"], json!([]));
}

#[tokio::test]
async fn save_replaces_the_song_and_bumps_the_revision() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let id = project_id(&create(&app, &cookie, song("Late Train", 1)).await);
    age_saves(&app).await;

    let mut changed = with_id(song("Late Train", 1), &id);
    changed["tempo_bpm"] = json!(140);
    let saved = save(&app, &cookie, &id, changed, 1).await;

    assert_eq!(saved.status, StatusCode::OK);
    assert_eq!(saved.body["revision"], 2);
    assert!(saved.body["updated_at"].as_i64().unwrap() > 0);
    let opened = open(&app, &cookie, &id).await;
    assert_eq!(opened.body["project"]["song"]["tempo_bpm"], 140);
    assert_eq!(opened.body["project"]["revision"], 2);
}

#[tokio::test]
async fn a_stale_revision_is_409_and_changes_nothing() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let id = project_id(&create(&app, &cookie, song("Late Train", 1)).await);
    age_saves(&app).await;
    save(&app, &cookie, &id, with_id(song("Tab one", 1), &id), 1).await;
    age_saves(&app).await;

    let stale = save(&app, &cookie, &id, with_id(song("Tab two", 1), &id), 1).await;

    assert_eq!(stale.status, StatusCode::CONFLICT);
    assert_eq!(stale.body["error"]["code"], "revision_conflict");
    let opened = open(&app, &cookie, &id).await;
    assert_eq!(opened.body["project"]["song"]["name"], "Tab one");
    assert_eq!(opened.body["project"]["revision"], 2);
}

#[tokio::test]
async fn a_song_id_that_differs_from_the_path_is_422_and_neither_project_changes() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let first = project_id(&create(&app, &cookie, song("First", 1)).await);
    let second = project_id(&create(&app, &cookie, song("Second", 1)).await);
    age_saves(&app).await;

    let response = save(
        &app,
        &cookie,
        &first,
        with_id(song("Second again", 1), &second),
        1,
    )
    .await;

    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.body["error"]["code"], "id_mismatch");
    for (id, name) in [(&first, "First"), (&second, "Second")] {
        let opened = open(&app, &cookie, id).await;
        assert_eq!(opened.body["project"]["song"]["name"], name);
        assert_eq!(opened.body["project"]["revision"], 1);
    }
}

#[tokio::test]
async fn saves_less_than_a_second_apart_get_429_and_keep_the_first_save() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let id = project_id(&create(&app, &cookie, song("Late Train", 1)).await);
    age_saves(&app).await;
    let first = save(&app, &cookie, &id, with_id(song("First save", 1), &id), 1).await;
    assert_eq!(first.status, StatusCode::OK);

    let second = save(&app, &cookie, &id, with_id(song("Second save", 1), &id), 2).await;

    assert_eq!(second.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(second.body["error"]["code"], "too_many_requests");
    let retry: u64 = second.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=2).contains(&retry));
    let opened = open(&app, &cookie, &id).await;
    assert_eq!(opened.body["project"]["song"]["name"], "First save");
    assert_eq!(opened.body["project"]["revision"], 2);
}

#[tokio::test]
async fn an_invalid_song_is_422_with_the_export_code_and_changes_nothing() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let id = project_id(&create(&app, &cookie, song("Late Train", 1)).await);
    age_saves(&app).await;

    let mut overlapping = with_id(song("Broken", 1), &id);
    overlapping["tracks"][0]["clips"] = json!([
        {"id": "c0", "loop_id": "l0", "start_measure": 1, "measures": 3},
        {"id": "c9", "loop_id": "l0", "start_measure": 2, "measures": 2},
    ]);
    let response = save(&app, &cookie, &id, overlapping.clone(), 1).await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.body["error"]["code"], "invalid_song");

    let created = create(&app, &cookie, overlapping).await;
    assert_eq!(created.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(project_count(&app).await, 1);
    let opened = open(&app, &cookie, &id).await;
    assert_eq!(opened.body["project"]["song"]["name"], "Late Train");
    assert_eq!(opened.body["project"]["revision"], 1);
}

#[tokio::test]
async fn bodies_that_are_not_json_or_miss_song_or_revision_are_400() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let id = project_id(&create(&app, &cookie, song("Late Train", 1)).await);
    age_saves(&app).await;

    for (method, uri, body) in [
        ("POST", "/api/v1/projects".to_string(), json!({})),
        (
            "POST",
            "/api/v1/projects".to_string(),
            json!({"song": "text"}),
        ),
        (
            "PUT",
            format!("/api/v1/projects/{id}"),
            json!({"song": with_id(song("x", 1), &id)}),
        ),
        (
            "PUT",
            format!("/api/v1/projects/{id}"),
            json!({"revision": 1}),
        ),
    ] {
        let response = app
            .send(request(method, &uri, Some(&cookie), Some(body)))
            .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{method} {uri}");
    }
    let mut raw = request("POST", "/api/v1/projects", Some(&cookie), None);
    *raw.body_mut() = axum::body::Body::from("not json");
    raw.headers_mut()
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    assert_eq!(app.send(raw).await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delete_removes_the_project_and_a_second_delete_is_404() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let id = project_id(&create(&app, &cookie, song("Demo", 1)).await);

    let deleted = remove(&app, &cookie, &id).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert_eq!(open(&app, &cookie, &id).await.status, StatusCode::NOT_FOUND);
    let again = remove(&app, &cookie, &id).await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    assert_eq!(again.body["error"]["code"], "not_found");
}

#[tokio::test]
async fn deleting_or_saving_an_id_that_was_never_used_is_404() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let never = "019f0000-0000-7000-8000-000000000000";
    assert_eq!(
        remove(&app, &cookie, never).await.status,
        StatusCode::NOT_FOUND
    );
    let put = save(&app, &cookie, never, with_id(song("x", 1), never), 1).await;
    assert_eq!(put.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn every_project_route_needs_a_session() {
    let app = TestApp::new(&[]).await;
    for (method, uri) in [
        ("GET", "/api/v1/projects"),
        ("POST", "/api/v1/projects"),
        ("GET", "/api/v1/projects/x"),
        ("PUT", "/api/v1/projects/x"),
        ("DELETE", "/api/v1/projects/x"),
    ] {
        let response = app.send(request(method, uri, None, Some(json!({})))).await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        assert_eq!(response.body["error"]["code"], "unauthenticated");
    }
}

#[tokio::test]
async fn another_users_project_is_indistinguishable_from_one_that_never_existed() {
    let app = TestApp::new(&[]).await;
    let ana = app.cookie_for("ana@example.com").await;
    let bo = app.cookie_for("bo@example.com").await;
    let id = project_id(&create(&app, &ana, song("Ana's song", 1)).await);
    age_saves(&app).await;
    // Bring it to revision 4 so "A's current revision" is not the initial one.
    for revision in 1..=3 {
        let saved = save(
            &app,
            &ana,
            &id,
            with_id(song("Ana's song", 1), &id),
            revision,
        )
        .await;
        assert_eq!(saved.status, StatusCode::OK);
        age_saves(&app).await;
    }
    let before = open(&app, &ana, &id).await;
    assert_eq!(before.body["project"]["revision"], 4);
    let never = "019f0000-0000-7000-8000-000000000000";

    let mut foreign = Vec::new();
    let mut unused = Vec::new();
    for (target, sink) in [(id.as_str(), &mut foreign), (never, &mut unused)] {
        sink.push(open(&app, &bo, target).await);
        sink.push(save(&app, &bo, target, with_id(song("Hijack", 1), target), 1).await);
        sink.push(save(&app, &bo, target, with_id(song("Hijack", 1), target), 4).await);
        sink.push(remove(&app, &bo, target).await);
    }

    for (theirs, never_used) in foreign.iter().zip(&unused) {
        assert_eq!(theirs.status, StatusCode::NOT_FOUND);
        assert_ne!(theirs.status, StatusCode::CONFLICT);
        assert_eq!(theirs.body, never_used.body);
        assert_eq!(theirs.body["error"]["code"], "not_found");
    }
    let after = open(&app, &ana, &id).await;
    assert_eq!(after.body, before.body);
}

async fn insert_rows(app: &TestApp, owner_id: &str, count: i64, size_bytes: i64) {
    let mut tx = app.db().pool().begin().await.unwrap();
    for i in 0..count {
        sqlx::query(
            "INSERT INTO projects (id, owner_id, name, time_signature, track_count, song, size_bytes, revision, created_at, updated_at) \
             VALUES ($1, $2, 'filler', '4/4', 0, '{}', $3, 1, 0, 0)",
        )
        .bind(format!("filler-{owner_id}-{i}"))
        .bind(owner_id)
        .bind(size_bytes)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn two_concurrent_creates_at_499_projects_leave_exactly_500() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let ana = api::users::find_by_email(app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    insert_rows(&app, &ana.id, MAX_PROJECTS_PER_USER - 1, 2).await;

    let (a, b) = join(
        create(&app, &cookie, song("One", 1)),
        create(&app, &cookie, song("Two", 1)),
    )
    .await;

    let mut statuses = [a.status, b.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::CONFLICT]);
    let refused = if a.status == StatusCode::CONFLICT {
        &a
    } else {
        &b
    };
    assert_eq!(refused.body["error"]["code"], "project_limit");
    assert_eq!(project_count(&app).await, MAX_PROJECTS_PER_USER);
}

#[tokio::test]
async fn the_project_count_limit_is_per_user() {
    let app = TestApp::new(&[]).await;
    let ana = app.cookie_for("ana@example.com").await;
    let bo = app.cookie_for("bo@example.com").await;
    let user = api::users::find_by_email(app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    insert_rows(&app, &user.id, MAX_PROJECTS_PER_USER, 2).await;

    assert_eq!(
        create(&app, &ana, song("One too many", 1)).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        create(&app, &bo, song("Fine", 1)).await.status,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn a_create_that_would_pass_the_storage_quota_is_409_and_stores_nothing() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let user = api::users::find_by_email(app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    insert_rows(&app, &user.id, 1, MAX_STORED_BYTES_PER_USER - 10).await;

    let response = create(&app, &cookie, song("Too big for what is left", 1)).await;

    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_eq!(response.body["error"]["code"], "project_limit");
    assert_eq!(project_count(&app).await, 1);
}

#[tokio::test]
async fn a_save_that_would_pass_the_storage_quota_is_409_and_rolled_back() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let user = api::users::find_by_email(app.db(), "ana@example.com")
        .await
        .unwrap()
        .unwrap();
    let id = project_id(&create(&app, &cookie, song("Small", 1)).await);
    insert_rows(&app, &user.id, 1, MAX_STORED_BYTES_PER_USER - 100).await;
    age_saves(&app).await;

    let response = save(
        &app,
        &cookie,
        &id,
        with_id(song("Grown past the limit", 3), &id),
        1,
    )
    .await;

    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_eq!(response.body["error"]["code"], "project_limit");
    let opened = open(&app, &cookie, &id).await;
    assert_eq!(opened.body["project"]["song"]["name"], "Small");
    assert_eq!(opened.body["project"]["revision"], 1);
}

fn dense_song(tracks: usize) -> Value {
    let rows = music::instruments::piano::PIANO.row_list();
    let notes: Vec<Value> = (0..128 * 16)
        .enumerate()
        .map(|(i, step)| {
            json!({"row_id": rows[i % rows.len()].id, "step": step, "length_steps": 1, "velocity": 100})
        })
        .collect();
    let track_list: Vec<Value> = (0..tracks)
        .map(|i| {
            json!({
                "id": format!("t{i}"), "name": format!("Track {i}"), "instrument": "piano",
                "volume_db": 0, "pan": 0, "muted": false, "soloed": false,
                "loops": [{"id": format!("l{i}"), "name": "Loop", "measures": 128, "notes": notes}],
                "clips": [{"id": format!("c{i}"), "loop_id": format!("l{i}"), "start_measure": 1, "measures": 128}],
            })
        })
        .collect();
    json!({
        "version": 2, "id": "x", "name": "Big", "tempo_bpm": 96,
        "time_signature": "4/4", "steps_per_measure": 16, "swing": 0,
        "measures": 128, "tracks": track_list,
    })
}

#[tokio::test]
async fn a_song_of_about_two_mebibytes_can_be_created_and_saved_but_three_cannot() {
    let app = TestApp::new(&[]).await;
    let cookie = app.cookie_for("ana@example.com").await;
    let big = dense_song(16);
    assert!(big.to_string().len() > 1_800_000);

    let created = create(&app, &cookie, big.clone()).await;
    assert_eq!(created.status, StatusCode::CREATED);
    let id = project_id(&created);
    age_saves(&app).await;
    let saved = save(&app, &cookie, &id, with_id(big.clone(), &id), 1).await;
    assert_eq!(saved.status, StatusCode::OK);

    let oversized = "x".repeat(3 * 1024 * 1024);
    let rejected = create(&app, &cookie, json!({"name": oversized})).await;
    assert_eq!(rejected.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(rejected.body["error"]["code"], "payload_too_large");
}
