# songs/audio-recording Specification

## Purpose

Lets songwriters record a microphone or audio interface onto an audio track in time with the song, hear themselves while doing it, and keep every pass as a take.

## Requirements

### Requirement: Audio input selection
Each audio track's header SHALL offer an input picker listing the browser's audio input devices by name, plus a choice of mono or stereo. Mono SHALL use the device's first channel. The choice SHALL be remembered in this browser for that track. It SHALL NOT be saved in the song, because device ids differ between browsers. When the remembered device is missing, the track SHALL use the browser's default input and show that it did so. Microphone permission SHALL be requested the first time the user opens the picker, arms monitoring, or records. When permission is denied, the page SHALL explain how to allow it, and recording SHALL stay unavailable. Audio input SHALL be captured with the browser's echo cancellation, noise suppression, and automatic gain control turned off.

#### Scenario: Choose an interface input
- **WHEN** the user opens the input picker on the "Vocals" track and chooses "Scarlett 2i2" in mono
- **THEN** recording on "Vocals" uses the interface's first input, and the choice is still selected after a reload

#### Scenario: Permission denied
- **WHEN** the user denies microphone access
- **THEN** the track shows how to allow microphone access, and Record is disabled for audio tracks

### Requirement: Input level meter
While an audio track is selected, monitoring, or recording, its header SHALL show a live peak level meter for its input. Any sample at or above full scale SHALL light a clip indicator, which stays lit until the user clicks it.

#### Scenario: Clipping shown
- **WHEN** the input reaches full scale
- **THEN** the clip indicator lights, and it stays lit until clicked

### Requirement: Recording audio takes
When the selected track is an audio track, the transport's Record control SHALL record audio from that track's input. It SHALL follow the same start, count-in, punch-in, punch-out, and stop rules as recording notes (see `patterns/midi-input`, "Recording a take").
- **Placement:** each take SHALL be placed so that a sound made in time with the playback lands at the song time it was heard. The audio SHALL be shifted earlier by the output and input latencies that the browser reports, plus the recording offset.
- **Result:** when the take ends, its audio SHALL be stored as a new recorded sample (a take) of the track, named "<track name> Take N" with N one more than the highest take number on the track, and SHALL NOT be added to the sample library. One audio clip covering what was recorded SHALL be placed on the lane, with loop off.
- **Replacing:** audio clips on the track inside the recorded span SHALL be shortened, split, or removed so that the new clip replaces them only there.
- **Live drawing:** while recording, the recorded part SHALL be drawn on the lane as it grows.
- **Undo:** each recording session SHALL be one undo step.
- **Limits:**
  - Recording SHALL stop by itself after 20 minutes, or when the song would exceed 128 measures, and keep what was recorded.
- **Past the end of the song:** with looping off, recording audio SHALL NOT stop when playback reaches the end of the song. Playback and recording SHALL continue, and the song SHALL be extended to the end of the recorded clip, up to 128 measures. With looping on, the loop region bounds each pass as usual.
- **Seeking:** with looping off, moving the playhead while recording audio SHALL end the take, keeping what was recorded before the seek. Playback SHALL continue from the new position.
  - A session that would exceed the track's 64 takes, or the song's 256 samples, SHALL be refused before it starts.
  - Recording SHALL be refused, with the reason given, when no input is available.

#### Scenario: Record a vocal from stopped
- **WHEN** an audio track is selected, the count-in is on, and the user presses Record at measure 1, sings for 8 measures, and presses Stop
- **THEN** one bar of clicks is heard, and then the track has its first take with one clip starting at measure 1 that plays the singing

#### Scenario: Seek while recording
- **WHEN** looping is off, the user is recording audio at measure 5, and clicks the timeline at measure 2
- **THEN** the take ends with the audio recorded through measure 5, and playback continues from measure 2

#### Scenario: Record past the end of a short song
- **WHEN** looping is off, the song is 1 measure long, and the user records a vocal on an audio track for 4 measures and presses Stop
- **THEN** recording did not stop at the end of measure 1, the clip covers the 4 measures, and the song is at least 4 measures long

#### Scenario: Latency compensated
- **WHEN** the browser reports 10 ms of output latency and 8 ms of input latency, and the user claps exactly on the beat of measure 2 while recording
- **THEN** the clap in the recorded clip falls within 5 ms of the start of measure 2

#### Scenario: Punch in over an earlier take
- **WHEN** a clip covers measures 1–8 and the user punches in at measure 3 and out at measure 5
- **THEN** the track plays the earlier take in measures 1–3, the new take from measure 3 to 5, and the earlier take again from measure 5 to 8

#### Scenario: One undo per session
- **WHEN** the user records a take and presses Cmd/Ctrl+Z
- **THEN** the new clip is gone, and the earlier clips are back as they were

### Requirement: Loop recording keeps every pass
While looping is on, each full or partial pass of the loop region during one recording session SHALL be kept as its own take. The lane SHALL show one clip for the region, playing the latest pass's take. A final pass shorter than one beat SHALL be discarded, and the clip SHALL play the pass before it. The earlier passes SHALL be listed in the clip's Takes list, so that the user can choose a better one. A loop session SHALL still be one undo step.

#### Scenario: Three passes
- **WHEN** looping is on over measures 1–4 and the user records three passes
- **THEN** the track gains three takes, and the clip at measures 1–4 plays the third, with the first two offered in its Takes list

#### Scenario: Stop just after the loop restarts
- **WHEN** looping is on over measures 1–4, the user records two full passes, and presses Stop 100 ms into the third
- **THEN** the track gains two takes, and the clip plays the second

### Requirement: Recording offset
The Studio SHALL offer a recording offset setting from −200 ms to +200 ms, default 0, remembered in this browser. The offset SHALL be applied on top of reported latencies when placing new takes, so that users can correct a constant offset. Changing the offset SHALL NOT move takes that were already recorded.

#### Scenario: Adjust offset
- **WHEN** the user sets the recording offset to +15 ms and records a clap on the beat
- **THEN** the clap is placed 15 ms earlier than it would be with offset 0

### Requirement: Input monitoring
Each audio track header SHALL have a Monitor toggle, off by default and not saved in the song. While it is on, the track's live input SHALL be heard through the track's effects, volume, and pan, whether or not the transport is playing. Mute SHALL silence monitoring, and solo SHALL apply to it as to playback. The first time monitoring is turned on, the page SHALL warn that monitoring through speakers can cause feedback and suggest headphones. Monitoring SHALL be heard with the lowest latency the browser offers for interactive audio. While monitoring and recording at the same time, the recorded take SHALL contain the input without effects.

#### Scenario: Hear yourself with reverb
- **WHEN** an audio track has Reverb on and the user turns Monitor on and sings
- **THEN** the singing is heard with reverb, and a recording made at the same time holds the dry singing

#### Scenario: Monitor muted
- **WHEN** Monitor is on and the user mutes the track
- **THEN** the input is no longer heard

### Requirement: Recorded samples in the song document
A song sample (see `songs/audio-tracks`, "Audio track and sample document") MAY have `origin` `"recording"`. Such a sample SHALL also have `track_id`, naming the audio track it was recorded on, and `recorded_at_ticks`, the song position of its first sample. Every check SHALL reject `recorded_at_ticks` on a sample that is not a recording, and a recording without it, with `invalid_song`. A track SHALL have at most 64 recorded samples. Every check SHALL reject a recorded sample whose `track_id` names no audio track with `invalid_song`. Recorded samples SHALL follow the same storage and cleanup rules as imported ones. Deleting an audio track SHALL, in the same undo step, remove its takes that nothing uses and turn takes still used elsewhere (by clips on other tracks, or by sampler pads or keys) into imported samples. They SHALL appear in the sample library only after the user chooses "Add to library" from the Takes list.

#### Scenario: Take kept with the song
- **WHEN** the user records a take and downloads a project bundle
- **THEN** `project.json` lists the take with origin `"recording"` and the track's id, and the bundle holds its audio

#### Scenario: Delete a track with takes
- **WHEN** the user deletes an audio track with three takes, one of which a clip on another track uses
- **THEN** the two unused takes are removed, the used one stays as an imported sample, the song stays valid, and one undo restores the track and all three takes

### Requirement: Takes list
When a clip on an audio track is selected, the audio clip panel SHALL list every take recorded on that track, newest first, under "Takes". From this list, the user SHALL be able to:
- choose a take for the clip, keeping the clip's position and length, playing the chosen take's audio from the same song position it was recorded at (using `recorded_at_ticks`, with the offset clamped to what the take holds), and limiting the length to what the take holds;
- rename a take;
- delete a take that nothing in the song uses (no clip, sampler pad, or sampler key);
- add a take to the sample library.

These actions SHALL also be in the clip's context menu under "Takes". Each choice, rename, and delete SHALL be one undo step.

#### Scenario: Switch to an earlier take
- **WHEN** a clip plays the track's third take and the user chooses the second from the Takes list
- **THEN** the clip plays the second take from the same song position, and one undo step was added

#### Scenario: Switch keeps song time
- **WHEN** take 1 was recorded from measure 1, a clip at measure 3 plays take 2, and the user chooses take 1 for that clip
- **THEN** the clip plays what take 1 recorded at measure 3, not take 1's opening

#### Scenario: Delete an unused take
- **WHEN** nothing in the song uses the first take and the user deletes it from the Takes list
- **THEN** it is removed from the song's samples

#### Scenario: Add a take to the library
- **WHEN** the user chooses "Add to library" on a take
- **THEN** the take appears in the sample library and can be placed in other songs

