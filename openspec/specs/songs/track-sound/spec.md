# songs/track-sound Specification

## Purpose

Lets songwriters shape how each track of a song sounds, with knobs for the instrument's tone and a fixed set of insert effects. The settings are saved with the song.

## Requirements

### Requirement: Track sound document
A track MAY have a `sound` object. A track without `sound`, and any setting left out of `sound`, SHALL use that setting's default, so that songs saved before this change sound exactly as they did. `sound` SHALL contain an optional `tone` and an optional `effects`, where every field is optional.

`tone`:

| Field | Range | Default | Applies to |
|---|---|---|---|
| `filter_cutoff_hz` | 40–20000 | instrument preset cutoff, or 20000 when the preset has no filter | all instruments |
| `filter_resonance` | 0.0–1.0 | 0.0 | all instruments |
| `attack_s` | 0.001–2.0 | instrument preset | melodic only |
| `decay_s` | 0.01–4.0 | instrument preset | melodic only |
| `sustain` | 0.0–1.0 | instrument preset | melodic only |
| `release_s` | 0.01–8.0 | instrument preset | melodic only |
| `pitch_semitones` | integer −12 to +12 | 0 | drums only |

`effects`, each with an `enabled` flag (default `false`) and these parameters:

| Effect | Parameters (range, default) |
|---|---|
| `eq` | `low_db`, `mid_db`, `high_db` (−12.0 to +12.0, 0) |
| `distortion` | `drive` (0.0–1.0, 0.4), `mix` (0.0–1.0, 0.5) |
| `chorus` | `rate_hz` (0.1–8.0, 1.5), `depth` (0.0–1.0, 0.5), `mix` (0.0–1.0, 0.5) |
| `delay` | `time` (one of `"1/16"`, `"1/8"`, `"1/8d"`, `"1/4"`, `"1/2"`, default `"1/8d"`), `feedback` (0.0–0.9, 0.35), `mix` (0.0–1.0, 0.3) |
| `reverb` | `decay_s` (0.5–10.0, 2.5), `mix` (0.0–1.0, 0.3) |

Setting a melodic-only field on a drums track, or a drums-only field on a melodic track, SHALL be invalid. Every place that checks a song document, including the browser song library, project-file import, and server-side song validation, SHALL reject a value that is out of range or of the wrong kind with error code `invalid_song`, and the message SHALL name the track and the setting. Unknown fields inside `sound` SHALL be kept unchanged, following the song document's rule for unrecognised fields.

#### Scenario: Old song sounds the same
- **WHEN** the user opens a song saved before track sound existed
- **THEN** every track plays with its instrument's default sound and no effects

#### Scenario: Out-of-range value rejected
- **WHEN** a song whose Bass track has `sound.effects.delay.feedback` of 1.5 is posted to song export
- **THEN** the response is `422` with code `invalid_song` and a message naming the Bass track and `feedback`

#### Scenario: Wrong-kind knob rejected
- **WHEN** a project file has a Drums track with `sound.tone.attack_s` set
- **THEN** the import is rejected with a message naming the Drums track and `attack_s`

### Requirement: Effects chain
Each track's sound SHALL be processed in this order: the instrument voice with its tone settings, then EQ, then Distortion, then Chorus, then Delay, then Reverb, then the track's volume and pan. A disabled effect SHALL pass the sound through unchanged. Delay time SHALL follow the song's tempo, including tempo changes made during playback. The `mix` of an effect SHALL blend the dry signal (0.0) with the processed signal (1.0).

#### Scenario: Delay follows tempo
- **WHEN** a track has Delay on with time `"1/4"` and the song is at 120 BPM
- **THEN** echoes are 0.5 s apart, and after the tempo is changed to 60 BPM they are 1.0 s apart

#### Scenario: Disabled effect is silent
- **WHEN** a track has Reverb off with mix 1.0
- **THEN** the track sounds the same as with Reverb's default settings and off

### Requirement: Sound panel
Each track header in the Studio SHALL have a Sound control that opens a panel for that track. The panel SHALL name the track. It SHALL show a Tone group with the knobs that apply to the track's instrument, and one group per effect, in chain order, each with an on/off switch and its parameter knobs. Delay time SHALL be chosen from its listed note values. A knob's parameters SHALL stay adjustable while its effect is off. The panel SHALL offer "Reset sound", which returns every setting of the track to its default. Only one track's panel SHALL be open at a time, and the panel SHALL NOT block editing, the mixer, or playback.

#### Scenario: Open a track's sound
- **WHEN** the user activates the Sound control on the Bass track
- **THEN** a panel titled with the Bass track opens, showing filter cutoff, filter resonance, attack, decay, sustain, release, and the five effects, all off

#### Scenario: Drums show drum knobs
- **WHEN** the user opens the Sound panel of a Drums track
- **THEN** the Tone group shows filter cutoff, filter resonance, and pitch, and no envelope knobs

#### Scenario: Reset sound
- **WHEN** the user has changed several settings on a track and chooses "Reset sound"
- **THEN** every setting returns to its default and every effect is off, as one undo step

### Requirement: Knob control
Each continuous setting SHALL be adjusted with a knob that:
- is an accessible slider exposing its name, current value with units, minimum, and maximum;
- changes the value when dragged vertically or horizontally, more finely while Shift is held;
- steps the value with the arrow keys and in larger steps with Page Up and Page Down;
- goes to its minimum and maximum with Home and End;
- resets to its default on double-click or Delete;
- shows its value while it is being changed.

The filter cutoff knob SHALL move logarithmically, so that each part of its travel covers an equal musical range. The pan control SHALL be one of these knobs and SHALL keep its current behavior.

#### Scenario: Keyboard adjusts a knob
- **WHEN** the Reverb mix knob has focus at 0.30 and the user presses Up three times
- **THEN** the value increases by three steps, and the knob announces the new value

#### Scenario: Double-click resets
- **WHEN** the user double-clicks the filter cutoff knob of a Bass track set to 300 Hz
- **THEN** the cutoff returns to the Bass preset's default

### Requirement: Sound changes take effect live
Changes to a track's sound SHALL be heard within 50 ms during playback, without restarting playback and without clicks from abrupt jumps. They SHALL also apply to note previews and live MIDI or keyboard input on that track. Toggling an effect SHALL NOT interrupt notes that are already sounding on the track.

#### Scenario: Turn the filter while playing
- **WHEN** the song is playing and the user turns the Bass track's filter cutoff down
- **THEN** the Bass track gets darker while playback continues

#### Scenario: Preview uses the track sound
- **WHEN** a Piano track has Reverb on and the user clicks a piano-roll key to audition it
- **THEN** the auditioned note has the reverb

### Requirement: Sound edits and undo
Track sound changes SHALL be part of the song: they SHALL be saved, restored on reload, included in downloaded project files, and recorded in undo history. A continuous knob drag SHALL be one undo step, and so SHALL each keyboard adjustment, each effect toggle, each delay-time choice, and each "Reset sound". A drag that ends at its starting value SHALL NOT add an undo step.

#### Scenario: Undo a knob drag
- **WHEN** the user drags the Reverb mix knob from 0.3 to 0.8 and presses Cmd/Ctrl+Z
- **THEN** Reverb mix is 0.3 again, and one undo step was used

#### Scenario: Sound survives reload
- **WHEN** the user turns Delay on for the Lead track and reloads the page
- **THEN** the Lead track still has Delay on with the same settings

### Requirement: Track sound outside the mixer
- MIDI export SHALL NOT include any sound setting. The exported file SHALL be identical whether or not tracks have `sound`.
- A track created by Add Track, by the song chat, by Send to song, or by any generation feature SHALL have no `sound`.
- Generating notes into an existing track SHALL leave its `sound` unchanged.
- The single-instrument editor pages SHALL keep each instrument's default sound and SHALL NOT offer a Sound panel.

#### Scenario: Export ignores sound
- **WHEN** the user exports a song whose Lead track has Distortion and Reverb on
- **THEN** the MIDI file is identical to the export of the same song with those effects off

#### Scenario: Regenerating keeps the sound
- **WHEN** the Bass track has a filter cutoff of 400 Hz and the user generates a new part into it
- **THEN** the Bass track's filter cutoff is still 400 Hz
