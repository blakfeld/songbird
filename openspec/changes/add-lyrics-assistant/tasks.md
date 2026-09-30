# Tasks

## 1. Lyrics domain in the `music` crate

- [ ] 1.1 Add `backend/crates/music/src/lyrics/request.rs` with `LyricsRequestBody` (`song_context`, `lyrics`, `selection`, `messages`) and validation into `LyricsRequest`. Use the fixed limits from design D4 and the error codes `invalid_messages`, `prompt_too_long` (reusing `tokens::estimate_tokens` and the configured `max_input_tokens`), `lyrics_too_long`, `invalid_selection`, and `invalid_song_context`. Verify with one unit test per error code, the 20-vs-21 message boundary, the 1024/1025-character user-message boundary at limit 256, and selection `from > to`.
- [ ] 1.2 Add `lyrics/prompt.rs`: a system prompt that states the reply-and-suggestions role and that all fenced text is data; a user prompt that serializes messages, lyrics, selection, and song context into escaped fenced blocks (design D1); and a per-request schema with `action` and `section_id` enums passed through `strictify` (design D2). Verify with unit tests that a lyric containing `</lyrics>` arrives escaped inside the fence, that the schema's `section_id` enum equals the request's section ids, and with a snapshot of the schema for a two-section request.
- [ ] 1.3 Add `lyrics/draft.rs` with a lenient `LyricsDraft` parse and `normalize` that truncates reply, text, and label, caps suggestions at 5, drops empty or unknown-action suggestions and unknown `section_id`s, drops `replace_selection` when the selection is absent or empty, and assigns ids `s1..`. Verify with unit tests for each spec normalization scenario.
- [ ] 1.4 Add `lyrics::assist(provider, &LyricsRequest)` with the same retry-only-unusable-output policy as `generate_pattern` (2 attempts). Verify with tests using a scripted fake provider: unparseable then valid succeeds; unparseable twice gives `InvalidDraft`; a transport error is not retried.
- [ ] 1.5 Add ts-rs derives for the request body, `LyricsResponse`, `LyricSuggestion`, and `SuggestionAction`, and register them in `music/tests/ts_bindings.rs`. Run `just gen-types` and verify `cargo test -p music --test ts_bindings` passes with the new `frontend/src/generated/*.ts` committed.

## 2. Provider seam and mock

- [ ] 2.1 Add `LyricsProvider` in `music/src/ai/mod.rs` and implement it for `SchemaProvider<T>`, which shares its `Arc<T>` transport with the pattern and chord adapters from #8. Verify the existing pattern and chord provider tests still pass unchanged.
- [ ] 2.2 Implement `LyricsProvider` for `MockProvider` per design D5. Verify with unit tests that the same request gives an identical response, that a selection yields a `replace_selection` suggestion, and that a request with section `"chorus-1"` yields `replace_section` for `"chorus-1"`.
- [ ] 2.3 Add a Claude transport test (with the existing HTTP mocking approach) showing a lyrics `StructuredRequest` is sent as a forced tool call with the lyrics schema. Add a live test under `just test-live` / `just test-live-ollama` that asks for a chorus and asserts a normalized non-empty reply. Verify the live tests are skipped by `just test`.

## 3. API endpoint

- [ ] 3.1 Add `lyrics: Arc<dyn LyricsProvider>` to #8's `Providers` bundle and fill it in `build_providers` for every provider choice (design D3; if #8 has not landed, introduce the bundle in the shape D3 describes). Verify that the existing `api/src/provider.rs` startup tests pass and that `check()` still runs once per transport.
- [ ] 3.2 Add `backend/crates/api/src/lyrics.rs` with `POST /api/v1/lyrics/assist`: validate before calling the provider, wrap the call in the configured generation timeout, and map errors to `generation_failed` / `generation_timeout`. Merge the router in `routes.rs`. Verify with `oneshot` integration tests on the mock provider: 200 shape, one 422 per error code with a fake provider asserting zero calls, 502 after two bad outputs, 504 with a hanging fake provider, and a 100 KiB lyrics body accepted (relies on #5's 1 MiB limit for `/api/v1/lyrics/`).
- [ ] 3.3 Document the endpoint and its limits in `backend/README.md`, and verify the documented `curl` example returns 200 against `SONGBIRD_AI_PROVIDER=mock just dev`.
- [ ] 3.4 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify both pass with no warnings.

## 4. Song document fields and pure lyric logic (frontend)

- [ ] 4.1 Add optional `lyrics` and `lyric_chat` (with `LyricChatMessage`) to the Rust `Song` in `backend/crates/music/src/song.rs` (`#[serde(default, skip_serializing_if = ...)]`). Extend `Song::validate` with the 20,000-character lyrics limit and the 20-message chat limit, register the new types in `tests/ts_bindings.rs`, and run `just gen-types`. Extend `lib/song/projectFile.ts` validation to match, and add valid and over-limit cases to `fixtures/song_validation.json` (#5's versioning policy: song `version` stays 2). Verify that the Rust and Vitest fixture tests pass and that a song without these fields serializes byte-identically.
- [ ] 4.2 Wire `lyrics` and `lyric_chat` into the song store (defaults `""` / `[]`, chat trimmed to the latest 20) and keep them out of song undo/redo history. Verify with Vitest that an old stored song loads with empty lyrics, that a project file round-trips lyrics and chat, and that song undo does not revert a lyrics change.
- [ ] 4.3 Add `frontend/src/lib/lyrics/limits.ts` (constants mirroring D4) and `sections.ts` (heading parsing, case-insensitive linking, "Add section headings" computation). Verify with Vitest cases covering the spec scenarios: link, unlinked, and scaffold that preserves existing text.
- [ ] 4.4 Add `lib/lyrics/applySuggestion.ts` returning a change spec plus an optional notice for `insert`, `replace_selection` (with stale-selection fallback), and `replace_section` (existing and missing heading). Verify with Vitest for each spec scenario.
- [ ] 4.5 Add `lib/lyrics/songContext.ts` (song → `song_context`, including chords when #8's data is present and `[]` otherwise) and `assistLyrics` in `lib/api.ts`. Verify with Vitest that a song without sections sends one implicit section and that the API error shape surfaces its message.

## 5. Notepad and chat UI

- [ ] 5.1 Add the `@codemirror/state`, `@codemirror/view`, and `@codemirror/commands` dependencies and create `components/lyrics/LyricsEditor.tsx` (client-only via `next/dynamic`, `ssr: false`). Include history, line wrapping, a heading decoration with an unlinked marker, a 20,000-character change filter with a notice, a character counter above 18,000, and debounced sync to the song store. Verify with Vitest (jsdom) that typing updates the store, that a paste past the limit is refused, and that `pnpm build` succeeds with no SSR error.
- [ ] 5.2 Add `components/lyrics/AssistantChat.tsx` and `SuggestionCard.tsx`: the message list, input with `TokenCounter` against `max_input_tokens`, Send disabled when empty, over the limit, or in flight, a loading state, an error that keeps the unsent text, "Clear conversation", and per-suggestion action buttons that apply through a single `input.suggestion` transaction. Verify with Vitest that replies never auto-apply, that one undo reverts an applied suggestion, and that the failure path leaves the conversation and lyrics unchanged.
- [ ] 5.3 Mount a Lyrics panel on the `/studio` song page with the notepad and chat side by side at desktop width and stacked on narrow screens, plus an "Add section headings" action. Confirm with `ui-designer` review notes, and verify keyboard-only use (Tab into and out of the editor and chat) manually.
- [ ] 5.4 Add a Playwright e2e test in `frontend/e2e/lyrics.spec.ts` against the mock backend. It should cover: create a song with sections → add headings → type lyrics → select a line → send a message → apply `replace_selection` → apply `replace_section` → reload → lyrics and chat restored. Verify `pnpm test:e2e` passes.

## 6. Integration checks

- [ ] 6.1 Run `just lint` and `just test` from the repo root and verify both pass.
- [ ] 6.2 Run `openspec validate add-lyrics-assistant --strict` and verify it reports the change as valid.
- [ ] 6.3 Run a manual smoke test with `SONGBIRD_AI_PROVIDER=ollama`: a three-turn conversation about a chorus returns replies whose suggestions apply correctly. Record the model used in the PR description.
