# Drum Machine page: UI spec (handoff)

Covers tasks 7.1–7.4, 8.4 and 9.1. Source of truth for behaviour is still the spec deltas in `specs/`; this doc fixes layout, components, states, copy, classes and accessibility so the build is consistent.

## 1. Goal and flow

A songwriter lands on `/drum-machine`, describes a groove, picks a length, and presses Generate. The pattern shows on a 12-row drum grid. They play it (looping), tweak notes, tempo and swing, and download MIDI for their DAW.

```
first visit ─▶ empty state ─┬─ Generate ─▶ loading ─┬─ success ─▶ editing ⇄ playing ─▶ Download MIDI
                            │                        └─ error (pattern unchanged, form keeps its values)
                            └─ "Start with a blank grid" ─▶ editing
reload ─▶ restored pattern and prompt (persisted per instrument)
```

## 2. Visual language (reuse, don't invent)

The landing page (`frontend/src/app/page.tsx`) sets the vocabulary: zinc neutrals, black/white primary pill, `dark:` variants driven by `prefers-color-scheme`. Keep it. The only new hues are for music content, where colour carries meaning:

| Role | Light | Dark | Why this hue |
|---|---|---|---|
| Page bg | `bg-zinc-50` | `dark:bg-black` | matches landing |
| Surface (cards, roll bg) | `bg-white` | `dark:bg-zinc-950` | |
| Border | `border-zinc-200` | `dark:border-zinc-800` | |
| Body text | `text-zinc-900` | `dark:text-zinc-50` | |
| Secondary text | `text-zinc-600` | `dark:text-zinc-400` | matches landing tagline, ≥ 7:1 |
| Note | `indigo-600` (#4f46e5, 6.3:1 on white) | `indigo-400` (#818cf8, ~6:1 on zinc-950) | notes must be readable against the neutral grid; one hue keeps the UI calm |
| Playhead | `amber-600` line (3.2:1 on white) + `amber-500/15` column | `amber-400` line + `amber-400/15` | must never be confused with notes or gridlines |
| Error | `text-red-700 bg-red-50 border-red-200` | `dark:text-red-300 dark:bg-red-950/40 dark:border-red-900` | |

Use Tailwind palette classes directly, as the landing page does. Don't add theme tokens yet; the one exception is the two CSS variables that size the grid (see 5.1).

**Shared control classes.** Put these in one small `components/ui/` set (`Button`, `Field`, `Select`, `NumberInput`) so every control matches:

- Focus ring (all controls): `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:focus-visible:outline-white` (copied from the landing link).
- Primary button: `rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50`.
- Secondary button: `rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900 disabled:…same`.
- Input/select: `h-10 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 aria-invalid:border-red-600 dark:aria-invalid:border-red-400`.
- Label: `text-sm font-medium text-zinc-700 dark:text-zinc-300`. Hint: `text-xs text-zinc-600 dark:text-zinc-400`.
- Numbers (tempo, counter, position): `font-mono tabular-nums` so they don't jitter while changing.

Wrap transitions in `motion-safe:`. The playhead never animates between steps (see 6).

## 3. Page layout

`<main className="mx-auto flex w-full max-w-screen-2xl min-w-0 flex-1 flex-col gap-6 bg-zinc-50 px-4 py-6 sm:px-6 sm:py-8 dark:bg-black">`. Only the piano roll's own scroller scrolls horizontally. Nothing else may be wider than the viewport, so give flex children `min-w-0`.

### Desktop (≥ 1024 px)

```
Songbird ›  Drum Machine                                   (← link to "/")
Describe a groove, then shape it on the grid.
┌ PromptForm (card) ──────────────────────────────────────────────────────────────┐
│ Describe your groove                                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │ laid-back boom bap with ghost-note snares…                                 │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│ Rhythm, feel, genre, fills…                                     10 / 256 tokens │
│ Measures [ 4 ▾]   Tempo (BPM) [ Auto ]   Time signature [4/4 ▾]     [ Generate ] │
│ ┌ alert ─ The AI could not generate a pattern… Your current pattern is unchanged. [×] │
└────────────────────────────────────────────────────────────────────────────────┘
┌ Editor (card) ──────────────────────────────────────────────────────────────────┐
│ Boom bap groove · 4/4                                              status text  │
│ [▶ Play]  Loop measures [1▾] to [4▾]  ☑ Follow playhead   Bar 2 · Beat 3        │  ← Transport
│ Measures [4▾]  Tempo [ 92 ] BPM  Swing ──●──── 12%  │ ↶ Undo ↷ Redo │ Clear  New… │ ⤓ Download MIDI │  ← Toolbar
│ ┌──────────────┬──1───────────────┬──2───────────────┬──3──────── ─ ─ ▶ scroll   │
│ │ Kick         │■   │    ■ ■│    │■   │    │ ■  │    │                           │
│ │ Snare        │    │■   │  ▫ │■  │    │■   │    │■  │                           │
│ │ …12 rows     │                                                                 │
│ └──────────────┴──────────────────────────────────────────────── ─ ─             │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Cards: `rounded-2xl border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-800 dark:bg-zinc-950`.
- PromptForm controls row: `flex flex-wrap items-end gap-4`. Generate is `ml-auto`.
- Transport and toolbar are two rows inside the editor card: `flex flex-wrap items-center gap-x-6 gap-y-3`. Separate groups with `border-l border-zinc-200 pl-6 dark:border-zinc-800` (desktop only).

### Narrow (< 640 px)

```
Drum Machine
┌ PromptForm ──────────────┐
│ [ textarea, 3 rows     ] │
│ hint          10 / 256   │
│ Meas. │ Tempo │ Time     │   grid grid-cols-3 gap-3
│ [      Generate        ] │   w-full
└──────────────────────────┘
┌ Editor ──────────────────┐
│ [▶ Play ]  Loop [1]–[4]  │   transport row
│ ☑ Follow   Bar 2 · Beat 3│
│ Meas. │ Tempo │ Swing    │   grid grid-cols-3 gap-3; swing slider spans full width below on < 400 px
│ [↶][↷] Clear New… ⤓ MIDI │   flex-wrap. Undo/Redo become icon-only (aria-label kept)
│ ┌Kick   │■   │    │ ▶    │   roll scrolls inside the card
└──────────────────────────┘
```

- Row labels shrink to 80 px (`w-20`, `text-xs`, `line-clamp-2`) so at least one beat of the grid shows on a 320 px screen.
- "Download MIDI" keeps its text and is shortened to "MIDI" only below 400 px, with `aria-label="Download MIDI"`.

## 4. Components and props

Files live under `frontend/src/components/editor/` (the directory is new). `app/drum-machine/page.tsx` stays a server component: it exports `metadata` (`title: "Drum Machine · Songbird"`) and renders `<PatternEditorPage instrumentId="drums" title="Drum Machine" />`. Every other drums-specific value comes from `/api/v1/instruments`, so the editor stays generic (D3).

| Component | Props | Responsibility |
|---|---|---|
| `PatternEditorPage` (client) | `instrumentId: string; title: string` | Loads the instrument and limits. Waits for store hydration. Owns `loop`, `follow`, and a polite status message. Mounts `useEditorShortcuts`. Lays out everything. |
| `PromptForm` | `instrumentId: string; limits: GenerationLimits \| null; limitsState: 'loading' \| 'ready' \| 'error'; onRetryLimits: () => void; onGenerated: (p: Pattern, hadPrevious: boolean) => void` | Prompt comes from the store (`prompt`, `setPrompt`, which persist). Measures, tempo and time signature are local state. Calls `generatePattern` with `instrument: instrumentId`, then `setPattern`. Owns `status: 'idle' \| 'submitting'` and `error: string \| null`. |
| `TokenCounter` | `count: number; max: number \| null` | Renders `n / max`. Flags the over-limit state. |
| `ErrorAlert` | `message: string; onDismiss: () => void` | `role="alert"` box. |
| `Transport` | `playback: Playback; measures: number; loop: LoopRange; onLoopChange: (r: LoopRange) => void; follow: boolean; onFollowChange: (v: boolean) => void` | Play/Stop, loop selects, follow toggle, position readout. |
| `EditorToolbar` | `instrumentId: string; instrument: InstrumentInfo \| null` | Measures, tempo, swing, undo/redo, clear, new, download. Reads the store. |
| `TempoField` | `value: number; onCommit: (bpm: number) => void` | Holds a local draft and commits on blur or Enter (see 7). |
| `SwingSlider` | `value: number /* 0–0.75 */; onCommit: (swing: number) => void` | Previews locally and commits on release. |
| `NewPatternDialog` | `instrument: InstrumentInfo \| null; defaultMeasures: MeasureCount; defaultTimeSignature: TimeSignature; onCreate: (m, ts) => void` | `<dialog>` with Measures and Time signature. |
| `DownloadMidiButton` | `pattern: Pattern` | Calls `exportMidi` and saves the blob. Idle, busy and error states. |
| `PianoRoll` | `instrumentId: string; pattern: Pattern; loop: LoopRange; follow: boolean; onManualScroll: () => void; subscribePosition: Playback['subscribePosition']; isPlaying: boolean` | Scroller, CSS vars, roving focus, measure split. |
| `MeasureRuler` | `measures: number; stepsPerMeasure: number; beatSteps: number; loop: LoopRange` | Sticky top header with measure numbers, beat ticks and the loop bracket. |
| `RowLabels` | `rows: Row[]` | Sticky left column. |
| `MeasureColumn` (`memo`) | `instrumentId: string; measureIndex: number; rows: Row[]; stepsPerMeasure: number; beatSteps: number; notes: Note[] /* notes starting in this measure */; carryIn: Note[] /* earlier notes covering steps here */; maxLengthByNote: Map<Note, number>; activeCell: { row: number; step: number } \| null` | Draws the cells and the NoteBars for notes that start in this measure. |
| `NoteBar` (`memo`) | `note: Note; rowIndex: number; measureStartStep: number; maxLength: number; onRemove: () => void; onCommitVelocity: (v: number) => void; onCommitLength: (len: number) => void` | Pointer interactions. Keeps the drag preview in local state. |
| `Playhead` | `subscribePosition; stepsPerMeasure: number; visible: boolean` | Positioned imperatively (no React state per frame). |
| `LoopShade` | `loop: LoopRange; measures: number` | Dims measures outside the loop. |

**Contract with the audio engine (8.3).** The engine isn't built yet, so fix this seam now:

```ts
interface Playback {
  isPlaying: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';  // 'loading' = Tone.start + kit fetch on first Play
  error: string | null;
  toggle(): void;
  stop(): void;
  // Per-frame step position must not go through React state, or all 32 measures would re-render at 60 fps.
  subscribePosition(cb: (absoluteStep: number | null) => void): () => void;
}
type LoopRange = { start: number; end: number };  // 1-based inclusive measures; whole pattern = {1, measures}
```

`usePlayback(instrumentId, loop)` returns a `Playback`.

**Helpers in `lib/`** (export them so tests don't duplicate the logic):

- `cellLabel(rowName, absStep, stepsPerMeasure)`
- `beatSteps(timeSignature)`: 4 for 4/4 and 3/4, 6 for 6/8
- `isTextEntryTarget(el)`
- `VELOCITY_PRESETS = [127, 100, 70, 40]`
- `CELL_W_PX = 28`

**Performance rules (D4):**

- **Stable per-measure note arrays.** Derive `notesByMeasure` and `carryIn` with structural sharing: reuse the previous array for any measure whose notes didn't change. Otherwise `memo` never hits and every edit re-renders all measures.
- **Stable handlers.** Build handlers inside `MeasureColumn` from `getPatternStore(id).getState()` so they don't depend on changing props.
- **Roving focus.** Pass `activeCell` only to the measure that holds it (`null` to all others). Moving focus then re-renders at most two measures.
- **No stacking context on `MeasureColumn`.** Don't give it a `z-index`, `transform`, `opacity < 1`, `contain: paint` or `content-visibility`. A note that crosses a barline is drawn by its starting measure with `overflow: visible` and must paint over the next measure.

## 5. Piano roll

### 5.1 Geometry

Set CSS variables on the `PianoRoll` root. Bars are positioned with `calc()` against these variables, so one responsive change moves cells and bars together.

| Var | Default | Coarse pointer (`pointer-coarse:`) | Why |
|---|---|---|---|
| `--cell-w` | 28 px | 28 px | Keeps a measure at 448 px, so two measures fit on a laptop at a readable density. Above the WCAG 2.2 24 px minimum target. |
| `--row-h` | 32 px | 40 px | Taller rows on touch without making long patterns wider. |
| label width | 112 px (`w-28`) | 80 px below `sm` | |
| ruler height | 28 px (`h-7`) | | |

Drag math uses `CELL_W_PX` (28), not `getBoundingClientRect`. That keeps it deterministic in jsdom, where rects are all zero.

**Structure**

```
div.scroller   relative overflow-auto max-h-[70vh] overscroll-x-contain scroll-pl-28 max-sm:scroll-pl-20
               rounded-xl border border-zinc-200 dark:border-zinc-800
  div.content  relative grid grid-cols-[auto_1fr] w-max
    corner      sticky top-0 left-0 z-40 bg-white dark:bg-zinc-950 border-b border-r
    MeasureRuler sticky top-0 z-30
    RowLabels    sticky left-0 z-30
    div.measures flex            (one MeasureColumn per measure)
    Playhead / LoopShade         absolute overlays, pointer-events-none
```

- `scroll-pl-*` stops keyboard-focused cells from scrolling under the sticky label column.
- `max-h-[70vh]` with a sticky ruler is there for future instruments with many rows. Drums (12 rows) never reach it.

**MeasureColumn:** `relative grid` with `grid-template-columns: repeat(stepsPerMeasure, var(--cell-w))` and `grid-template-rows: repeat(rows, var(--row-h))`.

**NoteBar position:**
```
left:   calc((step - measureStartStep) * var(--cell-w) + 2px)
top:    calc(rowIndex * var(--row-h) + 4px)
width:  calc(length * var(--cell-w) - 4px)
height: calc(var(--row-h) - 8px)
```
The 2 px inset and 4 px vertical gap keep adjacent notes on a row visibly separate. Without them, two 1-step notes would read as one 2-step note.

### 5.2 Gridlines and shading

Beats and measures are told apart by line weight and by shading, not by colour alone. Each `StepCell` gets the classes for its position:

| Position | Classes |
|---|---|
| every cell | `border-r border-b border-zinc-200 dark:border-zinc-800` |
| last step of a beat | `border-r-zinc-300 dark:border-r-zinc-700` |
| last step of a measure | `border-r-2 border-r-zinc-500 dark:border-r-zinc-500` |
| cells in odd beats (2nd, 4th) | `bg-zinc-50 dark:bg-zinc-900/50`; even beats `bg-white dark:bg-zinc-950` |

For 6/8, `beatSteps` is 6 (two dotted-quarter beats). That groups the grid the way a 6/8 player counts it.

**Ruler:** each measure number sits at the measure start, `text-xs font-semibold text-zinc-700 dark:text-zinc-300`. Beat starts get 6 px ticks (`bg-zinc-400`). The loop range shows as `bg-zinc-200 dark:bg-zinc-800` with 2 px end caps, but only when the range isn't the whole pattern.

**RowLabels:** `flex items-center px-3 text-sm font-medium text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-950 border-r border-zinc-300 dark:border-zinc-700 border-b`, height `var(--row-h)`, `truncate` with `title={row.name}`. Instrument order comes from `pattern.rows`.

### 5.3 Cells (empty-cell adding and keyboard model)

Each step is a `<button type="button">`. Buttons are always rendered, even under a note. The cell is the keyboard and assistive-tech model, and the NoteBar is its pointer skin.

- Name: `aria-label={cellLabel(...)}`. See 8.2.
- `aria-pressed={covered}`, where covered means some note covers this step.
- `tabIndex={isActive ? 0 : -1}` (roving).
- Click: `toggleNote(row.id, absStep)` adds a note (length 1, velocity 100) or removes the covering note. A click on a covered cell under a bar never reaches the cell, because the bar handles it. The handler is still correct, so `user.click(cell)` in RTL removes the note as the spec requires.
- Hover (empty cells only; covered cells sit under the bar): `hover:bg-indigo-600/10 dark:hover:bg-indigo-400/15` as a ghost note. Cursor is `cursor-pointer`.
- Focus: `focus-visible:relative focus-visible:z-20 focus-visible:bg-transparent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-black dark:focus-visible:outline-white`. The inset outline stays inside the 28 px cell, and raising z with a transparent background puts the ring above a note bar without hiding the bar.
- Touch: `touch-action: manipulation`.

### 5.4 NoteBar

The NoteBar is an `aria-hidden` div. Its keyboard equivalents live on the cells (8.3).

Attributes for tests: `data-testid="note"`, `data-row={row_id}`, `data-step`, `data-length` (preview value during a drag), `data-velocity`.

**Visual:**
- Base: `absolute z-10 rounded-[4px] border border-indigo-600 dark:border-indigo-400 touch-none select-none cursor-pointer`.
- Fill: a child `absolute inset-0 bg-indigo-600 dark:bg-indigo-400` with `opacity: 0.2 + 0.8 * (velocity / 127)`.
- Why the full-strength border: it keeps even velocity 1 at ≥ 3:1 against the grid, so quiet notes stay visible while the fill still carries loudness.
- `title={`Velocity ${v}`}` for mouse users.
- Hover: `hover:ring-2 hover:ring-indigo-600/40`. While dragging, show the ring plus a velocity tooltip.
- Active (pressed, before a drag threshold): `active:brightness-95`.

**Pointer behaviour** (pointer capture on `pointerdown`):

| Gesture | Result | Commit |
|---|---|---|
| Down then up with less than 4 px movement, no Alt | remove the note | `toggleNote(row, note.step)` |
| Alt/Option + click | cycle velocity preset: next lower value in `[127, 100, 70, 40]`, wrapping to 127 (100 → 70 → 40 → 127) | `setVelocity(row, note.step, v)` once |
| Vertical drag (≥ 4 px, mostly vertical) | `v = clamp(startV - round(dy), 1, 127)`. Up is louder, 1 px = 1 velocity, Shift makes it 0.25 per px. Preview via local state. Cursor becomes `cursor-ns-resize` on `document.body` for the duration. | `setVelocity` **once** on `pointerup`, only if changed |
| Escape during drag | revert the preview | nothing |

`setVelocity` pushes an undo step on every call, just like `resizeNote`. That's why both drags preview locally and commit once.

**Velocity tooltip (while dragging):**
- Position: `absolute -top-7 left-0 rounded bg-zinc-900 px-1.5 py-0.5 text-xs font-mono text-white dark:bg-zinc-100 dark:text-zinc-900`.
- Text: "Vel 72".

### 5.5 Resize handle

The handle is a child of NoteBar: `data-testid="note-resize"`, `aria-hidden`.

**Hit area:**
- Width 10 px at the bar's right edge: `absolute inset-y-0 -right-1 w-2.5` (6 px inside the bar, 4 px beyond it). The 4 px outside matters on a 1-step note: the bar is 24 px wide, and taking the handle wholly out of it would leave too little body to click.
- Coarse pointer: `pointer-coarse:w-4 pointer-coarse:-right-2`.
- `cursor-ew-resize touch-none z-10`.

**Visual:** on bar hover or during a resize, show a 2 px × 12 px grip centred in the handle (`bg-white/90 dark:bg-zinc-950/90 rounded-full`). Hide it otherwise so a dense grid stays clean.

**Drag:** `stopPropagation` on `pointerdown` so the body's remove and velocity logic never runs.
```
len = clamp(startLen + Math.round(dx / CELL_W_PX), 1, maxLength)
maxLength = min(nextNoteStartOnRow, totalSteps) - note.step   // computed by PianoRoll from the pattern
```
- The bar and `data-length` update live. Show an "N steps" tooltip, styled like the velocity tooltip.
- On `pointerup`, if the length changed, call `resizeNote(row.id, note.step, len)` once.
- Escape cancels.

Test mapping: `pointerDown(clientX: 0)`, then `pointerMove(clientX: 84)` (3 cells), then `pointerUp` gives length 4. With a note at step 4, dragging to +6 cells clamps to 4.

### 5.6 Playhead and auto-scroll (8.4)

**Playhead:**
- One element in `.content`: `absolute top-0 bottom-0 z-[15] pointer-events-none w-[var(--cell-w)] bg-amber-500/15 border-l-2 border-amber-600 dark:bg-amber-400/15 dark:border-amber-400`, `aria-hidden`.
- Its x is `labelWidth + step * cellW`. Set it through `style.transform = translateX(...)` in the `subscribePosition` callback, and only when the step changes.
- Hidden when stopped. With no transition, it jumps discretely step to step, which reads as a step sequencer and needs no reduced-motion variant.

**Auto-scroll (when `follow` is on):**
- Trigger: the playhead leaves the visible grid region `[scrollLeft + labelW, scrollLeft + clientWidth - 4 * cellW]`, including on loop wrap back to an earlier measure.
- Scroll to `scrollLeft = x - labelW - cellW`. This is page-flip scrolling, not continuous: continuous scrolling is harder to read and costlier.
- `behavior`: `'smooth'`, or `'auto'` (instant) when `prefers-reduced-motion: reduce`.

**Manual scroll:**
- A manual horizontal scroll during playback turns `follow` off. Detect it from `wheel`, `touchstart` or `pointerdown` on the scrollbar, or a scroll key, never from the `scroll` event, which programmatic scrolls also fire.
- The Follow checkbox shows the change. Pressing Play turns follow back on.

`LoopShade` covers measures outside a non-whole loop range with `bg-zinc-50/60 dark:bg-black/50 pointer-events-none`. The ruler bracket (5.2) gives the same information without relying on colour.

## 6. Prompt form (7.1)

| Field | Control | Copy | Rules |
|---|---|---|---|
| Description | `<textarea rows={3}>`, full width | Label "Describe your groove". Placeholder "e.g. laid-back boom bap with ghost-note snares and an open hat on the 'and' of 4". Hint "Rhythm, feel, genre, fills…" | Value from store `prompt`. `aria-describedby` = hint and counter ids. `aria-invalid` when over the limit. |
| Counter | `<p id="prompt-token-count" className="text-xs font-mono tabular-nums">` with `<span>{n} / {max}</span> tokens` | "10 / 256 tokens". Keep `n / max` in its own span so `getByText("10 / 256")` matches exactly. | `n = estimateTokens(prompt)`. Before limits load: `n / …`. Over the limit: `text-red-700 dark:text-red-400 font-semibold`, followed by the text "Too long. Shorten your description." so the state isn't shown by colour alone. |
| Measures | `<select>` | Label "Measures". Options are the numbers only ("4", "8", …) from `limits.measure_options`. | Default 4. Disabled while limits load. |
| Tempo | `<input type="number" inputMode="numeric" min=40 max=240>` | Label "Tempo (BPM)". Placeholder "Auto". Hint "Leave blank to let the AI choose." | Blank means the field is omitted from the request. Out of range sets `aria-invalid` and shows "Tempo must be 40–240 BPM." |
| Time signature | `<select>` | Label "Time signature". Options 4/4, 3/4, 6/8. | Default 4/4. |
| Generate | primary button | "Generate", or "Generating…" with a spinner while busy | Disabled when the prompt is blank or whitespace, over the limit, limits aren't loaded, tempo is invalid, or a request is in flight. |

**Other states:**

- **Loading.**
  - Form gets `aria-busy="true"`.
  - Spinner: `size-4 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin`. Under reduced motion it stays a static ring, and the label text still says "Generating…".
  - The piano roll stays visible and editable, with no overlay. On success, the new pattern replaces it through `setPattern`, which is undoable.
- **Success.** A polite status in the editor header reads: `Generated "<name>".`. If a previous pattern existed, append " Undo to get your previous pattern back."
- **Error.**
  - `ErrorAlert` appears below the controls row: `role="alert"`, error classes from section 2, `rounded-lg px-4 py-3 text-sm`.
  - Text: `{ApiError.message}`, followed by " Your current pattern is unchanged."
  - Dismiss button: `aria-label="Dismiss error"`.
  - The error clears on the next submit. Form values and the displayed pattern are untouched.
- **Limits failed to load.** The same alert style shows "Couldn't load generation settings." with a secondary "Retry" button. Generate stays disabled. Editing, playback and export still work, because the kit is bundled and works offline.

## 7. Editor toolbar (7.3, 9.1) and transport (8.4)

### Toolbar

Wrap it in `role="toolbar" aria-label="Pattern"` with its own roving arrow-key focus. Plain tab order is acceptable if roving focus proves fiddly.

**Commit rules.** Every store setter pushes an undo step, so:

- **Tempo:** a `NumberInput` (`w-20`) with the suffix "BPM". It commits on blur or Enter, only when valid and changed. Escape reverts. Typing "120" must not create three undo steps.
- **Swing:** `<input type="range" min=0 max=75 step=1>` (`w-32`, `accent-indigo-600`), with the value shown as "12%".
  - Preview locally; commit `setSwing(v / 100)` on `pointerup`, `keyup`, or blur.
  - `aria-valuetext="12 percent"`.
- **Measures:** a select with 4/8/12/16/32. Commits immediately; one change is one undo step.

**Buttons and states:**

| Control | Copy / name | State |
|---|---|---|
| Undo | "Undo" (icon ↶ plus text; icon-only below `sm` with `aria-label="Undo"`), `title="Undo (⌘Z / Ctrl+Z)"`, `aria-keyshortcuts="Meta+Z Control+Z"` | Disabled when `past.length === 0` |
| Redo | "Redo", `aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z"` | Disabled when `future` is empty |
| Clear | "Clear" (secondary) | Disabled when there are no notes. No confirm step, because it's undoable. Status: "Pattern cleared. Undo to restore." |
| New… | "New…" opens `NewPatternDialog` | Dialog title "New empty pattern". Fields: Measures (default = current) and Time signature (default = current). Buttons "Create" (primary) and "Cancel". Focus goes to the first field. Escape closes and focus returns to "New…". Needs the instrument's rows: while loading, "Create" is disabled and shows "Loading instrument…". |
| Download MIDI | "Download MIDI" (secondary, ⤓ icon) | Busy: "Preparing MIDI…", disabled. Saves via object URL with `<a download>`. Filename from `exportMidi().filename`; if none, fall back to `songbird-<slug(name)>-<bpm>bpm.mid`. Error: inline `role="alert"` `text-xs text-red-700 dark:text-red-400` reading "Couldn't export MIDI. Try again." |

**Header line** (above the transport):
- Pattern name: `text-base font-semibold`.
- Time signature: badge `rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-mono dark:bg-zinc-800`, read-only.
- Status message: `role="status"`, `text-sm text-zinc-600 dark:text-zinc-400`.

### Transport

- **Play/Stop** is one primary button, `min-w-24`, with the label "Play" (▶) or "Stop" (■) and `aria-keyshortcuts="Space"`. The name switches so RTL can use `getByRole('button', { name: 'Play' })`. States:
  - `status === 'loading'` (first Play: Tone.start plus kit): "Loading sounds…", disabled, with the spinner.
  - `error`: inline alert "Couldn't start audio. Check your browser allows sound, then try again."
  - Disabled when there is no pattern.
- **Loop:** "Loop measures [From ▾] to [To ▾]", with `aria-label`s "Loop start measure" and "Loop end measure".
  - Default `{1, measures}`.
  - "To" options are ≥ "From". Changing "From" past "To" moves "To" with it.
  - Reset the loop to the whole pattern whenever `measures` changes.
  - When the range isn't the whole pattern, show a text button "Loop whole pattern".
- **Follow:** checkbox "Follow playhead" (default on; see 5.6).
- **Position:** "Bar 2 · Beat 3", `font-mono tabular-nums text-sm text-zinc-600`, `aria-hidden` (it would flood screen readers). Updated only on beat change, through a ref.

## 8. Accessibility

### 8.1 Grid semantics

The DOM is measure-major (one column component per measure, for memoization), so real ARIA `grid` rows can't be expressed without `aria-owns` across thousands of cells. Instead:

- Scroller: `role="group" aria-roledescription="piano roll" aria-label="{instrument.name} piano roll"` (e.g. "Drums piano roll"). `aria-describedby` points to an `sr-only` paragraph: "Arrow keys move between steps. Enter adds or removes a note. Shift plus Up or Down changes velocity. Shift plus Left or Right changes length. Space plays or stops."
- Cells: toggle buttons with a roving tabindex, so the whole roll is **one** tab stop.

### 8.2 Accessible names (exact strings for tests)

- Cell: `"{row.name}, measure {m}, step {s}"`, with `m` and `s` 1-based and `s` counted within the measure. Examples: "Kick, measure 1, step 1"; "Snare, measure 1, step 5" (= absolute step 4 in the spec scenario); "Closed Hi-Hat, measure 3, step 16".
  - Why this and not "Kick, step 417": musicians count 1–16 inside a bar, like the steps on a hardware drum machine.
  - Tests should build names with `cellLabel` so the mapping stays in one place.
- Pressed state: `aria-pressed="true"` on every covered cell.
- Note details: `aria-description` on the note's start cell: "Note, velocity 100, 4 steps". Continuation cells: "Held from step 5". This keeps the name stable while the details stay available.
- A note's span can be checked with `data-*` on `data-testid="note"`, or by counting pressed cells.

### 8.3 Keyboard

| Where | Key | Action |
|---|---|---|
| Roll | ← → ↑ ↓ | Move one step or row. Focus scrolls into view (`block/inline: 'nearest'`; `scroll-pl` keeps it clear of the labels). |
| Roll | Home / End | First or last step of the row |
| Roll | PageUp / PageDown | Same step in the previous or next measure |
| Roll | Enter | Toggle: add a note, or remove the covering note |
| Roll | Delete / Backspace | Remove the covering note |
| Roll | Shift+↑ / Shift+↓ | Velocity ±10 on the covering note (one undo step per press) |
| Roll | V | Cycle velocity preset (same as Alt-click) |
| Roll | Shift+→ / Shift+← | Length ±1 via `resizeNote(row, note.step, len±1)`. The store clamps. |
| Global | Space | Play/Stop, except when the target is a text entry (see below) |
| Global | Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (also Ctrl+Y) | Undo / redo, except in text entry, where the browser's own text undo must keep working |

Focus stays on the same cell after add or remove, because cells persist.

**Space:** `useEditorShortcuts` listens on `document` for `keydown`.
- Ignore the event (no `preventDefault`) when `isTextEntryTarget(e.target)`: `textarea`; any `input` whose type isn't checkbox, radio, range, button or submit; `select`; `[contenteditable]`.
- Also ignore it when the target is a button, link, checkbox or `<summary>` **outside** the roll. Otherwise Space on "Clear" would both clear the pattern and start playback.
- Inside the roll, Space calls `preventDefault` on both `keydown` and `keyup`. Buttons fire `click` on Space `keyup`, so without the `keyup` call Space would also toggle the focused cell.
- RTL cases:
  1. Space with focus on a cell starts playback, and a second press stops it.
  2. Space typed in the textarea inserts a space and doesn't start playback.
  3. Space on a toolbar button only activates that button.

### 8.4 Other accessibility requirements

- Every icon-only control has an `aria-label`. SVG icons are `aria-hidden`.
- Focus is visible everywhere. Grid cells use the inset outline (5.3).
- Contrast: text meets ≥ 4.5:1 and non-text UI (note borders, playhead line, focus rings, input borders, zinc-500 measure lines) meets ≥ 3:1, in both schemes. Step lines (zinc-200 / zinc-800) are decorative; beats and measures are distinguished by the stronger lines plus shading.
- Nothing relies on colour alone:
  - Over-limit has text.
  - Loop range has a bracket.
  - Velocity has opacity, a `title` and an `aria-description`.
  - Playing state has the button label.
- Reduced motion: spinners are static and auto-scroll jumps instead of scrolling smoothly. The playhead never animates.
- Live regions: one polite `role="status"` in the editor header for generated, cleared and exported messages; errors use `role="alert"`. Playback position is never announced.

## 9. Page-level states

| State | Render |
|---|---|
| Store not hydrated (SSR / first paint) | Skeleton editor card: 12 rows of `h-8 rounded bg-zinc-100 dark:bg-zinc-900 motion-safe:animate-pulse`. This avoids a hydration mismatch from `localStorage`. |
| No pattern yet | Editor card shows the empty state in place of transport, toolbar and roll: heading "No pattern yet", text "Describe a groove above, or start from a blank grid.", secondary button "Start with a blank grid". That button calls `newEmptyPattern(instrument, measures from PromptForm, time signature from PromptForm)` and is disabled while the instrument loads. |
| Instrument failed to load and no pattern | Empty state adds "Couldn't load the drum kit's rows." and a "Retry" button. If a persisted pattern exists, rows come from `pattern.rows` and everything works. |
| Generating | See 6. The roll stays interactive. |
| Playing | Button reads "Stop", playhead visible, follow active. |

## 10. Test hooks summary

- Measure options: `getByRole('combobox', { name: 'Measures' })` inside the form named "Generate a pattern" (`<form aria-label="Generate a pattern">`). The toolbar also has a "Measures" select, so scope queries with `within`.
- Counter: `getByText('10 / 256')`.
- Generate: `getByRole('button', { name: 'Generate' })`.
- Cells: `getByRole('button', { name: cellLabel('Snare', 4, 16) })` → "Snare, measure 1, step 5". Assert `aria-pressed`.
- Notes: `getAllByTestId('note')` with `data-row`, `data-step`, `data-length`, `data-velocity`. Resize handle: `within(note).getByTestId('note-resize')`.
- Transport: button "Play"/"Stop"; comboboxes "Loop start measure" and "Loop end measure".
- Toolbar buttons: "Undo", "Redo", "Clear", "New…", "Download MIDI".

## 11. Incidental findings (outside this scope, worth a quick fix)

- `frontend/src/app/globals.css:24`: `body { font-family: Arial, … }` overrides the Geist font that `layout.tsx` loads and `--font-sans` maps. Remove it or use `var(--font-sans)` so the app actually renders in Geist.
- `frontend/src/app/layout.tsx:15-18`: metadata is still "Create Next App". Set it to "Songbird" with a title template (`%s · Songbird`).
