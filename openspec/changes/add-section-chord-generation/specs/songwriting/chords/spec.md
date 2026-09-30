# Spec Delta

## Purpose

Gives songwriters a harmonic plan for their song: a key and a chord progression for each section. Progressions can be generated from a plain-language prompt, edited by hand, and turned into notes on a track.

## ADDED Requirements

### Requirement: Song key
A song SHALL have an optional `key` of the form `<tonic> <mode>`, where:
- `tonic` is one of `C`, `C#`, `Db`, `D`, `D#`, `Eb`, `E`, `F`, `F#`, `Gb`, `G`, `G#`, `Ab`, `A`, `A#`, `Bb`, `B`;
- `mode` is `major` or `minor`.

The song page SHALL let the user choose a key, or choose "Auto" (no key). When chords are generated for a song with no key, the key returned by the generation SHALL become the song's key.

#### Scenario: Auto key is filled in
- **WHEN** a song has no key and chord generation returns key `A minor`
- **THEN** the song's key becomes `A minor`

#### Scenario: Explicit key is kept
- **WHEN** the song's key is `D major` and chords are generated
- **THEN** the song's key is still `D major` afterwards

### Requirement: Chord symbols
A chord SHALL be written as a symbol with three parts:
- a root, which is a letter `A`–`G` optionally followed by `#` or `b`;
- a quality, which is exactly one of: `` (major), `m`, `7`, `maj7`, `m7`, `dim`, `aug`, `sus2`, `sus4`, `m7b5`, `dim7`, `6`, `m6`, `9`, `add9`;
- an optional slash bass, written `/` followed by a root.

The system SHALL accept these aliases on input and store their canonical form:
- `maj` and `M` → major
- `min` and `-` → `m`
- `M7` and `Δ7` → `maj7`
- `min7` and `-7` → `m7`
- `ø` and `ø7` → `m7b5`
- `°` → `dim`
- `°7` → `dim7`

Any other symbol SHALL be rejected. The browser and the service SHALL parse symbols identically.

#### Scenario: Canonical symbols accepted
- **WHEN** the user enters `F#m7b5`, `Bb/D`, or `Gsus4`
- **THEN** each is accepted and stored exactly as entered

#### Scenario: Alias normalized
- **WHEN** the user enters `CM7`
- **THEN** the chord is stored as `Cmaj7`

#### Scenario: Unknown symbol rejected
- **WHEN** the user enters `H7` or `Cmaj13#11`
- **THEN** the symbol is rejected with a message and the previous chord is unchanged

### Requirement: Section chord progressions
Each section SHALL hold an ordered list of chords. Each chord SHALL have a `symbol`, a `start_step` (relative to the section's start), and a `length_steps`.

The unit for chord positions is the beat, defined as 4 steps in 4/4 and 3/4 and 6 steps in 6/8. A chord's `start_step` and `length_steps` SHALL be multiples of the beat, and each chord SHALL last at least one beat.

A section's chords SHALL either be empty or tile the section from its start to its end, with no gaps and no overlaps.

#### Scenario: Progression tiles a section
- **WHEN** a 4-measure 4/4 section has chords `C`, `Am`, `F`, `G`, one per measure
- **THEN** their `start_step` values are 0, 16, 32, 48, each has `length_steps` 16, and together they end at step 64

### Requirement: Generate chords from a prompt
The system SHALL expose `POST /api/v1/songs/chords/generate`. The request body SHALL be JSON with these fields:
- `song`: the song document, including its sections and optional key;
- `section_ids`: a non-empty list of section ids from that song;
- `prompt`: a string.

On success the response SHALL be `200` with this body:
- `key`: the song's key if one was set, otherwise a key chosen to suit the prompt;
- `sections`: a list of `{section_id, chords}`, one entry for each requested section, where each progression satisfies "Section chord progressions".

The generation SHALL take the song's tempo, meter, and key into account, along with each section's name, kind, length, and notes. It SHALL also take into account the chords already present in sections that were not requested, so that the new progressions fit the rest of the song.

#### Scenario: Chords for one section
- **WHEN** a client requests chords for the 8-measure Chorus of a 4/4 song in `C major`, with prompt "uplifting, big lift from the verse"
- **THEN** the response is `200` with key `C major` and one section entry for the Chorus, whose chords tile steps 0–128 on beat boundaries with valid symbols

#### Scenario: Several sections at once
- **WHEN** a client requests chords for the Verse and the Chorus
- **THEN** the response contains exactly one entry for each, in the order requested

#### Scenario: Other sections inform the result
- **WHEN** the Verse already has chords and a client requests chords only for the Chorus
- **THEN** the provider receives the Verse's chords as context, and the Verse is not part of the response

### Requirement: Chord generation input validation
The system SHALL reject a request with status `422`, without invoking the AI provider, when any of the following holds:
- `prompt` is empty or only whitespace (`invalid_prompt`);
- the prompt's estimate is over the configured `max_input_tokens`, using the same estimation rule as pattern generation (`prompt_too_long`);
- `section_ids` is empty, repeats an id, or names a section that is not in the song (`invalid_section`);
- the song has an invalid `key` (`invalid_key`);
- the song document is otherwise invalid (`invalid_song`).

#### Scenario: Unknown section
- **WHEN** a client requests chords for a section id that is not in the song
- **THEN** the response is `422` with error code `invalid_section` and no AI provider call is made

#### Scenario: Prompt too long
- **WHEN** the limit is 256 and the prompt's estimate is 257
- **THEN** the response is `422` with error code `prompt_too_long` and no AI provider call is made

### Requirement: Chord output is normalized
The system SHALL normalize every AI provider response before returning it, as follows:
1. Aliases SHALL be canonicalized and unparseable chord symbols dropped.
2. Starts SHALL be snapped down to a beat, and lengths rounded to whole beats with a minimum of one.
3. Chords SHALL be sorted, and overlaps trimmed so that the earlier chord ends where the later one starts.
4. Gaps SHALL be filled by extending the preceding chord. If the first chord starts after step 0, it SHALL be moved to start at 0.
5. The last chord SHALL be extended or truncated to end exactly at the section's end.
6. A key that is missing or invalid SHALL be replaced with the song's key or, if the song has none, `C major`.

If the response cannot be parsed, or a requested section ends up with no chords after normalization, the system SHALL retry once. If the retry also fails, it SHALL respond `502` with error code `generation_failed`. A generation that exceeds the configured generation timeout SHALL respond `504` with error code `generation_timeout`.

The same provider selection and startup checks as pattern generation SHALL apply, and a deterministic mock provider SHALL be available.

#### Scenario: Gap filled
- **WHEN** the provider returns `C` at step 0 with length 16 and `G` at step 32 in a 4-measure 4/4 section
- **THEN** the returned `C` has `length_steps` 32 and `G` runs from step 32 to step 64

#### Scenario: Off-beat start snapped
- **WHEN** the provider returns a chord starting at step 6 in 4/4
- **THEN** the returned chord starts at step 4

#### Scenario: Provider fails twice
- **WHEN** the provider returns unparseable output on the first attempt and on the retry
- **THEN** the response is `502` with error code `generation_failed`

#### Scenario: Mock provider is deterministic
- **WHEN** the service uses the mock provider and the same request is sent twice
- **THEN** both responses are identical and no outbound network request is made

### Requirement: Generate chords from the song page
The song page SHALL provide a "Generate chords" action with the following controls:
- a prompt field, with the same token counter and limit behavior as the pattern prompt;
- a scope, which is either the selected section or all sections;
- the key selector.

Generation SHALL be disabled for an empty or over-limit prompt. While a request is in flight, the page SHALL show a loading state. On success, the page SHALL replace the chords of the requested sections, and SHALL set the key when the song had none. The whole result SHALL be applied as one undoable edit. On failure, the page SHALL show the error and SHALL leave every chord unchanged.

If the song has no explicit sections, the implicit section SHALL first be made explicit, as described in songwriting/sections.

#### Scenario: Undo a generation
- **WHEN** the user generates chords for the Chorus and then presses Cmd/Ctrl+Z
- **THEN** the Chorus's previous chords, and the previous key, are restored

#### Scenario: Failure keeps chords
- **WHEN** the Verse has chords and a generation for the Verse fails
- **THEN** an error is shown and the Verse's chords are unchanged

### Requirement: Chord lane
The song page SHALL show a chord lane aligned with the tracks' measure grid, beneath the section ruler. Each chord's symbol SHALL be drawn across its duration. The user SHALL be able to edit the lane in these ways:
- change a chord's symbol, validated as described in "Chord symbols";
- split a chord at any beat inside it, which makes two chords with the same symbol;
- delete a chord. The preceding chord extends to cover the deleted chord's span. If the deleted chord was the section's first chord, the following chord extends back to the section start instead. Deleting a section's only chord leaves the section with no chords;
- drag the boundary between two adjacent chords in the same section, one beat at a time, with each chord keeping at least one beat;
- add a chord to a section with no chords, which creates a single chord spanning the whole section.

Every chord edit SHALL be undoable.

#### Scenario: Split a chord
- **WHEN** a 4/4 chord `C` spans steps 0–32 and the user splits it at beat 3
- **THEN** there are two `C` chords, spanning steps 0–8 and 8–32

#### Scenario: Delete a chord
- **WHEN** a section has `C` (steps 0–16), `F` (steps 16–32), and `G` (steps 32–64), and the user deletes `F`
- **THEN** `C` spans steps 0–32 and `G` is unchanged

#### Scenario: Boundary cannot erase a chord
- **WHEN** the user drags the boundary between `C` (0–16) and `F` (16–20) to step 20
- **THEN** the boundary stops at step 16, so that `F` keeps one beat

### Requirement: Chords follow section edits
When a section is lengthened, the section's last chord SHALL be extended to the new end.

When a section is shortened:
- chords starting at or beyond the new end SHALL be removed;
- a chord crossing the new end SHALL be truncated to end at it.

When a section is duplicated, the copy SHALL get an identical progression. When a section is deleted, its chords SHALL be removed. Renaming a section or changing its kind SHALL NOT change its chords.

#### Scenario: Duplicate carries chords
- **WHEN** a Chorus with chords `F`, `G`, `C`, `Am` is duplicated
- **THEN** "Chorus 2" has chords `F`, `G`, `C`, `Am` at the same relative positions

#### Scenario: Lengthen extends last chord
- **WHEN** a 4-measure 4/4 section ending in `G` (steps 48–64) is resized to 6 measures
- **THEN** `G` spans steps 48–96

### Requirement: Render chords to a track
The user SHALL be able to render the chords in a range into a chosen melodic track. The range is either the selected section or the whole song. Drums tracks SHALL NOT be offered as targets.

Rendering SHALL write one sustained voicing per chord into a new loop on the track, as long as the range, with note positions counted from the start of the range. The loop SHALL be named "<section name> chords", or "Song chords" when the range is the whole song, and SHALL be placed as one clip covering the range. The track's clips in the range SHALL be removed, split, or trimmed exactly as when a track generation result is applied (see `songs/track-generation`, "Generate a track in the Studio"), and the contents of existing loops SHALL NOT change. The notes SHALL have velocity 90, and each SHALL last the chord's full length. The voicing SHALL be deterministic:
- **Instruments whose highest note is at or below MIDI 60**: the voicing SHALL contain only the slash bass, or the root when there is no slash bass. It SHALL be placed in the lowest octave within the instrument's range.
- **All other instruments**: the voicing SHALL be the chord tones in close position. The root SHALL be placed in the octave C3–B3 (MIDI 48–59), and the remaining tones stacked upward. A slash bass SHALL be added in the octave below the root. Tones outside the instrument's range SHALL be moved by octaves until they are inside it.

The render SHALL be one undoable edit.

#### Scenario: Pad gets full voicings
- **WHEN** a 1-measure 4/4 section has chord `Am` and it is rendered to a Piano track
- **THEN** the track has a new 1-measure loop holding A3, C4, and E4 at loop step 0, each with `length_steps` 16 and velocity 90, placed as one clip covering the section

#### Scenario: Bass gets roots
- **WHEN** chord `C/E` is rendered to a track whose instrument's range tops out below MIDI 60
- **THEN** the rendered loop has a single E note, in the lowest octave within its range, lasting the chord's full length

#### Scenario: Linked clips elsewhere are unaffected
- **WHEN** a Piano track plays the loop "Keys A" in both the Verse and the Chorus, and the user renders the Chorus chords to that track
- **THEN** the Chorus gets a clip of the new loop "Chorus chords", and the Verse clip still plays "Keys A" unchanged

#### Scenario: Drums not offered
- **WHEN** the user opens "Render chords to track"
- **THEN** drums tracks are not listed as targets

### Requirement: Chord persistence
The song key and all section chords SHALL be saved with the song in the browser and SHALL be included in the song project file. Reloading the page SHALL restore them. Songs and project files without a key or chords SHALL load unchanged.

#### Scenario: Reload keeps chords
- **WHEN** the user generates chords, edits one, and reloads the page
- **THEN** the key and the edited chords are shown
