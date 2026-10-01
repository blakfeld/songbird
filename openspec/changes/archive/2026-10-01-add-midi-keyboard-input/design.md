# Design

## Context

See proposal.md for the motivation and the specs for the behavior. The current state (all paths under `frontend/src`):

**Live sound.**
- `engine.audition(row, {voiceKey, velocity})` (`lib/audio/engine.ts:420-455`) fires a fixed 0.5 s note.
- `SoundSource.trigger(row, start, end, velocity)` (`lib/audio/types.ts:25`) needs the end time up front, so it cannot hold a note open. `synthSource` calls `triggerAttack` and `triggerRelease` together (`synthSource.ts:85-91`). Drums ignore the end time.
- Studio previews go through a separate `previews` channel map, using the track's volume and pan but ignoring mute and solo (`engine.ts:249-266`).
- There are 32 synth voices per source, and the oldest voice is stolen when they run out.

**Timing.**
- The engine schedules one bar at a time with a 100 ms lookahead.
- Each `ScheduledBar {transportStart, duration, firstStep, steps, tempo, swing, measure}` is frozen when it is scheduled, and the last 3 are kept (`engine.ts:57-68`).
- `stepToSeconds` applies swing to odd steps (`lib/timing.ts`).
- `getPosition()` returns an integer step, and is private. `play()` sets the transport to 0 and the first bar at 0 (`engine.ts:351-355`).

**Stores.**
- `patternStore.edit` pushes one undo entry per call. Its gestures (`beginGesture`/`commitGesture`/`cancelGesture`, with `transient` `editNotes`) fold a drag into one entry, and any `edit` during a gesture folds in and ends it.
- `songStore` has `beginGesture`/`endGesture`/`cancelGesture`. Only `transient` ops stay inside a gesture. Other edits commit the gesture (`songStore.ts:119-131, 263-282`).
- `clipOps.newClip` makes a 1-measure clip. `freeSpanAt` finds the free measures ahead of a position, up to the end of the visible timeline (`timelineMeasures(song) = min(128, max(16, measures + 8))`). `resolveTrackNotes` is cached per `(loops, clips)` reference.
- Every clip op passes its result through `normalizeSong`, which sets `measures` to the end of the last-ending clip (improve-song-and-note-editing D1). A clip created past the song's end therefore lengthens the song.
- `lib/patternOps.ts` has `mergeNotes(existing: Note[], incoming: Note[]): Note[]`, which paste uses: a same-row, same-step incoming note replaces the existing one, and an existing note an incoming note overlaps is shortened to end where it starts, or removed if nothing remains.

**Transport and shortcuts.**
- `Transport.tsx` is a shared flex row. After add-timeline-loop-region it holds Play, the Loop toggle, and Follow, then the position readout.
- `useShortcuts` binds Space, undo, and Cmd/Ctrl+D. `R` is free.

**Tests.** `engine.test.ts` mocks Tone with a fake Transport. Playwright runs Chromium only, with no init scripts.

## Goals / Non-Goals

**Goals:**
- One input pipeline, from MIDI message to live sound and to the take buffer, shared by all three pages. Only the step at which a take commits differs between pages.
- Recorded notes land where the player heard them, taking the audio lookahead into account.
- Earlier passes are audible during loop recording, without spending an undo entry on each pass.

**Non-Goals:**
- Compensating for MIDI device or audio output latency beyond what the browser reports. There is no latency calibration UI.
- A generic event bus for other controllers.

## Decisions

### D1. `lib/midi/` holds a small access layer behind an interface
- **`MidiAccess`** wraps `navigator.requestMIDIAccess({ sysex: false })`. It exposes:
  - `status`: `unsupported | prompt | granted | denied`;
  - `inputs`, with id and name, updated from `onstatechange`;
  - `select(id | "all")`;
  - `subscribe(listener)`.
- **Parsing:** messages are parsed into `{type: "on" | "off" | "sustain", note, velocity, timeStamp}`. A note-on with velocity 0 becomes `off`, CC64 becomes `sustain`, and everything else is dropped.
- **Remembered settings:** `songbird.midi.v1` in localStorage stores `{granted: boolean, inputId}`. When `granted` is true, the page calls `requestMIDIAccess` on load. Chromium resolves that without a prompt once the site is allowed.
- **Singleton:** one module-level instance, so navigating between pages doesn't re-prompt or duplicate listeners.
- **Testing:** the interface is what Vitest fakes. Playwright uses `addInitScript` to install a fake `requestMIDIAccess` that the test can drive through `window.__midi.send(...)`.
- **Alternative:** the WebMidi.js library. It adds a dependency for what amounts to about 60 lines of parsing.

### D2. Held notes: `SoundSource.noteOn(row, time, velocity) → handle` and `noteOff(handle, time)`
- **The synth:** `triggerAttack` without a release. The voice's `freeAt` is `Infinity` until `noteOff`, and the voice-stealing rule treats held voices as the oldest to steal only when every voice is held.
- **Drums:** `noteOn` is the existing one-shot trigger, and `noteOff` does nothing.
- **Existing callers:** `trigger` stays for scheduled notes, so playback code is unchanged.
- **The engine:** `engine.liveNoteOn(row, {voiceKey, velocity})` and `liveNoteOff(...)` reuse the `previewVoice` channel routing. Live notes therefore follow the track's volume and pan and ignore mute and solo, which matches the preview rule the spec adopts.
- **The sustain pedal:** it is handled in the input layer (D4), not in the sources. Pedal-down defers note-offs in a set, and pedal-up flushes them.
- **Timing:** notes start at `context.currentTime`, with no added offset. The engine's playback lookahead doesn't apply to live notes. Tone's context uses the default `latencyHint: "interactive"`, and no change is needed. The 20 ms budget is then the time spent on the main thread, which a Vitest timing check guards.
- **Alternative:** a long fixed-length trigger, cut short by `triggerRelease`. It fights the voice pool's `freeAt` bookkeeping.

### D3. Mapping event times to steps: `engine.stepAt(domTimeStamp): {step, frac, seconds, stepSeconds} | null`
- **From MIDI time to transport time:**
  - `audioTime = ctx.currentTime − (performance.now() − timeStamp) / 1000`;
  - then `baseLatency + outputLatency` is subtracted (a missing one counts as 0), so the step matches what the player *heard*;
  - then `Transport.getSecondsAtTime(audioTime)` gives transport seconds.
- **Finding the step:** the engine finds the containing `ScheduledBar` among the kept bars, and inverts `stepToSeconds` within that bar, trying both even and odd steps with swing. It returns the nearest step's song-absolute index, which already reflects loop wrapping because `firstStep` is wrapped.
- **Wrap-around:** when the nearest step is the one just past the bar, and that bar was the last bar of the loop region, it maps to the region's first step. That covers the "Early downbeat" scenario. With looping off it maps to `null`, and the note is discarded.
- **Note length:** the note-off gets the same mapping. Length is `offStep − onStep`, counted along the playback order, which handles a note held across a loop wrap. It is clamped to the end of the range and to at least 1.
- **Alternative:** sampling the integer `subscribePosition`. It is quantized to animation frames and is floored rather than nearest.

### D4. `lib/recording/`: an input router, a take buffer, and page adapters
- **`InputRouter`** listens to `MidiAccess`. It keeps the map of held notes and the sustain state. For each event it:
  1. maps the note to a row through the target instrument's `rows[].midi_note`;
  2. calls the engine's live note API;
  3. while a take is active, sends the finished `{row_id, step, length_steps, velocity}` to the take on note-off.
- **`Take`** merges notes with the existing pure `mergeNotes(existing, recorded)` from `lib/patternOps.ts`, so recording and paste resolve collisions identically and there is no recording-specific merge. The same row and step replaces the old note, and an existing note that a recorded note overlaps is shortened. Adapters decide where the result goes:
  - **Pattern adapter:** it rides the pattern store's gesture, like the song adapter. `beginGesture()` at the start of the take, each finished note is a `transient` `editNotes` that re-merges the recorded notes onto the gesture's base, and `commitGesture()` at the end makes one undo step. When a take ends with no notes, nothing changes. A non-transient edit (toggle, tempo, clear) folds into the gesture and ends it, so the take's notes and that edit are one undo step. Both adapters remember the base they began and re-base on the current state whenever the store's `gestureBase` is no longer that object, so the next recorded note never merges onto a stale base. Drags (piano roll, clip move/resize, mixer sliders) start through the recording session's `guardEdit`, which ends the take first, because a drag shares the store's single gesture and its cancel or replay would otherwise discard the take.
  - **Song adapter:** it calls `store.beginGesture()` at the start of the take. Take edits are `transient` ops (D5), and `endGesture()` at the end makes one undo step. This also covers loops and clips the take creates. Undo and redo already call `endGesture` first, but the page also routes them (shortcut and buttons) through the recording session's finish, so the take is ended, announced and its router state cleared before the history moves. Leaving the page, or changing the engine, also ends and commits the take; only cancelling a count-in discards.
- **Alternative:** buffer everything and write it only when the take ends. That is simpler, but notes from the first pass wouldn't be heard on the second pass, which the spec requires.

### D5. Studio placement: `clipOps.recordNotes(song, trackId, notes, takeState)`
This is a pure op, marked `transient`.
- **Each song-absolute note** is looked up against `track.clips`:
  - **Inside a clip:** it is placed at `local = (step − clipStartStep) mod loopSteps` and merged into that loop.
  - **Otherwise:** `takeState.runs` is consulted. That maps each empty run's start measure to the loop and clip already created in this take.
    - **If the run has one:** the clip is extended toward the note, never past the run limit from `freeSpanAt`. `loop.measures` and `clip.measures` are changed together, and the note is merged.
    - **If not:** a loop and clip are created with a new `newClipWithNotes(song, trackId, measure, measures, notes)`, named as `newClip` names them, and recorded in `takeState`.
- **Limits:** a `clip-limit` or `loop-limit` failure increments `takeState.dropped[reason]`. The page reports the count when the take ends.
- **Ending a clip at a note's end:** a note whose end falls in a later measure extends the clip to cover it, within the run.
- **Why grow the clip:** extending one clip for each run, rather than creating a clip for each note, keeps a looping take over empty space to a single clip.
- **Past the song's end:** a run's limit is the next clip or the end of the visible timeline, as `freeSpanAt` already reports. Because `recordNotes` passes its result through `normalizeSong`, a clip created or extended past the song's end lengthens the song inside the take's gesture, so undoing the take also restores the length. The engine plays those measures only while a loop region covers them (add-timeline-loop-region D7).
- **Why not a fixed song length during a take:** the song's length is derived from its clips. Holding it fixed would mean refusing notes the player can hear the timeline reach.

### D6. Metronome and count-in live in the engine
- **The click source:** `metronomeSource` is a tiny Tone `MembraneSynth`/`Synth` pair, with an accented downbeat, connected straight to the destination and skipping the track channels.
- **Scheduling clicks:** `scheduleStep` adds a click when `metronome` is on and `stepInBar % beatSteps === 0`. `beatSteps` is already derived per time signature for the ruler: 4 for 4/4 and 3/4, and 6 for 6/8.
- **The count-in:** `play({countIn: true})` schedules one pre-roll bar at transport 0. The pre-roll bar has only clicks, is `measure: 0`, and is excluded from `getPosition`. The first real bar then starts at `preRoll.duration`.
  - `subscribeCountIn(cb)` drives the "Count-in" indicator, a beat counter that counts down 4-3-2-1. `subscribeCountInEnd(cb)` fires from a transport event when the first real bar is scheduled (up to the 100 ms lookahead before it is audible), so recording begins even when animation frames are throttled.
  - Stop during the pre-roll uses the normal `stop()`, and the adapter discards the take.
- **Where settings are saved:** `songbird.metronome.v1 = {metronome, countIn}` in localStorage, read by a small shared hook.
- **Alternative:** schedule clicks as a hidden voice. It would go through voice and mixer code and could leak into export.

### D7. The transport UI
- **The controls,** after Play, Loop, and Follow:
  - Record, a toggle with `aria-pressed`, `aria-keyshortcuts="R"`, and a red dot. It pulses while recording, with the text "Recording" so colour isn't the only signal.
  - Count-in, a toggle.
  - Metronome, a toggle.
  - The MIDI input control, a button that opens a menu of inputs, or a status message when MIDI is unsupported or denied.
- **Announcements** go through the page's existing `role="status"` region.
- **The shortcut:** `R` is added to `ShortcutActions`, with the same text-entry and dialog guards as Space, and ignoring `e.repeat`.
- **Timing:** `ui-designer` specifies the layout before the build.

## Risks / Trade-offs

- **[Risk] `outputLatency` is missing or wrong on some systems, so notes land a step late** → `baseLatency` is always part of the sum, so a missing `outputLatency` costs only the device delay, and cover the mapping with injected latencies in tests. Quantizing to the nearest sixteenth (±62 ms at 120 BPM) absorbs typical errors. A calibration setting can come later.
- **[Risk] Only 3 bars are kept, so a very late note-off of a long-held note can't be mapped** → note-off mapping falls back to the end of the range. A note held longer than the kept bars is recorded as lasting to the range's end, which is the correct clamp anyway.
- **[Risk] Held synth voices starve the pool when many keys are held with the pedal down** → steal the oldest held voice as a last resort. 32 voices exceed what a pedalled keyboard part typically needs.
- **[Risk] A song gesture that spans a long take conflicts with other edits the user makes mid-take** → a non-transient edit already commits the gesture. The adapter detects that (the gesture base was cleared), starts a new gesture for the rest of the take, and the take then spans two undo steps. That is documented, and it is an edge case.
- **[Trade-off] Safari users can't use MIDI input at all.** The control says so, and nothing else degrades.
- **[Trade-off] Live notes are heard on muted tracks,** which matches the existing preview rule and lets the user practise a part before unmuting it.

## Migration Plan

There is no data migration. The new localStorage keys (`songbird.midi.v1` and `songbird.metronome.v1`) start at their defaults when absent. Build after add-timeline-loop-region has been applied, because recording relies on its looping on/off and play-once behavior. Rollback is a frontend revert.

## Open Questions

- Should a latency offset setting be added if users report takes landing late? That can be decided after real-device testing in task 6.3, without changing these specs.
