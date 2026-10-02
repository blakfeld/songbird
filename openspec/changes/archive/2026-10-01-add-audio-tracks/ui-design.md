# UI design: audio tracks and samples

Input for tasks 4.2–4.4. It reuses the studio's existing language: zinc neutrals, `focusRing`, `menuItemClass`, `Menu`/`ContextMenu`, `Knob`, `ModalDialog`, `ErrorAlert`, the loop palette, the `bg-zinc-900 font-mono text-xs` drag tooltip, the `PastEnd` hatch, and the page `role="status"` line (`setStatus` / `onAnnounce`) for every result message. It adds no new colour tokens.

## 0. Shared pieces

| New file | Purpose |
|---|---|
| `frontend/src/lib/song/audioTime.ts` | Pure formatters: `formatPosition(ticks, song)` gives `"5.1.1"` (bar.beat.sixteenth). `spanLabel(clip, song)` gives `"measure 3 beat 1 to measure 6 beat 4"`; the end is the beat holding the last sounding frame. `formatFade(samples, rate)` gives `"Off"`, `"250 ms"`, or `"1.2 s"`. `formatLength(samples, rate)` gives `"0:01.2"`. `formatBarsBeats(ticks)` gives `"3 bars 2 beats"`. |
| `frontend/src/lib/audio/waveformPath.ts` | Pure function. `peaksPath(overview, offsetSamples, sliceSamples, maxColumns = 1024)` returns an SVG `d` in viewBox units: x is in frames of the slice and y runs from −1 to 1. It folds 256-frame bins into at most 1024 columns, using the min of mins and the max of maxes across both channels, and draws one closed polygon (top edge along the max, back along the min). Memoize on `(sampleId, offset, slice)`. |
| `components/studio/audio/Waveform.tsx` | Draws an SVG waveform (see §1.2). It is used by the lane clip, the dock overview, and the library row thumbnails. |
| `components/studio/audio/LoopGlyph.tsx` | A 12px `↻`-style SVG, `aria-hidden`, styled like `LinkGlyph`. It makes looping visible without relying on colour alone. |
| `components/studio/InstrumentIcon.tsx` (modify) | Add an `audio` glyph (vertical waveform bars): `<path d="M3 10h1M6 7v6M9 4v12M12 6v8M15 8v4M17 10h0"/>`. |

**Sample colour.** An audio clip uses `loopColour(song.samples.findIndex(s => s.id === clip.sample_id))`. Every clip of the same sample then has the same colour, just as linked MIDI clips share a loop colour, and the palette already has AA-checked fills.

**Instrument lookup.** `Arrangement.lookup` and `EditorDock` must treat `instrument === "audio"` as a known kind, not `"missing"`. Return `{ state: "audio" }` (or equivalent) so the header shows the audio icon and the text "Audio" instead of the missing-instrument warning.

## 1. Audio lane clip

### 1.1 Structure

- `components/studio/audio/AudioClipLane.tsx` is a sibling of `ClipLane`. `TrackLane` renders it when `track.instrument === "audio"`.
- Keep `ClipLane`'s outer lane div unchanged: the `--cell-w` container units, `@container relative min-w-0`, `PastEnd`, click-to-seek on empty space, and the right-click lane menu.
- Clip positions are in ticks: `left: calc(var(--cell-w) * start_ticks / 240)` and `width: calc(var(--cell-w) * durationSteps - 1px)`, where `durationSteps = secondsToTicks(len/rate)/240` at the current tempo.
- Each clip is a `<button>` (`AudioClipBlock`) with the same base classes as MIDI clips: `group/clip @container/clip absolute top-1 bottom-1 min-w-[3px] cursor-grab touch-pan-y overflow-hidden rounded-md border text-left select-none ${palette.block} ${focusRing}`. When not audible it also gets `opacity-40`.

Layers inside a clip:

```
 ┌[◆]kick-808 ↻───────────────────────────────────────────[◆]┐  ← name strip h-4; fade handles at the top corners
 │▏ ╱‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾╲ ▕│  ← envelope line (gain plus fade ramps)
 │▏╱ ▁▃▇█▆▃▂▁▃▇█▆▃┊▁▃▇█▆▃▂▁▃▇█▆▃┊▁▃▇█▆▃▂▁▃▇█▆▃┊▁▃▇█▆▃▂   ╲▕│  ← waveform; ┊ = repeat marks
 └▏──────────────────────────────────────────────────────────▕┘  ← ▏▕ trim edges
```

Hit areas from top to bottom, using DOM order and `z-*`:

| Layer | Element | Hit area | Cursor | Hidden below clip width |
|---|---|---|---|---|
| Fade handles | `span[data-handle="fade-in"\|"fade-out"]`, `z-30` | `size-3` (`pointer-coarse:size-5`), centred on the knee x at `top-0` | `ew-resize` | `@max-[3rem]/clip:hidden` |
| Trim edges | `span[data-handle="trim-start"\|"trim-end"]`, `z-20` | `inset-y-0 w-2` (`pointer-coarse:w-4`) at the left or right edge | `ew-resize` | start: `@max-[2rem]/clip`; end: same as today's resize handle |
| Gain line | `span[data-handle="gain"]`, `z-10` | `h-2` (`pointer-coarse:h-4`) band centred on the line, between the fade knees | `ns-resize` | `@max-[2rem]/clip:hidden` |
| Body | the button itself | everything else | `grab` / `grabbing` | – |

The handle visuals copy today's resize grip:
- Trim grip: `h-3 w-0.5 rounded-full bg-zinc-900/60 dark:bg-zinc-50/60`.
- Fade handle: `size-2.5 rounded-sm border border-zinc-900 bg-white dark:border-zinc-50 dark:bg-zinc-950`.

All handles are `invisible`, and become visible on `group-hover/clip`, when the clip is selected, or during its drag. All are `aria-hidden`, because every handle has a keyboard or dock equivalent (§1.5, §2).

### 1.2 Waveform (`Waveform.tsx`)

- The SVG is `absolute inset-x-0 top-4 bottom-0.5 h-[calc(100%-1.125rem)] w-full` (the same box as MIDI notes), with `viewBox="0 -1 {length_samples} 2"`, `preserveAspectRatio="none"`, and `aria-hidden`.
- **Slice** `<path id={useId()} d={peaksPath(...)} className={palette.note} />`. Draw it once. Loop repeats are `<use href="#id" x={k * slice_samples}>` for `k = 1..ceil(length/slice) − 1`. The outer viewBox crops the final partial repeat.
- **Gain:** wrap the paths in `<g data-testid="clip-wave" data-gain-scale={g.toFixed(3)} transform={`scale(1 ${g})`}>`, with `g = 10^(gain_db/20)`. The SVG viewport crops anything above full height, which satisfies "limited to the clip's height". The test for "Waveform follows gain" asserts that `data-gain-scale` is about 1.995 at +6 dB.
- **Fades:** a `<clipPath>` polygon shapes the envelope: `(0,0) (fi,−1) (L−fo,−1) (L,0) (L−fo,1) (fi,1)`. The waveform visibly tapers to nothing at each faded end.
- **Envelope line:** a `<polyline>` from `(0, 1)` through `(fi, yGain)`, `(L−fo, yGain)` to `(L, 1)`. `yGain` maps −24…+12 dB to the bottom…top of the area, so 0 dB sits at two thirds of the height. Use `className="fill-none stroke-zinc-900/70 dark:stroke-zinc-50/70"` and `vectorEffect="non-scaling-stroke"`. This single line is both the "gain line" and the visible fade ramps.
- **Repeat marks:** reuse the MIDI clip's dashed `<line data-testid="repeat-mark">` with the same classes, at `x = k * slice_samples`.
- **Loading** (overview not yet read): draw a centre line `stroke-current opacity-40 motion-safe:animate-pulse`.

### 1.3 Name strip

`absolute inset-x-0 top-0 flex h-4 items-center gap-1 pl-3 pr-3 text-[11px] font-medium`. The `pl-3`/`pr-3` padding keeps the name clear of the corner fade handles. It contains the sample name (truncated, and `font-semibold` when selected) and `<LoopGlyph/>` when `loop` is on. A `title` shows `kick-808 · 5.1.1–8.4.4 · looping · −6 dB`.

### 1.4 States

| State | Treatment |
|---|---|
| Default | `palette.block` + `border` |
| Hover | `hover:brightness-95 dark:hover:brightness-110`, and handles become visible |
| Selected | `shadow-sm ring-2 ring-zinc-900 dark:ring-zinc-50`, `aria-current="true"`, `data-selected`, name `font-semibold`, and handles visible |
| Focus | `focusRing` (outline, which is separate from the selection ring) |
| Dragging | `z-20 cursor-grabbing shadow-md`, and the body cursor is set as `ClipLane` does today |
| Not audible | `opacity-40` |
| **Missing audio** | The palette is replaced with `border-dashed border-red-700 dark:border-red-400`, the `PastEnd` hatch background (`bg-zinc-100/70 bg-[repeating-linear-gradient(135deg,…)]`), and no waveform. Centred text reads `⚠ Audio missing` (`text-[11px] font-medium text-red-800 dark:text-red-300`), hidden below `@max-[5rem]/clip`. The name strip stays. Move, trim, delete, and Replace still work, but the gain and fade handles are hidden. Meaning is carried by the text, dashes, and hatch, not by colour alone. |

### 1.5 Pointer gestures

Each drag is one undo step: call `beginGesture` once the pointer passes `DRAG_THRESHOLD_PX`, then `endGesture` or `cancelGesture`. Escape cancels, as in `ClipLane`.

- **Move:** snaps to sixteenths, or moves freely while Shift is held. The clip stops at its neighbour.
- **Trim start / trim end:** follow the same snapping as move.
- **Gain:** about 0.5 dB per px, or 0.1 dB per px with Shift. Double-clicking the gain line resets it to 0 dB, as the `VolumeSlider` reset does.
- **Fades:** no snapping. A fade cannot cross the other fade's knee.

The tooltip reuses the existing positioned tooltip (`first ? "top-full mt-1" : "-top-7"`):

| Gesture | Text |
|---|---|
| Move | `5.1.1`, or `5.1.1 · stopped at snare` when blocked |
| Trim start | `Starts 5.2.1` |
| Trim end | `Ends 8.4.4 · 3 bars 2 beats`, with `· plays 4 times` added when looping and `· end of sample` added when clamped |
| Gain | `−6.0 dB` |
| Fade | `Fade in 250 ms` / `Fade out 1.2 s` |

- Double-click on a clip opens the dock (`actions.select` + `openDock`); audio has no piano roll.
- Double-click on empty lane space opens the file picker, then imports and places the file at that snapped position.

### 1.6 Accessible name and keyboard

- Use `aria-roledescription="audio clip"`.
- `aria-label`: `"{sample name}, {spanLabel}"`, plus `", looping"`, `", audio missing"`, and `", gain −6 dB"` (only when not 0).
- Use a roving `tabIndex` across the lane's clips, as `ClipLane` does (`stopId`).
- `aria-describedby={AUDIO_CLIP_KEYS_HELP_ID}`, a new sr-only `<p>` in `Arrangement` next to `CLIP_KEYS_HELP`. Its text:

  > Left and Right arrows move the clip by a sixteenth. Shift with Left or Right changes its length. Up and Down arrows change its gain by 1 decibel. Alt with Left or Right moves to the previous or next clip. Enter opens the clip panel. Delete removes it. Command or Control D duplicates it. Shift F10 opens more actions.

| Key | Action |
|---|---|
| ←/→ | Move one sixteenth (stops at the neighbour). Held auto-repeat is one undo step (the existing `holding` pattern). |
| Shift+←/→ | Trim or extend the end by one sixteenth |
| ↑/↓ | Gain ±1 dB (held is one undo step) |
| Alt+←/→, Home/End | Move focus to a sibling clip |
| Enter | Select, open the dock, and focus the panel's Gain knob |
| Delete/Backspace | Delete |
| Cmd/Ctrl+D | Duplicate after itself |
| Shift+F10 / ContextMenu | Open the clip menu |

Set `aria-keyshortcuts` to match. Announce results through the existing `actions` announce, for example `"kick-808, measure 5 beat 1 to measure 8 beat 4"` or `"Gain −6 dB"`.

### 1.7 Clip context menu: `components/studio/audio/AudioClipMenu.tsx`

`AudioClipMenuItems` is shared by right-click, Shift+F10, and the dock's `⋯` (the same sharing rule as `ClipMenuItems`). Its items, all using `menuItemClass`:

- `Loop`: `role="menuitemcheckbox"` with `aria-checked`.
- separator
- `Replace sample…`
- `Duplicate` (shortcut hint `⌘D` / `Ctrl+D` right-aligned, as today)
- `Delete`

Disabled items use `aria-disabled` plus a hint `<p>` (existing pattern), for example "No room after this clip".

## 2. Dock audio clip panel: `components/studio/audio/AudioClipPanel.tsx`

`EditorDock` branches when `track.instrument === "audio"`, before any instrument lookup or loading skeleton. It uses the same `<section>` shell and `aria-label`: `Editor: {sample} on {track}` or `Editor: {track}`.

```
┌ role=toolbar "Audio clip" (same classes as the Loop toolbar) ─────────────────────┐
│ ■ kick-808   Loops · 5.1.1 – 8.4.4 · 4 bars                           [⋯]  [×]     │
├────────────────────────────────────────────────────────────────────────────────────┤
│ ▕░░░░▁▃▇█▆▃▂▁▃▇[█▆▃▂▁▃▇█▆▃▂▁▃▇█▆▃]▂▁▃▇█▆▃▂░░░░▏  whole sample; used slice in colour │
│ 0:00.0 – 0:02.0 of 0:04.1 · Stereo                                                 │
├────────────────────────────────────────────────────────────────────────────────────┤
│  (Gain)    (Fade in)  (Fade out)    [◯— Loop]      [Replace sample…]               │
│  −6 dB     250 ms     Off                                                          │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **Toolbar:**
  - `LoopSwatch` (sample colour index) and name `text-sm font-semibold truncate`.
  - Context `text-xs text-zinc-600 dark:text-zinc-400`.
  - `Menu` `⋯` with `AudioClipMenuItems` and `DockCloseButton`.
- **Overview:** `Waveform` over the whole sample, `h-16 px-2`, `aria-hidden`.
  - Outside the slice: `fill-zinc-400 dark:fill-zinc-600`.
  - The slice uses the clip colour, plus `border-x-2` brackets in `palette.swatch`.
  - The text line below states the slice, so the bracket isn't the only cue.
- **Controls:** `flex flex-wrap items-end gap-4 p-3`. Each control has one undo step per gesture (`onGestureStart`/`onGestureEnd`). Undo groups follow the existing Knob `transient` contract.

| Control | Component | Range / format |
|---|---|---|
| Gain | `Knob size="md" bipolar` | −24…+12, step 0.5, `snap {value:0, within:0.5}`, `format=formatDb` (from `VolumeSlider`), default 0 |
| Fade in / Fade out | `Knob size="md" scale="log"` | 1 ms … `min(clip length − other fade, 30 s)`. Values ≤ 1 ms are stored as 0 and read "Off". `format=formatFade`, default 0. Fades longer than 30 s are set with the lane handles. |
| Loop | Switch: reuse the `role="switch"` markup from `TrackSoundPanel`'s `Group` header, and extract it to `components/ui/Switch.tsx` rather than copying | Label "Loop". `aria-describedby` hint: "Off limits the clip to its slice" (only when on and the length exceeds the slice) |
| Replace sample | `Button` (secondary), "Replace sample…" | Opens `ReplaceSampleDialog` |

- **`ReplaceSampleDialog`** (`components/studio/audio/ReplaceSampleDialog.tsx`):
  - It is a `ModalDialog` labelled "Replace sample", `className="m-auto w-full max-w-md rounded-2xl p-0"`.
  - It contains `SampleList` (§3) in `mode="pick"`: activating a row picks it. Preview still works. The current sample shows `aria-current="true"`, has a "Current" badge, and is `aria-disabled`.
  - On pick, close and announce `Replaced kick-808 with snare.`, adding ` Clip shortened to fit.` when the length was clamped.
- **Missing audio:** above the controls, show `ErrorAlert` with "The audio for kick-808 isn't in this browser, so this clip is silent. Replace it with a library sample, or open the project bundle that includes it." The Replace button is promoted to `variant="primary"`. Gain, fades, and loop stay enabled because they are document edits.
- **No clip selected** (reuses the `EmptyState` layout):
  - Heading: `{track} has no clips yet` / `No clip selected on {track}`.
  - Hint: "Drop an audio file on the lane, or drag a sample from Samples."
  - Buttons: `Import audio…` (primary; imports and places at the playhead, as in §5) and `Show samples` (secondary; opens the Samples panel and focuses its search).
- **No AI:** "Generate part with AI…" is not rendered for audio tracks, in the track options or anywhere in the dock.
- **Sound panel:** `TrackSoundPanel` hides the Tone group for audio tracks and shows the effects only.

## 3. Samples panel

### 3.1 Where it lives

- **Toolbar:** a new `Button` "Samples" in `SongHeader`, before the Assistant button and visible at every width. It has `aria-expanded` and `aria-controls="samples-panel"`. It uses the `audio` glyph and keeps its text, with `max-sm:` hiding the text and an `aria-label` for that case.
- **lg and wider:** the right column becomes `components/studio/RightRail.tsx`. Its tablist `[Assistant] [Samples]` (`role="tablist"`, arrow keys, automatic activation) sits in the existing header strip (`border-b px-4 py-3`). Tab style: `rounded-md px-2 py-1 text-sm aria-selected:bg-zinc-100 aria-selected:font-semibold dark:aria-selected:bg-zinc-900`. The toolbar button selects the Samples tab and focuses search. The chat keeps its state when it is hidden: use `hidden`, don't unmount it.
- **Narrower than lg:** `SamplesPanel` renders as a **non-modal** sheet with `role="dialog" aria-modal="false"`. A modal `<dialog>` would make the lanes inert, and dragging a sample to them would then be impossible. Copy `TrackSoundPanel`'s positioning:
  - `max-md`: bottom sheet `inset-x-0 bottom-0 rounded-t-2xl max-h-[60dvh]`.
  - `md`: right sheet `md:top-0 md:right-0 md:h-dvh md:w-80 md:border-l md:shadow-lg`.

  Escape closes it and returns focus to the toolbar button. It doesn't trap focus.

### 3.2 Layout: `components/studio/samples/SamplesPanel.tsx`

```
Samples (12)                         [Import audio…]
[🔍 Search samples              ]
Places on: Loops at 3.1.1             ← or "Select an audio track to place samples"
┌──────────────────────────────────────────────────┐
│ [▶] ⠿ ▁▃▇▃▁ breakbeat-120           In song [⋯] │
│              0:04.0 · Stereo                     │
│ [■] ⠿ ▇▃▁   kick-808   (previewing)          [⋯] │
└──────────────────────────────────────────────────┘
```

- **Header:** `h2 text-sm font-semibold` "Samples" plus the count in `hintClass`, and `Button` "Import audio…". A hidden `<input type="file" multiple accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.aac,.flac,.ogg,.opus">`.
- **Search:** `<input type="search">` with `inputClass w-full`, an sr-only `<label>` "Search samples", and placeholder "Search". It filters case-insensitively on every keystroke. The result count is announced in a polite sr-only region ("3 samples").
- **Target line:** `hintClass`, `aria-live="polite"`. It tells the user where Enter will place a sample. It reads "Places on: {track} at {formatPosition(playhead)}", or "Select an audio track to place samples".
- **List:** `components/studio/samples/SampleList.tsx` (shared with Replace), with `mode: "library" | "pick"`. It is a `<ul aria-label="Samples">` of `SampleRow`. It is sorted newest first, scrolls in `overflow-y-auto overscroll-contain`, and rows are `h-14 border-b border-zinc-200 dark:border-zinc-800`.

### 3.3 Row: `components/studio/samples/SampleRow.tsx`

| Part | Element | Detail |
|---|---|---|
| Preview | `button` `size-7 pointer-coarse:size-9 rounded-full border` | `aria-label="Preview {name}"`, `aria-pressed`. Glyph `▶` or `■`. When pressed: `bg-indigo-600 text-white dark:bg-indigo-400 dark:text-zinc-950`. |
| Sample | `button draggable` (`group/sample flex-1 cursor-grab text-left`) | Contains the grip `⠿` (`text-zinc-400 group-hover/sample:text-zinc-700`), a `Waveform` thumbnail `h-5 w-16`, the name `text-sm truncate`, and the meta line `hintClass tabular-nums` with `0:04.0 · Stereo`. `aria-label="{name}, {spoken length}, {mono\|stereo}"` plus `", in this song"`. `aria-describedby` points to the list help. **Activate (click or Enter) places at the playhead** in library mode, or picks in pick mode. `title`: "Drag onto an audio lane, or press Enter to place at the playhead". |
| In song | `span text-[11px] rounded bg-zinc-100 px-1 dark:bg-zinc-800` | Shown when `song.samples` has the id. Decoration only; the fact is also in the label. |
| More | `Menu` `⋯` (`size-7` trigger, as in the track options) | Items: `Place at playhead`, `Rename…`, `Remove from library…` |

**Keyboard.** The list has one tab stop, using a roving `tabIndex` in a grid-style list.
- ↑/↓ move to the same control in the previous or next row. ←/→ move between preview, sample, and more.
- Home/End go to the first or last row.
- F2 renames.
- Delete opens the Remove dialog.
- Do not bind Space to preview, because Space is the global play/pause key (`Transport`). On the sample button it activates the button like Enter.
- Help text (sr-only): "Up and Down move between samples. Enter places the sample at the playhead on the selected audio track. F2 renames. Delete removes it from the library."

**Place with nothing to place on.** If no audio track is selected, the sample button has `aria-disabled="true"` in library mode, and Enter announces "Select an audio track first." Drag still works.

**Rename.** `InlineNameInput` replaces the name, `maxLength 80`. It commits on Enter or blur and cancels on Escape, as for track rename.

**Remove.** `components/studio/samples/RemoveSampleDialog.tsx` is a `ModalDialog role="alertdialog"`, styled like the delete-song confirm in `SongHeader`.
- Title: "Remove kick-808 from the library?"
- Body: "It isn't used by any saved song." or "**2 songs** still use it and will keep playing it." While the count loads, show `Spinner` with "Checking songs…".
- Buttons: Cancel, and Remove (destructive classes, as in `SongHeader`). Library removal is not undoable, so it always confirms.
- After removal, focus moves to the next row, or to search if the list is empty.

**Preview state.** Only one preview plays at a time. Starting another preview sets the old button's `aria-pressed` to false. When playback ends, the button resets. Song playback is never touched.

### 3.4 Panel states

| State | Content |
|---|---|
| Loading | 6 skeleton rows `h-14 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-900`, `aria-hidden`, and an sr-only status "Loading samples" |
| Error (IndexedDB) | `ErrorAlert` "Couldn't open the sample library." with Retry |
| Empty library | Centred `h3 text-sm font-semibold` "No samples yet", `hintClass` "Import audio files, or drop them here.", and `Button` "Import audio…" |
| No search match | `hintClass` `No samples match "{query}".` with a `Clear search` text button |
| Importing | An `ImportProgress` list at the top of the panel, one row per file: name, `<progress>` (`h-1 w-full accent-indigo-600`, `aria-label="Importing {file}"`), and percent. Rows disappear on success. |
| Import failed | A per-file `ErrorAlert` that is dismissible and names the file and reason: "notes.txt isn't an audio file this browser can read." / "is larger than 200 MB" / "is longer than 20 minutes" / "There isn't enough storage space" |
| Low storage | Before storing: `ModalDialog role="alertdialog"` "Browser storage is almost full", "About 150 MB is left. Importing kick.wav needs about 23 MB.", with [Cancel] [Import anyway] |
| Drop over panel | The panel gets `ring-2 ring-inset ring-indigo-600 bg-indigo-50/60 dark:ring-indigo-400 dark:bg-indigo-950/40` and an overlay label "Drop to import" |

## 4. Drop targets: `components/studio/samples/useSampleDrop.ts` + `NewTrackDropZone.tsx`

**Accepted drag types:** `application/x-songbird-sample` (library row; `effectAllowed="copy"`) and `Files`. An OS file's length is unknown until it is decoded.

**Navigation guard.** `Arrangement` installs window-level `dragover`/`drop` listeners that call `preventDefault()` for `Files`, with `dropEffect="none"` outside the targets. Without this, a file dropped a few pixels off a lane makes the browser navigate to the file, and unsaved UI state is lost.

**Drag-active state.** It is set on a window `dragenter` with an accepted type and cleared on `drop`/`dragend`/leaving the window. While a drag is active:

| Region | Idle-during-drag | Hovered |
|---|---|---|
| Audio lane | `ring-1 ring-inset ring-indigo-600/40` (shows where you *can* drop) | `ring-2 ring-inset ring-indigo-600 bg-indigo-500/5 dark:ring-indigo-400` plus a ghost |
| Instrument lane | unchanged; `dropEffect="none"` (cursor shows not-allowed) | same |
| Below-last-lane zone | appears (see below) | highlighted plus a ghost |
| Samples panel | unchanged | §3.4 drop styling (files only) |

**Ghost for a library sample** (its length is known):
- An `aria-hidden` block at the snapped drop position with the sample's real width at the current tempo.
- Classes: `pointer-events-none absolute top-1 bottom-1 rounded-md border border-dashed opacity-70`, with the sample's palette or `border-zinc-600 bg-zinc-500/15` when the sample isn't in the song yet. Add the `Waveform` thumbnail if it is cheap.
- The tooltip shows `kick-808 · 5.1.1` (Shift drag shows the unsnapped position).

**Ghost for a file** (length unknown): a `w-0.5 bg-indigo-600 dark:bg-indigo-400` insertion line at the snapped position, with the tooltip `Import here · 5.1.1`.

**Refused while hovering.** This covers overlap, the 128-measure limit, and the track limit for the zone.
- Ghost classes switch to `border-red-700 bg-red-500/10 dark:border-red-400`, a `⊘` badge in the corner where the copy ghost has `+`, and `dropEffect="none"`.
- Tooltip: `Space taken by snare`, `Past measure 128`, or `16 tracks · limit reached`.
- Text, the badge, and the cursor all carry the meaning, not just red.

**Results** go through `onAnnounce` to the page `role="status"` line:

| Outcome | Message |
|---|---|
| Placed | `Placed kick-808 on Loops at 5.1.1.` |
| Refused (sample) | `Couldn't place kick-808: the space at 5.1.1 on Loops is taken.` (or `…would make the song longer than 128 measures.`) |
| File imported but refused | `Imported kick to the library, but couldn't place it: the space at 5.1.1 on Loops is taken.` |
| File importing | While decoding, an `aria-hidden` placeholder sits at the drop point: `top-1 bottom-1 w-24 rounded-md border border-dashed border-zinc-400 bg-zinc-100 text-[11px] motion-safe:animate-pulse dark:bg-zinc-900`, with text "Importing… 40%" and a 2px progress bar along its bottom. Status: `Importing kick.wav…` |
| Multiple files on a lane | Place each file end to end from the drop point. Stop at the first file that doesn't fit, report it with the message above, and keep the rest in the library. All placements are one undo step. |

**`NewTrackDropZone`.** It renders under the last lane only while a drag is active. When there are no tracks, it replaces the "This song has no tracks yet" block for the duration of the drag.
- Layout: `grid h-20 grid-cols-[var(--gutter-w)_minmax(0,1fr)] border-2 border-dashed border-zinc-300 dark:border-zinc-700`.
- Gutter: the `audio` icon and "New audio track" (`text-sm font-medium`).
- Lane area: the same `--cell-w` container, so ghosts line up with the ruler.
- Hovered: `border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/40`.
- At 16 tracks: `border-zinc-300 opacity-60`, the text "16 tracks · limit reached", and `dropEffect="none"`.
- Mark it `aria-hidden`. The keyboard path is Add Track → Audio, then Enter on a sample.

**Auto-scroll.** While hovering within 32px of the arrangement's top or bottom edge, scroll it the way `useTrackDrag` does, so the zone is reachable in long songs.

## 5. Empty audio lane, Add Track, and track options

- **Empty-lane hint** (in `AudioClipLane`, using the same span classes as the MIDI hint, `pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-zinc-600 dark:text-zinc-400`):
  - Text: `Drop audio here or drag from Samples` followed by `<span class="max-sm:hidden"> · double-click to import</span>`.
  - While this lane is the hovered drop target, the hint is hidden so it doesn't collide with the ghost.
- **Add Track** (`AddTrackMenu.tsx`):
  - Add a first group `role="group" aria-label="Audio"` with heading "Audio" and an item `<InstrumentIcon instrumentId="audio" …/> Audio`, then a separator.
  - It renders above the loading and error states, because it doesn't need the instruments request.
  - The prop is `onAddAudio: () => void`.
  - The new track is selected, and focus moves to its select button (existing add-track behaviour).
- **Track options menu** (`TrackHeader.tsx`) for audio tracks:
  - Order: `Sound…`, `Import audio…`, separator, `Rename track…`, `Move track up`/`down`, `Delete track`.
  - Omit `LaneMenuItems` (loop/clip creation) and `Generate part with AI…`.
  - `Import audio…` opens a single-file picker (no `multiple`). It imports the file, then places it on this track at the playhead, as one undo step. Refusals use the §4 messages, and the sample stays in the library.
  - The menu closes before the picker opens, and focus returns to the options trigger afterwards.
- **Lane right-click menu** on empty audio-lane space: a single item, `Import audio here…`. It places the file at the snapped measure position of the click.

## 6. Accessibility checklist for implementers

- Every icon-only control (preview, `⋯`, close, Samples at `max-sm`) has an `aria-label`. Toggles use `aria-pressed`, `aria-checked`, or `aria-expanded`.
- No state is shown by colour alone:
  - looping is shown by the glyph and the label;
  - missing audio by the text, dashes, and hatch;
  - refused drops by the text, badge, and cursor;
  - previewing by the glyph and `aria-pressed`;
  - the selected tab by weight and `aria-selected`.
- All animation is `motion-safe:`, and drags and ghosts never animate.
- Waveform fills use palette `-700`/`-300` strokes on `/15` fills, the same contrast already checked for MIDI notes. The red states use `red-700`/`red-400` (≥ 4.5:1 for text on white or zinc-950).
- Every drag gesture has a keyboard path:
  - move and trim: arrows;
  - gain: ↑/↓ or the dock knob;
  - fades and loop: the dock;
  - placement: Enter in Samples;
  - new track from a sample: Add Track → Audio, then Enter.
- Narrow screens have no horizontal scroll. Dock controls `flex-wrap`, and Samples rows truncate names.

## 7. Files

**New**
- `frontend/src/lib/song/audioTime.ts`
- `frontend/src/lib/audio/waveformPath.ts`
- `frontend/src/components/ui/Switch.tsx` (extracted from `TrackSoundPanel`)
- `frontend/src/components/studio/RightRail.tsx`
- `frontend/src/components/studio/audio/`: `AudioClipLane.tsx`, `AudioClipBlock.tsx`, `Waveform.tsx`, `LoopGlyph.tsx`, `AudioClipMenu.tsx`, `AudioClipPanel.tsx`, `ReplaceSampleDialog.tsx`
- `frontend/src/components/studio/samples/`: `SamplesPanel.tsx`, `SampleList.tsx`, `SampleRow.tsx`, `RemoveSampleDialog.tsx`, `ImportProgress.tsx`, `NewTrackDropZone.tsx`, `useSampleDrop.ts`

**Modified**
- `AddTrackMenu.tsx`
- `InstrumentIcon.tsx`
- `TrackHeader.tsx`
- `TrackLane.tsx`
- `Arrangement.tsx`: drag state, guard, zone, help text, audio lookup
- `EditorDock.tsx`: audio branch
- `TrackSoundPanel.tsx`: hide Tone and use `Switch`
- `SongHeader.tsx`: Samples button
- `StudioPage.tsx`: `RightRail`, the Samples sheet, and the `onAnnounce` wiring
