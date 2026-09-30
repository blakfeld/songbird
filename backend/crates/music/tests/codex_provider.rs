mod common;

use std::sync::Arc;

use common::{request, FakeCodex, BAD_DRAFT};
use music::ai::{CodexCliProvider, PatternProvider, ProviderError, SchemaProvider};
use music::instruments::drums::DRUMS;

const GOOD: &str = r#"{"name":"Codex Groove","tempo_bpm":null,"swing":null,
  "sections":[{"id":"A","lanes":[{"lane":"kick","steps":"x..."}]}],"arrangement":["A"]}"#;

fn provider(fake: &FakeCodex, model: Option<&str>) -> SchemaProvider<CodexCliProvider> {
    SchemaProvider::new(CodexCliProvider::new(fake.bin(), model.map(String::from)))
}

#[tokio::test]
async fn success_returns_the_draft() {
    let fake = FakeCodex::new("ok", GOOD);
    let draft = provider(&fake, None)
        .generate(&request("rock", 4), &DRUMS)
        .await
        .unwrap();
    assert_eq!(draft.name, "Codex Groove");
}

#[tokio::test]
async fn passes_exactly_the_documented_flags_and_prompt_on_stdin() {
    let fake = FakeCodex::new("ok", GOOD);
    provider(&fake, Some("gpt-test"))
        .generate(&request("a mellow rock beat", 4), &DRUMS)
        .await
        .unwrap();

    let args = fake.args_log();
    let args: Vec<&str> = args.split_whitespace().collect();
    assert_eq!(
        &args[..8],
        [
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--color",
            "never",
            "--output-schema"
        ]
    );
    assert!(args[8].ends_with("schema.json"));
    assert_eq!(args[9], "--output-last-message");
    assert_eq!(args[11], "-C");
    assert_eq!(&args[13..], ["-m", "gpt-test", "-"]);

    let stdin = fake.stdin_log();
    assert!(stdin.contains("a mellow rock beat"));
    assert!(stdin.contains("hat_closed"));
}

#[tokio::test]
async fn invalid_output_is_reported_as_invalid_output() {
    let fake = FakeCodex::new("invalid", GOOD);
    let err = provider(&fake, None)
        .generate(&request("rock", 4), &DRUMS)
        .await
        .unwrap_err();
    assert!(matches!(err, ProviderError::InvalidOutput(_)));
}

#[tokio::test]
async fn non_zero_exit_is_a_request_error() {
    let fake = FakeCodex::new("fail", GOOD);
    let err = provider(&fake, None)
        .generate(&request("rock", 4), &DRUMS)
        .await
        .unwrap_err();
    assert!(matches!(err, ProviderError::Request(_)));
}

#[tokio::test]
async fn check_passes_when_signed_in() {
    let fake = FakeCodex::new("ok", GOOD);
    provider(&fake, None).check().await.unwrap();
}

#[tokio::test]
async fn check_says_to_log_in_when_signed_out() {
    let fake = FakeCodex::new("signed_out", GOOD);
    let err = provider(&fake, None).check().await.unwrap_err();
    assert!(err.to_string().contains("codex login"));
}

#[tokio::test]
async fn check_says_to_install_when_the_binary_is_missing() {
    let p = SchemaProvider::new(CodexCliProvider::new("/nonexistent/codex", None));
    let err = p.check().await.unwrap_err();
    assert!(err.to_string().contains("Install"));
    assert!(err.to_string().contains("SONGBIRD_CODEX_BIN"));
}

#[tokio::test]
async fn concurrent_requests_run_one_at_a_time() {
    let fake = FakeCodex::new("slow", GOOD);
    let p = Arc::new(provider(&fake, None));
    let run = |p: Arc<SchemaProvider<CodexCliProvider>>| {
        tokio::spawn(async move { p.generate(&request("rock", 4), &DRUMS).await })
    };
    let (a, b) = tokio::join!(run(p.clone()), run(p.clone()));
    a.unwrap().unwrap();
    b.unwrap().unwrap();
    assert_eq!(fake.args_log().lines().count(), 2);
    assert!(!fake.overlapped(), "two codex runs overlapped");
}

#[tokio::test]
async fn dropping_the_future_kills_the_child() {
    let fake = FakeCodex::new("hang", GOOD);
    let p = provider(&fake, None);
    let outcome = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        p.generate(&request("rock", 4), &DRUMS),
    )
    .await;
    assert!(outcome.is_err(), "hang mode should time out");
    let pid = std::fs::read_to_string(fake.dir.path().join("grandchild.pid"))
        .expect("fake codex recorded its grandchild")
        .trim()
        .to_string();
    let is_alive = || {
        std::process::Command::new("kill")
            .args(["-0", &pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    };
    for _ in 0..40 {
        if !is_alive() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("grandchild process {pid} survived the timeout");
}

#[tokio::test]
async fn check_times_out_when_the_cli_hangs() {
    let fake = FakeCodex::new("login_hang", GOOD);
    let p = SchemaProvider::new(
        CodexCliProvider::new(fake.bin(), None)
            .with_check_timeout(std::time::Duration::from_millis(200)),
    );
    let err = p.check().await.unwrap_err();
    assert!(matches!(err, ProviderError::Unavailable(_)));
    assert!(err.to_string().contains("did not answer"));
}

#[tokio::test]
async fn bad_drafts_from_codex_are_normalized_like_any_other() {
    let fake = FakeCodex::new("ok", BAD_DRAFT);
    let pattern = music::generate::generate_pattern(&provider(&fake, None), &request("x", 4))
        .await
        .unwrap();
    assert!(!pattern.notes.is_empty());
}
