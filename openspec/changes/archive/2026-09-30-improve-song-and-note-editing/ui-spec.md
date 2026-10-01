# UI spec: improve-song-and-note-editing

Task 3.1. This covers the visual and interaction details that `design.md` leaves open. Paths are under `frontend/src/`. Everything here reuses existing tokens:
- `inputClass`, `labelClass`, `hintClass`, and `focusRing` from `components/ui/classes.ts`;
- `Select`, `Button`, and `ModalDialog`;
- the zinc neutrals, indigo for notes, amber for the playhead, and zinc-800/200 for the loop region.

One new hue is introduced: **emerald**, used only for key highlighting. Amber would collide with the playhead, and indigo with notes and cell hover, so the key needs its own hue.

---

## 1. SongHeader: time signature and key

### Layout

The order is: name, library, Tempo, Swing, **Time signature**, **Key**, then the undo group. `LengthField` and `TimeSignaturePill` are deleted. The header stays `flex flex-wrap gap-x-6 gap-y-3`, so the new controls wrap like the others and there is no horizontal scroll at 320px.

```
Songbird › My song ✎   [Songs ▾]   Tempo [120] BPM   Swing ──o── 12%   Time signature [4/4 ▾]   Key [C ▾][Major ▾]   | ↶ Undo ↷ Redo  Saved
```

### Time signature

Use the same markup pattern as `TempoField`, with the label inline to the left of the control.

```tsx
<div className="flex items-center gap-2">
  <label htmlFor={id} className={labelClass}>Time signature</label>
  <Select id={id} value={song.time_signature} className="w-20 font-mono tabular-nums">
    <option value="4/4">4/4</option><option value="3/4">3/4</option><option value="6/8">6/8</option>
  </Select>
</div>
```

- The `<select>` stays controlled by `song.time_signature`. On change:
  - If `countTimeSignatureLosses(song, ts) === 0`, apply it right away.
  - Otherwise open the confirmation dialog with `pending = ts`. The select keeps showing the old value until the user confirms.
- After it applies, call `onAnnounce`:
  - `Time signature changed to 3/4.`
  - `Time signature changed to 3/4. 3 notes removed.`

### Key

The key is one labelled group containing two selects.

```tsx
<div role="group" aria-labelledby={keyLabelId} className="flex items-center gap-2">
  <span id={keyLabelId} className={labelClass}>Key</span>
  <div className="flex items-center gap-1.5">
    <Select aria-label="Key tonic" className="w-24" value={tonic}>…12 options…</Select>
    <Select aria-label="Key mode" className="w-24" value={mode}>
      <option value="major">Major</option><option value="minor">Minor</option>
    </Select>
  </div>
</div>
```

- **Tonic option text:** list sharp pitch classes with their enharmonic flat, so flat-key writers find their key: `C`, `C♯/D♭`, `D`, `D♯/E♭`, `E`, `F`, `F♯/G♭`, `G`, `G♯/A♭`, `A`, `A♯/B♭`, `B`. Option `value`s stay the spec's `C#`, `D#`, and so on.
- **Mode:** the `Minor` option has `title="Natural minor"`.
- **Commit:** each select commits on change through `setKey`, which is one undo step. No announcement is needed, because the native select already reports its value.

### Lossy time-signature confirmation

This uses `ModalDialog` with `role="alertdialog"`, and mirrors the "Delete song" dialog in `SongLibraryMenu.tsx:184`.
- Accessible label: `Change to {new}?`
- Losses only happen when going from 16 to 12 steps, so the lost notes are always in the last quarter note of a measure.

| Part | Copy (N = count) |
|---|---|
| Heading `h2.text-lg.font-semibold` | `Change to 3/4 and remove {N} note(s)?` |
| Body `p.text-sm.text-zinc-600.dark:text-zinc-400` | `A 3/4 measure is shorter than a 4/4 measure. {N} note(s) in the last quarter note of a measure won't fit and will be removed. Every other note keeps its place in its measure. You can undo this.` |
| Cancel (`Button`, `autoFocus`) | `Cancel` |
| Confirm (the red style from Delete song) | `Change to 3/4` |

- **Plurals:** use "1 note" and "N notes".
- **Focus:** it starts on Cancel, because this is a destructive action.
- **On close:** both Escape and Cancel leave the song unchanged. Focus returns to the time signature select, because `<dialog>` restores it natively, and the select still shows the old value.

---

## 2. Key highlighting

This applies only in the Studio dock, and only for `kind === "melodic"`. `PianoRoll` receives `keyHighlight` and passes a per-row tint, `"none" | "scale" | "tonic"`, to `RowLabels` and to `MeasureColumn`. The `MeasureColumn` memo comparator must include it.

### Row backgrounds (`MeasureColumn` `cellClass`)

- A tint **replaces** the background classes. The border classes and the beat and measure lines are unchanged.
- The odd/even beat alternation is kept inside tinted rows, so beat grouping still reads.
- Out-of-key rows keep today's classes: white keys are unshaded and black keys use the zinc shading.
- An in-key black-key row (for example F♯ in G major) takes the tint instead of the black-key shade. The keyboard gutter still shows which keys are black.

| Tint | Even beat | Odd beat |
|---|---|---|
| none | today's classes | today's classes |
| scale | `bg-emerald-50 dark:bg-emerald-950/50` | `bg-emerald-100/60 dark:bg-emerald-900/35` |
| tonic | `bg-emerald-100 dark:bg-emerald-900/55` | `bg-emerald-200/60 dark:bg-emerald-900/70` |

- **Contrast checks:**
  - The indigo-600 note border against the strongest light tint (emerald-200/60 over white) is about 6.5:1.
  - The indigo-400 border against the strongest dark tint is about 4.2:1.
  - Both pass the 3:1 non-text minimum, and low-velocity notes stay findable by their border.
  - These tints are no darker than today's black-key shading, so the zinc-300/700 beat lines and the zinc-500 measure lines stay as distinct as they are now.
- **Hover:** the empty-cell hover (`hover:bg-indigo-600/10`) stays as it is, and it overrides the tint on hover.

### Row labels: a key lane in the gutter

- **Why a separate lane:** the keyboard's white keys span fractional rows (`whiteKeyBox`), so they can't carry a per-row tint.
- **Where it goes:** in the Studio's `gutterClassName` branch of `RowLabels`, the wrapper is `flex justify-end` and leaves unused width. Render a row-aligned lane immediately left of `<Keyboard>`:

```
┌── gutter (var(--gutter-w)) ─────────────┬──┬────────┐
│                                         │  │ ▭ key  │  out of key
│                                         │▓▓│ ▭ key  │  in key (scale tint)
│                                         │A │ ▭ key  │  tonic: strong tint + letter
└─────────────────────────────────────────┴──┴────────┘
```

- **The lane:** `aria-hidden="true" className="w-5 shrink-0 border-r border-zinc-200 dark:border-zinc-800"`, with one `div` per row at `style={{height:"var(--row-h)"}}`.
  - **Scale row:** `bg-emerald-100 dark:bg-emerald-900/50`
  - **Tonic row:**
    - classes: `flex items-center justify-center bg-emerald-300 text-[10px] leading-none font-bold text-emerald-950 dark:bg-emerald-700 dark:text-emerald-50`;
    - it contains the tonic's letter, such as `C`, `A`, or `F♯`. The letter is the non-colour marker. Its text contrast is about 10:1 in light mode and 5.6:1 in dark mode.
  - **Other rows:** no background.
- **Screen readers:** the keyboard key buttons get `aria-description`. Their accessible names stay the plain row names, so existing queries keep working.
  - Tonic keys: `Tonic of A minor`.
  - Other in-key keys: `In A minor`.
  - Out-of-key keys: none.
- **Where it is off:** with `keyHighlight` absent (drum tracks and the pattern pages), no lane renders and the gutter is unchanged.

---

## 3. Past-the-end timeline (`Arrangement`, `ClipLane`)

- **The timeline:** the ruler, the lanes, and `labelEveryFor` all use `timelineMeasures(song)` in place of `song.measures`.
- **The past-end region:** the measures after `song.measures` get a shade with a hatch, plus a dashed end line. That gives three cues: fill, pattern, and line.

```tsx
// Shared by the ruler (as the first MeasureRuler child, so LoopRegion stays above it)
// and by each ClipLane (as its first child, so clips and the empty-lane hint paint above it).
<div aria-hidden="true" data-testid="past-end"
  className="pointer-events-none absolute inset-y-0 right-0 border-l-2 border-dashed border-zinc-500
             bg-zinc-100/70 bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(0_0_0/0.05)_6px_7px)]
             dark:bg-zinc-900/60 dark:bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(255_255_255/0.05)_6px_7px)]"
  style={{ left: `calc(var(--cell-w) * ${song.measures * spm})` }} />
```

- **Styling notes:**
  - A dashed zinc-500 line is not confused with the playhead (solid amber) or with the loop-region edges (solid zinc-800/200).
  - The line's contrast is 4.8:1 on white and about 4:1 on zinc-950.
  - Ruler bar numbers past the end use `text-zinc-500 dark:text-zinc-500`, down from zinc-700/300. That is still at least 4.5:1, so they read as secondary but stay legible.
- **When it is hidden:** do not render the region when `song.measures === timelineMeasures(song)`, which happens at the 128 cap.
- **Interaction:** the region stays fully interactive. `pointer-events-none` keeps the lane's `e.target === e.currentTarget` checks working, so double-clicking in it still creates a clip.
- **Screen readers:** add `<p className="sr-only">Song length: {n} measure(s). Add clips after the end to lengthen it.</p>` next to `CLIP_KEYS_HELP` in `Arrangement`. It is not live.
- **During a drag:** the song end follows transient clip moves and resizes live, so the shade retreats as a clip is dragged into it. No extra state is needed.

---

## 4. Piano roll selection

### Note bar (`NoteBar`)

| State | Classes |
|---|---|
| Unselected (today) | `border border-indigo-600 dark:border-indigo-400` and `hover:ring-2 hover:ring-indigo-600/40` |
| Selected | `data-selected="true"`, `border-2 border-zinc-950 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.9)] dark:border-white dark:shadow-[inset_0_0_0_1px_rgb(9_9_11/0.9)]`, with no hover ring |
| Dragging (move) | `z-20 cursor-grabbing shadow-md` on every moving note |

- **The selected note:**
  - The velocity fill (`opacity 0.2 + 0.8·v/127`) is unchanged, so velocity stays readable while a note is selected.
  - Its cues do not rely on colour: a doubled line (a dark 2px border with a light 1px inner line), a thicker border than unselected notes, and a luminance shift.
- **Cursors:**
  - The body cursor changes from `cursor-pointer` to `cursor-grab`, which matches `ClipLane` now that notes move in 2-D.
  - The resize handle keeps `cursor-ew-resize`.
- **Keyboard focus** stays on the cells, as today: a 2px black or white *inset* outline on one cell, drawn at `z-20` above the note. It stays distinct from selection because:
  - it is one cell in size, while selection outlines the whole note;
  - it is a single line, while selection is doubled;
  - it sits inset (`-outline-offset-2`), while the selection border sits on the note's edge.
- **Drag tooltip:** the existing chip shows the dragged note's target as `{row} · {bar}.{beat}.{sixteenth}`, for example `D4 · 2.1.3`, where `beat = floor(local / beatSteps) + 1` and `sixteenth = local % beatSteps + 1`. Velocity and resize chips are unchanged.

### Marquee

- **The overlay:** `aria-hidden="true" data-testid="marquee" className="pointer-events-none absolute z-20 rounded-[2px] border border-indigo-600 bg-indigo-600/10 dark:border-indigo-400 dark:bg-indigo-400/15"`.
- **Position:** it is placed in the coordinates of the `relative flex` measure container, which scroll with the grid. It follows the pointer unsnapped; hit-testing is done in step and row units.
- **Stacking:** it sits above notes (z-10). The sticky row labels (z-30) and the ruler cover it when it is scrolled under them.
- **When it shows:** only after the 4px threshold. On `pointer-coarse`, a drag on empty grid pans the scroller (cells are `touch-manipulation`), so touch users select by tapping. A touch multi-select mode is a known gap and out of scope.

### Accessible names

- **Notes:** notes stay `aria-hidden`. The note's head cell carries its identity.
  - **Head cell of a selected note:** `aria-label = "{cellLabel}, selected"`, for example `C4, measure 1, step 5, selected`. It keeps `aria-pressed="true"`, and `aria-description` stays `Note, velocity 100, 4 steps`.
  - **Held cells of a selected note:** `aria-description = "Held from step 1, selected"`.
- **Keyboard on a covered cell:** Enter and Space select that note alone, and Shift+Enter toggles it in the selection. This matches mouse clicks, now that a click no longer removes a note. Delete and Backspace remove the selection, or remove the focused note when nothing is selected.
- **Announcements** go to `PianoRoll`'s existing polite region:

| Event | Copy |
|---|---|
| Box select, Cmd/Ctrl+A, and click-extend | `{n} note(s) selected` |
| Escape | `Selection cleared` |
| Delete | `Removed {n} note(s)` |
| Alt+Arrow | `Moved to {row}, measure {m}, step {s}` (the dragged note, or the first selected note) |
| Copy / Cut | `Copied {n} note(s)` / `Cut {n} note(s)` |
| Paste | `Pasted {n} note(s)`, plus ` {k} didn't fit and were left out.` when k > 0. Send this to the page `role="status"` region too, per D7. |

### Tooltip and help text

- **The `title` on `NoteBar`** uses literal newlines, which render as line breaks:

```
{row} · velocity {v} · {len} step(s)
Drag to move · Shift-drag for velocity
Double-click or Delete to remove
```

  Tests should assert that it contains `Double-click or Delete to remove` and `Shift-drag for velocity`.
- **The sr-only help** (`PianoRoll` `helpId`) is replaced with:
  > Arrow keys move between steps. Enter adds a note, or selects the note under the cursor. Shift plus Enter adds it to the selection. Command or Control A selects all notes. Escape clears the selection. Delete removes the selected notes. Alt plus an arrow key moves them. Shift plus Up or Down changes velocity. Shift plus Left or Right changes length. Command or Control C, X, and V copy, cut, and paste. Space plays or stops.

---

## 5. NoteInspector

- **Why it always renders:** the inspector's slot is always there, so selecting a note never shifts the grid down. Its content switches between an empty hint and the controls.
- **Where it renders:** `PianoRoll` owns the selection (D5), so it renders the inspector into a host-provided slot element, through an `inspectorTarget` prop and a portal.

### Structure

```
Selected: [3 notes]   Velocity [ 90 ] ──────o────   Length [ Mixed ] steps
Empty:    No notes selected. Click a note, or drag across the grid to select several.
```

```tsx
<div role="group" aria-label="Selected notes" className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-2">
  <p className="text-sm font-medium tabular-nums">{n} {n === 1 ? "note" : "notes"} selected</p>
  <div className="flex items-center gap-2">
    <label htmlFor={velId} className={labelClass}>Velocity</label>
    <input id={velId} type="number" min={1} max={127} inputMode="numeric"
      className={`${inputClass} ${h} w-20 font-mono tabular-nums placeholder:text-zinc-500 dark:placeholder:text-zinc-400`}
      placeholder={mixed ? "Mixed" : undefined} aria-describedby={mixed ? velMixedId : undefined} />
    <input type="range" min={1} max={127} aria-label="Velocity slider"
      className={`w-28 accent-indigo-600 max-sm:hidden ${focusRing}`} />
  </div>
  <div className="flex items-center gap-2">
    <label htmlFor={lenId} className={labelClass}>Length<span className="sr-only"> in steps</span></label>
    <input id={lenId} type="number" min={1} readOnly={oneShot}
      className={`${inputClass} ${h} w-20 font-mono tabular-nums read-only:bg-zinc-100 read-only:text-zinc-600 dark:read-only:bg-zinc-900 dark:read-only:text-zinc-400`} />
    <span aria-hidden="true" className="text-sm text-zinc-600 dark:text-zinc-400">steps</span>
  </div>
</div>
```

- **Sizes:** `h` is `h-10` on pattern pages, which is `inputClass`'s default and matches the toolbar, and `!h-8` in the dock, which matches its `h-8` loop-name controls.
- **Mixed values:**
  - The number input's value is `""` and its placeholder is `Mixed`.
  - A hidden `<span id={velMixedId} className="sr-only">Selected notes have different velocities</span>` describes it, and the same pattern applies to length.
  - The slider sits at the rounded mean, with `aria-valuetext="Mixed"` until it is moved.
- **Committing:**
  - The number inputs follow `TempoField`: they commit on Enter or blur, Escape reverts, and out-of-range drafts set `aria-invalid` and don't commit.
  - The slider follows `SwingSlider`: it previews through a draft ref and commits on pointer-up, key-up, or blur.
  - Every commit is one undo step, and none plays sound.
- **One-shot instruments:**
  - The length input is `readOnly`, with `title` and `aria-describedby` both set to `One-shot sounds always play in full.`
  - It still shows the value, or `Mixed`.
- **Empty state:** the whole group shows only `<p className={hintClass}>` with the empty copy above. In the dock, the copy is shortened to `No notes selected`.
- **Focus:** editing does not move focus. Keys typed in the inspector never reach the grid, because it sits outside the grid's `onKeyDown`.

### Placement

- **Pattern pages:** a dedicated row directly under `EditorToolbar`, inside the Editor card, above `ResizablePianoRoll`. It sits there rather than inside the toolbar because the toolbar already wraps at most widths, and a fixed `min-h-10` row keeps the grid still.
  - Tab order: the toolbar, then the inspector, then the grid.
- **Studio dock:** in the Loop toolbar, in the slot the loop `LengthField` vacated, after the loop name and context and before the `ml-auto` menu. The header is `flex-wrap`. Below `md`, the group takes `basis-full`, so it always owns its own line and the roll never jumps.
