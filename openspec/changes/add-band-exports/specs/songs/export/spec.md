# Spec Delta

## ADDED Requirements

### Requirement: Download stems
The Studio page SHALL provide a "Download stems" action. It SHALL render the open song in the browser, including unsaved edits, and download one ZIP file named `songbird-<slug of song name>-<tempo_bpm>bpm-stems.zip`. The ZIP SHALL hold one WAV file per exported track, plus a `stems.txt` file.

Stems SHALL sound as the WAV mixdown would sound for that track alone:
- the track's instrument or audio clips;
- the track's sound settings and effects;
- volume and pan, as chosen by the mix option (see "Stem options").

A track with no clips SHALL NOT produce a stem. The render SHALL reflect the song as it was when the action started, and editing SHALL remain possible during the render. Nothing SHALL be sent to the server. The action SHALL be disabled while the song has no tracks.

#### Scenario: One stem per track
- **WHEN** the user downloads stems of a song with a Drums, a Bass, and a Piano track, all with clips and none muted
- **THEN** the ZIP holds three WAV files and `stems.txt`

#### Scenario: Audio track stem
- **WHEN** the song has an audio track that plays a vocal recording with reverb on
- **THEN** that track's stem contains the recording with the reverb

#### Scenario: Empty track skipped
- **WHEN** one of four tracks has no clips
- **THEN** the ZIP holds three WAV files, and `stems.txt` lists the empty track as skipped

#### Scenario: Edits during render
- **WHEN** the user changes a note after the stems render has started
- **THEN** the downloaded stems do not contain the change

### Requirement: Stem alignment and length
Every stem in one export SHALL:
- start at the same moment: the start of measure 1, or the start of the loop region's first measure for a loop-region export;
- have the same number of sample frames;
- use the same sample rate and channel count (stereo).

A stem's length SHALL be the length of the exported range plus, when effect tails are on, exactly 4 seconds. Sound that starts before the exported range and is still sounding at its start, such as a held note or an echo, SHALL be present at the start of the stem, as it would be heard when playing through. When effect tails are off, every stem SHALL end exactly at the end of the range.

Summing every stem from an "As mixed" export of the audible tracks SHALL reproduce the WAV mixdown of the same range. It SHALL match within the rounding of the bit depth, apart from the mixdown's tail trimming.

#### Scenario: Stems line up
- **WHEN** stems of a 16-measure song at 120 BPM in 4/4 are exported with tails on, at a 48 kHz sample rate
- **THEN** every WAV is 36 seconds long (32 seconds + 4), that is 1,728,000 frames, and the kick drum's first hit is at the same frame in the Drums stem as in the mixdown

#### Scenario: Stems sum to the mix
- **WHEN** the stems of an "As mixed" export are summed sample by sample
- **THEN** the result matches the WAV mixdown of the same song within one least-significant bit per track, over the length of the shorter file

#### Scenario: Tails off
- **WHEN** stems are exported with effect tails off
- **THEN** every stem is exactly the length of the exported range

### Requirement: Stem options
Before rendering, the stems dialog SHALL offer the following options:
- **Tracks**: "Audible tracks" (default) or "All tracks".
  - "Audible tracks" SHALL leave out tracks that mute and solo silence now.
  - "All tracks" SHALL export every track with clips, ignoring mute and solo.
- **Mix**: "As mixed" (default) or "Unity".
  - "As mixed" SHALL apply each track's volume and pan.
  - "Unity" SHALL render every track at 0 dB and centered.
  - Effects SHALL be applied in both.
- **Range**: "Whole song" (default) or "Loop region". "Loop region" SHALL be available only when the song has a loop region.
- **Effect tails**: on or off. It SHALL default to on for "Whole song" and off for "Loop region", so a loop-region export loops cleanly.
- **Bit depth**: 24-bit (default) or 16-bit PCM.

The dialog SHALL remember the last choices for the session. Options SHALL NOT be saved with the song.

#### Scenario: Muted track left out by default
- **WHEN** the Drums track is muted and the user exports stems with "Audible tracks"
- **THEN** the ZIP has no Drums stem

#### Scenario: All tracks ignores mute
- **WHEN** the Drums track is muted and the user exports stems with "All tracks"
- **THEN** the ZIP has a Drums stem with the drums audible

#### Scenario: Unity mix
- **WHEN** a Bass track at −12 dB and pan −0.5 is exported with "Unity"
- **THEN** its stem has the same level in both channels, and is 12 dB louder than with "As mixed"

#### Scenario: No loop region
- **WHEN** the song has no loop region
- **THEN** the "Loop region" range option is disabled

### Requirement: Loop-region stems
With the "Loop region" range, stems SHALL cover exactly the measures of the song's loop region, whether or not looping is currently turned on. Each stem SHALL start at the first sample of the region's first measure.

#### Scenario: Export the chorus loop
- **WHEN** the loop region is measures 9–16 of a 4/4 song at 90 BPM, and stems are exported with "Loop region" and tails off
- **THEN** every stem is 8 measures long (21.333 seconds), and starts with the material at the start of measure 9

#### Scenario: Held note across the region start
- **WHEN** a pad note starts in measure 8 and holds into measure 9, and stems are exported for a region that starts at measure 9
- **THEN** the pad stem is already sounding at its first sample

### Requirement: Stem file layout
In the stems ZIP:
- Each WAV SHALL be named `<NN>-<slug of track name>.wav`. `NN` is the track's position in the song, counted from 01 and zero-padded to two digits. Two tracks with the same name therefore get distinct files.
- Track names that slug to nothing SHALL use `track`.
- The ZIP entries SHALL be stored without compression.
- `stems.txt` SHALL be UTF-8 text that lists:
  - the song name, tempo, time signature, and key (or "none");
  - the sample rate and bit depth;
  - the exported range as measures and its start time in seconds;
  - the mix mode;
  - every stem file with its track name;
  - every track left out, with the reason ("muted", "not soloed", or "no clips").

#### Scenario: File names follow track order
- **WHEN** a song's tracks are, in order, "Drums", "Bass", and "Bass"
- **THEN** the ZIP holds `01-drums.wav`, `02-bass.wav`, and `03-bass.wav`

#### Scenario: Readme describes the export
- **WHEN** stems of a 96 BPM song in D minor are exported for the whole song
- **THEN** `stems.txt` states 96 BPM, D minor, start at measure 1 (0.000 s), and lists each stem file

### Requirement: Stem render progress, cancel, and limits
While stems render, the page SHALL show which stem is rendering ("Rendering 3 of 8: Bass") and the overall progress, and SHALL offer Cancel. Cancel SHALL stop the render without downloading anything and without changing the song.

Before rendering, the dialog SHALL show the estimated ZIP size. When the estimate exceeds 2 GB, the dialog SHALL refuse to start. It SHALL tell the user to shorten the range, choose fewer tracks, or choose 16-bit.

Only one audio render (stems or WAV mixdown) SHALL run at a time. While one runs, the other action SHALL be disabled.

When any stem reaches full scale, the page SHALL warn after the download, naming the stems that clipped.

#### Scenario: Cancel stems
- **WHEN** the user cancels while stem 3 of 8 is rendering
- **THEN** no file is downloaded and the song is unchanged

#### Scenario: Too large
- **WHEN** the estimate for a 128-measure song at 60 BPM with 16 tracks at 24-bit and 48 kHz exceeds 2 GB
- **THEN** the "Render" button is disabled, and the dialog explains how to reduce the size

#### Scenario: Mixdown blocked during stems
- **WHEN** a stems render is in progress
- **THEN** "Download WAV" is disabled until it finishes or is cancelled

#### Scenario: Clipped stem warning
- **WHEN** the Drums stem reaches full scale
- **THEN** after the download the page warns that the Drums stem clipped
