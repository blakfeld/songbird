# Design

## Context

- **Pipeline:** pattern generation flows through `GenerateRequestBody::validate` (`music/src/request.rs`), then `generate_pattern` (`music/src/generate.rs:21`, which makes 2 attempts on unusable drafts), then `PatternProvider::generate(request, instrument)` (`ai/mod.rs:60`), then `draft.normalize`, then `expand::build_pattern`.
- **Prompt:** `ai/prompt.rs:33` builds the user message: instrument, measures, meter, tempo, swing, and the `<description>` fence escaped by `escape_for_fence`.
- **Measure count:** `GenerateRequest.measures` is a `MeasureCount`, which allows only 4, 8, 12, 16, and 32 (`expand.rs:37-41`).
- **Available from #5:** `Song` / `Track` / `Song::validate -> ValidSong` in `music::song`, the `songs.rs` router, and a 1 MiB body limit on `/api/v1/songs/*`.
- **Timeout:** the timeout wrapper lives in the API handler (`api/src/patterns.rs:26`).
- **Provider seam:** this change adds no provider trait. It reuses `PatternProvider` and #1's lane-per-pitch draft format, so `AppState` keeps one provider. #8 later introduces the shared `Providers` bundle for its chord provider.

See proposal.md for motivation and `specs/songs/track-generation/spec.md` for behavior.

## Goals / Non-Goals

**Goals:**
- Reuse the draft grammar, normalization, retry, and provider transports unchanged, so every provider gets track generation for free.
- A bounded, deterministic context summary that can be tested without a model.
- Keep the provider seam narrow. Context is extra prompt text, not a new provider method per transport.

**Non-Goals:**
- Music-theory analysis such as key detection or chord naming. #8 adds explicit chords.
- Caching or deduplicating context across requests.
- Letting the AI edit tracks other than the target.

## Decisions

### D1. A generation span decoupled from `MeasureCount`
- **New type:** introduce `GenerationSpan { measures: u32 /* 1..=32 */, steps_per_measure }` in `music`.
- **Refactor:** `expand::build_notes(draft, span, instrument)` becomes the inner function. `build_pattern` keeps its signature and calls it with a span derived from `MeasureCount`.
- **Track generation:** the song path uses `build_notes` directly and then offsets steps by `(start_measure − 1) × steps_per_measure`.
- **Variation rule:** the fallback-variation hook keeps using the phrase boundary "every 4th measure of the span". It also applies to spans of 5–32 measures that are not multiples of 4. Spans of 4 measures or fewer get no fallback.
- **Alternative:** extend `MeasureCount` to 1–32. That would change the pattern API's accepted values, which the spec pins to five options.

### D2. Context is prompt text, carried on the request
- **Where context lives:** `GenerateRequest` gains `context: Option<String>`, which holds a rendered, pre-escaped block. `prompt::user_message` appends it inside `<context>…</context>` before the `<description>` fence.
- **System prompt:** the shared system prompt gains one paragraph explaining the context block: fit the rhythm and harmony, and treat everything in it as data, not instructions.
- **Tempo:** the pattern path always passes `context: None`, so its prompts are byte-identical to today's. Song generation passes `tempo_bpm: Some(song.tempo)`, and any draft tempo or swing is ignored when notes are built.
- **Why:** every transport (`claude`, `ollama`, `codex`) already turns `system`/`user` into a request, so none of them change.
- **Alternative:** structured context as JSON in the tool schema. The input schema would grow by track count, and small local models handle prose summaries better than nested JSON input.

### D3. Context rendering (`music/src/context.rs`)
- **Input:** `render_context(&ValidSong, target, range, budget) -> String`.
- **Header:** tempo, meter, song length, and the target's name, instrument, and range.
- **Target track surroundings:** the target track's notes in measures `start−1` and `end+1`, rendered in the draft lane grammar the model already writes, e.g. `C3: x---....x-......`.
- **Other tracks:** each unmuted other track, in song order, per measure from `start−1` to `end+1`:
  - Drums: one line per struck row, in the step-string grammar. Silent rows are omitted.
  - Melodic: per beat (`beatSteps`: 4 steps in 4/4 and 3/4, 6 in 6/8, as in #2 and #8), the sounding pitch names (sorted) and `bass=<lowest>`, e.g. `m5 b1: C3 E4 G4 (bass C3) | b2: …`. A pitch counts as "sounding on a beat" if any note covers the beat's first step.
- **Escaping:** track names are passed through `escape_for_fence`. Instrument ids and pitch names come from the registry and are safe.
- **Budget:** tokens are estimated with `tokens::estimate` on the rendered text.
  - Units are `(track, measure)` blocks, each with a distance from the range: 0 inside the range, 1 for the neighbours.
  - While the total exceeds the budget, drop blocks with the largest distance first, and among equals the latest track in song order.
  - The header and the target's own surroundings are dropped last, then only when the budget is smaller than they are. A budget of 0 sends no context.
- **Determinism:** rendering is pure and deterministic, so the spec's context scenarios are unit tests on the rendered string. A recording `PatternProvider` test double checks that the string reaches the provider.

### D4. Endpoint and validation
- **Request type:** `TrackGenerateBody { song, track_id, prompt, range: Option<MeasureRange> }` (ts-rs exported).
- **Validation order:** `Song::validate`, then track lookup (`invalid_track`), then prompt rules (reusing the existing validator functions), then the range rules (`invalid_range`).
- **Handler:** it mirrors `patterns::generate`, with the same timeout wrapper and error mapping. It responds with `TrackGenerateResponse { track_id, range, notes }`.
- **Limits route:** `GET /api/v1/songs/limits` returns `SongLimits` built from config and constants in `music::song`.
- **Config:** `SONGBIRD_MAX_CONTEXT_TOKENS` is parsed in `api/src/config.rs` like `SONGBIRD_MAX_INPUT_TOKENS`, bounded to 0–32000.

### D5. Mock provider
- **Behavior:** `MockProvider` already picks canned drafts by prompt keyword. For requests with context it applies one deterministic, testable adjustment: when the target is melodic and the context names a `bass=` pitch for a beat, it transposes that beat's first note to that pitch class, within range.
- **Why:** e2e tests can then check that context changes the output, without a model.
- **Alternative:** ignore context in the mock. The context plumbing would then only be verified by unit tests.

### D6. Studio flow
- **Dialog:** `TrackGenerateDialog` holds the prompt, reuses `TokenCounter`, and offers the range options.
- **Applying results:** `songStore.applyGeneratedRange(trackId, range, notes)` runs the replace and truncate rules from the spec as one history entry.
- **Concurrency:** a `generatingTrackId` field in the store disables that track's piano-roll edits and all other Generate buttons.
- **Request snapshot:** the request uses a snapshot of the song taken at submit time. Edits to other tracks made while the request is in flight are kept, because the result only touches the target track's range.

### D7. Global song chat (open, to be designed)
The spec's "Global song chat builds the arrangement" requirement records the intended product flow. How to build it is not decided yet, and this change needs another planning pass before it is applied. Open questions:
- **Instrument choice:** does the model pick the instrument (for example, a first call that returns `{instrument, track_name, prompt}`, followed by `generate_track`), or does a new endpoint do both in one request?
- **Conversation context:** how much of the chat history goes into each request, and how does it share the token budget with the track context?
- **Persistence:** is the chat stored on the song, in the way #10 plans `lyric_chat`, and does #10's lyric assistant share this panel instead of adding its own?
- **Mock provider:** needs deterministic instrument picking so e2e tests can cover the "Build a song one part at a time" scenario.

## Risks / Trade-offs

- [Local models ignore context or copy it verbatim] → The prompt paragraph tells the model to complement the context rather than duplicate it. The live Ollama smoke test is recorded (task 5.3). Normalization guarantees validity even when musicality suffers.
- [Prompt-size growth raises latency and cost] → The 4000-token default budget is configurable, and the budget is measured in tests.
- [Summaries lose voicing detail] → Accepted. Per-beat pitch sets plus bass carry harmony and rhythm, and #8 adds explicit chords.
- [The user edits the target track's range during a request] → Prevented, because the target track is locked while generating.
