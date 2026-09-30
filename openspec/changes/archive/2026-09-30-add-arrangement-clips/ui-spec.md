# Studio UI spec: arrangement clips

Extends the #4 Studio spec (`openspec/changes/archive/2026-09-30-add-multitrack-song/ui-spec.md`) for design D3, D4, and D7 and `specs/songs/clips/spec.md`. Everything not mentioned here is unchanged from #4. The places where this change reverses a #4 decision are listed in [Departures from #4](#departures-from-4), with the reason.

It reuses the existing tokens and parts: zinc neutrals, `focusRing`, `inputClass`, `hintClass`, `menuItemClass`, `Menu`, `ModalDialog`, `InlineNameInput`, `LengthField`, `Button`, the `NoteBar` drag tooltip, and the page's `role="status"` line. It adds one new token set, the loop palette, for a reason given in [Loop colours](#loop-colours).

## Goal

A songwriter should be able to see the song's form from the lanes: which groove repeats where, which placements are the same loop, and which one is open below. Then they should be able to rearrange it by dragging or by keyboard, without wondering whether an edit will change one bar or every copy.

## Vocabulary in the UI

- **Loop**: the reusable content. **Clip**: one placement of it on a lane. Both words appear in the UI, because "linked" and "Make unique" only make sense with both.
- Lengths use **bars**, as the song Length field does. Positions use **measure N**, as the #4 ruler, loop selects, and accessible names do.

## Lane (`TrackLane` → `NoteOverview` becomes `ClipLane`)

The lane size is unchanged from the current code: `h-20`, `max-md:h-28`, `pointer-coarse:h-24`, with the fit-to-width `--cell-w`. The lane's timeline cell is `relative min-w-0`. It holds the clip blocks, the empty-lane hint, and the drag previews.

```
 measure: 1    2    3    4    5    6    7    8
        ┌─────────┬─────────┐    ┌───────────────────┐
        │⛓ Groove A│⛓ Groove A│    │ Fill              │   ← label row (16px)
        │ ▌ ▌▌ ▌  │ ▌ ▌▌ ▌  │    │ ▌▌▌ ▌╎▌▌▌ ▌╎▌▌▌ ▌▐│   ← notes; ╎ = repeat mark
        └─────────┴═════════┘    └───────────────────┘
          indigo    indigo         amber            ▐ = resize handle
                    (selected: 2px ring)
```

### Clip block

- **Element:** `<button type="button" aria-roledescription="clip" data-clip-id={id}>`, absolutely positioned. It is a button because D7 says so and because Enter, Space, and focus come for free.
- **Position:**
  - `left: calc(var(--cell-w) * {(start_measure − 1) × spm})`.
  - `width: calc(var(--cell-w) * {measures × spm} - 1px)`. The 1px leaves a visible seam between back-to-back clips, so two adjacent clips of the same loop never read as one long clip.
  - `top-1 bottom-1` (4px inset, as #4's region block used). `min-w-[3px]`, so a 1-bar clip in a 128-bar song is still visible and hittable.
- **Base classes:** `group/clip @container/clip absolute top-1 bottom-1 overflow-hidden rounded-md border text-left select-none touch-pan-y cursor-grab {palette.block} ${focusRing}`.
  - `touch-pan-y` lets a phone user scroll the arrangement vertically with a finger that lands on a clip. Horizontal travel is the drag.
- **Label row:** `absolute top-0 inset-x-0 flex h-4 items-center gap-1 px-1.5 text-[11px] leading-4 font-medium text-zinc-900 dark:text-zinc-50`.
  - It holds the link glyph when the loop is linked (below), then `<span className="truncate">{loop.name}</span>`.
  - `@max-[2rem]/clip:hidden` hides the label below 32px of block width. The accessible name and `title` still carry the name.
  - The text is zinc-900 or zinc-50, never the hue, so the name's contrast doesn't depend on which of the 8 colours the loop gets.
- **Link glyph:** a 12px chain-link SVG (`size-3 shrink-0`, `aria-hidden`), shown only when the loop is used by more than one clip. It is the non-colour signal that a block is linked.
- **`title`:** `"{loop name} · measures {a}–{b}"`, plus `" · linked, {N} clips"` when linked. It gives pointer users the full name when the label is truncated or hidden.
- **Miniature notes:** an `<svg aria-hidden className="absolute inset-x-0 top-4 bottom-0.5" preserveAspectRatio="none" viewBox="0 0 {clip.measures × spm} {span}">` with one `<path>` in `{palette.note}`, `strokeWidth={1} vectorEffect="non-scaling-stroke"`, as #4 did.
  - The path is the clip's resolved notes (D2) shifted to clip-local steps.
  - `overviewLayout`'s vertical range is computed once per track across all its loops, not per clip. Otherwise the same pitch would sit at different heights in different blocks, and linked blocks would stop looking identical.
- **Repeat marks:** only when `clip.measures > loop.measures`. They are drawn in a second full-height svg (`absolute inset-0`, same viewBox width) as one `<line>` per boundary at `k × loop.measures × spm`, where `k = 1…`. The line uses `className="stroke-zinc-900/40 dark:stroke-zinc-50/40"`, `strokeDasharray="2 2"`, and `vectorEffect="non-scaling-stroke"`. Each line crosses the label row, so the mark still reads when the notes are sparse.
- **Inaudible track:** the #4 `opacity-40` moves from the overview wrapper to each block and to the hint. Behaviour is unchanged.

### Loop colours

#4 departure 2 chose one indigo accent. This change needs a second signal for "same loop", so each loop gets a hue from `LOOP_PALETTE[loopIndex % 8]`, where `loopIndex` is the loop's index in `track.loops`. It lives in a new `components/studio/loopPalette.ts` as literal class strings, so Tailwind can see them.

| # | Hue | `block` (bg + border) | `note` (fill + stroke) | `swatch` |
|---|---|---|---|---|
| 0 | indigo | `bg-indigo-500/15 border-indigo-600 dark:bg-indigo-400/15 dark:border-indigo-400` | `fill-indigo-700 stroke-indigo-700 dark:fill-indigo-300 dark:stroke-indigo-300` | `bg-indigo-600 dark:bg-indigo-400` |
| 1 | amber | `bg-amber-500/15 border-amber-600 dark:bg-amber-400/15 dark:border-amber-400` | `fill-amber-700 … dark:…-amber-300` | `bg-amber-600 dark:bg-amber-400` |
| 2 | teal | `…teal-500/15 border-teal-600 / dark teal-400` | `teal-700 / teal-300` | `teal-600 / teal-400` |
| 3 | rose | `rose-500/15, rose-600 / rose-400` | `rose-700 / rose-300` | `rose-600 / rose-400` |
| 4 | sky | `sky-500/15, sky-600 / sky-400` | `sky-700 / sky-300` | `sky-600 / sky-400` |
| 5 | lime | `lime-500/15, **lime-700** / lime-400` | `lime-800 / lime-300` | `lime-700 / lime-400` |
| 6 | fuchsia | `fuchsia-500/15, fuchsia-600 / fuchsia-400` | `fuchsia-700 / fuchsia-300` | `fuchsia-600 / fuchsia-400` |
| 7 | orange | `orange-500/15, orange-600 / orange-400` | `orange-700 / orange-300` | `orange-600 / orange-400` |

- **Order:** neighbouring indices alternate warm and cool, so a track's first few loops are the most distinct from each other.
- **Contrast:** every border is at least 3:1 (non-text) against white, `indigo-50` (the selected lane), and zinc-950. Lime uses `-700` because `lime-600` measures about 3.0:1 on white. The note fills are `-700` or `-800` (light) and `-300` (dark), which is at least 3:1 on the tinted fill.
- **Index 0 is indigo**, so a track with one loop (every migrated song) looks the same as #4.
- **Colour is never the only signal:**
  - The loop name is on every block wide enough to hold it, and in `title` and the accessible name on every block.
  - The link glyph marks linked clips.
  - The dashed "linked to selection" border (below) shows which blocks belong to the selected clip's loop.
- **Swatch:** a `size-2.5 rounded-sm {palette.swatch}` square, `aria-hidden`. It appears next to loop names in menus, the Loops dialog, and the dock header, so the colour key is learnable.

### Selected, focused, and linked states

| State | Treatment | Programmatic |
|---|---|---|
| Selected (the clip in the dock) | `ring-2 ring-zinc-900 dark:ring-zinc-50 shadow-sm`, label `font-semibold`. Two px of neutral ring, not a hue. | `aria-current="true"` (as on the track name button) |
| Other clips of the selected clip's loop | `border-2 border-dashed` (same hue) | "linked, N clips" in the name |
| Keyboard focus | `focusRing` (outline, offset 2). It sits outside the selection ring with a visible gap, so focused-and-selected shows both. | — |
| Hover | `hover:brightness-95 dark:hover:brightness-110` | — |
| Dragging (moving) | `cursor-grabbing shadow-md z-20` | — |

Focus and selection are separate. Tabbing into a lane does not select, because otherwise tabbing past 16 lanes would repeatedly swap the dock. Enter, Space, a click, or any edit key on a clip selects it.

### Empty lane

- **Hint:** `<span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-zinc-600 dark:text-zinc-400">Double-click to add a clip</span>`.
  - It replaces #4's "No notes yet. Select the track to add some."
  - It uses `zinc-600`, not #4's `zinc-500`, because zinc-500 on `indigo-50` is below 4.5:1.
- **When it shows:** only when the track has no clips. A lane with clips and gaps shows nothing in the gaps. The hint teaches the gesture once, and repeating it in every gap would be noise.
- **Keyboard route:** the hint is not focusable. Keyboard users get New clip from the track's `⋯` menu and from the dock's empty state.

### Pointer gestures

| Gesture | Target | Result |
|---|---|---|
| Click | clip | Selects it (and its track). Does not seek. |
| Double-click | clip | Selects it and moves focus into the piano roll. This is the DAW "open region" habit. |
| Click | empty lane space | Seeks and selects the track, as in #4. The selected clip is kept if it is on this track. Otherwise the track's earliest clip is selected, following D4's header rule. |
| Double-click | empty measure | `newClip` at that measure. The new clip is selected and focused. |
| Right-click (`contextmenu`) | clip | Selects it and opens the [clip menu](#clip-menu) at the pointer. |
| Right-click | empty measure | Opens the [lane menu](#lane-menu) at the pointer, targeting that measure. |
| Drag body | clip | Move ([below](#move-and-resize)) |
| Drag right edge | clip | Resize |
| Alt/Option-drag body | clip | Linked copy |

`preventDefault` on `contextmenu` only over the lane timeline. Everywhere else keeps the browser menu.

### Move and resize

- **Drag threshold:** a pointer must travel 4px before a drag starts. Below that, it is a click (select). This keeps selection from nudging clips.
- **Body cursor:** `cursor-grab`, and `cursor-grabbing` on `document.body` while dragging (so the cursor doesn't flicker when the pointer leaves the block).
- **Resize handle:** `<span aria-hidden data-handle="resize" className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize touch-none pointer-coarse:w-4">`. It contains the `NoteBar` grip (`h-3 w-0.5 rounded-full bg-zinc-900/60 dark:bg-zinc-50/60`), visible on `group-hover/clip`, while selected, and while dragging.
  - The handle is rendered only when the block is at least 24px wide (40px with `pointer-coarse`). On narrower blocks it would cover the whole body, so move could not be reached. Those clips resize with Shift+arrows, or after the window is widened.
  - No left-edge handle: the model has no loop start offset (a non-goal), so a left-edge trim would really be "move and shorten", which is confusing.
- **Snapping:** the raw pointer delta is converted to whole measures, rounded to the nearest, and passed to `moveClip` or `resizeClip`. Those functions clamp (D5), so the block stops against a neighbour or the song edge.
- **Live preview (move and resize):** the store updates live inside `beginGesture`/`endGesture`, so the real block is the preview. A readout tooltip uses the `NoteBar` tooltip classes (`absolute -top-7 left-0 z-50 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900`).
  - Move: "Measures 5–6". Resize: "4 bars".
  - On the first lane, where `-top-7` would sit under the sticky ruler, it is placed below the block (`top-full mt-1`).
- **Escape during a drag** cancels. The clip goes back to where it was, and no undo entry is kept (end the gesture, then restore the snapshot taken at `beginGesture`).

### Alt/Option-drag (linked copy)

- **Mode:** decided when the drag threshold is crossed, from `event.altKey`. It is not toggled mid-drag, because a move is applied live and switching would need to undo it.
- **Original:** stays in place and unchanged.
- **Ghost:** a copy of the block at the snapped target, with `pointer-events-none opacity-70 border-dashed shadow-md`. It has a badge `absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-zinc-900 text-[10px] font-bold text-white dark:bg-zinc-50 dark:text-zinc-950` showing "+". The cursor is `cursor-copy`. The tooltip reads "Copy to measures 9–10".
- **Target:** the ghost shows exactly what `placeLoop` will produce (the same clamping), including being shortened by a neighbour. If the pointer is over an occupied measure, the ghost snaps to the nearest free span.
- **No free measure on the lane:** the ghost is hidden, the cursor is `cursor-not-allowed`, and on drop the status line reads the "no empty measures" message ([Copy](#copy)).
- **Drop:** one undo step. The new clip becomes selected. Focus stays where the pointer left it.

## Keyboard

### Focus order (changes to #4's tab order)

… → for each track: name, `⋯`, M, S, volume, pan, **clip stop** → next track … → **dock header** (Loops button, Loop length, Clip actions `⋯`) → piano roll → keyboard gutter.

- **Clip stop:** there is one roving tab stop per lane (`tabIndex=0` on one clip and `-1` on the rest). It is the selected clip if it is on this lane, otherwise the lane's earliest clip. An empty lane has no stop.
  - It is one stop, not one per clip, because 16 lanes of up to 256 clips would make Tab useless.
- **Skip links:** unchanged. "Skip to piano roll" now lands in the dock header's first control, because the loop controls belong with the roll.

### Keys on a focused clip

| Key | Action | Notes |
|---|---|---|
| Enter / Space | Select | Space is a native button activation, so `useShortcuts` already leaves it alone (`SELF_ACTIVATING`). |
| ← / → | Move 1 measure | Selects the clip too. |
| Shift+← / Shift+→ | Shorten / lengthen by 1 measure | Minimum 1. |
| Alt+← / Alt+→ | Focus the previous / next clip on the lane | Doesn't select. Plain arrows are taken by move (spec), so moving focus needs a modifier. |
| Home / End | Focus the first / last clip on the lane | |
| Delete / Backspace | Delete the clip | Focus and selection go to the next clip, else the previous one, else the track name button. |
| ⌘D / Ctrl+D | Duplicate after | `preventDefault`, to override the browser's bookmark shortcut. |
| F2 | Rename loop | The OS rename convention. It opens the dock header's inline rename. |
| Shift+F10 / ContextMenu | Open the clip menu | The menu is anchored to the block's bottom-left. |

- **Held keys:** auto-repeat on arrows and Shift+arrows is folded into one gesture that ends on key-up, like `PanKnob`, so a held arrow is one undo step.
- **At a limit:** an arrow that can't move or resize because a neighbour or the song edge is in the way does nothing and announces the limit ([Copy](#copy)).
- **Announcements:** after every keyboard move or resize, the status line announces the new span, e.g. "Groove A, measures 4 to 5". Focus stays on the same button, so screen readers would not re-read its changed name otherwise.
- **Duplicate (⌘/Ctrl+D) scope:** handled in `useShortcuts` whenever a clip is selected and the target is not text editing (`isTextEditingTarget`), including inside the piano roll, where D is unused. The user often edits in the dock and then wants another copy. If focus was on a clip, it moves to the new clip.
- **Help text:** one `sr-only` paragraph per Arrangement, `id="clip-keys-help"`, referenced by every clip's `aria-describedby`: "Left and Right arrows move the clip by a measure. Shift with Left or Right changes its length. Alt with Left or Right moves to the previous or next clip. Delete removes it. Command or Control D duplicates it. F2 renames its loop. Shift F10 opens more actions."
- **`aria-keyshortcuts`** on each clip: `"ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Delete Meta+D Control+D F2 Shift+F10"`.

### Clip accessible name

Format: `{loop name}, {span}[, linked, {N} clips][, loop plays {k} times]`

- `span` is "measure 3" for one measure and "measures 3 to 4" otherwise.
- The linked part is present only when N > 1.
- "loop plays k times" is present only when `clip.measures > loop.measures`, with `k = ceil(clip.measures / loop.measures)`. This is repeat information a sighted user gets from the repeat marks.
- **Examples:**
  - "Groove A, measures 3 to 4, linked, 3 clips"
  - "Fill, measure 8"
  - "Bass 1, measures 1 to 8, loop plays 4 times"
- The lane group label is unchanged from #4 ("Track 2: Bass").

## Menus

All menus use `Menu`'s panel classes and `menuItemClass`, with ↑/↓, Enter, Escape (return focus to the invoker), and Tab to close. Disabled items use `aria-disabled` plus an `aria-describedby` hint paragraph (`px-3 pb-2 text-xs text-zinc-600 dark:text-zinc-400`), like #4's "A song needs at least one track", so they stay discoverable.

**New component: `ContextMenu`.** It has the same markup and keyboard behaviour as `Menu` without the trigger:
- It takes `open`, `anchor: {x, y}`, `label`, `onClose`, and `returnFocusTo`.
- It is placed `fixed` at the anchor and clamped inside the viewport.
- It is used for pointer right-click and for Shift+F10.

Extract `Menu`'s key and outside-click handling into a hook so the two can't drift apart.

Separators: `<div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />`.
Group headings: `<p id className="px-3 pt-2 pb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">`, with the items wrapped in `<div role="group" aria-labelledby>`.

### Lane menu

The lane menu is the existing track `⋯` menu (`Track options for {name}`), extended. It is also opened as a `ContextMenu` by right-clicking an empty measure. There is one menu, not two, because a second lane-level button would add a tab stop to every lane, and the header row has no room.

```
┌──────────────────────────────┐
│ New clip at measure 5        │
│ ── Place loop at measure 5 ──│  (group heading)
│ ■ Groove A          3 clips  │
│ ■ Fill              1 clip   │
│ ■ Chorus keys     not placed │
├──────────────────────────────┤
│ Rename track…                │
│ Delete track                 │
└──────────────────────────────┘
```

- **Target measure:**
  - From right-click, the measure under the pointer.
  - From the `⋯` button, the first free measure after the selected clip if it is on this track, otherwise the first free measure from measure 1.
  - The measure is part of the item text, so the user always knows where the clip will land.
- **"New clip at measure {m}":** calls `newClip`. The new clip is selected and focused.
- **Place loop group:**
  - One `menuitem` per loop in `track.loops` order.
  - Each item holds the swatch, the name (`truncate`), and a count on the right (`ml-auto shrink-0 text-xs tabular-nums text-zinc-600 dark:text-zinc-400`): "1 clip", "{N} clips", or "not placed".
  - Accessible name: "Place Groove A, used by 3 clips".
  - Choosing one calls `placeLoop`. The new clip is selected and focused.
  - With no loops, the group shows the hint "No loops yet".
  - It is a flat group rather than a submenu, because `Menu` has no submenu support, and a flat list is simpler to operate by keyboard. The panel's existing `max-h-80 overflow-y-auto` covers 64 loops.
- **Disabled cases:**
  - No free measure on the track: New clip and every Place item are `aria-disabled`, with the hint "No empty measures on this track".
  - 256 clips: same, with the hint "This track has 256 clips, the most it can hold".
  - 64 loops: New clip only is disabled, with the hint "This track has 64 loops, the most it can hold". Placing an existing loop still works.
- **"Rename…"** becomes **"Rename track…"**, to tell it apart from Rename loop. Delete track is unchanged.
- **Panel width:** `w-64` (up from `w-52`) to fit "Place loop at measure 128".

### Clip menu

It is opened by right-clicking a clip, by Shift+F10 or ContextMenu on a focused clip, and by the dock header's **Clip actions** `⋯` button, which is the discoverable pointer path. Label: `Clip actions for {loop name}, {span}`.

| Item | Shortcut hint | Disabled when (hint text) |
|---|---|---|
| Duplicate | ⌘D (Mac) / Ctrl+D | No room: "No room after this clip". Clip limit: "This track has 256 clips, the most it can hold" |
| Make unique | — | Single clip: "Only this clip uses {loop name}". Loop limit: "This track has 64 loops, the most it can hold" |
| Rename loop… | F2 | never |
| *(separator)* | | |
| Delete clip | Del | never |

- **Shortcut hints:** `<kbd className="ml-auto font-sans text-xs text-zinc-600 dark:text-zinc-400">`, plus `aria-keyshortcuts` on the item.
- **Delete clip:** undoable, with no confirmation (as Delete track in #4). It is not styled red, to match Delete track.
- **Make unique:** keeps focus on the clip. The block changes colour (the copy is appended, so it gets a new index) and loses its link glyph if it was the second-to-last clip.
- **Rename loop…:** selects the clip, then turns the dock header's loop name into `InlineNameInput` (`label="Loop name {name}"`, `maxLength={LOOP_NAME_MAX}`), focused with its text selected. On commit or cancel, focus returns to the invoker.

## Editor dock

### Dock header (new bar above `PianoRoll`)

The #4 dock header was the roll's sticky corner, which is only `--gutter-w` × 28px (the ruler's `h-7`). It can't hold a name, a count, a menu, and a length field, so this change adds a toolbar above the roll: `<div role="toolbar" aria-label="Loop" className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800">`. The corner keeps its #4 content: instrument icon, track name, and instrument name.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ■ Groove A ▾   Drums · used by 3 clips     Loop length [ 2 ] bars    ⋯   │
├───────────────┬──────────────────────────────────────────────────────────┤
│ 🥁 Drums      │ 1    1.2   1.3   1.4   2    2.2 …   (loop-local ruler)   │
```

| Element | Spec | Accessible name |
|---|---|---|
| Loops button | `Button` variant `ghost`-like (`h-8 rounded-md px-2 hover:bg-zinc-100 dark:hover:bg-zinc-800`) with the swatch, the loop name (`text-sm font-semibold truncate max-w-48`), and "▾". It opens the [Loops dialog](#loops-dialog). While renaming, it is replaced in place by `InlineNameInput` (`h-8 w-48`). | `aria-label="Loop {name}. Show all loops on {track}"`, `aria-haspopup="dialog"` |
| Context line | `text-xs text-zinc-600 dark:text-zinc-400`: "{track name} · used by {N} clips" ("used by 1 clip" when N = 1). When N > 1 the chain glyph comes first, and the line becomes `font-medium text-zinc-900 dark:text-zinc-50`, because that is when an edit reaches beyond this clip. | Plain text, and part of the section label (below) |
| Loop length | `LengthField` with a new `label` prop: visible text "Loop length", suffix "bars", range `LOOP_MEASURE_RANGE`. It commits on blur or Enter, as today. The prop is needed so the page doesn't have two fields both named "Length". | "Loop length" |
| Clip actions | The `⋯` icon trigger, same classes as the track `⋯` (`size-7`, `pointer-coarse:size-9`), `ml-auto`. It opens the [clip menu](#clip-menu). | `aria-label="Clip actions for {loop name}, {span}"` |

- **Section label:** the dock's `aria-label` becomes `"Editor: {loop name} on {track name}"`, or `"Editor: {track name}"` in the empty state.
- **Linked-edit cue:** while N > 1, the roll's scroller gets `aria-describedby` pointing at the context line. A screen-reader user hears "used by 3 clips" when entering the grid, and so knows that edits apply everywhere.
- **Loop length shortened with notes removed:** the status line gets the loop-shorten message. Lengthening says nothing.
- **Grid:** `loopGrid` (D3), with the ruler numbered from 1. `resetKey={loop.id}`.
- **Playhead:** the roll's own playhead gets the derived loop position, and is hidden (not dimmed) when the song position is outside the selected clip (D3). No extra UI.

### Loops dialog

The "loop menu" is built as a dialog rather than a `role="menu"`. Each loop needs its own Rename and Delete, and unplaced loops can't be reached any other way. Buttons inside menu items are not valid ARIA, whereas the Song library already uses a list with row buttons. It reuses `ModalDialog` with `className="m-auto w-full max-w-md rounded-2xl p-6"`, titled "Loops on {track name}".

- **List:** `<ul>` of loops in `track.loops` order. Each `<li className="flex items-center gap-2 py-1">` has:
  - **Primary button** (`flex-1 min-w-0 text-left rounded-md px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-900 ${focusRing}`), containing the swatch, the name (`font-medium truncate`), and on the right the count "{N} clips" / "1 clip" / "Not placed" (`text-xs tabular-nums text-zinc-600`).
    - It selects the loop's earliest clip and closes the dialog.
    - For an unplaced loop the row shows the same content as static text, not a button, because there is no clip to open. The spec only offers editing through a clip.
    - The current loop has `aria-current="true"` and a "Current" text badge, as in the library.
  - **Rename** icon button (`aria-label="Rename {name}"`) turns the row into `InlineNameInput`.
  - **Delete** icon button (`aria-label="Delete {name}"`). No confirmation, because it is undoable (unlike library deletes).
    - It deletes the loop and all its clips, then announces the message in [Copy](#copy).
    - Focus moves to the next row's primary button, else the previous row's, else the dialog's Close button.
    - If the dialog's current loop is deleted, selection falls to the track's earliest remaining clip, or the empty state.
- **Footer:** `Button` "Close". Escape also closes. Focus returns to the Loops button, or to the track name button if the dock's loop is gone.

### Empty dock state

This is shown when the selected track has no selected clip (usually because it has no clips).

```
┌──────────────────────────────────────────────┐
│                                              │
│          Drums has no clips yet              │
│   Add a clip to start writing a loop.        │
│              [ + New clip ]                  │
│         Adds measures 1–4                    │
└──────────────────────────────────────────────┘
```

- **Container:** `flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center`. There is no dock header bar, because there is no loop.
- **Title:** `<h2 className="text-sm font-semibold">`.
  - "{track} has no clips yet" when the track has none.
  - "No clip selected on {track}" when it has clips but none is selected. This can happen after the loop was deleted from the Loops dialog.
- **Body:** `hintClass`: "Add a clip to start writing a loop." or "Select a clip in the lane, or add a new one."
- **Action:** primary `Button` "New clip", with `aria-describedby` pointing at the hint below it, "Adds measures {a}–{b}" (`hintClass`). The span is what `newClip` at the first free measure will create.
  - On success, focus moves into the piano roll, because the user came here to write notes.
  - With no free measure, the button is `disabled` and the hint reads "No empty measures on this track".
  - At 64 loops, the button is disabled with the hint "This track has 64 loops, the most it can hold".
- The instrument-error states from #4 take priority over this state.

## Copy

All messages go through the page's existing `<p role="status">`. Undoable destructive edits end with "Undo to restore." as in #4. Loop names are wrapped in curly quotes, as in "Duplicated as “{name}”".

| Trigger | Message |
|---|---|
| Duplicate, no room | "No room to duplicate “{loop}”. The next {n} bars after it aren't free." |
| Any add at the 256-clip limit | "{track} already has 256 clips, the most a track can hold." |
| New clip or Make unique at the 64-loop limit | "{track} already has 64 loops, the most a track can hold. Delete an unused loop to add another." |
| Alt-drag or menu with no free measure | "There are no empty measures on {track}." |
| Keyboard move blocked | "Can't move further: {the next clip starts at measure 6 / the song ends at measure 8 / the song starts at measure 1}." |
| Keyboard resize blocked | "Can't lengthen further: {the next clip starts at measure 6 / the song ends at measure 8}." or "A clip is at least 1 bar long." |
| Keyboard move or resize | "{loop}, measures {a} to {b}" (the span part of the accessible name) |
| Delete clip | "Deleted a clip of “{loop}”. The loop is still available in Place loop. Undo to restore." |
| Delete loop | "Deleted the loop “{loop}” and its {N} clips. Undo to restore." ("and its clip" for 1, and "Deleted the loop “{loop}”. Undo to restore." for 0) |
| Make unique | "This clip now plays “{loop} (copy)”. Editing it won't change the other clips." |
| Loop shortened, notes removed | "Loop shortened to {n} bars. Notes after bar {n} were removed. Undo to restore." |
| Song shortened, clips changed (replaces #4's note message) | "Shortened to {n} bars. Clips after bar {n} were trimmed or removed. Undo to restore." |
| Opening a v1 song | Nothing. The migration is inaudible and invisible, so announcing it would only worry users. |

## States summary

| State | Lane | Dock |
|---|---|---|
| Track has no clips | "Double-click to add a clip" hint | Empty state, "{track} has no clips yet" |
| Clips, none selected | Blocks, none ringed | Empty state, "No clip selected on {track}" |
| Clip selected, loop unique | Ring on the selected block | Header shows "used by 1 clip" |
| Clip selected, loop linked | Ring on the selected block, dashed borders on its siblings, glyphs on all of them | Header with glyph and "used by N clips" in medium weight |
| Playing inside the selected clip | Lane playhead | Roll playhead at the loop-local position |
| Playing outside the selected clip | Lane playhead | No roll playhead |
| Dragging | Live block with tooltip, or a ghost for Alt | The dock follows the live selection |
| Instruments loading or error | #4 skeleton / `ErrorAlert` (blocks aren't drawn without rows) | #4 states |

## Accessibility notes

- **Contrast:** block text is zinc-900 or zinc-50 on at most 15% tint, at least 4.5:1 in both themes. Borders, note fills, and swatches are at least 3:1 ([Loop colours](#loop-colours)). The hint is zinc-600 or zinc-400.
- **Not colour alone:**
  - Linked is shown by the glyph and the "linked, N clips" text.
  - Selected is shown by the 2px neutral ring and `aria-current`.
  - Siblings of the selection are shown by the dashed border.
  - Repeats are shown by the dashed marks and the "loop plays k times" text.
- **Targets:** blocks are the lane height minus 8px (72px, or 88px with a coarse pointer), and at least 3px wide at the smallest fit scale. Narrow clips remain reachable by keyboard and by Alt+arrows from a neighbour. Resize handles are 8px, or 16px with a coarse pointer.
- **Reduced motion:** no transitions are added. The live drag preview is direct manipulation, not animation.
- **Live regions:** only the existing status line. There are no per-clip live regions.

## Departures from #4

1. **Clip blocks replace the single region block.** #4 departure 5 drew "one region block per lane covering the whole song" and a single `role="img"` per lane. Now each lane holds one focusable `<button>` per clip, with its own miniature and repeat marks. The lane-wide `role="img"` label ("{name}: N notes, measures a–b") is removed, because the clips' accessible names replace it.
2. **Per-loop colours replace the single indigo accent** in the lanes (#4 departure 2). Index 0 stays indigo, and the header, sliders, and roll stay indigo. Loop identity needs a glanceable marker, and D7 chose colour plus name.
3. **Lanes gain tab stops.** #4 kept lanes pointer-only ("the lane is not a second tab stop"). Clips must be keyboard-operable (spec), so each lane with clips adds exactly one roving stop.
4. **Clicking a lane no longer scrolls the dock to that measure, and the dock-window bracket in the lane ruler is removed** (#4 departure 11, and `NoteOverview` "Clicking the lane" and "Dock window indicator"). The dock shows a loop, not the song, so a song measure has no position in it. A plain click on empty space still seeks and selects the track.
5. **The dock header moves out of the roll's corner into its own toolbar bar** (#4 departure 9, "Corner (dock header)"). The corner keeps the track identity. The loop controls need more than 28px of height.
6. **A track can have an empty dock.** #4 said "a track is always selected… so the dock is never empty". A track is still always selected, but it may have no clip, so the dock has an empty state.
7. **The track `⋯` menu grows** New clip, Place loop, and the "Rename track…" label (from "Rename…"). Tests that query `menuitem` "Rename…" need updating.
8. **The empty-lane copy changes** from "No notes yet. Select the track to add some." to "Double-click to add a clip", and from zinc-500 to zinc-600 for contrast on the selected lane.

## Open points for the implementer

- **Palette order depends on loop index**, so deleting loop 0 changes the colour of every later loop on the track. This is accepted: colour is a same-or-different cue, not identity. A stable `colour` field on `Loop` would avoid it, but would change the document shape.
- **"Place loop" of a loop longer than the free gap** shortens the clip silently, as specified. The ghost and the menu's measure label show where it starts, but not its shortened length. If testing shows surprise, add "(fits 2 of 4 bars)" to the menu item.
