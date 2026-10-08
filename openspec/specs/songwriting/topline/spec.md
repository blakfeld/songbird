# songwriting/topline Specification

## Purpose

Turns a section of the user's lyrics into a singable vocal melody (a topline) on a track of the song. Each syllable is attached to the note that sings it, stressed syllables fall on beats, phrases fit the section's bars, and every note fits the chosen voice range and the song's harmony.

## Requirements

### Requirement: Syllables and stress
Before a topline is generated, each lyric line of the chosen lyric section SHALL be split into syllables, and each syllable SHALL be marked stressed or unstressed. The rules are:
- **Lyric lines:** a lyric section's lines are the lines under its heading, up to the next heading (see `songwriting/lyrics`, "Lyric headings"). Blank lines SHALL be skipped.
- **Words:** a word is a run of letters, digits, and apostrophes. Other characters SHALL separate words and SHALL NOT appear in syllables.
- **Splitting:** English words SHALL be split by deterministic rules. Each syllable SHALL have one vowel group. A silent final `e` SHALL NOT form its own syllable, and a contraction such as `don't` SHALL be one syllable. A word with no vowel letter, a number, or a word in a non-Latin script SHALL be one syllable.
- **Display:** a syllable that is followed by another syllable of the same word SHALL end with `-`, for example `beau-`, `ti-`, `ful`.
- **Stress:**
  - A one-syllable word SHALL be stressed unless it is on the built-in list of function words (such as `a`, `the`, `and`, `of`, `to`, `in`, `my`, `your`).
  - A word of several syllables SHALL have exactly one stressed syllable, chosen by deterministic rules.
- **Same everywhere:** the same line SHALL always give the same syllables and stress, and the results SHALL match a shared table of example words.

The user SHALL be able to correct the result before generating:
- toggle a syllable's stress;
- re-split a word by typing it with hyphens, such as `ev-ery`. The letters SHALL be unchanged, and a split that changes them SHALL be refused.

Corrections SHALL NOT change the lyrics text.

#### Scenario: Split a line
- **WHEN** the lyric line is `Beautiful morning, don't fade away`
- **THEN** the syllables are `beau-`, `ti-`, `ful`, `mor-`, `ning`, `don't`, `fade`, `a-`, `way`

#### Scenario: Stress marks
- **WHEN** the lyric line is `Beautiful morning, don't fade away`
- **THEN** `beau-`, `mor-`, `don't`, `fade`, and `way` are stressed, and `ti-`, `ful`, `ning`, and `a-` are not

#### Scenario: Function words unstressed
- **WHEN** the lyric line is `and the night`
- **THEN** `and` and `the` are unstressed and `night` is stressed

#### Scenario: Correct a split
- **WHEN** the user re-splits `every` from `ev-`, `er-`, `y` to `ev-ery`
- **THEN** the word has the syllables `ev-` and `ery`, and the lyrics text still reads `every`

#### Scenario: Split that changes letters refused
- **WHEN** the user re-splits `every` as `ev-ry`
- **THEN** the correction is refused and the previous split is kept

#### Scenario: Blank lines skipped
- **WHEN** a lyric section holds two lyric lines separated by a blank line
- **THEN** the topline preview shows two lines

### Requirement: Voice range presets
A topline SHALL be generated for one voice range preset. Every note of a generated topline SHALL lie inside the preset's range and inside the target track's instrument range. The presets are:

| preset | range |
|---|---|
| Soprano | C4 (60) – A5 (81) |
| Alto | F3 (53) – D5 (74) |
| Tenor | C3 (48) – A4 (69) |
| Baritone | A2 (45) – F4 (65) |

When the instrument covers only part of the preset, the usable range SHALL be the overlap. When there is no overlap, or the overlap is narrower than one octave, the request SHALL be rejected (see "Topline request validation").

#### Scenario: Notes stay in the voice
- **WHEN** a topline is generated with the Alto preset on a Vocal Guide track
- **THEN** every returned note's pitch is between F3 and D5

#### Scenario: Partial overlap with the instrument
- **WHEN** a topline is generated with the Baritone preset on a Synth Lead track (C3 to C6)
- **THEN** every returned note's pitch is between C3 and F4

### Requirement: Lyrics on notes in the song document
A note in a loop MAY carry an optional `lyric`, a string of 1–16 characters with no line breaks. A note with a `lyric` starts that syllable. A note without one that follows a note with a lyric in the same loop continues the previous syllable, as a melisma.

A loop MAY carry an optional `topline` source, which records what the loop was generated from:
- `section_name`: the lyric section's name, 1–40 characters;
- `voice`: one of `soprano`, `alto`, `tenor`, or `baritone`;
- `lines`: 1–32 lines. Each line has its `text`, of at most 200 characters, and its `syllables`, 1–64 per line and at most 256 in all. Each syllable is a `text` of 1–16 characters and a `stressed` flag.

Both fields SHALL be saved through the same autosave as other song edits, included in "Download project" files, and loaded from "Open project" files. A note or loop without them SHALL be saved and downloaded without those fields, exactly as before this change, and songs saved before this change SHALL load unchanged. Saving a song that breaks these limits SHALL be refused with `422` and code `invalid_song`, storing nothing, and "Open project" SHALL reject such a file.

#### Scenario: Lyrics survive a reload
- **WHEN** the user generates a topline, waits for the song to show as saved, and reloads the page
- **THEN** the topline loop's notes show the same syllables

#### Scenario: Project round trip
- **WHEN** a song with a topline loop is downloaded as a project and that file is opened
- **THEN** the new project's loop has the same notes, syllables, and topline source

#### Scenario: Old documents unchanged
- **WHEN** a song with no lyrics on any note is downloaded as a project
- **THEN** no note in the file has a `lyric` field and no loop has a `topline` field

#### Scenario: Oversized syllable rejected
- **WHEN** a client saves a project whose song has a note with a 17-character `lyric`
- **THEN** the server responds `422` with code `invalid_song` and the stored project is unchanged

### Requirement: Topline generation endpoint
The system SHALL expose `POST /api/v1/songs/topline/generate`. The request body is a JSON object with these fields:
- `song`: a song document;
- `track_id`: the target track;
- `range`: `{start_measure, end_measure}`, 1-based and inclusive, which is the section's measures;
- `section_name`: the lyric section's name;
- `lines`: the syllabified lines, as in the `topline` source;
- `voice`: a preset;
- `prompt`: an optional style description, such as "soaring, mostly stepwise". It may be empty.

On success it SHALL respond `200` with these fields:
- `track_id` and `range`;
- `notes`: in the loop note shape, with `step` counted from the first step of `start_measure`, and each note's `lyric` set as described below;
- `prosody`: `{stressed_syllables, stressed_on_beat}`, where `stressed_on_beat` counts the stressed syllables whose notes start on a beat.

The endpoint SHALL NOT store the song or the result.

The endpoint SHALL require a signed-in user and SHALL apply the same AI access rules as the other AI endpoints: provider selection, per-user keys, per-minute and daily limits, the concurrent generation limit, and the error codes for a missing, rejected, exhausted, or rate-limited key. Its body limit SHALL be the same as the song endpoints'.

#### Scenario: Generate a chorus topline
- **WHEN** a client posts an 8-measure 4/4 song, a Vocal Guide track, `range` `{5, 8}`, two lines totalling 14 syllables, and `voice` `tenor`
- **THEN** the response is `200`, it has exactly 14 notes carrying a `lyric`, and every note lies within steps 0–63

#### Scenario: No AI key
- **WHEN** keys are per user and a signed-in user without a stored key posts a valid body
- **THEN** the response is `409` with error code `api_key_required` and no provider call is made

### Requirement: Topline request validation
The system SHALL validate the request before invoking the AI provider. A rejected request SHALL NOT invoke the provider.
- **Song:** the song SHALL pass song export validation, with the same error codes.
- **Track:** `track_id` SHALL name a track whose instrument is melodic and not a sampler or audio track. Otherwise the request SHALL be rejected with `422` and code `invalid_track`.
- **Range:** `range` SHALL be present and SHALL follow track generation's range rules. Otherwise the request SHALL be rejected with `invalid_range`.
- **Lines:** `lines` and `section_name` SHALL follow the limits of the `topline` source. Otherwise the request SHALL be rejected with `422` and code `invalid_lyrics`.
- **Fit:** the total syllable count SHALL NOT exceed the number of sixteenth-note steps in the range. Otherwise the request SHALL be rejected with `422` and code `lyrics_do_not_fit`.
- **Voice:** the voice's usable range on the target instrument SHALL span at least 12 semitones. Otherwise the request SHALL be rejected with `422` and code `invalid_voice`.
- **Prompt:** `prompt` MAY be empty. A non-empty prompt over `max_input_tokens` SHALL be rejected with `prompt_too_long`.

A body that is not valid JSON for the endpoint, including an unknown `voice`, SHALL be rejected with `400` and code `invalid_json`.

#### Scenario: Drums track rejected
- **WHEN** `track_id` names a Drums track
- **THEN** the response is `422` with code `invalid_track` and no provider call is made

#### Scenario: Too many syllables for the bars
- **WHEN** a 1-measure 4/4 range is sent with 17 syllables
- **THEN** the response is `422` with code `lyrics_do_not_fit` and no provider call is made

#### Scenario: Voice outside the instrument
- **WHEN** the Soprano preset is requested on a Bass track (E1 to G3)
- **THEN** the response is `422` with code `invalid_voice`

#### Scenario: Empty prompt accepted
- **WHEN** a valid request has `prompt` `""`
- **THEN** the request is accepted

### Requirement: Topline context
The AI provider SHALL receive, in addition to the lines and the prompt, the following context:
- the same song and other-track context that track generation sends for the target track and range, under the same token budget (see `songs/track-generation`);
- the section name;
- the voice's usable range;
- the strong beats of the meter: steps 0 and 8 in 4/4, step 0 in 3/4, and steps 0 and 6 in 6/8;
- the chords sounding in the range, when the song's sections have chords.

The lyric lines, syllables, section name, and prompt SHALL be passed as quoted material that the provider is told to treat as content, not as instructions, and that cannot end the quoting early.

#### Scenario: Chords reach the provider when present
- **WHEN** a topline is generated over a Chorus whose chords are `F`, `G`, `C`, `Am`
- **THEN** the context sent to the provider contains those chords with their positions

#### Scenario: No chords, key only
- **WHEN** a topline is generated in a song in E minor whose sections have no chords
- **THEN** the provider context names E minor and contains no chord information, and the request succeeds

#### Scenario: Lyrics cannot escape the fence
- **WHEN** a lyric line contains the closing tag used to fence the lines in the provider prompt
- **THEN** the provider receives that text escaped, still inside the fence

### Requirement: Topline output normalization
The system SHALL validate and normalize every provider response before returning it, so the following always hold:
- **Every syllable placed:** every syllable of every line SHALL be attached to exactly one note, in the order given, and that note's `lyric` SHALL equal the syllable's text. A syllable MAY be followed by up to 3 continuation notes without a `lyric`. Further continuation notes SHALL be dropped.
- **One line at a time:** notes SHALL NOT overlap in time. A note SHALL be shortened so it ends no later than the next note starts. Each line SHALL start no earlier than the previous line's last note starts.
- **Inside the range:** no note SHALL start before step 0 or end after the range's length. Lengths SHALL be at least 1 step.
- **Inside the voice:** a pitch outside the voice's usable range SHALL be moved by whole octaves to the nearest octave inside it.
- **Velocity:** velocities SHALL follow pattern generation's rules.

A response that leaves any syllable without a note, or places one outside the range, SHALL be invalid and SHALL be retried once. If the retry is also invalid, the system SHALL respond `502` with code `generation_failed`. A request that exceeds the generation timeout SHALL be aborted with `504` and code `generation_timeout`.

Placing stressed syllables on beats and fitting each line to whole measures are instructions to the provider, not normalization rules. The response's `prosody` SHALL report how well the stress rule was met.

#### Scenario: Missing syllable retried
- **WHEN** the provider's first response skips one syllable and its retry places every syllable
- **THEN** the response is `200` with every syllable attached to a note

#### Scenario: Missing syllable twice
- **WHEN** the provider skips a syllable on the first attempt and on the retry
- **THEN** the response is `502` with code `generation_failed`

#### Scenario: Overlap trimmed
- **WHEN** the provider places `love` at step 0 with length 8 and the next syllable at step 4
- **THEN** the returned `love` note has length 4

#### Scenario: Pitch folded into the voice
- **WHEN** the provider places a syllable on C6 for a Tenor topline
- **THEN** the returned note is on C4

### Requirement: Deterministic mock topline
When the service is configured with the mock provider, topline generation SHALL return the same notes for the same request every time, without network access. The mock's output SHALL obey these prosody rules:
- **Phrases:** the range SHALL be divided into one slot per line, of equal length rounded down to whole beats. Each line SHALL start at the start of its slot, except that a line MAY begin with a pickup: its unstressed syllables before the first stressed one are sung just before the slot, so that the first stressed syllable starts on the slot's first beat. A slot SHALL be shortened when the lines after it need the room, so that every line stays inside the range.
- **Stress on the beat:** every stressed syllable SHALL start on a beat whenever its line has at most two syllables per beat of its slot. The one exception is a line that begins unstressed and has no room for a pickup, because it is the first line of the range or the previous line has no step to spare.
- **Line ends:** the last syllable of each line SHALL hold until the end of its slot, or until the next line's pickup begins.
- **Pitch:** every note's pitch class SHALL be in the song key's scale. Every stressed syllable SHALL be on a tone of the chord sounding at its start, or on a tone of the tonic triad when no chord is sounding. The last note SHALL be on the key's tonic.
- **Velocity:** stressed syllables SHALL have velocity 100, and other notes velocity 80.

#### Scenario: Mock is repeatable
- **WHEN** the mock provider receives the same topline request twice
- **THEN** both responses are identical and no outbound network request is made

#### Scenario: Lines on the downbeats
- **WHEN** the mock generates a topline for an 8-measure 4/4 section with four lines of at most 8 syllables each
- **THEN** the lines start on the first beat of measures 1, 3, 5, and 7, every stressed syllable starts on a beat, and `stressed_on_beat` equals `stressed_syllables`

#### Scenario: Mock follows chords
- **WHEN** the mock generates a topline over a section whose only chord is `Am`
- **THEN** every stressed syllable's pitch class is A, C, or E

#### Scenario: Mock without chords
- **WHEN** the mock generates a topline in D major for a song without chords
- **THEN** every stressed syllable's pitch class is D, F#, or A, and the last note is a D

### Requirement: Generate a topline in the Studio
The Studio SHALL offer a "Generate topline" dialog. It is opened from a linked lyric heading (see `songwriting/lyrics`) or from a section's menu. The dialog SHALL show:
- **Section:** the section name and its measures.
- **Syllables:** each line's syllables, with stressed syllables marked and editable as described in "Syllables and stress".
- **Fit warning:** a warning when the syllable count exceeds what fits. In that case Generate SHALL be disabled.
- **Voice:** a preset selector. The last choice SHALL be remembered in this browser, starting at Tenor.
- **Target track:**
  - "New Vocal track" is the default. It adds a track named "Vocal" using the Vocal Guide instrument.
  - Every existing melodic track that is not a sampler is also offered. Drums and audio tracks SHALL NOT be offered.
- **Style:** a style prompt with the live token counter.
- **Other sections:** when other sections have the same name and the same length, an option to place the result on every one of them. It SHALL be on by default.

A section menu's "Generate topline" SHALL be disabled, with a hint to add a heading, when no lyric heading is linked to that section. When a lyric section is linked to several song sections, the dialog SHALL target the first of them in song order.

While the user has no usable AI key, Generate SHALL be disabled with the notice the song chat shows. While a request is in flight the dialog SHALL show a loading state. On failure the dialog SHALL show the error and leave the song unchanged. A result that arrives after a different song was opened SHALL be discarded. Adding the "Vocal" track SHALL be refused, with the reason shown, when the song already has 16 tracks.

On success, in one song undo step:
- the "Vocal" track SHALL be added, if chosen;
- the notes SHALL be written as a new loop named "<section name> topline", truncated to 40 characters, with its `topline` source set;
- the loop SHALL be placed as one clip over the section, replacing the target track's clips in that range by the same rules as track generation;
- when chosen, the loop SHALL also be placed as linked clips over each same-named section.

The lyrics text and the lyric undo history SHALL NOT change. After success the dialog SHALL close, the new clip SHALL be selected, and a short notice SHALL report the `prosody` result, such as "11 of 12 stressed syllables on the beat".

#### Scenario: Topline from the Chorus heading
- **WHEN** the notepad has a `[Chorus]` heading linked to a 4-measure Chorus section at measures 9–12, and the user chooses "Generate topline" on it and presses Generate with the defaults
- **THEN** a "Vocal" track is added, holding a "Chorus topline" loop placed as one clip over measures 9–12 whose notes show the Chorus syllables, and the lyrics are unchanged

#### Scenario: Placed on every chorus
- **WHEN** the song has three 4-measure sections named "Chorus", and the user generates a topline for the first with "every Chorus" on
- **THEN** the Vocal track has three linked clips of the same loop, one over each Chorus

#### Scenario: One undo step
- **WHEN** the user generates a topline onto a new Vocal track and then clicks the Studio's Undo button
- **THEN** the Vocal track is removed and the lyrics are unchanged

#### Scenario: Section without a heading
- **WHEN** the song has a "Bridge" section and the notepad has no `[Bridge]` heading
- **THEN** the Bridge section menu's "Generate topline" is disabled with a hint to add a `[Bridge]` heading

#### Scenario: Too many syllables
- **WHEN** a 1-measure section's lyric section has 20 syllables
- **THEN** the dialog shows a fit warning and Generate is disabled

#### Scenario: Failure keeps the song
- **WHEN** a topline request returns an error
- **THEN** the dialog shows the message and the song's tracks and clips are unchanged

### Requirement: Stale lyrics notice
When the dock shows a loop with a `topline` source, and a lyric section whose heading matches the source's `section_name` exists with lines that differ from the source's lines, the dock SHALL show a notice that the lyrics have changed since the topline was generated. The notice SHALL offer "Regenerate", which opens the topline dialog for that section and target track. In that dialog, a line whose text equals a line of the source SHALL start with the source's syllables and stress, so corrections the user made earlier are kept. When no heading matches, no notice SHALL be shown.

#### Scenario: Edited lyrics flagged
- **WHEN** the user generates a Chorus topline and then changes a word in the Chorus lyrics
- **THEN** selecting the topline clip shows the changed-lyrics notice with "Regenerate"

#### Scenario: Corrections kept on regenerate
- **WHEN** the user corrected `every` to `ev-ery` in the first Chorus line, generated, edited only the second line, and chooses "Regenerate"
- **THEN** the dialog shows `ev-` and `ery` for the first line

### Requirement: Re-flow lyrics
When the dock shows a loop with a `topline` source, the dock SHALL offer "Re-flow lyrics". The action reassigns the source's syllables, in order, to the loop's notes in order of start step:
- When several notes start at the same step, only the highest SHALL receive a syllable.
- Notes left over after the last syllable SHALL have no `lyric`.
- When syllables are left over after the last note, the user SHALL be told how many have no note.

The action SHALL be one song undo step and SHALL NOT change any note's pitch, timing, or velocity.

#### Scenario: Re-flow after adding a note
- **WHEN** a topline loop's notes carry `hold`, `me`, `close`, and the user deletes the `me` note, adds a note between the other two, and chooses "Re-flow lyrics"
- **THEN** the notes, in order, carry `hold`, `me`, and `close`

#### Scenario: More syllables than notes
- **WHEN** a topline loop with 10 syllables has 8 notes and the user chooses "Re-flow lyrics"
- **THEN** the 8 notes carry the first 8 syllables and the user is told 2 syllables have no note
