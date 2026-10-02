# Design

## Context

See proposal.md for the motivation and specs/ for the requirements. This change builds on the following existing pieces.

**AI stack (`backend/crates/music/src/ai/`):**
- `StructuredProvider` is the one schema-generic JSON transport. Claude, OpenAI, Ollama, and Codex each implement it.
- Each AI capability has its own seam with a schema adapter and a mock:
  - `PatternProvider` / `SchemaProvider` / `MockProvider`;
  - `PlanProvider` / `SchemaPlanProvider` / `MockPlanProvider`;
  - `LyricsProvider` / `SchemaLyricsProvider` / `MockLyricsProvider` (`ai/lyrics.rs`).
- `api/src/provider.rs` bundles them in `Providers`. `Providers::over(transport)` is the single place that adds a capability, and it covers every access mode, including per-user keys (`ai_access.rs`).

**Track generation:**
- `generate::generate_track` (`generate.rs:63`) renders cross-track context with `context::render_context(song, target, range, budget)`.
- It sends a `GenerateRequest` through `PatternProvider` and returns range-relative notes.
- `songs::ai_router` (`api/src/songs.rs:31`) holds the metered, body-limited AI routes.

**Song model:**
- `Song`, `Section`, `Loop`, and `Clip` are in `music/src/song.rs`.
- `Note { row_id, step, length_steps, velocity }` is in `music/src/pattern.rs:39`. It is shared by patterns and loops.
- TypeScript types are generated with ts-rs by `just gen-types`.
- `song.key` already exists and defaults to C major.

**Frontend:**
- Lyric headings, and their links to sections, are parsed in `frontend/src/lib/lyrics/headings.ts` and `sectionLinks.ts`.
- `clipOps.applyGeneratedRange` (`lib/song/clipOps.ts:449`) and `songStore.applyGeneratedRange` write a range as a new loop with one clip.
- The piano roll is built from `components/editor/PianoRoll.tsx`, `NoteBar.tsx`, and `NoteInspector.tsx`. The note clipboard is in `lib/noteClipboard.ts`.

**Shared fixtures:** the repo-root `fixtures/` directory (`timing.json`, `song_validation.json`, `instruments.json`, ...) keeps Rust and TypeScript in step.

**In flight:** `add-section-chord-generation` adds `Section.chords`, a `songs/track-generation` chord-context line in `render_context`, and a `Providers.chords` field. This change is designed so that it either lands first or rebases trivially (D7).

## Goals / Non-Goals

**Goals:**
- One more AI capability that uses the existing transport, access, metering, retry, and timeout machinery, and adds no new configuration.
- Strict guarantees on the output (every syllable placed, monophonic, in range, in voice) that hold for every provider. Prosody is good with the mock and best-effort with real models.
- Syllables travel with the notes, so ordinary piano-roll edits do not break the mapping and MIDI export needs no extra lookup.

**Non-Goals:**
- A dictionary-grade English syllabifier. Rules plus user correction is the bar (D2).
- Rhythmic quantization of model output to enforce stress. Moving notes the model placed would fight its phrasing and could create collisions. Stress is measured and reported instead (D5).
- Changing the lyric assistant (`/api/v1/lyrics/assist`) or its mock.

## Decisions

### D1. The syllable lives on the note (`Note.lyric`)
Add `lyric: Option<String>` to `Note`, using `#[serde(default, skip_serializing_if = "Option::is_none")]` and `#[ts(optional)]`. `Song::validate` checks 1–16 characters and no line breaks.

Melisma is implicit: a note without a lyric continues the previous syllable. MIDI karaoke and MusicXML do the same, so export is a direct mapping.

Because `Note` is shared, patterns can also carry lyrics (for example after "Send to song" and back). Pattern validation accepts the field, and the single-pattern MIDI download ignores it. That is a stated non-goal, and the next step if it is wanted.

*Alternatives:*
- A side table on the loop, `syllables: [{note_index, text}]`. Rejected because every note edit (sort, delete, paste) would have to rewrite indices, and the clipboard and undo code would all need to learn about it.
- A section-level `topline` object mapping syllables to `(step, row)`. Rejected because moving a note silently breaks the mapping.

### D2. Syllabification runs in the browser, with a shared fixture
`frontend/src/lib/topline/syllabify.ts` contains:
- a tokenizer;
- a vowel-group splitter with the usual English consonant rules (VCV → V-CV, VCCV → VC-CV, keeping digraphs such as `th`, `ch`, `sh`, `ph`, and `ng` together);
- a silent-`e` rule and a contraction rule;
- a stress assigner. The assigner leaves function words unstressed and stresses other one-syllable words. For longer words it uses suffix rules (`-tion`/`-sion`/`-ic` stress the syllable before them), stresses the second syllable after an unstressed prefix (`a-`, `be-`, `de-`, `re-`, `un-`, ...), and otherwise stresses the first syllable.
- a small exception table of common lyric words.

`fixtures/syllables.json` holds at least 150 words and lines with their expected splits and stress. Vitest consumes it.

The request carries the syllables, so the server never needs to syllabify. This keeps one implementation, and it is the only way the user's corrections in the dialog reach the model. The server validates only the shape and limits.

*Alternatives:*
- Syllabify in Rust and add a preview endpoint. Rejected: it needs an extra round trip on every keystroke in the dialog, and corrections would still have to be sent back.
- Ask the model to syllabify. Rejected: it is non-deterministic, it cannot be checked by the normalizer, and the mock could not test it.
- The `hyphenation` crate or Knuth–Liang patterns. These are tuned for typesetting hyphenation, not sung syllables (they avoid one-letter syllables such as `a-way`), and they add a large dictionary. They can be reconsidered if the rule set's accuracy disappoints (see Open Questions).

### D3. Request and response contract
`music/src/topline.rs` defines `ToplineGenerateBody { song, track_id, range, section_name, lines, voice, prompt }`, `ToplineResponse { track_id, range, notes, prosody }`, and `ValidToplineRequest::validate`. It reuses:
- `ValidSong` and the song error codes;
- track generation's range validation (`MeasureRange`);
- the melodic-only target check that `ValidTrackRequest` already enforces;
- `estimate_tokens` for the prompt.

The new error codes are `invalid_lyrics`, `lyrics_do_not_fit`, and `invalid_voice`, added to `api/src/error.rs`. `VoicePreset` is an enum with `range() -> (u8, u8)`, exported through ts-rs so the dialog lists the same presets.

The range comes from the client rather than from a `section_id`. Implicit sections ("Song", "Song 2") exist only in the browser, and track generation already speaks in ranges.

### D4. Provider seam and draft format
`music/src/ai/topline.rs` adds a `ToplineProvider` trait (`generate(&ToplineRequest) -> ToplineDraft`, `check`), a `SchemaToplineProvider<T>` over the shared `Arc` transport, and a `MockToplineProvider`. `Providers` gains `topline: Arc<dyn ToplineProvider>`, set in `Providers::new`, defaulting to the mock, and wired in `Providers::over`, exactly as `lyrics` is.

The model emits positions in beats, not steps, because models count beats more reliably (as in the chord design):

```
{ lines: [{ line: int, syllables: [{ index: int, pitch: string, start_beat: number, beats: number,
            melisma: [{ pitch: string, beats: number }] }] }] }
```

- `start_beat` is measured from the range start, in quarter-beat resolution.
- `index` refers to the syllable's position in the request, so the model never has to copy syllable text, which it would misspell.
- Pitches use the same pitch parser as melodic lanes, which accepts sharps, flats, and MIDI numbers.

The prompt lists each line as numbered syllables with a stress mark (`0:BEAU* 1:ti 2:ful`). It also gives the strong beats, the bar count, the voice range, the key, and the chords when present. All of it is fenced with `escape_for_fence`. Track-generation context comes from `render_context` with the same budget.

### D5. Normalization, and prosody as a measured score
`ToplineDraft::normalize` runs these steps in order:
1. Map index to syllable and drop unknown indices.
2. Require every syllable exactly once. Otherwise the draft is invalid.
3. Convert beats to steps (a beat is 4 steps, or 6 in 6/8) and round to whole steps.
4. Sort by line, then syllable.
5. Lay out melisma notes after their syllable note, capped at 3.
6. Trim overlaps, and drop zero-length notes, which makes the draft invalid if that removes a syllable note.
7. Check the range. A syllable note outside it makes the draft invalid.
8. Fold pitches by octave into the voice range intersected with the instrument range.
9. Clamp velocity.
10. Set `lyric` on the syllable notes.

Invalid drafts go through the same single retry as patterns and lyrics. The retry helper in `generate.rs` (or `with_one_retry`, if the chord change has extracted it) is reused, not copied.

`prosody` is computed after normalization: stressed syllables whose note starts on a beat, out of all stressed syllables. Snapping stressed syllables to beats in the normalizer was rejected, because shifting notes cascades into collisions and destroys deliberate syncopation. The score is shown to the user and asserted by the live test (at least 70% with Ollama).

### D6. Mock algorithm
`MockToplineProvider` is deterministic, needs no hashing, and works only from the request:
- **Slots:** the slot length is `floor(range_steps / lines / beat) * beat`, with a minimum of 1 beat.
- **Rhythm:** within a slot, syllables go on an eighth-note grid, or a sixteenth grid when there are more than two syllables per beat. A stressed syllable that would fall off the beat is pushed to the next beat, provided the rest of the line still fits in the slot. The last syllable is extended to the slot end.
- **Pitch:** the mock walks the key's scale (major, or natural minor) from the middle of the voice range. It moves stepwise on unstressed syllables, and leaps to the nearest tone of the sounding chord on stressed syllables, or of the tonic triad when there are no chords. The last note goes to the nearest tonic.

This satisfies the mock requirements in the spec, and those are written as Rust unit tests.

### D7. Chord dependency degrades gracefully
- The topline prompt builder reads chords through `render_context`'s output. When `add-section-chord-generation` lands, its chord line appears there automatically.
- For the mock, a small `sounding_chord(song, abs_step) -> Option<Vec<PitchClass>>` helper is added behind a module boundary:
  - If chords exist on `Section`, it reads them.
  - If this change lands first, the helper returns `None`, and the tonic-triad path covers the behavior.
- Whichever change lands second wires the helper to `Section.chords` and adds the "Mock follows chords" test. The task list marks this step as conditional.

### D8. Write-back reuses the generated-range path
The frontend action is `songStore.applyTopline({trackChoice, range, notes, source, alsoRanges})`. In one history entry it:
1. optionally adds the "Vocal" track (`addTrack` with instrument `vocal`);
2. calls `clipOps.applyGeneratedRange` to create the "<section> topline" loop and its clip;
3. sets `loop.topline`;
4. for each extra same-named range, clears the range with `clearMeasureRange` and places a clip of the same loop with `placeLoop`.

The extra ranges are linked clips rather than copies, so editing the chorus melody once updates every chorus. This matches the way users already reuse loops.

### D9. Re-flow and stale detection are pure frontend ops
`lib/topline/toplineOps.ts` provides:
- `reflowLyrics(loop) -> {loop, unplaced}`;
- `isStale(loop.topline, lyricSections)`, which compares line texts after whitespace trimming;
- `seedSyllables(lines, source)`, which reuses the corrected syllables for unchanged lines.

The piano roll's move, resize, velocity, and clipboard paths already spread note objects. Tests pin down that `lyric` survives each path, so that a future refactor cannot drop it silently.

### D10. Vocal Guide instrument
`music/src/instruments/vocal.rs` follows `synth_lead.rs`. It declares `midi_program` 54, a range of 40–84, the highest-note monophonic rule, and a melodic prompt hint (a singable line with stepwise motion and phrase breaths). `fixtures/instruments.json` and the frontend synth voice table gain a `vocal` entry: a sine plus a soft triangle, a formant-ish band-pass, about 5 Hz vibrato with a delayed onset, and a 60 ms attack.

### D11. MIDI lyric events
`song_midi.rs` emits `MetaMessage::Lyric(bytes)` at the Note On tick when the resolved note has a `lyric`. It is ordered before Note On at equal ticks, so karaoke-style readers display the syllable as it is sung. Notes without lyrics emit nothing, which keeps existing exports byte-identical and protects the current snapshot tests.

## Risks / Trade-offs

- **[Risk]** Rule-based English stress is wrong for some words (for example `record` the noun vs. the verb). → **Mitigation:** the dialog's stress toggle and re-split, corrections that are kept across regeneration, and the exception table, which can be grown from user reports.
- **[Risk]** Models misplace or drop syllables in long sections. → **Mitigation:** index-based output, strict normalization with one retry, the 256-syllable cap, and a live test.
- **[Risk]** Real-model prosody is weak. → **Mitigation:** the prosody score is shown to the user, who can regenerate, and the prompt gives the strong beats explicitly with stress-marked syllables.
- **[Trade-off]** Syllables on notes can get out of step after heavy manual editing. This is accepted: "Re-flow lyrics" restores order in one action, and the lyric field gives exact control.
- **[Risk]** Adding a field to `Note` touches patterns as well as songs. → **Mitigation:** the field is optional and skipped when absent, the byte-identical serialization tests are extended, and `fixtures/song_validation.json` gains lyric cases.
- **[Risk]** Merge conflict with `add-section-chord-generation` in `Providers` and `render_context`. → **Mitigation:** both changes only add fields or lines, and D7 isolates the chord read.

## Migration Plan

The new fields (`Note.lyric`, `Loop.topline`) are optional, so no migration is needed and the song `version` stays 2. Older builds keep unknown fields when they load and save, because the song importer preserves them, so a rollback keeps the lyrics in stored songs. The `vocal` instrument id is additive. A song using it opened by an older build fails instrument validation, which is the same behavior as any newly added instrument.

## Open Questions

- **Parenthetical lines.** Should lines such as `(x2)` or `(instrumental)` be skipped automatically? Today they would be sung. Users can delete them from the preview by editing the lyrics. This can be added to the line filter later without changing the contract.
- **Syllabifier quality bar.** Is a rule set plus an exception table good enough, or should a pronouncing-dictionary subset (CMUdict, about 1–2 MB) be lazily loaded for stress? This can be decided after measuring the fixture accuracy on a larger word list.
- **Voice range presets.** Are four presets enough, or is a custom low/high range needed? A custom range would be an additive request field.
- **Lyric event encoding.** Some older DAWs expect Latin-1 in Lyric meta-events. UTF-8 is chosen for now, and this should be verified with Logic, Ableton, and MuseScore during implementation.
- **Vocal track default instrument.** If users prefer hearing the guide melody on Synth Lead, the dialog default could become configurable.
