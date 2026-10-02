# Tasks

## 1. Lyrics domain in the `music` crate

- [x] 1.1 Add `backend/crates/music/src/lyrics.rs` with `LyricsAssistBody` (`song_context`, `lyrics`, `selection`, `messages: Vec<ChatMessage>`) and `validate(max_input_tokens, max_context_tokens)` into a valid request. Use the limits from design D5, reuse the existing song constants and `validate_prompt`, and add `LyricsRequestError` with codes `invalid_messages`, `lyrics_too_long`, `invalid_selection`, and `invalid_song_context`. Verify with one unit test per error code, the 20-vs-21 message boundary, a 4,001-character earlier message, the 1,024/1,025-character last-message boundary at limit 256 (`prompt_too_long`), a blank last message (`invalid_prompt`), selection `from > to` and `to` past the end in UTF-16 units (an emoji counts 2), duplicate and blank section ids, 129 sections, and that ids `implicit` and `implicit-2` are accepted.
- [x] 1.2 Add `render_prompt` (design D1, D5): `<song>` lines, per-section `<notes>`, fenced `<message>` blocks, `<lyrics>`, and `<selection>` holding the server-sliced text, with all client text escaped. Trim to `max_context_tokens` by dropping the oldest messages first, then notes from the last section backwards, never dropping the latest message, lyrics, or section lines. Verify with unit tests that a lyric containing `</lyrics>` and an assistant message containing `</message>` arrive escaped inside their fences, that trimming order matches D5, and that budget 0 keeps the latest message and lyrics. Add a snapshot of a two-section prompt to `music/tests/prompt_snapshot.rs` (its `check_snapshot` helper and `tests/snapshots/`).
- [x] 1.3 Add `LyricsDraft` (lenient parse) and `normalize`: truncate reply, text, and label; cap suggestions at 5; drop empty and unknown-action suggestions and unknown `section_id`s; drop `replace_selection` without a non-empty selection; assign ids `s1..`; and treat an empty reply as unusable with a new `DraftError::InvalidLyrics`. Verify with unit tests for each spec normalization scenario.
- [x] 1.4 Add `assist_lyrics(provider, &request)` with `plan_chat`'s retry loop (`generate::ATTEMPTS`). Verify with scripted fake providers: unparseable then valid succeeds; unparseable twice gives `GenerationError`; an empty reply twice gives `InvalidDraft`; a transport error and `ProviderError::Unauthorized` are returned after one call.
- [x] 1.5 Add ts-rs derives for the body, `LyricsSongContext`, `LyricsSectionContext`, `LyricSelection`, `LyricsAssistResponse`, `LyricSuggestion`, and `SuggestionAction`, and register them in `backend/crates/api/tests/ts_bindings.rs`. Run `just gen-types` and verify `cargo test -p api --test ts_bindings` passes with the new `frontend/src/generated/*.ts` committed.

## 2. Provider kind and mock

- [x] 2.1 Add `backend/crates/music/src/ai/lyrics.rs` with `LyricsProvider`, `LyricsRequest`, and `SchemaLyricsProvider<T>`. The adapter builds a per-request schema with `action` and `section_id` enums and passes it through `strictify` (design D2, D3). Verify with a `music/tests/schema_snapshot.rs` snapshot for a two-section request, with a test that the `section_id` enum equals the request's ids, and with `music/tests/openai_strict.rs` accepting the schema.
- [x] 2.2 Add `MockLyricsProvider` per design D10. Verify with unit tests that the same request gives an identical response, that a non-empty selection yields `replace_selection`, and that a first section `"chorus-1"` yields `replace_section` for `"chorus-1"`.
- [x] 2.3 Add a case to `music/tests/provider_contract.rs` (the existing wiremock approach) showing a lyrics request is sent to Claude as a forced tool call with the lyrics schema and to OpenAI as strict structured output. Add a live test in `music/tests/live.rs` that asks for a chorus and asserts a normalized non-empty reply. Verify that `just test` skips the live test and `just test-live-ollama` runs it.
- [x] 2.4 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify both pass with no warnings.

## 3. API endpoint

- [x] 3.1 In `api/src/provider.rs`, add `lyrics: Arc<dyn LyricsProvider>` to `Providers`. Fill it in `over` with `SchemaLyricsProvider`, and in `mock()` and `new()` with `MockLyricsProvider`, and add `with_lyrics` (design D3). In `api/src/ai_access.rs`, implement `LyricsProvider` for `Failing` and include it in `MockUserProviders::providers`. Verify that every existing `api` test passes unchanged and that the `provider.rs` startup tests still see one `check()` per transport.
- [x] 3.2 Add `ApiError::LyricsRejected { code, message }` (422) with `From<LyricsRequestError>`, and extend the status and code test in `error.rs`. Verify with that unit test.
- [x] 3.3 Add `api/src/lyrics.rs` with `ai_router()` and the `assist` handler from design D4, and merge it into the metered `ai` router in `routes.rs` with `DefaultBodyLimit::max(SONG_MAX_BODY_BYTES)`. Verify with a new `api/tests/lyrics.rs` using `tests/common/app.rs`:
  - 200 shape on the mock;
  - one 422 per error code, with a fake provider asserting zero calls;
  - 400 `invalid_json` for an unknown role;
  - 502 after two bad outputs;
  - 504 with a hanging fake;
  - 401 when signed out;
  - a cross-origin request refused;
  - a 500 KiB body accepted and a body over 2 MiB rejected with 413 `payload_too_large`.
- [x] 3.4 Extend the per-user access tests to cover the new route. Verify that `api/tests/user_ai_access.rs` gets 409 `api_key_required` with no daily count consumed when the user has no key, and that `-revoked`, `-quota`, and `-ratelimited` keys give the same codes as `/api/v1/songs/chat`. Verify that `api/tests/ai_limits.rs` gets 429 `too_many_requests` once the per-minute limit is spent across lyric and chat requests.
- [x] 3.5 Document `POST /api/v1/lyrics/assist`, its limits, its trimming, and its error codes in `backend/README.md`, next to `/api/v1/songs/chat`. Verify that the documented `curl` example returns 200 against `just dev` with the mock provider.
- [x] 3.6 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify both pass with no warnings.

## 4. `lyric_chat` on the song

- [x] 4.1 Add `LyricChatEntry`, `LyricChatSelection`, and `StoredLyricSuggestion`, plus `Song.lyric_chat` (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`), to `backend/crates/music/src/song.rs`. Add the `SongErrorKind::LyricChat` check to `Song::validate` (design D6) and register the types in `api/tests/ts_bindings.rs`. Run `just gen-types`. Verify with Rust unit tests at and over each limit, and that a song without the field serializes byte-identically. Verify with an `api/tests/projects.rs` case that saving 21 entries gives 422 `invalid_song` and leaves the stored project unchanged.
- [x] 4.2 Mirror the check in `frontend/src/lib/song/projectFile.ts` with a `"lyric_chat"` error kind, and add valid and over-limit cases to `fixtures/song_validation.json` (song `version` stays 2). Verify that both the Rust and Vitest fixture tests pass.
- [x] 4.3 Add `applyLyricReply` and `clearLyricChat` to `songStore.ts`, using `set` rather than `edit`, clipping to 4,000 characters, keeping the latest 20, and omitting an empty field. Add `"lyric_chat"` to `withLiveFields` in `songLoop.ts`. Verify with Vitest:
  - a reply is not an undo step;
  - song undo after a reply keeps the conversation;
  - clearing leaves `lyrics` and `chat` unchanged;
  - 21 messages trim to 20;
  - a project file round-trips the conversation with its suggestions;
  - an old song loads with none.
- [x] 4.4 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify both pass with no warnings.

## 5. Lyric logic and UI (frontend)

- [x] 5.1 Extend `frontend/src/lib/lyrics/headings.ts` with a capture group, `headingName`, and `lyricSections`. Add `lib/lyrics/sectionLinks.ts` with `linkKey`, `linkedSections`, and `missingHeadings` over `sectionsOf(song)` (design D8). Verify with Vitest cases for the spec scenarios: link with whitespace and case, unlinked, rename relinks, scaffold preserving existing text, scaffold of a 40-measure unsectioned song giving `[Song]` and `[Song 2]`, and duplicate section names sharing one heading. The existing `headings.test.ts` must still pass.
- [x] 5.2 Add `lib/lyrics/applySuggestion.ts` for `insert` (cursor, or end before first focus), `replace_selection` (with stale fallback), and `replace_section` (id, then stored name; existing heading, first of several, missing heading, implicit section that became real). Add `lib/lyrics/songContext.ts` (implicit ids sent as they are, `chords: []`) and `assistLyrics` in `lib/api.ts`. Verify with Vitest for each spec scenario, that an unsectioned song sends ids `implicit`, `implicit-2`, and that a 422 surfaces the server's message.
- [x] 5.3 Give `LyricsEditor.tsx` a `registerEditor` handle (`snapshot`, `apply` with `userEvent: "input.suggestion"`) and a section-key `Compartment` that drives an unlinked-heading marker (design D9). Add an "Add section headings" button to `LyricsPanel`. Verify with Vitest (jsdom) in `LyricsEditor.test.tsx`:
  - one undo reverts an applied suggestion;
  - an application past 20,000 characters is refused with the limit notice;
  - `snapshot` includes typing not yet synced;
  - renaming a section toggles the marker without resetting undo history;
  - the scaffold is one undo step.
- [x] 5.4 Add `components/lyrics/useLyricChat.ts`, `LyricChatPanel.tsx`, and `SuggestionCard.tsx`, and mount the panel below the notepad in `LyricsPanel` with a stored height (design D9). Include the message list, `TokenCounter` against `getSongLimits().max_input_tokens`, the key gate, the loading state, error with put-back, "Clear conversation", and per-suggestion actions. Get `ui-designer` review notes on the stacked layout in the tab and the drawer. Verify with a `StudioPage.lyrics.test.tsx` case:
  - replies never auto-apply;
  - the lyric and song chats show only their own messages;
  - a reply for a closed song is discarded;
  - failure leaves conversation and lyrics unchanged.

  Also verify keyboard-only use manually: Tab into and out of the notepad, the input, and the suggestion buttons.
- [x] 5.5 Add `frontend/e2e/lyrics-assistant.spec.ts` on the `user-mock` backend. Cover two flows. The first: create a song with sections → add headings → type lyrics → select a line → send → apply `replace_selection` → apply `replace_section` → reload → lyrics and conversation restored. The second: an unsectioned song → add headings → apply `replace_section` for "Song". Verify `pnpm test:e2e` passes.

## 6. Integration checks

- [x] 6.1 Run `just lint` and `just test` from the repo root and verify both pass.
- [x] 6.2 Run `openspec validate add-lyrics-assistant --strict` and verify it reports the change as valid.
- [ ] 6.3 Run a manual smoke test with `SONGBIRD_AI_PROVIDER=ollama`: a three-turn conversation about a chorus returns replies whose suggestions apply correctly. Record the model used in the PR description.
