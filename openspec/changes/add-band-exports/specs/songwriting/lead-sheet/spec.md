# Spec Delta

## Purpose

Turns a song's form, chords, lyrics, and melody into a lead sheet that a band can read: a printable chart (PDF through the browser) and a MusicXML file that opens in notation software. Each part is optional, so a song with only some of them still produces a useful chart.

## ADDED Requirements

### Requirement: Lead sheet options
A lead-sheet request SHALL carry a song document and these options:
- `melody_track_id`: the id of a track to use as the melody, or `null` for no melody;
- `chord_display`: `symbols` (default) or `nashville`;
- `include_lyrics`: a boolean (default `true`).

The request SHALL be rejected with status `422` when:
- the song fails the song validation used for export (`invalid_song`);
- `melody_track_id` names no track in the song, or names a drum track or an audio track (`invalid_melody_track`);
- `chord_display` is `nashville` and the song has no key (`key_required`).

Lead-sheet options SHALL NOT be saved with the song.

#### Scenario: Drum track as melody rejected
- **WHEN** a client requests a lead sheet with `melody_track_id` set to the Drums track
- **THEN** the response is `422` with error code `invalid_melody_track`

#### Scenario: Nashville without a key
- **WHEN** a client requests `chord_display` `nashville` for a song with no key
- **THEN** the response is `422` with error code `key_required`

### Requirement: Lead sheet endpoint
The system SHALL expose `POST /api/v1/songs/export/lead-sheet`. It SHALL accept a lead-sheet request as its JSON body and respond `200` with a JSON lead sheet that holds:
- the song's name as the title, its tempo, its time signature, and its key (or none);
- whether the song swings;
- the song's sections in order, each with its name, its kind, its first measure, and its measures;
- for each measure, the chords shown in it, each with its beat position and display text;
- each section's lyrics, when lyrics are included;
- lyrics that belong to no section;
- the melody, when a melody track is chosen.

The endpoint SHALL NOT store the song and SHALL NOT call an AI provider. The same request SHALL always produce the same response.

#### Scenario: Lead sheet for a sectioned song
- **WHEN** a client posts a 4/4 song "Late Train" at 96 BPM in G major, with sections Intro (4), Verse (8), and Chorus (8)
- **THEN** the response is `200` with title "Late Train", 96 BPM, 4/4, G major, and three sections covering measures 1–4, 5–12, and 13–20

### Requirement: Sections and bars on the lead sheet
The lead sheet SHALL have one bar for every measure of the song, grouped by section in song order. Each section's name SHALL label its first bar. A song without sections SHALL be laid out as its implicit sections (see `songwriting/sections`), but implicit section names SHALL NOT be shown as labels.

#### Scenario: Section labels
- **WHEN** a song has sections Intro, Verse 1, and Chorus
- **THEN** the lead sheet labels the first bar of each with "Intro", "Verse 1", and "Chorus"

#### Scenario: Unsectioned song
- **WHEN** a 12-measure song has no sections
- **THEN** the lead sheet has 12 bars and no section labels

### Requirement: Chords on the lead sheet
When a section holds chords, each chord SHALL appear in the bar and at the beat where it starts. Its display text SHALL be the chord's canonical symbol, or its Nashville number when `chord_display` is `nashville`. A bar in which no chord starts, but in which a chord is sounding, SHALL show the sounding chord at beat 1. Every bar can therefore be read on its own, including the first bar of a line or a page.

When a section holds no chords, its bars SHALL have no chords. This includes every song made before chords existed. The rest of the lead sheet SHALL be unaffected.

#### Scenario: Two chords in a bar
- **WHEN** a 4/4 bar has `C` from beat 1 and `G/B` from beat 3
- **THEN** that bar shows `C` at beat 1 and `G/B` at beat 3

#### Scenario: Held chord
- **WHEN** an `Am` chord lasts two measures
- **THEN** both bars show `Am` at beat 1

#### Scenario: Song without chords
- **WHEN** no section of the song holds chords
- **THEN** the lead sheet has its section labels, its bars, and its lyrics, and every bar is empty of chords

### Requirement: Lyrics on the lead sheet
When `include_lyrics` is true and the song has lyrics, the lyrics SHALL be split by lyric headings (see `songwriting/lyrics`):
- Text under a heading SHALL be attached to every song section that the heading is linked to, so a chorus sung three times shows its words three times.
- Text before the first heading SHALL be attached to the song's first section.
- Text under an unlinked heading SHALL be kept, with its heading, as lyrics that belong to no section.
- Blank lines at the start and end of each block SHALL be dropped. Lines inside a block SHALL be kept as typed.

When `include_lyrics` is false, or the song has no lyrics, the lead sheet SHALL have no lyrics.

#### Scenario: Lyrics follow headings
- **WHEN** the lyrics are `[Verse 1]`, two lines, `[Chorus]`, and two lines, and the song has sections Verse 1, Chorus, and a second Chorus
- **THEN** Verse 1 has the first two lines, and both Chorus sections have the last two lines

#### Scenario: Unlinked heading kept
- **WHEN** the lyrics contain `[Tag]` and the song has no section named Tag
- **THEN** the lines under `[Tag]` appear as unplaced lyrics headed "Tag"

#### Scenario: Lyrics without headings
- **WHEN** a song's lyrics have no headings
- **THEN** all of the lyrics are attached to the first section

### Requirement: Melody on the lead sheet
When `melody_track_id` names a melodic track, the lead sheet SHALL include that track's melody. The melody is the notes the track's clips play over the song, as for MIDI export, reduced to a single line:
- where notes overlap, the highest sounding pitch SHALL be kept, and an earlier note SHALL be cut where a higher one starts;
- note positions and lengths SHALL stay on the song's step grid;
- a note that crosses a beat or bar line where standard notation needs a break SHALL be written as tied notes;
- silences SHALL be written as rests;
- pitches SHALL be written at concert pitch and spelled to the song's key: flats in flat keys, sharps in sharp keys and in C major or A minor, or when the song has no key.

When the melody track carries lyric syllables aligned to its notes, those syllables SHALL appear under their notes, and the lyrics of the sections they cover SHALL NOT also be printed as text. Otherwise, lyrics SHALL appear as text per section.

When the song has a designated melody track (from add-topline-melody), the Studio SHALL propose it as the default melody. Otherwise, the default SHALL be no melody.

#### Scenario: Overlapping notes reduced
- **WHEN** the melody track plays C5 from step 0 to step 8 and E5 from step 4 to step 12
- **THEN** the melody has C5 for steps 0–4 and E5 for steps 4–12

#### Scenario: Note tied across the bar
- **WHEN** a 4/4 melody note starts on beat 4 of measure 1 and lasts two beats
- **THEN** it is written as a quarter note tied to a quarter note in measure 2

#### Scenario: Spelling in a flat key
- **WHEN** the song is in F major and the melody plays MIDI note 70
- **THEN** the note is spelled B♭4

#### Scenario: No melody chosen
- **WHEN** `melody_track_id` is `null`
- **THEN** the lead sheet has no melody

### Requirement: Nashville numbers
When `chord_display` is `nashville`, each chord's display text SHALL be its Nashville number relative to the tonic of the song's key, which is 1:
- The root SHALL be written as a scale degree 1–7 of the key's major scale. A root that is not in the scale SHALL take a `b` prefix on the degree above, except for the degree between 4 and 5, which SHALL be written `#4`.
- The chord's quality suffix SHALL be kept as in the symbol, written after the number. A major triad has no suffix. In the printed chart, the suffix SHALL be raised, so that `57` reads as 5 with a 7.
- A slash bass SHALL be written as a number after `/`.

MusicXML SHALL always use chord symbols, whatever `chord_display` is.

#### Scenario: Numbers in a major key
- **WHEN** a song in G major has chords `G`, `Em7`, `C/E`, and `D7`
- **THEN** they are shown as `1`, `6m7`, `4/6`, and `57`

#### Scenario: Borrowed chord
- **WHEN** a song in C major has the chords `Bb` and `F#m7b5`
- **THEN** they are shown as `b7` and `#4m7b5`

#### Scenario: Minor key
- **WHEN** a song in A minor has the chords `Am`, `F`, and `G`
- **THEN** they are shown as `1m`, `b6`, and `b7`

### Requirement: MusicXML export endpoint
The system SHALL expose `POST /api/v1/songs/export/musicxml`. It SHALL accept a lead-sheet request and respond `200` with `Content-Type: application/vnd.recordare.musicxml+xml`, an uncompressed MusicXML 4.0 `score-partwise` document as the body, and a `Content-Disposition` attachment filename of `songbird-<slug of song name>-<tempo_bpm>bpm.musicxml`. The request SHALL be validated as in "Lead sheet options". The document SHALL contain a single part, with:
- the title as the work title;
- the time signature, the key signature, and a tempo marking at the start, plus "Swing" when the song swings;
- one measure per lead-sheet bar;
- each section name as a rehearsal mark on its first measure, and a double bar line at the end of each section except the last, which SHALL end with a final bar line;
- each chord as a harmony element at its beat, written where the chord starts and at the first measure of each section;
- the melody's notes, rests, and ties, with aligned syllables as lyrics, when there is a melody;
- when there is no melody, one slash-notehead note per beat in each measure, so notation software shows a rhythm-slash chart.

The endpoint SHALL NOT store the song and SHALL NOT call an AI provider.

#### Scenario: Download MusicXML
- **WHEN** a client posts a valid song "Late Train" at 96 BPM
- **THEN** the response is `200` with `Content-Type: application/vnd.recordare.musicxml+xml` and filename `songbird-late-train-96bpm.musicxml`

#### Scenario: Chord-only chart
- **WHEN** a 4/4 song with chords and no melody is exported
- **THEN** every measure has four slash-notehead quarter notes, and harmony elements where the chords start

#### Scenario: Rehearsal marks
- **WHEN** a song with sections Verse and Chorus is exported
- **THEN** the first measure of each section has a rehearsal mark with the section's name, and the Verse's last measure ends with a double bar line

### Requirement: MusicXML compatibility
Every exported MusicXML document SHALL validate against the MusicXML 4.0 schema. It SHALL open in MuseScore 4 without a repair prompt, showing the title, the tempo, the section rehearsal marks, the chord symbols, and the melody or slashes.

#### Scenario: Schema validation
- **WHEN** MusicXML documents exported from the lead-sheet test fixtures are validated against the MusicXML 4.0 XSD
- **THEN** every document validates

#### Scenario: Round trip of chords
- **WHEN** an exported document is parsed by an independent XML parser
- **THEN** the harmony elements, read in order with their measures and offsets, reproduce the song's chords and positions

### Requirement: Printable chart
The Studio SHALL provide a print view of the lead sheet in a "Chart" layout, to be printed or saved as PDF through the browser's print dialog. The layout SHALL show:
- the title, tempo, time signature, and key, at the top of the first page;
- the bars four to a line, with each section starting a new line under its label;
- the chord display text in each bar, at its beat position;
- a `%` simile sign in a bar whose chords are identical to the previous bar's in the same section, in place of repeating the chords;
- each section's lyrics under that section's bars;
- unplaced lyrics, under their headings, after the last section.

A section SHALL NOT be split across pages unless it is taller than a page. Printing SHALL hide every part of the Studio except the lead sheet. The layout SHALL fit on both Letter and A4 paper.

#### Scenario: Print a chart
- **WHEN** the user opens the lead sheet and chooses "Print / Save as PDF"
- **THEN** the browser's print dialog opens, with a preview that shows only the chart

#### Scenario: Simile bar
- **WHEN** two consecutive bars of a verse both hold only `Am`
- **THEN** the second bar shows `%`

#### Scenario: Chart without chords or lyrics
- **WHEN** the song has sections but no chords and no lyrics
- **THEN** the chart shows the header, section labels, and empty bars

### Requirement: Printable melody layout
When a melody track is chosen, the print view SHALL also offer a "With melody" layout. This layout SHALL show the MusicXML lead sheet engraved in standard notation, with the rehearsal marks, chord symbols, melody, and aligned syllables. Lyrics that are not aligned to the melody SHALL follow the notation as text per section, under their section names. The notation engraver SHALL be loaded only when this layout is first shown. If it fails to load, the view SHALL say so and SHALL keep the "Chart" layout available.

#### Scenario: Melody layout
- **WHEN** the user chooses the Lead track as melody and the "With melody" layout
- **THEN** the print preview shows a single staff with the Lead track's melody, the chord symbols above it, and the section rehearsal marks

#### Scenario: No melody, no melody layout
- **WHEN** no melody track is chosen
- **THEN** the "With melody" layout is not offered

#### Scenario: Engraver fails to load
- **WHEN** the notation engraver cannot be loaded
- **THEN** the view shows an error for the "With melody" layout, and the "Chart" layout still prints

### Requirement: Lead sheet action in the Studio
The Studio page SHALL provide a "Lead sheet" action that opens a dialog for the open song, including unsaved edits. The dialog SHALL offer:
- the melody track: none, or any melodic track;
- the chord display: chord symbols, or Nashville numbers. Nashville numbers SHALL be disabled, with an explanation, when the song has no key;
- whether to include lyrics;
- "Print / Save as PDF", which opens the print view;
- "Download MusicXML", which saves the file returned by the MusicXML endpoint.

The dialog SHALL say what is missing when the song has no chords, no lyrics, or no melody track, and SHALL name the feature that adds each. It SHALL NOT block the export. If a request fails, the dialog SHALL show the error and leave the song unchanged.

#### Scenario: Missing chords explained
- **WHEN** the user opens the lead-sheet dialog for a song without chords
- **THEN** the dialog notes that the chart has no chord symbols, and that chords can be generated or entered in the chord lane, and both export buttons stay enabled

#### Scenario: Download MusicXML from the Studio
- **WHEN** the user clicks "Download MusicXML"
- **THEN** a `.musicxml` file named from the song name and tempo is downloaded
