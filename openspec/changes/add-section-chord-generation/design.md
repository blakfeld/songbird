# Design

## Context

See proposal.md for the motivation. This change relies on the following existing pieces.

**AI stack in `backend/crates/music/src/ai/`:**
- `StructuredProvider` (`ai/mod.rs:47-55`) is a schema-generic JSON transport, implemented by Claude, Ollama, and Codex.
- `SchemaProvider<T>` (`ai/mod.rs:74-105`) adapts a transport to the pattern-specific `PatternProvider`.
- `MockProvider` (`ai/mock.rs:10-56`) implements `PatternProvider` directly. It picks a canned draft by keyword, or else by a stable FNV hash of the request.
- `generate_pattern` (`generate.rs:21`) owns the two-attempt retry.
- Prompts fence user text with `escape_for_fence` (`ai/prompt.rs:55`).
- Draft schemas are made strict by `strictify` (`ai/prompt.rs:80`).

**API crate:** `AppState` (`api/src/state.rs`) holds `Arc<dyn PatternProvider>`, which `build_provider` constructs and checks at startup (`api/src/provider.rs:12-44`).

**Earlier changes in this roadmap:**
- #5 adds the Rust `Song` mirror, the `/api/v1/songs/` route group, and its 1 MiB body limit.
- #6 adds track generation and a context summarizer with `SONGBIRD_MAX_CONTEXT_TOKENS`. It adds no provider trait: it reuses `PatternProvider` and the lane-per-pitch draft format from #1, passing the context as `GenerateRequest.context`. `AppState` therefore still holds a single `Arc<dyn PatternProvider>` when this change starts.
- #7 adds `Song.sections` (Rust `music::song`, generated to TypeScript, validated by `fixtures/song_validation.json`) and the section operations in `frontend/src/lib/songSectionOps.ts`.
- add-arrangement-clips replaced `Track.notes` with per-track `loops` and `clips` (song `version` 2). #6 D13 adds `clearMeasureRange` and `splitClip` in `lib/song/clipOps.ts` and `songStore.applyGeneratedRange`, which writes a range of a track as a new loop placed as one clip without changing any existing loop. #6's context summarizer reads resolved notes, so chord context sits beside what the clips actually play.

**Frontend:** the timing math is already mirrored between Rust and TypeScript through a shared fixture (`fixtures/timing.json`, verified by `frontend/src/lib/timing.test.ts`). This change uses the same pattern for chord parsing.

## Goals / Non-Goals

**Goals:**
- One chord grammar with identical behavior in Rust and TypeScript.
- Chord generation reuses the provider selection, startup checks, retry, and timeout of pattern generation. It must not add a second way to configure AI.
- Chord-aware track generation that the mock provider makes testable end to end.

**Non-Goals:**
- Voice leading between chords in rendered voicings. Voicings are simple close position, which is predictable and easy to edit afterwards.
- Chord suggestions based on existing melody notes.
- Extended chords beyond the grammar, such as 11ths, 13ths, and altered chords.

## Decisions

### D1. Chord symbols are the storage format, parsed on both sides
`Chord { symbol, start_step, length_steps }` stores the canonical symbol string. Both sides parse the grammar:
- **Rust:** `music/src/chords/symbol.rs` parses to `ChordSymbol { root: PitchClass, quality: Quality, bass: Option<PitchClass> }` and provides `pitch_classes()`.
- **TypeScript:** `frontend/src/lib/chords.ts` does the same.

`fixtures/chords.json` lists inputs with their expected canonical form and pitch classes, or with a rejection. Both test suites consume it, so drift fails CI.

*Alternative:* store a structured `{root, quality, bass}`. This was rejected because symbols are what users type and read, what the AI emits, and what a future MIDI or lyrics export would show. The structured form is derived.

### D2. Chord provider seam mirrors the pattern one
Add a `ChordProvider` trait in `music/src/ai/chords.rs`:

```
async fn generate(&self, req: &ChordRequest) -> Result<ChordDraft, ProviderError>
```

It has two implementations:
- **`SchemaChordProvider<T: StructuredProvider>`:** builds the chord prompt and schema, then parses the result.
- **`MockChordProvider`:** has canned progressions by section kind, transposed to the key:
  - verse: I–vi–IV–V
  - chorus: IV–V–I–vi
  - bridge: vi–IV–I–V
  - pre-chorus: ii–IV–V–V
  - intro, outro, and other: I–IV–I–V
  
  It places one chord per measure, cycles the progression to fill the section, and uses `C major` when the song has no key. The key is `A minor` when the prompt contains "minor" or "sad", so the auto-key path is testable.

This is the first change that needs a second AI capability, so it introduces the shared provider bundle that later changes extend:
- `build_provider` becomes `build_providers(&Config) -> Providers`, where `Providers { patterns: Arc<dyn PatternProvider>, chords: Arc<dyn ChordProvider> }` lives in `api/src/provider.rs`.
- `AppState.provider` becomes `AppState.providers`. Handlers read the field they need, for example `state.providers.patterns`.
- Every adapter wraps the same transport. `SchemaProvider` and `SchemaChordProvider` hold an `Arc<T>`, so they share one transport (and Codex's `Semaphore(1)`). Startup runs `check()` once per transport, not once per capability.
- For `mock`, `MockProvider` serves patterns and `MockChordProvider` serves chords.
- #9 adds `lyrics: Arc<dyn LyricsProvider>` to `Providers` in the same way. Any later AI tool adds one field and one adapter, not a new wiring path.

*Alternative:* one provider trait with a method per artifact type. This was rejected because it forces every future tool, such as lyrics in #9, to edit every provider.

### D3. Draft format and prompt
The model emits:

```
{ key: string|null, sections: [{ section_id, chords: [{ symbol, start_beat, beats }] }] }
```

Positions are given in **beats** rather than steps. Models count beats reliably, and working in beats removes a class of off-grid errors.

The schema constrains `section_id` to an enum of the requested ids. `symbol` stays a free string, because the grammar is validated by the normalizer, not the schema, and aliases are allowed.

The user message contains the following:
- Song meta: tempo, meter, key or "choose one".
- For every section: name, kind, and measures. The section is marked either TARGET or CONTEXT, and CONTEXT sections carry their existing chords.
- Section notes, fenced with `escape_for_fence` like the description because they are user text.
- The prompt, fenced as `<description>`.

Context is trimmed to `SONGBIRD_MAX_CONTEXT_TOKENS` using #6's estimator. Notes of far-away CONTEXT sections are dropped first, then their chords. TARGET sections are never dropped.

### D4. Normalization order
`music/src/chords/normalize.rs` runs these steps in order:
1. Canonicalize or drop symbols.
2. Convert beats to steps (beat = 4 steps, or 6 in 6/8).
3. Snap starts down and round lengths to whole beats, with a minimum of 1.
4. Sort by start.
5. Trim overlaps.
6. Fill gaps by extension, and pull the first chord to 0.
7. Fit the last chord to the section end.

A requested section missing from the draft, or left empty after these steps, marks the draft invalid, which triggers the one retry. The retry loop is shared with `generate_pattern` by extracting a small generic `with_one_retry` helper in `generate.rs`, so both paths have the same semantics: transport errors are not retried (see the existing test at `generate.rs:123`).

### D5. Endpoint
`POST /api/v1/songs/chords/generate` lives in a new `api/src/chords.rs` that is merged into the router. It follows the same flow as `patterns.rs`: validate, then `tokio::time::timeout`, then provider, then normalize.

Validation reuses `estimate_tokens` and the `invalid_prompt` and `prompt_too_long` codes, and adds `invalid_section` and `invalid_key`. `invalid_song` comes from #5's song validation.

The route sits under `/api/v1/songs/` and inherits the 1 MiB limit from #5.

### D6. Chord-aware track generation
#6's context summarizer gains a chord line per context window. It is ordered by distance from the range and budgeted like other context, and it is emitted only when chords exist, so chord-less requests are byte-identical to before. This protects #6's snapshot tests.

The track-generation system prompt gains one instruction to fit parts to the sounding chords, and this instruction is included only when chords are present.

The melodic mock (from #1 and #6) post-processes its canned notes: each note's pitch is moved to the nearest pitch whose pitch class is in the chord sounding at its step. #6 returns notes relative to the range start, so the lookup adds the range's first step to find the chord at the note's absolute song position. The note is kept within the instrument's range, and ties resolve downward. This makes coherence assertable in Rust and in Playwright.

### D7. Voicing for render-to-track is frontend-only
The voicing rules in the spec live in `frontend/src/lib/chordVoicing.ts`. Rendering is a local, deterministic edit that needs no server round trip. The "bass-range" test is `instrument.range.high <= 60`, using the `range` from #1's instrument discovery.

`chordVoicing` returns notes with steps counted from the range start, the same shape #6's generation returns. The render action then calls the same range write-back as #6 (`applyGeneratedRange`'s clear, split, and place rules), with the loop named "<section name> chords", or "Song chords" for the whole song, truncated to 40 characters. Reusing it means render and generation replace a range identically, and both leave other clips of shared loops alone.

*Alternative:* write the voicings into the loop of the clip under the range. Every other clip linked to that loop would change too.

### D8. Chord edits keep the tiling invariant
All chord operations are pure functions in `frontend/src/lib/chordOps.ts`. Each one returns a progression that satisfies tiling, and a shared test helper asserts that invariant after every operation. The operations are set symbol, split, delete, move boundary, add to empty, and the section-edit hooks.

#7's `songSectionOps.ts` resize, duplicate, and delete call the chord hooks, so the section and chord edits are one undo entry.

## Risks / Trade-offs

- **[Risk]** Models emit exotic symbols (`C13`, `Cmaj7#11`) that get dropped, and the gaps are then filled, so the result is simpler than intended. **Mitigation:** the prompt lists the allowed qualities explicitly, and the schema description repeats them. Dropped symbols are logged at debug level, and the live tests (`just test-live-ollama`) check that most chords survive.
- **[Risk]** Grammar drift between Rust and TypeScript. **Mitigation:** the shared fixture (D1).
- **[Risk]** Changing `SchemaProvider` to share a transport touches pattern generation. **Mitigation:** the existing provider contract tests must pass unchanged, and the change is mechanical.
- **[Trade-off]** Close-position voicings jump between chords. We accept this, because users can edit afterwards or regenerate the track with chord context (D6) for smoother parts.
- **[Risk]** Chord context for a large song exceeds the context budget. **Mitigation:** distance-ordered trimming (D3, D6), with in-range chords kept whenever any context is.

## Migration Plan

`Song.key` and `Section.chords` are optional. In Rust they use `#[serde(default)]` and are skipped when empty, so the documents from #4, #5, and #7 are unaffected, and the song `version` stays 2.

Rollback: builds before this change keep the fields untouched, because #4's loader and #5's importer preserve unrecognised fields (#5 design D1).
