# Studio UI spec (`/studio`)

Layout spec for task 4.1, based on `mockups/studio.png` and design D5 and D6. It reuses the existing editor components and styling: zinc neutrals, the indigo accent, the amber playhead, `Button`, `Select`, `Field`, `ErrorAlert`, `Spinner`, `focusRing`, `inputClass`, and `--cell-w`/`--row-h`. Every place this spec departs from the mockup is listed in [Departures from the mockup](#departures-from-the-mockup), with the reason.

## Goal

Songwriters coming from a DAW should find the familiar arrangement: tracks stacked on one timeline, the selected track's piano roll below it, and the mix on each track header. The page keeps the conventions the drum machine and instrument editors already use, so it does not feel like a second product.

## Page shell

`app/studio/page.tsx` renders `StudioPage`. At `lg` and wider, the page is a fixed-viewport app shell. The page itself never scrolls; each region scrolls internally.

```
┌──────────────────────────────────────────────────────────────┬─────────────────┐
│ SongHeader  Songbird ›  [Demo ✎]  [Songs ▾]  Tempo[120]BPM    │ AssistantPanel  │
│             Swing ──●── 12%  Length[8]bars  (4/4)  ↶ ↷  Saved │ ┌─────────────┐ │
│ Transport   [▶ Play]  Loop measures [1]to[8]  ☑Follow  Bar 1·1│ │ Assistant   │ │
├──────────────┬───────────────────────────────────────────────┤ ├─────────────┤ │
│ [+ Add track]│ 1        2        3        4        5     …   │ │             │ │
│  3/16        │ ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │ │  (empty     │ │
├──────────────┼──────────────────────┃────────────────────────┤ │   state)    │ │
│1 [🥁] Drums ⋯│▐ ▌▌ ▌ ▌▌ ▌ ▌▌ ▌ ▌▌ ▌  ┃ ▌ ▌▌ ▌                 │ │             │ │
│  M S ──●── ◔ │                      ┃                         │ │             │ │
├──────────────┼──────────────────────┃────────────────────────┤ │             │ │
│2 [🎹] Piano ⋯│  ▬▬   ▬▬▬  ▬         ┃  (selected: tinted)     │ │             │ │
│  M S ──●── ◔ │                      ┃                         │ │             │ │
├──────────────┴──────────────────────┃────────────────────────┤ │             │ │
│ Piano · Piano │ 1    1.2   1.3   1.4   2 ┃  2.2   …    (scrolls)   │ ├─────────────┤ │
│               ├──────────────────────────┃────────────────────────┤ │ [disabled   │ │
│        ┌keys┐ │ PianoRoll grid           ┃                        │ │  input] [➤] │ │
│        └────┘ │                          ┃                        │ └─────────────┘ │
└───────────────┴──────────────────────────┸────────────────────────┴─────────────────┘
   gutter = --gutter-w (shared)   lanes: whole song fits the width, no horizontal scroll
                                  dock: --cell-w scale, scrolls on its own
                                  ┃ = one playhead per region, each at its own scale
```

- **Root:** `<main className="grid h-dvh min-w-0 overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_minmax(12rem,11fr)_minmax(16rem,9fr)]">`
- **Placement:**
  - Row 1, column 1: `SongHeader` and `Transport`.
  - Row 2, column 1: `Arrangement` (`<section aria-label="Arrangement">`).
  - Row 3, column 1: `EditorDock` (`<section aria-label="Editor: {track name}">`).
  - Column 2, rows 1 to 3: `AssistantPanel` (`<aside aria-labelledby>`).
- **Region separators:** `border-zinc-200 dark:border-zinc-800`. The arrangement and dock sit directly on `bg-white dark:bg-zinc-950` with `border-t`, not in rounded cards. The existing pages use `rounded-2xl` cards. A DAW surface needs edge-to-edge space, and cards would add padding in every region.
- **Resizable split:** the split between arrangement and dock defaults to about 55/45, and a separator between them trades height (see the piano-roll-editor spec, "Resize the piano roll vertically").
- **Shared gutter:** `--gutter-w` is `16rem` at `md` and wider. Both the track-header column and the dock's row-label column are exactly this wide. The two regions' timelines then start at the same x, so the page reads as one aligned column even though the two scales differ.
- **Two scales:**
  - **Lanes** fit the whole song into the available width, with no horizontal scroll (see departure 3).
  - **Dock** keeps the existing `--cell-w: 28px` and scrolls horizontally on its own.

## Song header (`SongHeader`)

The header is one `flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6` row above a `Transport` row. The `divider` class from `EditorToolbar` separates the groups.

| Control | Component / behavior | Accessible name |
|---|---|---|
| Breadcrumb | Same `Songbird ›` link as `PatternEditorPage` | `nav aria-label="Breadcrumb"` |
| Song name | `<h1 className="text-lg font-semibold">` containing an `InlineNameField`: a text button that becomes an `inputClass` input on click or Enter. It is 1–80 characters (`maxLength=80`). Enter or blur commits. Escape cancels. An empty value reverts silently. | Button: `aria-label="Rename song {name}"`. Input: `aria-label="Song name"` |
| Library | `SongLibraryMenu` trigger: `Button` "Songs ▾" (see [Song library](#song-library-songlibrarymenu)) | `aria-haspopup="dialog"` |
| Tempo | Reuse `TempoField` as-is (40–240, commits on blur/Enter) | "Tempo" |
| Swing | Reuse `SwingSlider` as-is (0–75%, one commit per drag) | "Swing" |
| Length | `LengthField`: a copy of the `TempoField` pattern, 1–128, suffix "bars". A number field, not a 128-option `Select`, because typing "32" is faster. | "Length" (suffix "bars" visible) |
| Time signature | A read-only pill, reusing `rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-zinc-800`. It has `title="Chosen when the song was created"`. It is not focusable. | Visible text is prefixed with `<span class="sr-only">Time signature </span>` |
| Undo / Redo | The `Button`s copied from `EditorToolbar` (↶/↷, `aria-keyshortcuts`, labels hidden `max-sm`), wired to the song store | "Undo", "Redo" |
| Save status | `SaveStatus`: `text-xs text-zinc-600 dark:text-zinc-400`. It shows "Saved", "Saving…", or "Not saved". "Not saved" gets `text-red-700 dark:text-red-300` plus a ⚠ glyph, so colour is not the only signal. | Only transitions to and from failure are announced, through the page status region. Announcing every autosave would be noise. |
| Assistant toggle (`<lg` only) | `Button` "Assistant", with `aria-expanded` and `aria-controls` pointing at the drawer | "Assistant" |

- **Transport:** reuse `Transport` unchanged apart from one copy prop. `Loop whole pattern` becomes `Loop whole song`, through a `wholeLabel` prop, because the existing text is hard-coded. Its measure `Select`s cover 1…`song.measures`.
- **Status line:** a `<p role="status" className="min-h-5 text-sm text-zinc-600 dark:text-zinc-400">` directly under the header row. It uses the same pattern as the editor page and carries undo hints (see [Copy](#copy)).

## Arrangement (`Arrangement`)

The arrangement scrolls vertically only (`relative min-h-0 overflow-y-auto overflow-x-hidden`). Its inner grid is `grid w-full grid-cols-[var(--gutter-w)_minmax(0,1fr)]`.

**Fit-to-width scale.** The timeline column (ruler and lanes) is `@container` (Tailwind 4 container queries). It sets `style={{"--cell-w": \`calc(100cqw / ${totalSteps})\`}}`. The existing `MeasureRuler`, `LoopShade`, and `Playhead` all position through `--cell-w`, so they scale to the lane width unchanged, and a length or window change reflows without JS measurement. On a 128-bar song a step can be well under 1px, which is fine for an overview.

The column contains:

- **Corner** (`sticky top-0 left-0 z-50`, height matching the ruler, `bg-white dark:bg-zinc-950 border-r border-b`):
  - `AddTrackMenu` trigger: `Button` with a "+" glyph and the visible label "Add track". Its label is hidden `max-sm`, and then `aria-label="Add track"` is required.
  - The count "3/16" next to it, `text-xs tabular-nums text-zinc-600`, so users can see that the limit exists before they reach it.
  - At 16 tracks the button gets `disabled`, and the count reads "16/16 · limit reached".
- **Ruler:** reuse `MeasureRuler` (measure numbers, beat ticks, loop highlight), `sticky top-0 z-40`, at the lanes' fit-to-width scale. It needs two new presentational props so labels never collide:
  - `labelEvery`: the smallest of 1, 2, 4, 8, or 16 that keeps labelled measures at least 32px apart. It is computed from the lane width with a `ResizeObserver`, and recomputed only on resize. The first measure and any loop-range edge are always labelled.
  - `showBeats`: beat ticks are drawn only when a measure is at least 48px wide.
  - Measure dividers stay on every bar (`border-r`, dropping to `border-zinc-300` when `labelEvery > 1`), so the bar grid stays countable.
- **Lanes:** one `TrackLane` per track in song order. Each is `role="group" aria-label="Track {n}: {name}"` and is two grid cells in one grid row:
  - `TrackHeader`, `sticky left-0 z-30`.
  - `NoteOverview`.
- **Lane height:** `h-16`, or `pointer-coarse:h-20`. Lanes are separated by `border-b border-zinc-200 dark:border-zinc-800`.
- **Below the last lane:** empty space in the same grid colours, so the ruler and playhead still read as a timeline. This matches the mockup's empty area.
- **Playhead and loop shade:** a `Playhead` and a `LoopShade` absolutely positioned over the lanes column, spanning all lanes (`top-0 bottom-0`) at the lanes' scale.
  - This playhead subscribes to the same `subscribePosition` as the dock's.
  - At fit scale the `w-[var(--cell-w)]` fill is sub-pixel, so the `border-l-2` line is what reads, which is intended.
  - It needs a `snap` prop (or a lanes-specific variant) that updates at step granularity only when a step is at least 1px wide, and otherwise at most once per animation frame. Per-step updates at a 0.3px step would write the transform without visible movement.

### `TrackHeader` (inside `w-[var(--gutter-w)]`, `px-2 py-1.5`, two rows)

```
┌────────────────────────────────────────────┐
│ 1  [icon]  Bass line · Piano           [⋯] │  row 1: identity
│            [M][S]  ───────●──  (◔)          │  row 2: mixer
└────────────────────────────────────────────┘
```

| Element | Spec | Accessible name / role |
|---|---|---|
| Number | `w-5 text-right font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-400` | Part of the lane's group label |
| Instrument icon | `InstrumentIcon`: an inline 20px SVG in a `size-8 rounded-md bg-zinc-100 dark:bg-zinc-800` tile. The glyph is picked by instrument id (drums, piano/keys, bass, synth, strings/pad), falling back on `kind` (`drums` or a generic note). The glyph set is new because the API supplies no icons. | `aria-hidden`, because the instrument name is shown as text |
| Name (select target) | `<button>` holding the track name (`text-sm font-medium truncate`) and, when it differs from the name, `· {instrument name}` (`text-xs text-zinc-600`). Click or Enter selects the track. Double-click starts an inline rename (`InlineNameField`, 1–40 characters). | `aria-label="Select {name} track ({instrument})"`, with `aria-current="true"` when selected |
| Track menu | `⋯` icon `Button` (`size-7 rounded-md`). It opens a small menu (`role="menu"`) with **Rename…** and **Delete track**. Delete is `aria-disabled` when there is 1 track, with the menu hint "A song needs at least one track". Deleting needs no confirmation because it is undoable; the status line says so. | `aria-label="Track options for {name}"`, `aria-haspopup="menu"` |
| Mute | Toggle `button`, `size-7 rounded text-xs font-bold`, letter "M". Off: `border border-zinc-300 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300`. On: `bg-indigo-600 text-white dark:bg-indigo-400 dark:text-zinc-950` | `aria-label="Mute {name}"`, `aria-pressed` |
| Solo | Same shape, letter "S". On: `bg-amber-400 text-zinc-950` (the DAW convention that solo is yellow; AA against zinc-950 text) | `aria-label="Solo {name}"`, `aria-pressed` |
| Volume | `VolumeSlider`: native `input type=range` from −60 to +6, `step=0.5`, `flex-1 min-w-12 accent-indigo-600`. Double-click resets to 0 dB. While dragging or focused, a readout tooltip ("−12.0 dB") is styled like the `NoteBar` tooltip. Pointer-down starts a gesture and pointer-up, key-up, or blur commits it, so one drag is one undo step (like `SwingSlider`). | `aria-label="Volume {name}"`, `aria-valuetext="−12 dB"` / `"0 dB"` |
| Pan | `PanKnob`, a custom `role="slider"` (a `size-7` circle with `border-zinc-400`, a centre tick, and an indicator line rotated −135° to +135°). Vertical or horizontal drag moves it at 1% per px, or finer with Shift. It snaps to centre within ±3%. Double-click resets to centre. It has the same gesture and tooltip behavior as volume ("L30", "C", "R30"). | `aria-label="Pan {name}"`, `aria-valuemin=-100 aria-valuemax=100`, `aria-valuetext="Center"` / `"30% left"` |

- **Selected track:** the header and its lane both get `bg-indigo-50 dark:bg-indigo-950/40`, and the header gets `shadow-[inset_4px_0_0] shadow-indigo-600`. `aria-current` carries the state for assistive technology. A track is always selected: selection falls back to the first track, so the dock is never empty.
- **Inaudible track:** a track that is muted, or silenced because another track is soloed, gets `data-audible="false"`. Its `NoteOverview` drops to `opacity-40`, and the header adds `<span class="sr-only">, not audible</span>` to the group label. Users can then tell *why* a track is silent without hunting for the soloed one.
- **Missing instrument:** if a track's instrument is missing from `GET /api/v1/instruments`, the icon tile shows "?" and the name line reads "{name} · Instrument unavailable". The dock shows `ErrorAlert` with the message "This track's instrument isn't available, so it can't be edited or played."

### `NoteOverview`

- **Region block:** one block spanning the whole song, `absolute inset-x-0 inset-y-1 rounded-md border border-indigo-600/30 bg-indigo-600/10 dark:border-indigo-400/30 dark:bg-indigo-400/10`.
- **Notes:** one SVG per lane, sized `w-full h-full`, with `viewBox="0 0 {totalSteps} {rowSpan}"` and `preserveAspectRatio="none"`. It holds one `<path>` (`fill-indigo-600 dark:fill-indigo-400`).
  - The path is in step units, so it scales with the lane and never needs rebuilding on resize.
  - It also has a matching `stroke` with `vector-effect="non-scaling-stroke"` and `stroke-width="1"`. At fit scale a sixteenth-note hit can be under a pixel wide, and the stroke keeps every note at least 1px, so a sparse drum part never vanishes.
- **Vertical mapping:**
  - Drums map row index across the lane height.
  - Melodic tracks map the track's own lowest-to-highest used pitch, padded by one row, so a bass line fills the lane instead of being a flat strip.
- **Empty track:** the lane shows sticky "No notes yet. Select the track to add some." (`text-xs text-zinc-500`, on the left of the visible area) instead of a blank block.
- **Clicking the lane:**
  - It selects the track.
  - It scrolls the dock so the clicked measure is at the left edge of the grid, with `scrollLeft = measureIndex × stepsPerMeasure × CELL_W_PX`. The scroll is `smooth`, or `auto` under reduced motion.
  - If playback is running, it counts as a manual scroll, so Follow is turned off. Otherwise the next page flip would snap away from where the user asked to go.
  - It is pointer-only: the name button is the keyboard path, so the lane is not a second tab stop. Keyboard users jump by measure inside the roll with PageUp/PageDown, which already exist.
- **Dock window indicator** (recommended, cheap): a `border-x-2 border-indigo-600/60` bracket in the lane ruler marks the measures currently visible in the dock. It updates on the dock's scroll events. It is `aria-hidden`. With the scales no longer shared, this shows where the roll is within the song.
- **Accessibility:** `role="img" aria-label="{name}: {count} notes, measures {first}–{last}"`, or "no notes".

### `AddTrackMenu`

- **Menu:** `role="menu"`, listing every instrument from `GET /api/v1/instruments`, grouped "Drums" / "Melodic", each with its `InstrumentIcon`.
- **Choosing an instrument:** adds the track (named after the instrument, then "Piano 2" and so on), selects it, scrolls it into view, and moves focus to its name button.
- **Loading and errors:** while instruments are loading, the menu shows `Spinner` "Loading instruments…". On error it shows `ErrorAlert` with Retry.

## Editor dock (`EditorDock`)

- **Contents:** the existing `PianoRoll` for the selected track, filling the region.
- **Needed `PianoRoll` changes:** these are presentational, alongside D2's `NoteGrid` props:
  - `className` override, so `max-h-[70vh] rounded-xl border` can become `h-full` with no radius.
  - `gutterClassName`, so the label column is `w-[var(--gutter-w)]` with the drum labels full width or the keyboard `ml-auto`.
  - `corner` slot, rendered in the existing sticky corner cell.
- **Corner (dock header):** `InstrumentIcon`, the track name (`text-sm font-semibold truncate`), and the instrument name (`text-xs text-zinc-600`). This replaces the mockup's "No Regions selected".
- **Ruler:** `MeasureRuler` with a new `beatLabels` prop that prints `1`, `1.2`, `1.3`… at beat ticks (`text-[10px] text-zinc-600`). The mockup's dock ruler reads in bar.beat, and the lane ruler above already carries bar numbers.
- **Playhead:** the roll's own existing `Playhead`, at `--cell-w` scale. It is driven by the same `subscribePosition` as the lanes' playhead. The two sit at different x positions because the scales differ, but both show the same musical position.
- **Scrolling:** the dock scrolls horizontally on its own, and nothing syncs it with the lanes. "Follow playhead" and `onManualScroll` behave exactly as on the single-instrument pages. The only link from the lanes is the click-to-measure jump described under `NoteOverview`.
- **Keyboard and help:** everything in `PianoRoll` is unchanged: roving cell focus, Shift+arrows, V, Delete, the `sr-only` help text, and key audition.

## Assistant column (`AssistantPanel`) (inactive in this change)

- **Container:** `<aside aria-labelledby="assistant-title" className="flex min-h-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">`.
- **Header:** `px-4 py-3 border-b`, containing `<h2 id="assistant-title" className="text-sm font-semibold">Assistant</h2>`.
- **History area:** `flex-1 overflow-y-auto` (the future `role="log"`). The empty state is centered, `max-w-60 text-center`:
  - Title "Your song assistant", `text-sm font-medium`.
  - Body "Soon you'll be able to ask for a bass line, a new drum part, or lyrics here." (`id="assistant-note"`, `text-sm text-zinc-600 dark:text-zinc-400`).
- **Composer:** `border-t p-3 flex gap-2`, containing:
  - `<textarea disabled rows={2} aria-label="Message the assistant" aria-describedby="assistant-note" placeholder="Chat isn't available yet">` using `inputClass` with `h-auto py-2 resize-none`.
  - A disabled primary `Button`, `aria-label="Send message"`.
  - Native `disabled` keeps both controls out of the tab order, while screen-reader browse mode still finds them together with the explanation.

## Dialogs

All dialogs reuse `NewPatternDialog`'s `<dialog>` shell and classes: `m-auto w-full max-w-sm rounded-2xl border … p-6 backdrop:bg-black/50`, focus returns to the trigger, and Escape closes. The library and Send-to-song dialogs use `max-w-md`.

### `NewSongDialog`

- **Opened from:** "New song…" in the library.
- **Fields:** `Field` "Name" (default "Untitled song", 1–80 characters) and `Field` "Time signature" (`Select` over `TIME_SIGNATURES`, with hint "Can't be changed after the song is created.").
- **Buttons:** Cancel and primary "Create".
- **On Create:** creates the song with the spec defaults and the chosen time signature, opens it, closes the library, and moves focus to the song `<h1>` (`tabIndex=-1`).

### Song library (`SongLibraryMenu`)

- **Container:** a modal `<dialog aria-labelledby>` with the title "Songs".
- **Top:** a primary `Button` "New song…", which opens `NewSongDialog`.
- **List:** `<ul>`, most recently modified first. Each `<li>` has:
  - An open button (`flex-1 text-left`) showing the name (`font-medium truncate`) and "Edited {relative time}" (`<time dateTime>`, with the absolute time in `title`), plus the time-signature pill. The current song has `aria-current="true"` and a "Current" badge (text, not just a tint).
  - Icon buttons: **Rename** (turns the row into `InlineNameField`), **Duplicate** (creates "{name} (copy)" and announces "Duplicated as "{name} (copy)"."), and **Delete**. Their labels are `aria-label="Rename {name}"`, `"Duplicate {name}"`, and `"Delete {name}"`.
- **Delete confirmation:** a nested `<dialog role="alertdialog">` asking "Delete "{name}"?", with the body "This can't be undone." and the buttons Cancel (autofocused) and **Delete song** (`bg-red-600 text-white hover:bg-red-700`). Library deletes are not in the undo history, so they need this confirmation.
  - Deleting the open song opens the next most recent one.
  - Deleting the last song creates and opens a default "Untitled song", so the Studio always has a song.
- **States:**
  - Loading the index: `Spinner` "Loading songs…".
  - Index read failure: `ErrorAlert` with Retry.
  - The list never shows an empty state, because a song always exists after the first visit.

### Send to song (D6, on `/drum-machine` and `/instruments/[id]`)

- **Trigger:** `SendToSongButton`, a secondary `Button` "Send to song…" in its own `divider` group in `EditorToolbar`, placed before Download MIDI. It is shown whenever a pattern is displayed.
- **`SendToSongDialog` title:** "Send "{pattern name}" to a song".
- **Chooser:** `<fieldset>` with `<legend>` "Song", as radio rows. Radios fit a single choice with a secondary description better than a `Select` does.
  - **New song** (default). Description: "{tempo} BPM · {ts} · {n} bars", from the pattern.
  - Each index song whose `time_signature` matches, showing the name and "Edited …".
    - A song with 16 tracks is shown `disabled` with the text "Full: 16 tracks", so it is unavailable rather than silently missing.
    - A shorter song, when selected, shows the hint "“Demo” will be lengthened from 8 to 16 bars."
  - Footnote (`hintClass`): "Only {ts} songs are listed, because a song's time signature can't change." When no songs match, it reads "No {ts} songs yet."
- **Buttons:** Cancel and primary "Send". While saving, the Send button shows `Spinner` "Sending…".
- **Success:** the form is replaced in place by the confirmation "Added "{pattern}" to "{song}" as track {n}." Focus moves to it (`tabIndex=-1`). It offers a primary link **Open in Studio** (`/studio?song={id}`) and **Done**. The pattern on the page is unchanged.
- **Errors:** a load or save failure shows `ErrorAlert` inside the dialog with Retry.
- **Data dependency:** the "Full" state needs a per-song track count. It comes from `track_count` in the D3 index record, so the dialog never has to load song bodies just to render the list.

## States

| State | Presentation |
|---|---|
| Loading (IndexedDB and instruments) | The shell grid renders immediately. The header and lanes show 3 skeleton rows, and the dock shows 12 bars. They use `bg-zinc-100 dark:bg-zinc-900 motion-safe:animate-pulse`, as in `PatternEditorPage`. There is also `<p role="status" class="sr-only">Loading song…</p>`. Controls are not rendered until the song loads, so nothing can edit a placeholder. |
| First visit | A default song is created silently (spec defaults). No empty state is shown. |
| `?song=<id>` not found | The last-opened song opens, and the status line reads "That song couldn't be found, so your last song was opened." |
| Instruments failed | Lanes still render their headers. The overviews and dock show `ErrorAlert` "Couldn't load instruments." with Retry, because rows come from the listing. |
| Storage failure | `StorageBanner`: `ErrorAlert` full-width at the top of column 1 (above the header) with `onRetry` ("Retry saving") and `onDismiss`. The message is "Changes aren't being saved. Browser storage is full or unavailable. You can keep editing, but closing this tab will lose your changes." After dismissal, `SaveStatus` keeps showing "Not saved" until a save succeeds. A later successful save announces "Changes are being saved again." |
| Audio error | This is `Transport`'s existing `ErrorAlert`. |
| Playing | Shown by the `Transport` Stop button and the readout ("Bar 3 · Beat 2"), the amber playhead across the lanes and dock, and the loop highlight in both rulers. |

## Copy

- **Status line after undoable destructive edits**, following the existing "Pattern cleared. Undo to restore.":
  - "Deleted the Bass track. Undo to restore."
  - "Shortened to 8 bars. Notes after bar 8 were removed. Undo to restore." This appears only if notes were actually removed.
  - "Added a Piano track."
- **Product labels:** "Studio" (page title `Studio`, landing link "Open the Studio"), "Songs", "Add track", and "bars" for song length. "Measures" stays only in the reused loop selects, to match the existing Transport wording.

## Keyboard

- **Global shortcuts:** these generalize `useEditorShortcuts` over the song store.
  - Space toggles playback, except in text entry, on self-activating controls, and on keyboard keys (same rules as today).
  - ⌘/Ctrl+Z undoes. ⇧⌘/Ctrl+Z and Ctrl+Y redo. Text-editing targets keep native undo (`isTextEditingTarget`).
- **Skip links:** the first focusable elements are `sr-only focus:not-sr-only` links, "Skip to tracks" and "Skip to piano roll". Sixteen tracks at six controls each would otherwise put about 100 tab stops before the roll.
- **Tab order:** breadcrumb → song name → Songs → tempo → swing → length → undo/redo → transport → Add track → for each track: name, ⋯, M, S, volume, pan → piano roll (a single roving tab stop) → keyboard gutter (single stop) → assistant (disabled, skipped).
- **`PanKnob` keys:** ←/↓ and →/↑ move ±1%. PageUp/PageDown move ±10%. Home is full left and End is full right. **Delete, Backspace, or 0** resets to centre. These keys are listed in `title` and `aria-keyshortcuts="Delete"`. Changes from held keys coalesce into one undo step, committed on key-up.
- **`VolumeSlider` keys:** native range keys, with the same key-up commit. **0** resets to 0 dB.
- **Inline name fields:** Enter commits, Escape cancels, and blur commits.
- **Menus** (Add track, track ⋯): ↑/↓ move between items, Enter activates, Escape closes and returns focus to the trigger, and Tab closes.
- **No global Mute or Solo keys** in this change. Single letters would collide with the roll's `V` and future typing in the assistant.

## Accessibility notes

- **Contrast:** text uses zinc-600/zinc-400 (dark) or darker, which is AA on white/zinc-50 and zinc-950/black. Pressed M (indigo-600 with white) and S (amber-400 with zinc-950) both exceed 4.5:1. Control borders (zinc-300/zinc-700) are paired with a text letter, so they don't rely on 3:1 for their meaning.
- **Not colour alone:**
  - Mute and Solo use a filled versus outlined shape plus `aria-pressed`.
  - Selection uses the inset bar plus `aria-current`.
  - An inaudible track uses reduced opacity plus sr text.
  - Save failure uses the ⚠ glyph and "Not saved" text.
- **Target size:** controls are at least 28px (`size-7`). With a coarse pointer, M, S, pan, and ⋯ grow to `size-9` and lanes to `h-20`.
- **Focus:** every custom control uses `focusRing`. Grid cells keep their existing inset outline.
- **Reduced motion:** skeleton pulses are `motion-safe:`. Follow scrolling already falls back to `auto`. The drawer slides in only under `motion-safe:`.
- **Live regions:** one polite `role="status"` for the page and one `role="alert"` for storage failure. The playhead and position readout stay `aria-hidden`, as they are today.

## Narrow viewports

| Width | Behavior |
|---|---|
| `≥ xl` | Assistant is `24rem` wide. |
| `lg` to `xl` | Assistant is `20rem` wide. |
| `md` to `lg` | Two-column shell, with the assistant hidden. The header's "Assistant" button opens `AssistantPanel` in a right-side modal `<dialog>` sheet (`w-80 h-dvh ml-auto`). The column exists (D5) but does not take a third of a tablet screen for an inactive panel. |
| `< md` | The shell drops `h-dvh` and becomes normal page flow: header (wrapping), arrangement (`max-h-[50dvh]` internal scroll), dock (`h-[70dvh]`). `--gutter-w` becomes `9rem`. `TrackHeader` goes to three rows (row 1: number, name, ⋯; row 2: M, S, pan; row 3: full-width volume) with lane `h-24`, and the icon is hidden. The dock's label column goes back to its native `w-20`/`w-14`, so the roll keeps usable grid width. The lanes still fit the whole song into the remaining width, and `labelEvery` thins the ruler labels further. |
| All widths | Every scroller is `min-w-0 overflow-x-auto overscroll-x-contain`, so the page never scrolls horizontally. |

## Omitted from the mockup (non-goals)

These are omitted: the Score, Step Sequencer, and Session Player tabs; the Time/Scale Quantize, Strength, Swing, and Velocity inspector; the Edit/Functions/View menus and the tool, snap, and zoom toolbar; the record-arm and input-monitor (R/I) buttons; folder and stack tracks (disclosure triangles); clip regions and region editing; and the mockup corner's duplicate-track and download buttons.

## Departures from the mockup

1. **Light and dark themes instead of dark only.** The app follows `prefers-color-scheme` with zinc tokens everywhere. Dark mode approximates the mockup, and a dark-only page would be the one inconsistent screen.
2. **One indigo accent instead of per-track colours.** The existing notes, slider accents, and hovers are indigo. Instrument identity comes from the icon and the visible instrument name, which also avoids meaning carried by colour alone.
3. **The lanes always fit the whole song, with no horizontal scroll.** The mockup shows a zoomed-out arrangement that still scrolls. Fitting the song keeps the whole arrangement visible at once (proposal) without adding zoom controls. The dock keeps its own scale and scroll, as in the mockup.
4. **Ruler labels thin out automatically (every 1, 2, 4, 8, or 16 bars)**, instead of the mockup's fixed every-second-bar labels. The spacing between labels depends on song length and window width.
5. **One region block per lane covering the whole song**, not clips, because there is no clip editing. Empty tracks show a text hint instead of a blank lane.
6. **An explicit song header, transport, undo/redo, and save status** above the arrangement. Logic's control bar is outside the mockup frame. These are required by the spec and reuse the existing toolbar components.
7. **Track header controls:** M/S (no R/I), a pan knob, and an added **⋯ menu** for rename and delete. Logic relies on context menus and double-clicks, which are neither discoverable nor keyboard accessible. Double-click rename is kept as a shortcut.
8. **A visible track count "n/16"** by Add track, so the limit is understood before the button disables.
9. **The dock corner shows the track name and instrument** instead of "No Regions selected". There are no regions, and a track is always selected.
10. **The assistant's grey placeholder boxes become a titled panel** with an empty state and a disabled, labelled input. Below `lg` the panel becomes a drawer.
11. **Clicking a lane jumps the dock to that measure.** A lane-ruler bracket shows the dock's visible window. Neither is in the mockup; together they replace the link between the regions that a shared scale would have given.
12. **The playhead uses the existing amber style** from `Playhead.tsx` instead of Logic's grey line. Each region has its own playhead at its own scale.
13. **Draggable splitter** between the arrangement and the dock, added at the user's request (it replaces the earlier fixed split).
14. **The "zz" glyph under the mockup is a screenshot artifact** and is ignored.
