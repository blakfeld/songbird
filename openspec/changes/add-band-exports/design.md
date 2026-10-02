# Design

## Context

See proposal.md for the motivation. The change is grounded in the following existing code.

**Audio export (browser):**
- `frontend/src/lib/audio/mixdown.ts` (`renderMixdown`) snapshots the song and builds a `songPlaybackModel`.
  - It keeps only `audible` voices, and renders in 30-second `OfflineContext` segments, each with a 4-second pre-roll. The pre-roll lets held notes and effect tails from earlier audio arrive correctly.
  - It appends a tail of up to 4 s, trimmed at −60 dBFS, and encodes 16-bit WAV in a worker (`wavEncodeClient.ts`).
  - Each voice is a `tone.Channel(volume, pan)` behind an insert chain (`insertChain.ts`), connected straight to the destination. There is no master bus, so the mix is exactly the sum of the per-track channels.
  - Cancel is checked between segments.
- `fflate` is already a dependency, used by `lib/song/projectBundle.ts` for `.songbird.zip`.
- The export buttons live in `components/studio/SongFileActions.tsx`.

**Song model (`backend/crates/music/src/song.rs`, mirrored to TypeScript by ts-rs):**
- `Song` has `name`, `tempo_bpm`, `time_signature`, `steps_per_measure`, `swing`, and `key: Option<SongKey>`.
  - `SongKey` is `{tonic, mode}`, and tonics are spelled with sharps only (`A#`, not `B♭`).
  - It also has `loop_region: Option<LoopRegion { region: Option<MeasureRegion{start_measure,end_measure}>, enabled }>`, `tracks` (with `volume_db`, `pan`, `muted`, `soloed`), `lyrics`, and `sections` (with `name`, `kind`, `measures`, `notes`).
- `Section.chords` arrives with add-section-chord-generation, together with the Rust chord-symbol parser (`music/src/chords/symbol.rs`, `ChordSymbol { root, quality, bass }`).

**MIDI export:** `music::song_midi::song_to_midi(&ValidSong)` is served by `api/src/songs.rs::export_midi` at `POST /api/v1/songs/export/midi`, with a `song_filename` slug helper. The clip-to-absolute-notes expansion that MIDI export uses is what the melody reduction needs.

**Lyric headings:** these are parsed only in the frontend today (`songwriting/lyrics`, "Lyric headings"). The rule is a line that is only `[Name]`, matched to section names ignoring case and surrounding whitespace.

## Goals / Non-Goals

**Goals:**
- Stems that are sample-aligned with each other and with the mixdown, produced by the same renderer, so the two can never drift apart.
- Peak memory during stem export bounded by one track's segment, plus the encoded output.
- A single source of truth for the lead sheet: one Rust model feeds the JSON for the chart, the MusicXML, and, through MusicXML, the engraved melody.
- Every lead-sheet input (sections, chords, lyrics, melody) is optional, and its absence is a tested path.

**Non-Goals:**
- A notation editor, or any editing of the lead sheet in Songbird. Users who want to edit open the MusicXML in MuseScore.
- Server-side PDF generation.
- Multi-staff scores (piano grand staff, bass line, drums). The lead sheet is one melody staff.

## Decisions

### D1. Stems share the mixdown renderer, one track at a time
`renderMixdown` is split into:
- a core, `renderVoices(snapshot, voices, range, opts)`, which runs the existing segment loop;
- thin callers: the mixdown passes all audible voices, and stems call the core once per exported voice.

Range is a new input `{startSeconds, endSeconds, tail: "trim-to-floor" | "fixed" | "none"}`:
- the mixdown keeps `trim-to-floor`;
- stems use `fixed` (exactly 4 s) or `none`.

A fixed tail is what makes every stem the same length without first holding every stem in memory to find the longest tail.

For the mix options:
- **"Unity"** substitutes `volumeDb = 0, pan = 0` on the voice copies before rendering. The insert chain is untouched, so effects stay on.
- **"All tracks"** builds voices with mute and solo ignored. This needs a flag on `createSongPlaybackModel`, or a snapshot with `muted = soloed = false` everywhere. The snapshot approach is preferred because it touches no playback code.

The existing pre-roll already renders material from before a segment's window. Loop-region stems therefore set the first window's start to the region start, and get held notes and echoes from before the region for free.

*Alternative: render all tracks in one multichannel `OfflineContext`* (up to 32 channels, so 16 stereo stems) by routing each channel into a `ChannelMergerNode`. This would take one pass instead of N, but needs N× the memory per segment and a parallel routing path that the mixdown doesn't use. It is rejected for now and kept as the optimization to reach for if stem export proves too slow (see Risks).

### D2. Stems stream into a stored ZIP
Each finished stem is encoded (16-bit, or a new 24-bit path in `wavEncode.ts`, both in the worker) and pushed as `Uint8Array` chunks into an `fflate.Zip` with `ZipPassThrough` entries (stored, no compression). Output chunks accumulate as `Blob` parts. The browser can page Blob parts out of the JS heap, so only the current stem's float buffer and its encoded bytes are live at once.

Stored rather than deflated, because PCM audio barely compresses and deflate would take as long again as the render.

The 2 GB cap exists because `fflate` cannot write Zip64, so any file over 4 GiB would be corrupt. 2 GB also matches the project bundle's import limit and keeps clear of browser Blob quotas.

The estimate is `Σ stems × frames × 2 channels × bytes per sample`, plus the headers.

### D3. The lead-sheet model is built in Rust
A new module, `music::lead_sheet`, builds `LeadSheet` from `&ValidSong` and `LeadSheetOptions`. The model holds the header, sections, bars, the chords placed in bars with their beat and display text, the lyric blocks, and the melody as notation events (`Note { pitch: Spelled, duration_divisions, tie_start, tie_stop, syllable }` and `Rest`). The model is exported to TypeScript with ts-rs, and is the JSON body of `/export/lead-sheet`. `music::musicxml` serializes the same model.

Why Rust:
- the chord parser, song validation, and clip expansion already live there;
- MusicXML generation is pure, deterministic, and easy to snapshot-test in Rust;
- the chart view then just draws data, with no music logic duplicated in TypeScript.

*Alternative: build it all in TypeScript and write MusicXML in the browser.* This was rejected because it would duplicate the chord parser's music logic. It would also put spelling and quantization where the existing MIDI expansion code isn't.

### D4. MusicXML encoding choices
- **Format:** MusicXML 4.0 `score-partwise`, uncompressed `.musicxml`. `.mxl` (zipped) is smaller, but uncompressed XML is easier to test and to diff, and every target application opens both.
- **Divisions:** `divisions` = steps per quarter note (`steps_per_measure / beats × (beat_unit / 4)`), so every step-grid position is an integer duration and no rounding happens.
- **Key signature:** a fixed table converts the sharps-only `SongKey` to conventional spelling and `<fifths>`:
  - A# major → B♭ (−2), D# major → E♭ (−3), G# major → A♭ (−4), C# major → D♭ (−5), F# major → F# (+6);
  - A# minor → B♭m (−5), D# minor → D#m (+6), and D, G, C, and F minor are flat keys.

  Pitch spelling follows the signature's accidental direction (spec "Melody on the lead sheet").
- **Chords:** each chord is a `<harmony>` with `root-step`/`root-alter`, `kind` (with a `text` attribute holding Songbird's suffix so applications show it verbatim), optional `bass`, and `<offset>` in divisions when it is not on the downbeat. The quality → `kind` mapping is a table, unit-tested for every quality in `fixtures/chords.json`.
- **Rehearsal marks:** `<direction><direction-type><rehearsal>` holding the section name. A `<barline>` is `light-light` at section ends and `light-heavy` at the end of the song.
- **Bar ties:** the melody's tie-splitting follows standard beaming rules per meter:
  - simple meters split at beats when a note starts off the beat and crosses one;
  - compound meters split at dotted-quarter beats;
  - every meter splits at bar lines.

  A lookup of representable durations (whole through 16th, single dots) decides the pieces.
- **Writer:** use `quick-xml` for writing (escaping is handled) and for parsing in tests. Use `xmllint --schema` against a vendored MusicXML 4.0 XSD in a `just` recipe as the schema-validation check. The XSD is fetched into `backend/crates/music/tests/fixtures/musicxml/` once; if `xmllint` is absent, the test is skipped.

### D5. PDF: browser print of a Songbird-drawn chart, plus Verovio only for melody
Options considered:

| Option | Chart quality | Melody notation | Cost |
|---|---|---|---|
| A. Browser print of an HTML/SVG chart (print CSS) | Excellent; system fonts render any script used in the lyrics | None by itself | No dependency |
| B. jsPDF / pdf-lib generated in the browser | Good | None | Needs embedded fonts for non-Latin lyrics; a direct file download |
| C. Verovio (WASM, LGPL-3.0) renders MusicXML to SVG in the browser | Good for notation; poor for lyric blocks and chart grids | Excellent: chords, rehearsal marks, lyrics | Several MB of WASM, loaded lazily |
| D. OpenSheetMusicDisplay (BSD-3, VexFlow) | As C | Good, weaker on harmony and slash noteheads | About 1 MB of JS |
| E. Server-side LilyPond, MuseScore CLI, or Typst | Excellent | Excellent | A heavy binary on the VPS, a new conversion path to their formats, and render time on the server |

**Chosen:** A for the "Chart" layout, and A + C for the "With melody" layout.
- The chart is simple to draw from the `LeadSheet` JSON as HTML. It prints with the user's fonts, and the browser's "Save as PDF" makes the PDF. No PDF library and no font embedding are needed.
- For melody, Verovio renders the exact MusicXML the user can download. What is printed and what MuseScore opens therefore cannot disagree. It is dynamically imported only on the melody layout, so the Studio bundle does not grow.
- The print route is `/songs/[id]/lead-sheet` (client-only). It reads the open song from the store, so unsaved edits are included. It has a print stylesheet that hides the chrome and sets `break-inside: avoid` on sections.

*Trade-off:* "Print / Save as PDF" goes through the print dialog rather than downloading a `.pdf` directly. That is the price of not embedding fonts and not running a server renderer. B can be added later behind the same view, if users ask for a one-click PDF.

### D6. Lyrics are split in Rust, with a shared heading fixture
`music::lyrics` gains a `split_by_headings(lyrics, sections)`. It mirrors the frontend's heading rule, and both are tested against a new `fixtures/lyric_headings.json`, in the same way as `timing.json` and `chords.json`. The frontend notepad's heading parser is switched to consume the same fixture in its tests. This catches drift between the notepad and the export.

### D7. Melody source and graceful degradation
- **Melody track:** any melodic (non-drum, non-audio) track. When add-topline-melody lands, it is expected to mark one track as the topline. The dialog defaults to that track. If the change also provides per-note syllables, the lead-sheet builder reads them into `Note.syllable`. Until then, `syllable` is always `None`, and lyrics print as section blocks. This degradation is already specified, so add-topline-melody only has to fill the field.
- **Chords:** read through `Section.chords`. If this change is applied before add-section-chord-generation is archived, the chord tasks (tasks group 3) wait. Everything else in the lead sheet works without chords, by spec.
- **Monophonic reduction:** a sweep over the expanded notes, ordered by start, that keeps the highest sounding pitch (see spec). It reuses the clip expansion from `song_midi` so the lead sheet and the MIDI file agree on what a clip plays.

### D8. Nashville numbers are computed in Rust at display time
`chord_display = nashville` changes only each chord's display text in the model. The degree table and the `#4` exception are in the spec. MusicXML ignores the option, because MusicXML 4.0's `numeral` harmony is poorly supported by importers, and writing it would silently lose chords in Sibelius.

### D9. API shape mirrors the MIDI export
Both new routes:
- sit in `songs::router()`, beside `export/midi`, not in `ai_router()`, so they are not metered;
- reuse `ValidSong` and `song_filename`;
- return the error envelope used by the MIDI export.

Options are a separate `options` object rather than query parameters, so the request stays one JSON body under the existing 2 MiB limit.

## Risks / Trade-offs

- **[Stem render time scales with track count.]** A 16-track, 128-bar song could take minutes. → Mitigations:
  - the progress shows "n of N";
  - Cancel works between segments;
  - empty tracks are skipped;
  - D1's multichannel single pass is the fallback optimization if measurements on a real song exceed about 3× the mixdown time.
- **[Large Blob memory on low-RAM devices.]** → The 2 GB cap, the size estimate shown before rendering, and the 16-bit option. Measure peak memory in the `mixdown.real.test.ts` style harness on a long song.
- **[Floating-point differences between per-track and summed renders.]** Each segment's render differs only in which voices are present, and the destination sums linearly. Equality is tested within 1 LSB per stem, not bit-exactly.
- **[Verovio is LGPL-3.0.]** It is used as the unmodified npm package and dynamically linked (a separately loaded WASM module), which LGPL permits. Record it in third-party notices. If that is unacceptable, swap in OSMD (D5 option D) behind the same "With melody" layout.
- **[Slash-notehead rendering differs across applications.]** Some importers show slashes as normal notes on the middle line. That is still readable. Verify in MuseScore 4 manually (task 4.6).
- **[Lyrics placed by heading rather than by bar.]** Lyrics sit under a section's bars, not under individual bars. Aligning words to bars needs syllable timing, which is add-topline-melody's job.
- **[Sharps-only key spelling.]** The conversion table in D4 fixes notation. The song's key display elsewhere is unchanged.

## Migration Plan

No data migration; song documents are unchanged. Ship in two independently releasable parts:
1. stems (frontend only);
2. the lead sheet (backend and frontend), after add-section-chord-generation is archived.

Rollback is removing the actions. No stored data depends on them.

## Open Questions

- **Nashville in minor keys:** this design numbers from the minor tonic (`1m`, as in the spec). Many Nashville players number from the relative major (A minor's `Am` is `6m`). Should there be a per-export toggle? The model supports either, so it can be decided after user feedback.
- **24-bit as the default** stem depth assumes DAW users. If most users import into GarageBand or a phone app, 16-bit may be the friendlier default.
- **What add-topline-melody exposes:** this design assumes a track-level "topline" marker and optional per-note syllables. The field names are to be agreed when that change is written. The lead-sheet builder reads them through one adapter function.
- **Letter vs A4:** the print view is designed to fit both. Whether to expose a paper-size choice, or leave it to the print dialog, can be decided during UI review.
- **Including the full mix in the stems ZIP** (`00-mix.wav`), as some producers expect: it is cheap to add later, using the same renderer.
- **A one-click `.pdf` download** (option B), if the print dialog proves confusing.
