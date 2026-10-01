## Purpose

Lets songwriters record a microphone or audio interface onto an audio track in time with the song, hear themselves while doing it, and keep every pass as a take.

## ADDED Requirements

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
  - A session that would exceed the track's 64 takes, or the song's 256 samples, SHALL be refused before it starts.
  - Recording SHALL be refused, with the reason given, when no input is available.

#### Scenario: Record a vocal from stopped
- **WHEN** an audio track is selected, the count-in is on, and the user presses Record at measure 1, sings for 8 measures, and presses Stop
- **THEN** one bar of clicks is heard, and then the track has its first take with one clip starting at measure 1 that plays the singing

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
While looping is on, each full or partial pass of the loop region during one recording session SHALL be kept as its own take. The lane SHALL show one clip for the region, playing the latest pass's take. The earlier passes SHALL be listed in the clip's Takes list, so that the user can choose a better one. A loop session SHALL still be one undo step.

#### Scenario: Three passes
- **WHEN** looping is on over measures 1–4 and the user records three passes
- **THEN** the track gains three takes, and the clip at measures 1–4 plays the third, with the first two offered in its Takes list

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
A song sample (see `songs/audio-tracks`, "Audio track and sample document") MAY have `origin` `"recording"`. Such a sample SHALL also have `track_id`, naming the audio track it was recorded on. A track SHALL have at most 64 recorded samples. Every check SHALL reject a recorded sample whose `track_id` names no audio track with `invalid_song`. Recorded samples SHALL follow the same storage and cleanup rules as imported ones. They SHALL appear in the sample library only after the user chooses "Add to library" from the Takes list.

#### Scenario: Take kept with the song
- **WHEN** the user records a take and downloads a project bundle
- **THEN** `project.json` lists the take with origin `"recording"` and the track's id, and the bundle holds its audio

### Requirement: Takes list
When a clip on an audio track is selected, the audio clip panel SHALL list every take recorded on that track, newest first, under "Takes". From this list, the user SHALL be able to:
- choose a take for the clip, keeping the clip's position and length and limiting the length to what the take holds;
- rename a take;
- delete a take that no clip uses;
- add a take to the sample library.

These actions SHALL also be in the clip's context menu under "Takes". Each choice, rename, and delete SHALL be one undo step.

#### Scenario: Switch to an earlier take
- **WHEN** a clip plays the track's third take and the user chooses the second from the Takes list
- **THEN** the clip plays the second take from the same song position, and one undo step was added

#### Scenario: Delete an unused take
- **WHEN** no clip uses the first take and the user deletes it from the Takes list
- **THEN** it is removed from the song's samples

#### Scenario: Add a take to the library
- **WHEN** the user chooses "Add to library" on a take
- **THEN** the take appears in the sample library and can be placed in other songs

