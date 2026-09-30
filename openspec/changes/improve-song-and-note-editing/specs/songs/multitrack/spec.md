# Spec Delta

## MODIFIED Requirements

### Requirement: Song document
A song SHALL have:
- a `version` of `2`;
- an `id`;
- a `name` of 1–80 characters;
- `tempo_bpm`, from 40 to 240;
- `time_signature`, one of `"4/4"`, `"3/4"`, or `"6/8"`;
- `swing`, from 0.0 to 0.75;
- a `key`, with a `tonic` (one of `C`, `C#`, `D`, `D#`, `E`, `F`, `F#`, `G`, `G#`, `A`, `A#`, `B`) and a `mode` (`major` or `minor`);
- `measures`, an integer from 1 to 128;
- an ordered list of 1–16 `tracks`.

`measures` SHALL always equal the end measure of the song's last-ending clip on any track, or 1 when the song has no clips. A song saved without a `key` SHALL open in C major, and a song saved with a stale `measures` SHALL be corrected when it opens.

Step resolution and `steps_per_measure` SHALL follow the same sixteenth-note rules as a pattern document.

Each track SHALL have:
- an `id`;
- a `name` of 1–40 characters;
- an `instrument`, which is an instrument id listed by `GET /api/v1/instruments`;
- `volume_db`, from −60.0 to +6.0;
- `pan`, from −1.0 (full left) to +1.0 (full right);
- `muted` and `soloed` flags;
- `loops` and `clips`, as defined by `songs/clips`.

Every note in a track's loops SHALL reference a row of the track's instrument.

#### Scenario: New song defaults
- **WHEN** the user creates a new song
- **THEN** it has these settings:
  - It is named "Untitled song".
  - It is in 4/4 and C major, at 120 BPM with swing 0.
  - It has no clips, so it is 1 measure long.
  - It has two tracks: a Drums track using `drums` and a Piano track using `piano`.
  - Each track is at 0 dB, centered, not muted, and not soloed, and has no loops and no clips.

#### Scenario: Rows come from the track's instrument
- **WHEN** a track uses the `drums` instrument
- **THEN** its piano roll shows exactly the drums instrument's rows, and every note in the track's loops references one of them

#### Scenario: Length follows the clips
- **WHEN** a song's last-ending clip covers measures 9–12 and the user deletes it, leaving clips that end at measure 6
- **THEN** the song is 6 measures long

#### Scenario: Old song without a key
- **WHEN** the user opens a song saved before keys existed
- **THEN** its key is C major and its notes are unchanged

### Requirement: Song settings
The user SHALL be able to change these song settings from the Studio header:
- the name;
- the tempo, from 40 to 240 BPM;
- the swing, from 0 to 75%;
- the time signature;
- the key.

There SHALL be no control for the song's length, which follows its clips (see "Song document").

**The timeline:** the arrangement SHALL show at least 8 empty measures after the song's end and at least 16 measures in total, never more than 128.

**Changing the time signature:** the timeline and every piano roll SHALL regrid to the new measure length. Clips SHALL keep their start measures and lengths in measures. Each loop note SHALL keep its measure and its step within that measure.
- A note whose step within its measure does not exist in the new, shorter measure SHALL be removed.
- A note that would cross the end of its measure SHALL be shortened to end there.
- **Confirmation:** when any notes would be removed, the page SHALL first say how many, and SHALL change the time signature only if the user confirms.
- **Undo:** the change SHALL be one undo step.
- **Tempo:** tempo SHALL NOT change.

**Changing the key:** a key change SHALL NOT change any note.

Changes to the time signature and the key SHALL be song setting changes for undo purposes.

#### Scenario: Lengthen appends silence
- **WHEN** an 8-measure song's Bass clip is moved so it ends at measure 12
- **THEN** the song is 12 measures long, measures 9–12 of the other tracks have no clips, and their measures 1–8 are unchanged

#### Scenario: Shorten trims clips
- **WHEN** a 12-measure song's only clip reaching past measure 8 is deleted
- **THEN** the song shortens to the end of its last remaining clip, and no other clip or loop changes

#### Scenario: Timeline room past the end
- **WHEN** a song's clips end at measure 20
- **THEN** the arrangement shows measures 1–28, and the user can create a clip in measure 25, which makes the song 25 measures long

#### Scenario: 4/4 to 3/4 keeps beats in their bars
- **WHEN** a 4/4 loop has notes on the first step of beats 1, 2, and 4 of measure 2, and the user changes the song to 3/4 and confirms
- **THEN** the notes on beats 1 and 2 of measure 2 remain on beats 1 and 2 of measure 2, the beat-4 note is removed, and the page had said one note would be removed

#### Scenario: Cancel a lossy change
- **WHEN** a change to 3/4 would remove notes and the user cancels the warning
- **THEN** the song stays in 4/4 and every note is unchanged

#### Scenario: Lengthening the measure loses nothing
- **WHEN** a 3/4 song is changed to 4/4
- **THEN** no warning is shown, every note keeps its measure and step within the measure, and the last beat of every measure is empty

#### Scenario: Undo a key change
- **WHEN** the user changes the key from C major to E minor and presses Cmd/Ctrl+Z
- **THEN** the key is C major again
