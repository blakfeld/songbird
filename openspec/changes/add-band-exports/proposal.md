# Proposal

## Why

Songbird exports a multitrack MIDI file and a single WAV mixdown today. Neither is what a songwriter hands to a band or a producer. A producer wants **stems**: one audio file per track, all starting at bar 1, that drop straight into any DAW without re-synthesizing the sounds. Musicians want a **lead sheet**: a printable chart with the form, the chords, and the words, and ideally the melody, in a format they can also open and edit in MuseScore, Sibelius, or Dorico. With sections (#7), lyrics, and chords (add-section-chord-generation) in place, Songbird holds everything a chart needs. It just cannot print it.

**Depends on:**
- add-song-export (archived), for `songs/export`, the browser offline renderer in `frontend/src/lib/audio/mixdown.ts`, the WAV encoder worker, and the `/api/v1/songs/export/` route group.
- add-timeline-loop-region (archived), for `Song.loop_region`, used by loop-region stem export.
- add-song-sections and add-lyric-notepad (archived), for section names and kinds, and for lyric headings linked to sections.
- **add-section-chord-generation (in progress)**, for `Section.chords` and the Rust chord-symbol parser. The lead sheet shows chord symbols only when sections hold chords. It does not need chords to work.
- **add-topline-melody (proposed)**, for a designated vocal/lead melody track and, if it provides them, lyric syllables aligned to melody notes. Without it, the user can pick any melodic track as the melody, and lyrics are printed as text blocks rather than under notes.

Stems have no dependency on either in-progress change and can ship first. The lead-sheet half should be applied after add-section-chord-generation is archived. The melody parts degrade as described in design.md until add-topline-melody lands.

## What Changes

- **Stem export**: a "Download stems" action renders one WAV per track in the browser, through the same offline renderer as the WAV mixdown, and downloads them as a single ZIP.
  - Every stem starts at the same moment (bar 1, or the loop region's first bar) and has the same length, so the files line up when dropped into a DAW at the same position.
  - Options:
    - which tracks: the tracks that are audible now (mute and solo respected, the default) or every track;
    - mix: "As mixed" (track volume, pan, and effects) or "Unity" (0 dB, centered, effects kept);
    - range: the whole song or the loop region only;
    - effect tails: on or off;
    - bit depth: 24-bit (default) or 16-bit.
  - The ZIP also holds a `stems.txt` that lists tempo, meter, key, sample rate, and start bar.
  - The page shows progress per stem and offers Cancel. It shows the estimated size before rendering, and refuses exports larger than 2 GB.
- **Lead sheet document**: a new endpoint, `POST /api/v1/songs/export/lead-sheet`, turns a song and lead-sheet options into a structured lead sheet. The lead sheet holds:
  - the title, tempo, meter, and key;
  - the bars grouped by section, with each section's name;
  - the chord symbols placed at their beats;
  - the lyrics grouped by section;
  - optionally, a monophonic melody taken from one track.
- **MusicXML export**: `POST /api/v1/songs/export/musicxml` writes the same lead sheet as a MusicXML 4.0 file that opens in MuseScore, Sibelius, and Dorico. It has:
  - section names as rehearsal marks;
  - chords as harmony elements;
  - the melody, or slash notation where there is no melody;
  - lyric syllables under the melody when they are aligned.
- **Printable lead sheet (PDF)**: a print view in the Studio, printed or saved as PDF through the browser's print dialog. It has two layouts:
  - **Chart**: a bar grid of chord symbols, with section labels and lyrics per section, drawn by Songbird.
  - **With melody**: the MusicXML engraved in standard notation by Verovio, which is loaded only when this layout is used.
- **Nashville number chart**: the chart layout can show chords as Nashville numbers relative to the song's key instead of chord symbols. This needs a key.
- **Graceful degradation**:
  - With no chords, the chart shows the sections, bars, and lyrics, with empty bars.
  - With no melody, there is no notation layout, and MusicXML uses rhythm slashes.
  - With no aligned syllables, lyrics are printed as text blocks per section.
  - With no lyrics, the lyric blocks are left out.

Non-goals:
- Server-side audio rendering, and stems in formats other than WAV (FLAC, MP3, or AIFF).
- Per-track MIDI stems. The multitrack MIDI file already serves this.
- Repeat signs, first and second endings, or D.S./coda. Every bar is written out.
- Transposing parts for B♭ or E♭ instruments.
- Detecting the melody automatically from a mix, or aligning lyric syllables to notes automatically.
- Chord symbols in MIDI export (still a non-goal of add-section-chord-generation).
- Storing exports on the server.

## Capabilities

### New Capabilities
- `songwriting/lead-sheet`: This covers the lead-sheet options, the structured lead-sheet endpoint, how sections, chords, lyrics, and the melody appear on the lead sheet, and how each degrades when absent. It also covers the MusicXML endpoint and its compatibility, the printable chart and melody layouts, Nashville numbers, and the Studio actions.

### Modified Capabilities
- `songs/export`: this change ADDS requirements for stem export: the stems download, stem alignment and length, stem options, loop-region stems, the size limit, progress, and the ZIP layout. It does not change the existing MIDI, project, or WAV mixdown requirements. The Studio's export actions may be grouped into a menu, which those requirements already allow.

## Impact

- **Backend (`music` crate)**:
  - a new `lead_sheet` module that builds the lead-sheet model from a validated song and options, with bar layout, chord placement, lyric splitting, melody reduction and quantization, pitch spelling, and Nashville numbers;
  - a new `musicxml` module that writes MusicXML 4.0;
  - a lyric-heading parser mirrored from the frontend through a shared fixture `fixtures/lyric_headings.json`;
  - lead-sheet types exported through ts-rs.
- **Backend (`api` crate)**: two routes, `POST /api/v1/songs/export/lead-sheet` and `POST /api/v1/songs/export/musicxml`. Both are under `/api/v1/songs/`, so the existing 2 MiB body limit applies. Neither calls an AI provider, and neither stores anything.
- **Frontend**:
  - `lib/audio/mixdown.ts` is refactored so that one renderer produces both the mix and each stem;
  - a 24-bit path is added to the WAV encoder;
  - a streaming stem ZIP is built with `fflate`, which is already a dependency;
  - a stems dialog;
  - a lead-sheet dialog and a print route;
  - Verovio (`verovio` npm package, WASM) is loaded on demand for the melody layout only.
- **Dependencies**:
  - `quick-xml` in the `music` crate, for writing and test-parsing XML;
  - `verovio` in the frontend, loaded lazily so it does not grow the Studio bundle.
- **Data**: no song document changes. Lead-sheet and stem options are not saved with the song.
- **Performance**: stems take roughly as long as one mixdown per exported track. Peak memory is bounded by rendering one track at a time in 30-second segments and streaming each encoded stem into the ZIP.
