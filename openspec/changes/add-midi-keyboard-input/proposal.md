# Proposal

## Why

Today the only way to enter notes in Songbird is to click them into the piano roll one by one, or to have them generated. Songwriters with a MIDI keyboard want to audition ideas by playing them. They also want to capture a performance directly, whether that is a bassline played in one pass or a drum beat built up over several loops. Without this, every idea has to be translated into mouse clicks, which is slow and loses the feel of the playing. #4 add-multitrack-song listed "Live MIDI recording" as a non-goal. This change adds it now that songs, clips, and the loop region are in place.

**Depends on:**
- #4 add-multitrack-song and add-arrangement-clips (both archived).
- add-timeline-loop-region, which provides looping on/off and play-once. Build and archive this change after it.

## What Changes

- **Connecting a keyboard.** A MIDI input control on the transport on the Studio, `/drum-machine`, and `/instruments/[id]`.
  - The first time the user uses it, it asks the browser for MIDI access. It lists connected inputs, with "All inputs" as the default, and follows devices as they are plugged in or out.
  - It remembers the choice, and whether access was granted, in this browser.
  - Where the browser doesn't support Web MIDI (for example Safari), or access is denied, the control explains why and the rest of the page still works.
- **Playing live.** Keys on the keyboard play the page's instrument immediately. In the Studio that is the selected track's instrument, heard through the track's volume and pan. Details:
  - Velocity is respected.
  - Sustained instruments hold a note until the key is released or the sustain pedal comes up.
  - Drums play one-shots.
  - A key maps to the instrument row with the same MIDI note number. Keys outside the instrument's rows are ignored.
  - Live play works whether the transport is stopped or playing.
- **Recording.** A Record button, and the `R` key, on the transport.
  - **Starting from stopped:** Record plays an optional one-bar count-in, then starts playback and records from where Play would start.
  - **Starting while playing:** Record punches in at once.
  - **Ending the take:** pressing Record again ends the take and playback continues. Stop ends both. With looping off, the take also ends when playback ends.
  - **Quantizing:** each note's start snaps to the nearest sixteenth step (swing-aware), and its length is rounded to at least one step.
  - **Merging (overdub):** takes merge into what is there already. A recorded note on the same row and step replaces the old note, and overlapping notes are shortened rather than stacked.
  - **Looping on:** recording cycles through the loop region. Each pass merges, and notes from earlier passes are heard on the next pass.
  - **Undo:** a whole take is one undo step.
- **Where recorded notes go:**
  - **Single-instrument pages:** into the pattern. Its length never changes.
  - **Studio:** onto the selected track at the song position where they were played.
    - A note that lands inside an existing clip goes into that clip's loop, at the matching position in the loop, so linked clips change too.
    - Notes played over empty lane space create a new loop and clip covering the measures played, with one clip per empty stretch.
    - Clip and loop limits are enforced, and notes that cannot be placed are reported.
- **Metronome and count-in.**
  - A Metronome toggle clicks on every beat, with the downbeat accented, whenever the transport runs.
  - A Count-in toggle (on by default) sets whether a recording started from stopped begins with one bar of clicks.
  - Both settings are saved in this browser. The click is never part of the song or pattern.
- **Non-goals:**
  - Recording audio.
  - Pitch bend, modulation, aftertouch, and other controllers. The sustain pedal is the one exception.
  - MIDI output, MIDI clock sync, and MIDI learn.
  - Recording on several tracks at once, and record-arm buttons.
  - Quantize settings other than sixteenths, and recording without quantizing.
  - Growing a song or pattern while recording.
  - A computer-keyboard "musical typing" input.
  - Recording without a MIDI device.

## Capabilities

### New Capabilities
- `patterns/midi-input`: MIDI device access and choice, live play of the page's instrument, and recording takes (the Record control, start and stop rules, quantizing, merging, loop cycling, and undo), including recording into a pattern on single-instrument pages.

### Modified Capabilities
- `patterns/playback`: adds the "Metronome and count-in" requirement. Existing requirements are unchanged.
- `songs/clips`: adds the "Recording onto the Studio timeline" requirement, covering where a take's notes land relative to existing clips, and how new clips are created from a take. Existing requirements are unchanged.

## Impact

- **Frontend only. No API or backend changes.**
- New `lib/midi/` holds Web MIDI access, the device list, and message parsing, which covers note on/off, velocity, and the sustain pedal.
- New `lib/recording/`:
  - takes are buffered, quantized, and merged;
  - Studio takes are placed onto clips.
- **Engine and sound sources** (`lib/audio/engine.ts`, `synthSource.ts`, `drumsSource.ts`):
  - held notes, through new `noteOn`/`noteOff` calls on `SoundSource`;
  - live input routed through the track's channel;
  - converting a MIDI event time to a song step;
  - metronome clicks and a one-bar pre-roll.
- **Stores:**
  - `patternStore` gains a take merge that is one undo step.
  - `songStore` and `clipOps` gain transient take edits inside a gesture, and creating a loop and clip with a given length and notes.
- **UI:**
  - `Transport.tsx` gains Record, Metronome, Count-in, and the MIDI input control.
  - `useEditorShortcuts` gains `R`.
  - The piano roll and lanes show recorded notes during the take.
- **Tests:** a fake `requestMIDIAccess` for Vitest and a Playwright init script, which is Chromium only.
- **Downstream:** add-song-sections lists "Live recording" as a non-goal. That wording can be left as is, because sections don't change recording.
