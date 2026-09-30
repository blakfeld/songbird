# Proposal

## Why

Today the playback loop is set with two measure dropdowns and a "Loop whole pattern/song" button in the transport bar. Those controls are away from the music they describe, so the user has to translate "that chorus there" into measure numbers. Looping also cannot be switched off, so there is no way to hear a song play through once and stop. DAWs such as Logic Pro set the loop directly on the timeline ruler. You drag over the bars you want, adjust the highlighted strip, and click it to switch looping on or off. Songbird should work the same way on every page that plays music.

## What Changes

- **Loop region on the ruler.** The ruler above the timeline shows the loop region as a highlighted strip that snaps to whole measures.
  - **Draw:** dragging across the ruler outside the region draws a new region there. It replaces the old one and turns looping on.
  - **Move:** dragging the region's body moves it along the ruler without changing its length.
  - **Resize:** dragging either edge grows or shrinks it, down to 1 measure.
  - **Toggle:** clicking the region without dragging turns looping on or off. When looping is off, the region stays visible but dimmed.
  - **Keyboard:** the region's start edge, end edge, and body are focusable and can be adjusted with the arrow keys. The body toggles with Enter or Space.
- **Loop toggle beside Play.** A Loop button next to Play and Stop shows whether looping is on and switches it on or off. It is a second way to do what clicking the region does.
- **Loop off plays once.** With looping off, Play starts at measure 1 (or at the Studio's seek position), plays to the end of the pattern or song, lets notes still sounding finish, then stops and resets the playhead. With looping on, behavior is as today: Play starts at the region's start and the region repeats.
- **Changes during playback** take effect at the next measure boundary:
  - Turning looping off lets playback run on to the end.
  - Turning it on while the playhead is outside the region sends playback to the region's start.
- **Saved with the work.** The region and the on/off state are saved with the song (Studio) and with each instrument's pattern (single-instrument pages). They survive a reload.
  - They are not undo steps, and undoing or redoing an edit does not move the region.
  - A new song or pattern, or one saved before this change, starts with looping on and the region covering its whole length.
- **Length changes.** A region that covered the whole length keeps covering the whole length. Any other region is clamped into the new length. This replaces today's reset whenever the length changes.
- **Removed:** the "Loop measures" start/end dropdowns and the "Loop whole pattern" / "Loop whole song" button.
- **Where:** the Studio arrangement ruler (song scale), and the piano-roll ruler on `/drum-machine` and `/instruments/[id]` (pattern scale). The Studio dock's ruler measures positions inside the selected clip's loop, not the song, so it does not show the song's loop region.
- **Non-goals:**
  - Regions that start or end partway through a measure.
  - Several loop regions or markers.
  - A punch-in or record range.
  - Click-to-seek on the ruler (seeking stays on the Studio lanes).
  - A loop region inside the dock.
  - Changing the engine's timing model.

## Capabilities

### New Capabilities
<!-- None. The behavior belongs to the existing playback capability. -->

### Modified Capabilities
- `patterns/playback`: "Play and stop" (start position with looping off, and the stop at the end) and "Looping" (optional looping, the region, and the Loop toggle). Adds "Editing the loop region on the ruler" and "Loop region is saved".
- `songs/multitrack`: "Mixed song playback", where the loop region and toggle apply to the whole song and the region is drawn on the arrangement ruler.

## Impact

- **Frontend only. No API, backend, or Rust `Pattern` type changes.**
  - `components/editor/MeasureRuler.tsx` becomes interactive, with a new `LoopRegion` overlay.
  - `components/editor/Transport.tsx` loses the dropdowns and gains the Loop toggle.
  - `LoopShade` dims the unlooped measures only while looping is on.
  - `PatternEditorPage` and `StudioPage` drop their component-local `loopState`.
  - `components/studio/Arrangement.tsx` hosts the interactive ruler.
- **Engine** (`lib/audio/engine.ts`): a looping on/off setting and a play-once path that ends after the last measure's sounds finish.
- **Storage:**
  - Patterns: the region sits beside the pattern in the pattern store's persisted state (`patternStore.ts`), outside undo history.
  - Songs: an optional `loop_region` field on `Song`, with no version bump. The song store keeps it out of undo snapshots.
- **Downstream planning changes need a small update** (via `/opsx:update`):
  - `add-song-sections`: selecting a section should set the loop region and turn looping on.
  - `add-context-aware-track-generation`: its "Loop range" option should be offered only while looping is on and the region is not the whole song.
- **Tests:** the Transport dropdown tests and the Studio length-change assertion on "Loop end measure" are rewritten against the ruler and the toggle.
