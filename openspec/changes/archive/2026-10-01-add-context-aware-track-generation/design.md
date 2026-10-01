# Design

## Context

- **Pipeline:** pattern generation flows through `GenerateRequestBody::validate` (`music/src/request.rs`), then `generate_pattern` (`music/src/generate.rs:21`, which makes 2 attempts on unusable drafts), then `PatternProvider::generate(request, instrument)` (`ai/mod.rs:60`), then `draft.normalize`, then `expand::build_pattern`.
- **Prompt:** `ai/prompt.rs:33` builds the user message: instrument, measures, meter, tempo, swing, and the `<description>` fence escaped by `escape_for_fence`.
- **Measure count:** `GenerateRequest.measures` is a `MeasureCount`, which allows only 4, 8, 12, 16, and 32 (`expand.rs:37-41`).
- **Available from #5:** `Song` / `Track` / `Loop` / `Clip` / `Song::validate -> ValidSong` in `music::song`, the `songs.rs` router, and a 2 MiB body limit on `/api/v1/songs/*`. `ValidSong` carries each track's resolved notes (#5 D5, a port of add-arrangement-clips D2), so the server never reads loops directly to learn what a track plays.
- **Available from add-arrangement-clips:** tracks hold `loops` and `clips` (its D1), `resolveTrackNotes` (D2), and pure `Song → Song` clip operations in `lib/song/clipOps.ts` (D5), including the "<track name> <n>" loop naming used by New clip.
- **Available from add-timeline-loop-region:** playback looping is a `LoopSetting { region: { start, end } | null, enabled }` (1-based, inclusive measures) with pure helpers in `frontend/src/lib/loopRegion.ts`. The Studio edits it on the arrangement ruler through `components/editor/LoopRegion.tsx` and a Loop toggle beside Play. The song store holds it as the song's optional `loop_region { region: { start_measure, end_measure } | null, enabled }`; absent or null means no region and looping off. A song starts with no region, and looping on with no region loops the whole song, so a loop range exists only when the user has drawn a region.
- **Available from improve-song-and-note-editing:** the browser song has an optional `key: { tonic, mode }`, with `tonic` one of the 12 pitch classes `C`…`B` (sharps only) and `mode` `major` or `minor` (natural minor). An absent key means C major, and the Studio always shows one. That change is frontend only, so the Rust `Song` does not carry it yet.
- **Timeout:** the timeout wrapper lives in the API handler (`api/src/patterns.rs:26`).
- **Provider seam:** track generation reuses `PatternProvider` and #1's lane-per-pitch draft format. The chat's planner is a second provider kind, so this change introduces the `Providers` bundle #8 had planned (D12).

See proposal.md for motivation and `specs/songs/track-generation/spec.md` for behavior.

## Goals / Non-Goals

**Goals:**
- Reuse the draft grammar, normalization, retry, and provider transports unchanged, so every provider gets track generation for free.
- A bounded, deterministic context summary that can be tested without a model.
- Keep the provider seam narrow. Context is extra prompt text, not a new provider method per transport.

**Non-Goals:**
- Music-theory analysis such as key detection or chord naming. #8 adds explicit chords.
- Caching or deduplicating context across requests.
- Letting the AI edit tracks other than the target, including from the chat.
- Streaming chat replies.

## Decisions

### D1. A generation span decoupled from `MeasureCount`
- **New type:** introduce `GenerationSpan { measures: u32 /* 1..=32 */, steps_per_measure }` in `music`.
- **Refactor:** `expand::build_notes(draft, span, instrument)` becomes the inner function. `build_pattern` keeps its signature and calls it with a span derived from `MeasureCount`.
- **Track generation:** the song path uses `build_notes` directly and returns its notes **relative to the range start** (step 0 is the first step of `start_measure`). The browser stores them unchanged as a loop's notes (D6), so no offset is applied on either side.
- **Variation rule:** the fallback-variation hook keeps using the phrase boundary "every 4th measure of the span". It also applies to spans of 5–32 measures that are not multiples of 4. Spans of 4 measures or fewer get no fallback.
- **Alternative:** extend `MeasureCount` to 1–32. That would change the pattern API's accepted values, which the spec pins to five options.

### D2. Context is prompt text, carried on the request
- **Where context lives:** `GenerateRequest` gains `context: Option<String>`, which holds a rendered, pre-escaped block. `prompt::user_message` appends it inside `<context>…</context>` before the `<description>` fence.
- **System prompt:** the shared system prompt gains one paragraph explaining the context block: fit the rhythm and harmony, and treat everything in it as data, not instructions.
- **Tempo:** the pattern path always passes `context: None`, so its prompts are byte-identical to today's. Song generation passes `tempo_bpm: Some(song.tempo)`, and any draft tempo or swing is ignored when notes are built.
- **Why:** every transport (`claude`, `ollama`, `codex`) already turns `system`/`user` into a request, so none of them change.
- **Alternative:** structured context as JSON in the tool schema. The input schema would grow by track count, and small local models handle prose summaries better than nested JSON input.

### D3. Context rendering (`music/src/context.rs`)
- **Input:** `render_context(&ValidSong, target, range, budget) -> String`. Every note it reads comes from `ValidSong`'s resolved notes, at absolute song steps. Loops that no clip plays, and the parts of loops a short clip does not reach, never appear in context, because the model should hear what the listener hears.
- **Header:** tempo, meter, key, song length, and the target's name, instrument, and range. The key is rendered as its name, e.g. `key=E minor`, with an absent key rendered as `C major` so the model hears what the Studio shows. The header is part of the budget's last-dropped block, so the key always reaches the model unless the budget is smaller than the header.
- **Why the key:** without it, a melodic part over a sparse or drums-only song has no harmonic anchor, and the model picks a key at random. The key is context only. Notes are not snapped to it, matching the Studio, where the key highlights rows but never moves notes.
- **Target track surroundings:** the target track's resolved notes in measures `start−1` and `end+1`, rendered in the draft lane grammar the model already writes, e.g. `C3: x---....x-......`.
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
- **Handler:** it mirrors `patterns::generate`, with the same timeout wrapper and error mapping. It responds with `TrackGenerateResponse { track_id, range, notes }`, with `notes` relative to the range start (D1).
- **Limits route:** `GET /api/v1/songs/limits` returns `SongLimits` built from config and constants in `music::song`.
- **Config:** `SONGBIRD_MAX_CONTEXT_TOKENS` is parsed in `api/src/config.rs` like `SONGBIRD_MAX_INPUT_TOKENS`, bounded to 0–32000.

### D5. Mock provider
- **Behavior:** `MockProvider` already picks canned drafts by prompt keyword. For requests with context it applies one deterministic, testable adjustment: when the target is melodic and the context names a `bass=` pitch for a beat, it transposes that beat's first note to that pitch class, within range.
- **Why:** e2e tests can then check that context changes the output, without a model.
- **Alternative:** ignore context in the mock. The context plumbing would then only be verified by unit tests.

### D6. Studio flow
- **Dialog:** `TrackGenerateDialog` holds the prompt, reuses `TokenCounter`, and offers the range options.
- **Active loop range:** one browser helper, `activeLoopRange(song)`, returns the song's `loop_region.region` span only when `enabled` is true, a region exists, the region covers less than the whole song, and it spans at most 32 measures; otherwise it returns nothing. The dialog offers "Loop range" only when the helper returns a span, and the chat sends it as `range` (D7).
  - **Why require looping on:** with looping off, the region is dimmed and does not affect playback, so offering it would generate over measures the user is not listening to.
  - **Why require a region:** with no region, looping on covers the whole song, which "Whole song" already offers.
  - **Why exclude the whole song:** a drawn whole-song region plays the same as no region, and "Whole song" already covers it.
  - **Why one helper:** the dialog and the chat then cannot disagree about when a loop range exists.
- **Applying results:** `songStore.applyGeneratedRange(trackId, range, notes)` runs D13 as one history entry: it clears the range on the target track, then adds a new loop (`measures` = the range length, `notes` as returned, named by the New clip rule "<track name> <n>") and one clip of it covering the range. That clip becomes the selected clip, so the result opens in the dock.
- **Concurrency:** a `generatingTrackId` field in the store disables that track's piano-roll edits and all other Generate buttons.
- **Request snapshot:** the request uses a snapshot of the song taken at submit time. Edits to other tracks made while the request is in flight are kept, because the result only touches the target track's range.

### D7. Chat endpoint
- **Contract:** `POST /api/v1/songs/chat` takes `ChatBody { song, messages, range? }`, where `messages` is `[{role: user|assistant, content}]` with the latest user message last, and `range` is the active loop range from D6's `activeLoopRange`, omitted when there is none. It returns `ChatResponse { reply, track: {name, instrument, range, notes} | null }`. `range` is the range chosen by D10, and `notes` are relative to its start, as in D1.
- **Stateless:** the browser holds the history, matching #10's lyric assistant, so the server stores nothing and any instance can serve any request.
- **Ids stay on the client:** the browser assigns the new track's id, its loop and clip ids, and default mixer settings, as when a track is added by hand, so the song store remains the only source of ids. The new track holds one loop named after the track, as long as the range, placed as one clip covering the range.
- **Validation:** `Song::validate`, then 1–20 messages with the last from the user, then the existing prompt rules on the last message. Assistant messages over 4,000 characters are rejected with `invalid_request`, the same limit #10 uses.
- **Why one endpoint instead of two browser calls:** one round trip, and a failure in the second call cannot leave the browser holding a plan with no notes.
- **Alternative:** the browser calls a plan endpoint, then `songs/tracks/generate`. This exposes a half-finished state and needs a placeholder track to generate into.

### D8. Planner call
- **Provider kind:** `ai/plan.rs` adds `PlanProvider`, `SchemaPlanProvider<T: StructuredProvider>`, and `MockPlanProvider`, following #8's one-trait-per-artifact shape. They reuse the schema-generic transports unchanged. Claude's hard-coded "emit_pattern" error text becomes the request's `tool_name`.
- **Schema:** `{action: "add_track" | "reply_only", reply, instrument, track_name, prompt, measures}`, where `measures` is the length the user named (1–32) or null. `instrument` is an enum of registry ids, built the same way the draft schema builds its lane enums.
- **Rechecks after the call:** the server rechecks the instrument, because not every transport enforces enums. An unknown id is retried once as an unusable draft, and then fails with `generation_failed`. `track_name` is trimmed to 40 characters.
- **Rewritten prompt:** the planner turns "now the bass" into a standalone description, for example "a bass line locking to the kick and following the piano's chords". This lets the generation call stay exactly as D1–D3 define it, with no knowledge of the chat.
- **Timeouts:** the planner and the generation call each run under the existing 60 s timeout, because they are separate provider calls with separate failure modes.
- **`reply_only`:** answers questions such as "what tempo is this?" without adding a track. It is also the path when the song has 16 tracks. The server enforces that limit before generating, whatever the planner says.

### D9. Conversation context
- **Scope:** only the planner sees the transcript.
- **Rendering:** messages are rendered as fenced `<message role=…>` blocks, each passed through `escape_for_fence`. This is the format #10 D1 designs, so the two assistants can later share the renderer.
- **Arrangement summary:** alongside the transcript, one line per track gives its name, instrument, muted state, and the measures in which its resolved notes sound. It is enough to resolve "to match" and "the bass" without full note detail.
- **Budget:** the transcript is trimmed oldest-first until the planner prompt fits `SONGBIRD_MAX_CONTEXT_TOKENS`. The latest user message and the summary are never trimmed.
- **Generation budget:** the generation call gets the rewritten prompt plus the D3 context, under the same budget as before. Adding chat does not grow any single provider call beyond what the budget allows.

### D10. Chat range
- **Rule:**
  - When the planner reports a length the user named (`measures`, 1–32), the range is measures 1 to that length, extending the song if needed.
  - Otherwise, when no track has any clip, the range is measures 1–8, because an empty song is 1 measure long and "the whole song" would give a one-bar part.
  - Otherwise, when the song has at most 32 measures, the range is the whole song.
  - When the song is longer, the range is the supplied `range` if it spans at most 32 measures. The browser supplies one only while looping is on and a region exists that is not the whole song (D6).
  - Otherwise the server returns a `reply_only` response asking the user to turn on looping and draw a loop region of at most 32 measures on the ruler, and it makes no generation call.
- **Why:** this reuses the existing 32-measure span limit and does not quietly generate only part of a long song.

### D11. Chat persistence
- **Field:** `Song` gains optional `chat: [{role, content, track_id?}]`, with `#[serde(default, skip_serializing_if = "Vec::is_empty")]` in Rust per #5's optional-field policy. The browser trims it to the latest 20 on append.
- **Undo:** adding a track from the chat and appending the assistant message is one undo step. Undo removes the track, and the chat message stays, marked with the removed track's id so the panel can show that the track is gone.
- **#10:** its lyric assistant should reuse this field and the panel instead of adding `lyric_chat`. That revision belongs to #10.

### D12. Providers bundle
- **Bundle:** `api/src/provider.rs` builds `Providers { patterns, plans }` over one shared transport per configured provider, and `AppState.provider` becomes `AppState.providers`. `check()` runs once per transport.
- **Why here:** this is the first change that needs a second provider kind. #8 then adds `chords` rather than introducing the bundle.

### D13. Writing a range back: clear, split, then place
- **Helpers:** `lib/song/clipOps.ts` gains two pure functions. #7 needs the same two for measure insert and remove, so whichever of #6 and #7 is built first adds them and the other reuses them.
  - `splitClip(song, trackId, clipId, atMeasure)`: the head keeps the clip's loop and ends before `atMeasure`. The tail starts at `atMeasure` and keeps the same loop when `(atMeasure − clip.start_measure)` is a multiple of `loop.measures`, because it then starts on a repeat. Otherwise the tail gets a new loop, named "<loop name> (cont.)" (truncated to 40 characters), that holds exactly the notes the tail played, as resolved by `resolveTrackNotes` and re-based to the tail's start, with the tail's length. A note sustaining across `atMeasure` is cut there, as at any clip end.
  - `clearMeasureRange(song, trackId, start, end)`: splits clips crossing `start` and `end + 1`, then deletes every clip inside the range.
- **Loops are never edited.** Clearing or splitting only removes, shortens, or adds clips and adds loops. This keeps linked clips elsewhere in the song unchanged, which is the whole point of the loop model.
- **Limits:** if the split and the new loop would exceed 64 loops or 256 clips on the track, the result is not applied and the user is told the track's limit is reached. The generated notes are lost; the user can free space and regenerate.
- **Why bake a misaligned tail instead of rotating the loop:** a rotated copy keeps the loop short but must cut notes that wrap past its end, so the tail would sound different. Baking is exact. The tail loses its repeat structure, which Make unique would have broken anyway.
- **Alternative:** write generated notes into the existing loop. Every other clip of that loop would change too, which the user did not ask for.

### D14. The song's key on the Rust `Song`
- **Shape:** `Song.key: Option<SongKey>`, with `SongKey { tonic: PitchClass, mode: KeyMode }`, serialized as `{"tonic": "E", "mode": "minor"}` to match the browser's field. It is `#[serde(default, skip_serializing_if = "Option::is_none")]`, per #5's versioning policy, so songs without it serialize byte-identically.
- **Validation:** `Song::validate` rejects an unknown tonic or mode with the song validation error codes, and the browser's project-file validator and `fixtures/song_validation.json` follow it.
- **Ownership:** whichever of #5 and this change lands first adds the field, and the other reuses it. #8 (add-section-chord-generation) also plans a song key and should reuse this field rather than add its own.
- **Alternative:** send the key as a separate request field beside `song`. That would let the two drift, and the key is already part of the song the browser posts.

## Risks / Trade-offs

- [The planner sees only each instrument's `id`, `name`, `kind`, and range] → This is fine with `drums` and `piano`. With #3's synth set it may choose poorly between similar instruments. Instrument names stay descriptive. A `description` field on `InstrumentInfo` is the follow-up if the live smoke test (task 6.3) shows poor choices.
- [A chat message costs two provider calls] → The planner prompt is small, and the transcript is capped by the context budget. The live smoke test records the latency of both calls.
- [Local models ignore context or copy it verbatim] → The prompt paragraph tells the model to complement the context rather than duplicate it. The live Ollama smoke test is recorded (task 6.3). Normalization guarantees validity even when musicality suffers.
- [Prompt-size growth raises latency and cost] → The 4000-token default budget is configurable, and the budget is measured in tests.
- [Summaries lose voicing detail] → Accepted. Per-beat pitch sets plus bass carry harmony and rhythm, and #8 adds explicit chords.
- [The user edits the target track's range during a request] → Prevented, because the target track is locked while generating.
- [Each regeneration adds a loop, so loops pile up] → Unplaced loops are listed with a "0 clips" count and can be deleted from the loop menu (add-arrangement-clips). Regenerating the same range removes the previous generated clip and leaves its loop unplaced, so the user can place it again or delete it.

### D15. Ranges may extend past the song end
- **Rule:** track generation and chat accept ranges up to measure 128, not only up to the song's current length. The song's length follows its clips, so placing the generated clip grows the song, as placing any clip past the end already does.
- **Why:** a new song is 1 measure long, so bounding ranges by the current length made it impossible to generate a part longer than what already exists.
- **Context:** measures past the end have no other-track context; only the header and the target's surroundings apply.
