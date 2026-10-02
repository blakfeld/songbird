## Purpose

Lets songwriters play their own samples from notes, as a keyboard sampler that pitches one sample or as a pad sampler that triggers one-shots, so the piano roll, MIDI input, and recording drive imported sounds.

## ADDED Requirements

### Requirement: Sampler track document
A track whose `instrument` is `sampler-keys` or `sampler-pads` SHALL be a sampler track. These reserved ids SHALL be accepted wherever a song document is checked, even though `GET /api/v1/instruments` does not list them. A sampler track SHALL have the usual `loops` and `clips`, and SHALL have a `sampler` object:
- **`sampler-keys`:** `keys`, with:
  - `sample_id`, naming one of the song's `samples`, or null when no sample is chosen;
  - `root_note`, a MIDI note from 0 to 127, default 60 (`C4`);
  - `one_shot`, default false.
- **`sampler-pads`:** `pads`, with at most 16 entries, each with:
  - `row_id`, from `pad-1` to `pad-16`, unique within the track;
  - `sample_id`, naming one of the song's `samples`;
  - `gain_db`, from −24.0 to +12.0, default 0;
  - `pitch_semitones`, an integer from −24 to +24, default 0.

Its rows SHALL be:
- **Keys:** one row per chromatic pitch from MIDI 24 (`C1`) to 96 (`C7`), named as melodic rows are (see `instruments/melodic`, "Pitch rows over a range").
- **Pads:** 16 rows, `pad-1` to `pad-16`, displayed with the assigned sample's name, or "Pad N" when empty.

Every note SHALL reference a row of its track's instrument. The track's `sound.tone` SHALL follow the melodic rules for keys and the drum rules for pads (see `songs/track-sound`). Every check SHALL reject a broken rule with `invalid_song` and a message naming the track.

#### Scenario: Keys row range
- **WHEN** a client inspects a `sampler-keys` track's rows
- **THEN** there are 73 rows, from `C7` down to `C1`

#### Scenario: Pad sample must be in the song
- **WHEN** a pads track assigns `pad-3` a `sample_id` that is not in the song's `samples`
- **THEN** the song is rejected with `invalid_song` naming the track

#### Scenario: Wrong-kind tone knob
- **WHEN** a `sampler-pads` track has `sound.tone.attack_s` set
- **THEN** the song is rejected with `invalid_song` naming the track and `attack_s`

### Requirement: Adding sampler tracks
The Add Track control SHALL offer "Sampler (keys)" and "Sampler (pads)" next to "Audio". The new tracks SHALL be named "Sampler" and "Pads", then "Sampler 2" or "Pads 2", and so on. They SHALL start with no sample assigned, and with one empty loop placed as a clip at measure 1, so the piano roll and pad labels are available at once. The track, loop, and clip SHALL be added as one undo step, and the new track SHALL be selected. Sampler tracks SHALL count toward the 16-track limit.

#### Scenario: Add a pad sampler
- **WHEN** the user chooses "Sampler (pads)" from Add Track
- **THEN** a "Pads" track is added and selected, and its piano roll shows 16 rows labeled "Pad 1" to "Pad 16"

### Requirement: How sampler notes sound
- **Keys:** a note SHALL play the chosen sample from its start, pitched by `2^((note − root_note)/12)`, with its level scaled by velocity as for melodic instruments.
  - **Sustained:** with `one_shot` off, the sound SHALL follow the track's amp envelope and stop with the envelope's release after the note ends, or earlier if the sample ends first.
  - **One-shot:** with `one_shot` on, the sample SHALL play to its end regardless of note length.
  - At least 32 notes SHALL sound at once, with the oldest stopped first when more are needed.
  - With no sample chosen, notes SHALL be silent.
- **Pads:** a note on a pad row SHALL play that pad's sample to its end, at the pad's gain and pitch and the track's pitch knob, with level scaled by velocity. A note on an empty pad SHALL be silent.
- **Common to both:** the sound SHALL go through the track's tone filter, effects, volume, pan, mute, and solo, in playback, previews, row auditions, live MIDI play, and mixdown. Timing SHALL match other instruments' notes to within 5 ms. When a sample's audio is missing from this browser, its notes SHALL be silent, and the sampler strip SHALL show the sample as missing.

#### Scenario: Pitched up an octave
- **WHEN** a keys sampler has root `C4` and the user plays `C5`
- **THEN** the sample is heard at double speed, an octave higher

#### Scenario: Sustained note releases
- **WHEN** one-shot is off, the release is 0.2 s, and a 1-step note plays a 4-second sample at 120 BPM
- **THEN** the sound stops about 0.2 s after the note's end, not at the sample's end

#### Scenario: Pad one-shot
- **WHEN** `pad-1` holds a 2-second crash and a 1-step note plays on `pad-1`
- **THEN** the full 2-second crash is heard

### Requirement: Assigning sounds
When a sampler track is selected, the editor dock SHALL show a sampler strip above its piano roll.
- **Keys:** the strip SHALL show the chosen sample's name with Choose, Preview, and Clear actions, a root-note picker, and a One-shot toggle. Dropping a library sample or an audio file on the strip SHALL choose it.
- **Pads:** each pad row's label SHALL be a drop target for a library sample or an audio file, and SHALL have a menu with Choose sample, Preview, Clear, Gain, and Pitch. Dropping several audio files on a pad SHALL assign them in order to that pad and the pads below it, stopping at `pad-16`, as one undo step.
- **Song samples:** choosing a sample SHALL add it to the song's `samples` if it is not already there. A dropped file SHALL be imported to the library first (see `songs/sample-library`).
- **Undo:** each assignment, clear, and setting change SHALL be one undo step, and a gain or pitch drag SHALL be one step.
- **Auditioning:** clicking a row's key or label SHALL audition it, as on other instruments.

#### Scenario: Drop a kick on a pad
- **WHEN** the user drags "kick-808" from the library onto the "Pad 1" row label
- **THEN** the row is labeled "kick-808", notes on that row play it, and one undo step was added

#### Scenario: Drop several files on a pad
- **WHEN** the user drops three audio files on the "Pad 14" row label
- **THEN** they are imported and assigned to `pad-14`, `pad-15`, and `pad-16`, as one undo step

#### Scenario: Choose a sample for keys
- **WHEN** the user chooses "vox-ah" for a keys sampler and plays `E4` on a MIDI keyboard
- **THEN** "vox-ah" is heard pitched up four semitones

### Requirement: Sampler tracks in export and AI
- **MIDI export:** sampler tracks SHALL be included in song order, like melodic tracks. They take the next melodic channel, never channel 10, and carry no Program Change. Keys notes SHALL use their row's pitch. Pad notes SHALL use MIDI notes 36 to 51 for `pad-1` to `pad-16`.
- **Chat:** the song chat SHALL never add a sampler track.
- **Generation:** "Generate part with AI" SHALL NOT be offered on sampler tracks. The track generation endpoint SHALL reject a sampler target with `400` and a validation error code.
- **Context:** keys tracks SHALL be sent as generation context like melodic tracks, named "<track name> (sampler)". Pads tracks SHALL NOT be sent.

#### Scenario: Pads export
- **WHEN** a song with a Pads track whose notes are on `pad-1` and `pad-3` is exported to MIDI
- **THEN** that track's MIDI notes are 36 and 38, on a melodic channel, with no Program Change

#### Scenario: Keys used as context
- **WHEN** a song has a keys sampler with notes and the user asks the chat for a bass part
- **THEN** the generation context includes the keys sampler's notes

#### Scenario: Generate refused on a sampler
- **WHEN** a client asks the track generation endpoint to generate into a `sampler-pads` track
- **THEN** the response is `400` with a validation error code and no provider is called
