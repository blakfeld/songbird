# songs/audio-tracks Specification

## Purpose

Lets a song hold audio (imported samples, loops, stems, and later recordings) on its own tracks. The audio is placed, edited, mixed, and played in time with the song's generated and played parts.

## Requirements

### Requirement: Audio track and sample document
A song MAY have `samples`, a list of at most 256 entries describing the audio its clips use. Each entry SHALL have:
- `id`, unique within the song;
- `name`, 1–80 characters;
- `sample_rate`, from 22050 to 192000;
- `channels`, 1 or 2;
- `length_samples`, from 1 up to 20 minutes at its sample rate;
- `origin`, which is `"import"` here; later changes MAY add other origins.

A track whose `instrument` is the reserved id `audio` SHALL be an audio track. `audio` SHALL be accepted wherever a song document is checked, including the browser, project files, and server-side song validation, even though `GET /api/v1/instruments` does not list it. An audio track SHALL have empty `loops` and `clips`, and SHALL have `audio_clips`: at most 256 entries, each with:
- `id`, unique within the song;
- `sample_id`, naming one of the song's samples;
- `start_ticks`: the clip's position on the song timeline, at 240 ticks per sixteenth step, from 0;
- `offset_samples` and `slice_samples`: the part of the sample the clip uses, with `offset_samples + slice_samples` no more than the sample's length and `slice_samples` at least 1;
- `length_samples`: how long the clip plays, at least 1. Without looping it SHALL be no more than `slice_samples`;
- `loop`, default false. When it is true, the slice SHALL repeat to fill `length_samples`;
- `gain_db`, from −24.0 to +12.0, default 0;
- `fade_in_samples` and `fade_out_samples`, from 0, whose sum is at most `length_samples`, each default 0.

A non-audio track SHALL NOT have `audio_clips` entries. Two audio clips on the same track SHALL NOT overlap in song time at the song's current tempo. A sample that no clip uses MAY stay in `samples`. A song document SHALL never contain audio data. A song with audio SHALL keep `version` 2. Every check SHALL reject a broken rule with `invalid_song` and a message naming the track, or `samples` for a sample-level problem. An audio track MAY have the `sound` effects of `songs/track-sound`. Its `tone` settings SHALL be invalid, because they shape an instrument's voice.

#### Scenario: Audio track accepted by the server
- **WHEN** a client posts a song with a Drums track and an audio track named "Loops" to song export
- **THEN** the song is not rejected for the audio track

#### Scenario: Clip outside its sample
- **WHEN** a clip has `offset_samples` 40000 and `slice_samples` 20000 on a sample of 50000 samples
- **THEN** the song is rejected with `invalid_song` and a message naming the track

#### Scenario: Unknown sample
- **WHEN** a clip's `sample_id` names no entry in `samples`
- **THEN** the song is rejected with `invalid_song` and a message naming the track

#### Scenario: Tone knobs on audio rejected
- **WHEN** an audio track has `sound.tone.filter_cutoff_hz` set
- **THEN** the song is rejected with `invalid_song` naming the track and `filter_cutoff_hz`

### Requirement: Adding audio tracks
The Add Track control SHALL offer "Audio" separately from the instrument list. A new audio track SHALL be named "Audio", then "Audio 2", and so on, and SHALL have no clips. Audio tracks SHALL count toward the 16-track limit.

#### Scenario: Add an audio track
- **WHEN** the user chooses "Audio" from Add Track in a song with 3 tracks
- **THEN** a fourth track named "Audio" is added and selected, and its lane is empty

### Requirement: Audio clip playback
During song playback, each audio clip SHALL play from `offset_samples` of its sample, starting at the time its `start_ticks` falls at the song's tempo, for `length_samples`, with these properties:
- When `loop` is on, it SHALL go back to `offset_samples` after each `slice_samples`, with no gap.
- Its level SHALL follow `gain_db`.
- It SHALL rise linearly from silence over `fade_in_samples`, and fall linearly to silence over the last `fade_out_samples`.
- It SHALL go through the track's effects, volume, pan, mute, and solo like any other track.
- Starting playback, or jumping, inside a clip SHALL start it at the matching position.
- Song looping SHALL restart clips at the matching position when the loop wraps.
- An audio clip SHALL start within 5 ms of where note playback places the same song time.
- Changing the tempo SHALL move where clips start, but SHALL NOT change their speed or pitch.
- When a tempo increase would make clips on a track overlap, each earlier clip SHALL be shortened to end where the next one starts, in the same undo step as the tempo change.
- Changing the time signature SHALL keep each clip at the same measure and position within that measure.

When a sample's audio is not available in this browser, its clips SHALL be silent and drawn as missing, and the rest of the song SHALL play normally.

#### Scenario: Start inside a clip
- **WHEN** an audio clip covers measures 3–6 and the user starts playback at measure 5
- **THEN** the clip is heard from the start of its third measure

#### Scenario: Looping clip repeats seamlessly
- **WHEN** a 1-measure drum loop sample is placed with loop on and stretched to 4 measures
- **THEN** the loop is heard 4 times back to back, with no gap or click between repeats

#### Scenario: Tempo change keeps the audio intact
- **WHEN** a clip starts at measure 5 at 120 BPM and the user changes the tempo to 100 BPM
- **THEN** the clip still starts at measure 5, and its audio plays at its original speed and pitch

#### Scenario: Faster tempo trims touching clips
- **WHEN** two audio clips sit back to back at 120 BPM and the user changes the tempo to 121 BPM
- **THEN** the first clip is shortened to end where the second starts, and a single undo restores both the tempo and the clip's length

### Requirement: Song length with audio
An audio clip SHALL end at the song time that its start plus `length_samples` reaches at the current tempo. For the song's `measures` (see `songs/multitrack`), an audio clip SHALL count up to the measure in which it ends. A change that would make the song longer than 128 measures, such as a placement, an extension, a tempo change, or a time signature change, SHALL be refused with a message naming the limit.

#### Scenario: Song grows with a sample
- **WHEN** the song is 4 measures long and the user places a sample that ends partway through measure 7
- **THEN** the song is 7 measures long

### Requirement: Audio clips on the lane
An audio track's lane SHALL draw each clip at its position, showing:
- the sample name;
- a waveform of what it plays, scaled by its gain and shaped by its fades;
- a mark at each repeat while it loops.

The selected clip SHALL be visibly distinguished. Each clip SHALL be keyboard-focusable. Its accessible name SHALL include the sample name, the span in measures and beats, and "looping" when it loops. An empty audio lane SHALL show a hint to drop an audio file or drag a sample from the library.

#### Scenario: Waveform follows gain
- **WHEN** the user raises a clip's gain by 6 dB
- **THEN** the clip's waveform is drawn about twice as tall, and limited to the clip's height

### Requirement: Editing audio clips
The user SHALL be able to:
- **Move:** drag a clip to move it along its lane, snapped to sixteenth steps, or freely while Shift is held. Left and Right arrows move a focused clip one step.
- **Trim the start:** drag a clip's left edge to hide or reveal the start of its slice, never past the sample's start, keeping the audio at the same song time.
- **Trim or extend the end:** drag the right edge. Without looping, the end SHALL stop at the end of the sample. With looping, dragging past the slice SHALL repeat it.
- **Loop:** turn looping on or off from the clip's context menu or the clip panel. Turning it off SHALL limit the clip's length to its slice.
- **Gain and fades:** drag a clip's gain line, and its fade-in and fade-out handles at the top corners.
- **Duplicate and delete:** with Cmd/Ctrl+D, duplicate a clip immediately after itself, and with Delete or Backspace, delete it. Both SHALL also be in the clip's context menu.
- **Replace sample:** choose another sample for a clip from the library. The clip SHALL keep its position, gain, fades, and loop setting, start from the new sample's beginning, and keep its length where the new sample allows.

A move, trim, extension, or duplicate that would overlap another clip on the same track SHALL stop at that clip. Each drag SHALL be one undo step, and so SHALL each key press, toggle, duplicate, replace, and delete. Editing SHALL never change the stored audio.

#### Scenario: Trim the start
- **WHEN** a clip starts at measure 3 and the user drags its left edge one measure to the right
- **THEN** the clip starts at measure 4, the audio heard in measure 4 is unchanged, and the first measure of the sample is no longer heard

#### Scenario: Extend a loop
- **WHEN** a looping 2-measure clip is extended by dragging its right edge to 8 measures
- **THEN** the clip covers 8 measures and plays its slice 4 times

#### Scenario: Move stops at a neighbour
- **WHEN** the user drags a clip into the clip after it
- **THEN** the dragged clip stops where the next clip begins

#### Scenario: Undo a fade
- **WHEN** the user drags a clip's fade-in handle and presses Cmd/Ctrl+Z
- **THEN** the clip has its previous fade-in

### Requirement: Audio clip panel
When an audio clip is selected, the editor dock SHALL show an audio clip panel instead of a piano roll, with:
- the sample name, the clip's start and length;
- controls for gain, fade-in, fade-out, and loop;
- a "Replace sample" action.

When an audio track has no selected clip, the dock SHALL say how to add audio to it.

#### Scenario: Edit gain from the panel
- **WHEN** the user selects a clip and sets its gain to −6 dB in the clip panel
- **THEN** the clip plays 6 dB quieter, its waveform shrinks, and one undo step was added

### Requirement: Sample audio storage
The audio of each sample SHALL be stored in the browser as lossless PCM, separately from song documents, in a store kept per signed-in user (see `platform/accounts`), and SHALL survive reloads and signing out. One stored copy SHALL serve every song and library entry that refers to the same sample id. A sample's audio SHALL be kept while any of these refers to it:
- the sample library;
- any of the user's saved songs, including those stored on the server;
- the open song's undo or redo history.

Once none of them does, it SHALL be deleted. That check SHALL run when a song is opened or deleted, and when a sample is removed from the library. The Studio SHALL ask the browser to keep its storage persistent the first time audio is stored. It SHALL warn before storing new audio when less than 200 MB of browser storage remains.

#### Scenario: Survives reload
- **WHEN** the user places a sample and reloads the page
- **THEN** the clip plays the same audio

#### Scenario: Undo keeps audio available
- **WHEN** the user removes a sample from the library and deletes its only clip, then presses Cmd/Ctrl+Z
- **THEN** the clip is back and plays its audio

#### Scenario: Shared between songs
- **WHEN** two songs use the same library sample and the user deletes one of them
- **THEN** the other song still plays the sample

#### Scenario: Freed when unused
- **WHEN** a sample has been removed from the library and the last song using it is deleted
- **THEN** the browser no longer stores that sample's audio
