# Design

## Context

The drum-machine change made the core instrument-agnostic, and each instrument is a static `Instrument` in `backend/crates/music/src/instruments/mod.rs`. An instrument is:
- `id`, `name`, and `midi_channel`;
- `sustained`;
- `rows: &'static [RowDef]`;
- `system_prompt` and `row_aliases`;
- `examples` for the mock provider;
- `fallback_variation`.

The draft format (`draft.rs`) is one-measure sections of *lanes*. Each lane names a row and gives a step string (`.gxX-`) or a velocity array. Lanes resolve through `Instrument::resolve_row` (`instruments/mod.rs`), which lowercases the key and matches row ids or aliases. The schema from `ai/prompt.rs::draft_schema` restricts lane names to the instrument's row ids. `expand.rs::expand_notes` applies the arrangement and inserts `fallback_variation` at phrase ends. `midi.rs::pattern_to_midi` writes a Type 1 file with a conductor track and one note track.

The design's open item was "pitch ranges, scales and chords are deferred to the change that adds a melodic instrument". This change is that change. See proposal.md for why.

## Goals / Non-Goals

**Goals:**
- Adding the next melodic instrument (`add-synth-instrument-set`) is a data-only module: id, name, program, range, prompt, and examples.
- One draft format and one normalizer for every instrument, so provider contracts and tests stay shared.
- Existing drum behavior, saved drum patterns, and the drum schema snapshot keep working. The only exception is the documented new response fields.

**Non-Goals:**
- Frontend UI or sound for melodic instruments (`add-melodic-piano-roll`).
- Key or scale awareness beyond what the model infers from the description. Song keys arrive with `add-section-chord-generation`.
- Pitch bend, sustain pedal, program changes mid-pattern, or velocity curves per instrument.
- Grids finer than sixteenths or triplets. That non-goal is unchanged.

## Decisions

### D1. Melodic rows are computed from a range, not listed by hand
`Instrument` gains `kind: InstrumentKind { Drums, Melodic }` and `midi_program: Option<u8>`. It also gains `range: Option<PitchRange>` (`{low, high}`, serialized for the API).

Rows stay `&'static [RowDef]` so every consumer keeps working. For melodic instruments the slice is built once through a `std::sync::LazyLock<Vec<RowDef>>` per instrument, from a `pitch_rows(low, high)` helper. The helper runs high → low, and each id is `pitch_name(midi)`, for example 61 → `C#4`. This needs owned strings where `RowDef` uses `&'static str`. `RowDef` therefore changes to hold `Cow<'static, str>`, or the lazily built names are leaked once at startup; both are one-time and bounded. The implementer picks the simpler of the two. Either way, the public `Row` JSON is identical.
- *Alternative considered:* writing 61 `RowDef` literals per instrument. It is error-prone and makes every new instrument noisy.
- *Alternative considered:* rows generated on every request. That is wasteful, and `row_index` lookups want a stable slice.

Display order is high → low because that is how piano rolls read, top to bottom. The frontend already renders `pattern.rows` in order, so no client logic changes.

### D2. Reuse the lane draft format; one lane per pitch
The model writes `{"lane": "C4", "steps": "x---....x---...."}`, and a chord is three lanes.
- *Alternative considered:* a new melodic draft with `{pitch, start, length, velocity}` note lists. It is more natural for melodies, but it doubles the schema, prompt, normalizer, and tests, and it loses the cheap `-` holds.

The lane format already expresses sustained notes (`x---`), and it keeps one normalizer and one set of provider contract tests. The shared system prompt gets a short melodic paragraph through `Instrument::system_prompt`: pitch-named lanes, chords as multiple lanes, holds for sustained notes, and staying within the range listed.

For melodic instruments the JSON schema's lane enum lists the row ids, 61 values for piano. That is small enough for Claude tool schemas and Ollama `format` schemas. Flats and MIDI numbers are accepted by the normalizer, not the schema. Strict-schema providers therefore only ever emit sharps, and lenient providers are still repaired.

### D3. Melodic lane resolution with octave folding
`Instrument::resolve_row` stays as it is for drums. For `kind == Melodic`, lanes go through `parse_pitch(raw) -> Option<i32>`:
- It is case-insensitive.
- It accepts the letter A–G, then `#`/`b`/`♯`/`♭` (zero or one), then an octave from −1 to 9.
- Alternatively it accepts a bare integer from 0 to 127.

The result is folded into `[low, high]` by adding or subtracting 12 until it fits. The nearest octave is used: fold down from above and up from below. A range narrower than an octave could make a pitch class unreachable, so the lane is dropped then. No catalog instrument has such a range, but the code must not loop.

Folding can make two lanes land on one row, for example `C4` and `C5` when the range tops out at `B4`. The existing `merge_loudest` behavior then keeps the louder note per (row, step).

### D4. Deterministic melodic fallback variation
This is a `melodic_phrase_end` hook shared by all melodic instruments, a *cadence* variant of the primary measure:
1. Keep the notes that start in the first half of the measure (`step < steps_per_measure / 2`).
2. Extend every note that starts at the latest remaining onset so it lasts to the end of the measure.
3. If the first half has no notes, take the measure's first onset group, move it to step 0, and hold it to the end.
4. If the result still equals the primary, as with a whole-measure chord, transpose its highest note up an octave, or down if that leaves the range.

This always differs from the primary for any non-empty measure, never invents pitches outside the chord material except the octave move, and stays inside the range. The drum snare-roll hook is unchanged.

### D5. `midi_program` on the pattern, optional on input
`Pattern` gains `#[serde(default)] midi_program: Option<u8>`. Build and `Pattern::empty` copy it from the instrument.

On export, a missing value falls back to the instrument's program, looked up through the registry. The export handler therefore receives the registry, just as generate already does. That keeps browser-saved v1 drum patterns, which lack the field, valid, and it means old melodic patterns cannot exist yet. `version` stays 1 because the change is purely additive.
- *Alternative considered:* bumping `version` to 2. That would force a frontend migration for no behavior gain.

The ts-rs output makes the field `midi_program: number | null`. Frontend literals in tests need it, and `just gen-types` regenerates the types.

### D6. Program Change at tick 0 on the note track
The Program Change goes into the note track, after the track name and before any note, on `midi_channel - 1`, with wire value `program - 1`. It is omitted when `midi_program` is `None`. Logic Pro ignores program changes for Software Instrument tracks but honors them when a GM device is used. The spec only requires the event to be present and parse correctly, and manual Logic checks confirm pitches.

### D7. Channel 1 for melodic single-instrument patterns
Single patterns are exported alone, so any non-drum channel works. Channel 1 matches what DAWs default to. Multitrack export (`add-song-export`) reassigns channels per track, so this is not a constraint on songs.

### D8. Mock provider examples
`piano.rs` ships four example drafts:
- ballad: whole-note chords;
- pop: syncopated chords plus a top line;
- jazz: shell voicings;
- arpeggio: broken chords.

Each has keywords like the drum examples. The mock stays deterministic, and piano tests run offline.

## Risks / Trade-offs

- **[Risk] Models write melodies measure by measure, so drafts get long for 32 measures.** → The arrangement still repeats sections. The prompt tells the model to reuse sections, and output size is bounded by `sections × lanes`. The existing timeout and retry handle failures.
- **[Risk] A 61-value enum in the schema raises token cost per request.** → Roughly 300 tokens, which is acceptable. Revisit only if Ollama models degrade.
- **[Risk] `RowDef` string ownership churn touches drum code.** → Keep `RowDef`'s public shape stable behind the `row_list()`/`info()` accessors. Drum tests and the drums schema snapshot must pass unchanged.
- **[Trade-off] Octave folding can change a voicing the model intended.** → This is preferable to dropping notes. The user can edit the result.

## Migration Plan

This is additive and needs no data migration. Deploy the backend and frontend together, because the regenerated types add a required-in-TS field. Roll back by reverting the PR; no state is stored server-side.
