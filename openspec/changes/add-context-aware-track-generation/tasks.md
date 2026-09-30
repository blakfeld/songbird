# Tasks

## 1. Generation span and request plumbing (music crate)

- [ ] 1.1 Add `GenerationSpan` and refactor `expand.rs` into `build_notes(draft, span, instrument)` with `build_pattern` delegating (design D1); verify all existing `expand.rs`/`generate.rs` tests pass and new tests cover spans of 1, 5, and 7 measures (fallback variation at every 4th measure only for spans > 4)
- [ ] 1.2 Add `context: Option<String>` to `GenerateRequest`, the `<context>` block in `prompt::user_message`, and the context paragraph in the shared system prompt (design D2); verify a snapshot test that pattern prompts are byte-identical when `context` is `None` and a test that the context block precedes the description

## 2. Context rendering and budget

- [ ] 2.1 Implement `music/src/context.rs` rendering (header, target surroundings, drums step-strings, melodic per-beat pitches + bass, muted tracks excluded, names escaped) per design D3; verify unit tests for "Other tracks reach the provider", "Muted tracks are ignored", "Continuity with the target's surroundings", and "Track names cannot escape the context block" on the rendered string
- [ ] 2.2 Implement budget trimming (distance-first, then later tracks) using `tokens::estimate`; verify tests that a dense 16-track × 32-measure song renders ≤ 4000 estimated tokens, a 500 budget renders ≤ 500, and a 0 budget renders no context

## 3. Endpoint, validation, config

- [ ] 3.1 Add `TrackGenerateBody`, `MeasureRange`, `TrackGenerateResponse`, `SongLimits` with ts-rs derives, register in `tests/ts_bindings.rs`, and run `just gen-types`; verify the binding test passes
- [ ] 3.2 Implement validation (`Song::validate` → `invalid_track` → prompt rules → `invalid_range`, including the >32-measure omitted-range rule); verify one unit test per error scenario in "Track generation request validation"
- [ ] 3.3 Implement `generate_track` in `music/src/generate.rs` (span, context, same retry/normalize, offset to absolute steps, drop draft tempo/swing); verify tests with a scripted provider for velocity 200 → 127, retry then `generation_failed`, and notes confined to the range
- [ ] 3.4 Add `SONGBIRD_MAX_CONTEXT_TOKENS` (default 4000, 0–32000) to `api/src/config.rs` and `.env.example`; verify config tests for default, custom value, and out-of-range startup failure naming the variable
- [ ] 3.5 Add `POST /api/v1/songs/tracks/generate` and `GET /api/v1/songs/limits` in `api/src/songs.rs` with the timeout wrapper; verify `oneshot` integration tests with the mock provider for whole-song success, range success, `invalid_track`, `invalid_range`, `504 generation_timeout` (hanging provider), limits reflecting config, and a recording provider showing context reaches the provider
- [ ] 3.6 Extend `MockProvider` with the deterministic bass-following adjustment (design D5); verify "Mock is deterministic" and a test that changing another track's bass changes the mock's melodic output
- [ ] 3.7 Document track generation and `SONGBIRD_MAX_CONTEXT_TOKENS` in `backend/README.md`; verify the documented `curl` example returns `200` with the mock provider
- [ ] 3.8 Run from `backend/`: `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`; verify both pass

## 4. Studio generate flow

- [ ] 4.1 Add `generateTrack` and `getSongLimits` to `frontend/src/lib/api.ts`; verify Vitest tests for request shape and error mapping
- [ ] 4.2 Add `songStore.applyGeneratedRange` (replace notes starting in range, truncate notes crossing the range start, one history entry) and `generatingTrackId` locking; verify Vitest tests for "Regenerate a range and undo" and "Notes outside the range are kept"
- [ ] 4.3 Build `TrackGenerateDialog` (prompt + `TokenCounter`, range options per limits, loading and error states) and the per-track Generate action; verify RTL tests for "Failure leaves the track unchanged", "Whole song unavailable for long songs", and the target track's editor being disabled while in flight

## 5. Integration checks

- [ ] 5.1 Add a Playwright test with the mock provider: create a song, add notes to Drums, generate the Bass track for measures 1–4, verify notes appear only in 1–4, then undo
- [ ] 5.2 Run `just lint` and `just test`; verify both pass
- [ ] 5.3 Run one live Ollama track generation against a 3-track song (`just test-live-ollama` or manual `curl`); record latency and the estimated context size in `backend/README.md`
- [ ] 5.4 Run `openspec validate add-context-aware-track-generation --strict`; verify it passes
