# Tasks

## 1. Generation span and request plumbing (music crate)

- [ ] 1.1 Add `GenerationSpan` and refactor `expand.rs` into `build_notes(draft, span, instrument)` with `build_pattern` delegating (design D1); verify all existing `expand.rs`/`generate.rs` tests pass and new tests cover spans of 1, 5, and 7 measures (fallback variation at every 4th measure only for spans > 4)
- [ ] 1.2 Add `context: Option<String>` to `GenerateRequest`, the `<context>` block in `prompt::user_message`, and the context paragraph in the shared system prompt (design D2); verify a snapshot test that pattern prompts are byte-identical when `context` is `None` and a test that the context block precedes the description

## 2. Context rendering and budget

- [ ] 2.1 Implement `music/src/context.rs` rendering (header, target surroundings, drums step-strings, melodic per-beat pitches + bass, muted tracks excluded, names escaped) per design D3, reading only `ValidSong`'s resolved notes; verify unit tests for "Other tracks reach the provider", "Repeating clips are context", "Muted tracks are ignored", "Continuity with the target's surroundings", and "Track names cannot escape the context block" on the rendered string, plus a test that an unplaced loop's notes never appear
- [ ] 2.2 Implement budget trimming (distance-first, then later tracks) using `tokens::estimate`; verify tests that a dense 16-track × 32-measure song renders ≤ 4000 estimated tokens, a 500 budget renders ≤ 500, and a 0 budget renders no context

## 3. Endpoint, validation, config

- [ ] 3.1 Add `TrackGenerateBody`, `MeasureRange`, `TrackGenerateResponse`, `SongLimits` with ts-rs derives, register in `tests/ts_bindings.rs`, and run `just gen-types`; verify the binding test passes
- [ ] 3.2 Implement validation (`Song::validate` → `invalid_track` → prompt rules → `invalid_range`, including the >32-measure omitted-range rule); verify one unit test per error scenario in "Track generation request validation"
- [ ] 3.3 Implement `generate_track` in `music/src/generate.rs` (span, context, same retry/normalize, notes relative to the range start per design D1, drop draft tempo/swing); verify tests with a scripted provider for velocity 200 → 127, retry then `generation_failed`, and notes confined to `0..range length in steps`
- [ ] 3.4 Add `SONGBIRD_MAX_CONTEXT_TOKENS` (default 4000, 0–32000) to `api/src/config.rs` and `.env.example`; verify config tests for default, custom value, and out-of-range startup failure naming the variable
- [ ] 3.5 Add `POST /api/v1/songs/tracks/generate` and `GET /api/v1/songs/limits` in `api/src/songs.rs` with the timeout wrapper; verify `oneshot` integration tests with the mock provider for whole-song success, range success, `invalid_track`, `invalid_range`, `504 generation_timeout` (hanging provider), limits reflecting config, and a recording provider showing context reaches the provider
- [ ] 3.6 Extend `MockProvider` with the deterministic bass-following adjustment (design D5); verify "Mock is deterministic" and a test that changing another track's bass changes the mock's melodic output
- [ ] 3.7 Document track generation and `SONGBIRD_MAX_CONTEXT_TOKENS` in `backend/README.md`; verify the documented `curl` example returns `200` with the mock provider
- [ ] 3.8 Run from `backend/`: `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`; verify both pass

## 4. Chat (backend)

- [ ] 4.1 Add `ai/plan.rs` with `PlanProvider`, `SchemaPlanProvider<T>` (schema with an `instrument` enum of registry ids, plus the post-call instrument recheck and retry), and `MockPlanProvider` (keyword-to-instrument rules: drum or beat → `drums`, piano, chord, or keys → `piano`, otherwise the first melodic instrument; questions → `reply_only`). Make Claude's missing-tool error name the request's `tool_name` (design D8). Verify unit tests for schema enum contents, the unknown-instrument retry then `generation_failed`, 40-character name trimming, and deterministic mock plans
- [ ] 4.2 Introduce `Providers { patterns, plans }` in `api/src/provider.rs` over one shared transport, and move `AppState.provider` to `AppState.providers` (design D12). Verify that all existing API tests pass and that `check()` runs once per transport
- [ ] 4.3 Implement the planner prompt rendering: fenced, escaped `<message role=…>` transcript, per-track arrangement summary, and oldest-first trimming to `SONGBIRD_MAX_CONTEXT_TOKENS` that keeps the latest message and summary (design D9). Verify tests that a message cannot escape its fence, that trimming drops the oldest first, and that a 0 budget still sends the latest message and summary
- [ ] 4.4 Add `ChatBody`, `ChatMessage`, `ChatResponse`, and `max_chat_messages` on `SongLimits` with ts-rs derives, register them in `tests/ts_bindings.rs`, and run `just gen-types`. Verify the binding test passes
- [ ] 4.5 Implement `POST /api/v1/songs/chat` in `api/src/songs.rs`: validation, the 16-track guard, the range rule (design D10), the planner call, and then `generate_track` with the rewritten prompt, each call under the timeout wrapper. Verify `oneshot` integration tests for every "Song chat endpoint" scenario, "Long song without a loop range", and a `504` when the planner hangs
- [ ] 4.6 Document the chat endpoint in `backend/README.md`, including a `curl` example; verify it returns `200` with the mock provider
- [ ] 4.7 Run from `backend/`: `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`; verify both pass

## 5. Studio generate flow and chat

- [ ] 5.1 Add `generateTrack`, `sendChat`, and `getSongLimits` to `frontend/src/lib/api.ts`; verify Vitest tests for request shape and error mapping
- [ ] 5.2 Add `splitClip` and `clearMeasureRange` to `lib/song/clipOps.ts` per design D13 (skip if #7 already added them), and `songStore.applyGeneratedRange` (clear the range, add a new "<track name> <n>" loop and one clip over the range, select it, refuse past the loop or clip limit, one history entry) with `generatingTrackId` locking; verify Vitest tests for "Regenerate a range and undo", "Notes outside the range are kept", "Generated part is a new loop and clip", "Linked clips elsewhere are unaffected", a misaligned tail getting a "(cont.)" loop that resolves to the same notes, and the limit refusal
- [ ] 5.3 Add `activeLoopRange(song)` (design D6: `loop_region.region` span only when `enabled`, a region exists, it is not the whole song, and it is at most 32 measures). Build `TrackGenerateDialog` (prompt + `TokenCounter`, range options per limits with "Loop range" from `activeLoopRange`, loading and error states) and the per-track Generate action; verify a Vitest test of `activeLoopRange` for looping off, no region with looping on, a whole-song region, a region over 32 measures, and a 9–16 region, and RTL tests for "Failure leaves the track unchanged", "Whole song unavailable for long songs", "Loop range follows the loop region", "Loop range needs looping on", "Loop range needs a region", "Whole-song region is not a loop range", and the target track's editor being disabled while in flight
- [ ] 5.4 Add the optional `chat` field to the frontend `Song` type, and add `songStore.applyChatResult`. It appends the user and assistant messages (trimmed to the latest 20), adds the returned track with a client id, default mixer settings, and one loop placed as one clip over the returned `range` (design D7), and records one history entry (design D11). Verify Vitest tests for "Undo a chat-added track", 20-message trimming, and an unrecognised-field round trip that still works with `chat` present
- [ ] 5.5 Wire #4's `AssistantPanel`: history with added-track labels, input disabled while in flight, error display, and `activeLoopRange(song)` sent as `range` (omitted when it returns nothing). Verify RTL tests for "Build a song one part at a time" (mocked API), "Track limit in chat", "Chat failure leaves the song unchanged", "Long song without a loop range", and "Conversation survives reload"

## 6. Integration checks

- [ ] 6.1 Add a Playwright test with the mock provider: create a song, add notes to Drums, generate the Bass track for measures 1–4, verify a new clip covers measures 1–4 and notes play only there, then undo. Add a second test that builds piano, then drums, then bass through the chat with the mock provider, and verifies three tracks that each have one clip with notes and that undo removes the bass
- [ ] 6.2 Run `just lint` and `just test`; verify both pass
- [ ] 6.3 Run one live Ollama track generation against a 3-track song and one three-message chat session (`just test-live-ollama` or manual `curl`); record latency for the planner and generation calls, the estimated context size, and whether the planner picked sensible instruments in `backend/README.md`
- [ ] 6.4 Run `openspec validate add-context-aware-track-generation --strict`; verify it passes
