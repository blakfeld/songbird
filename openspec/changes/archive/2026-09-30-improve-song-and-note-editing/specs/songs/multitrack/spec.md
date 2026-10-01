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
- A note SHALL keep its length, and MAY cross a barline. Its length SHALL be shortened only to end at the next note in its row or at the end of its loop.
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

#### Scenario: A sustained note keeps its length across barlines
- **WHEN** a loop has a note longer than one measure and the user changes the time signature
- **THEN** the note keeps its length, shortened only if it would run into the next note in its row or past the loop's end

#### Scenario: Undo a key change
- **WHEN** the user changes the key from C major to E minor and presses Cmd/Ctrl+Z
- **THEN** the key is C major again

### Requirement: Mixed song playback
The Studio page SHALL provide the transport behavior of `patterns/playback`, applied to the whole song. This SHALL include:
- Play, Stop, and Space to toggle;
- the Loop toggle, and an optional loop region in song measures that is drawn and edited on the arrangement's measure ruler above the lanes;
- playing once through the song when looping is off;
- a playhead shown across the lanes and the open piano roll;
- accurate timing, velocity, and note length for sustained and one-shot instruments;
- live edits being audible.

Every audible track SHALL be played at the same time with its own instrument's sounds, using the song's tempo, swing, and time signature.

- **Seeking:** clicking empty lane space to seek SHALL set where Play starts only while looping is off. While looping is on, Play SHALL start at the region's first measure, or at measure 1 when there is no region.
- **The dock's ruler:** the docked piano roll's ruler counts measures within the selected clip's loop. It SHALL NOT show or edit the song's loop region.
- **Region bounds:** the region SHALL be bounded by the arrangement's visible timeline (see "Song settings"), not by the song's length, so it MAY cover silent measures after the song's end. Looping with no region, and playing once, SHALL still use the song's length. When the song shrinks, a region inside the new timeline SHALL be kept, and one extending past it SHALL be clamped to it.
- **New songs:** a new song, or one saved before loop regions existed, SHALL open with no loop region and looping off, so Play plays the song once. Turning on the Loop toggle with no region SHALL loop the whole song.

#### Scenario: Tracks play together
- **WHEN** a song has a kick on step 0 of the Drums track and a `C3` on step 0 of the Bass track, and the user presses Play
- **THEN** both notes start at the same time with their own instruments' sounds

#### Scenario: New song has no region
- **WHEN** the user creates a new song
- **THEN** the arrangement ruler shows no loop region, the Loop toggle is not pressed, and no lane measures are shaded

#### Scenario: Loop a range across tracks
- **WHEN** the song has no loop region and the user drags across measures 5–8 on the arrangement ruler and presses Play
- **THEN** measures 5–8 of every audible track play, repeating

#### Scenario: Song plays once
- **WHEN** looping is off on a 16-measure song and the user presses Play
- **THEN** every audible track plays measures 1–16 once, and playback stops by itself

#### Scenario: Seek with looping off
- **WHEN** looping is off, the user clicks empty lane space in measure 9, and then presses Play
- **THEN** playback starts at measure 9 and stops by itself after the song's last measure

#### Scenario: Region past the song's end
- **WHEN** a song's clips end at measure 4 and the user drags across measures 6–9 on the arrangement ruler and presses Play with looping on
- **THEN** the region is 6–9, and playback repeats those silent measures

#### Scenario: Region kept when the song shrinks
- **WHEN** the song is 12 measures long with a region of 9–12, and the user deletes the clip so the song is 4 measures long
- **THEN** the region is still 9–12, because the timeline still shows 16 measures

#### Scenario: Region clamped to the timeline
- **WHEN** the song is 20 measures long with a region of 25–28, and the song shrinks to 4 measures
- **THEN** the region becomes measure 16 only, the end of the 16-measure timeline

#### Scenario: Region is not in the dock
- **WHEN** the song's region is measures 5–8 and a clip's loop is open in the dock
- **THEN** the dock's ruler shows no loop region and no loop shading
