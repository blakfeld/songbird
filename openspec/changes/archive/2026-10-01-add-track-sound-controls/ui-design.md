# UI design: Track sound controls (task 4.1)

Covers the Sound button, the Sound panel (popover / bottom sheet), the generic `Knob`, and the effect on/off switch. Reuses `focusRing`, `hintClass`, `menuItemClass`, `menuPanelClass`, the zinc/indigo palette, and the `Spinner`-style inline SVG approach (`InstrumentIcon`). No new colour tokens.

## 1. Sound button (TrackHeader)

### Placement

The header gutter is `16rem` at `md+` and `9rem` below `md` (`StudioPage.tsx:304`).

- **`md+`**: the button goes last in row 2, after `PanKnob`, giving `M S [volume] Pan Sound`. It sits with the mixer controls because it is a per-track sound control. Width check: 240px usable, minus `pl-7`, leaves 212px. The four 28px controls plus gaps take 144px, so the volume slider keeps about 68px. That is above its `min-w-12`.
- **Below `md`**: row 2 is already over budget (four 36px coarse controls in about 128px). Hide the button there with `max-md:hidden`. Add a **"Sound…"** menu item as the first item in the track's `⋯` menu, and show it at every width so keyboard users have a second route in.

### Button

```
className = `${toggleBase} relative inline-flex items-center justify-center ${toggleOff}
  hover:bg-zinc-100 dark:hover:bg-zinc-800
  aria-expanded:border-zinc-900 aria-expanded:bg-zinc-200 aria-expanded:inset-ring-1 aria-expanded:inset-ring-zinc-900
  dark:aria-expanded:border-zinc-100 dark:aria-expanded:bg-zinc-800 dark:aria-expanded:inset-ring-zinc-100
  max-md:hidden`
```

These are the same "pressed" tokens as the Transport toggles (`Transport.tsx:17`). They are keyed on `aria-expanded` so the open state is never shown by colour alone: the inset ring also changes.

- **Icon**: an inline SVG, `viewBox="0 0 20 20"`, `size-4`, `stroke="currentColor" stroke-width="1.5" fill="none"`, `aria-hidden`. It is a three-fader "mixer" glyph: `M5 3v14M10 3v14M15 3v14` plus thumbs `<rect x="3.5" y="11" width="3" height="2.5" rx=".5"/>`, `x="8.5" y="5"`, `x="13.5" y="9"`. It is filled with `fill-current`.
- **Attributes**:
  - `aria-label`: `"Sound for {track.name}"`, or `"Sound for {track.name} (customized)"` when the sound is customized.
  - `aria-haspopup="dialog"`, `aria-expanded={open}`, and `aria-controls={open ? panelId : undefined}`.
  - `title="Sound"`.
- **Customized indicator**: shown when the track's sound differs from what "Reset sound" would produce. That includes any effect being on, and any parameter differing from its default, even on an effect that is off. The indicator is a dot: `<span aria-hidden class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-indigo-600 ring-2 ring-white dark:bg-indigo-400 dark:ring-zinc-950" />`. It is a shape that is either present or absent, so it doesn't rely on hue. Its state is also in the accessible name.
- **Below `md`**: put the same dot on the `⋯` trigger and add `(sound customized)` to that trigger's `aria-label`. The menu item reads `Sound…`. When the sound is customized, a second line under it reads `Customized` in `hintClass`, and the item's `aria-describedby` points to that line.

## 2. Sound panel

### Shared structure

```
<section role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}>
  header:  <h2 id={titleId}>{track.name} sound</h2> · instrument name · [Reset sound] [×]
  body:    Tone group, then EQ, Distortion, Chorus, Delay, Reverb (chain order, DOM order = visual order)
  <p role="status" class="sr-only">  ← "Bass sound reset" after reset
```

**Container classes**: `fixed z-50 flex flex-col rounded-lg border border-zinc-200 bg-white text-zinc-900 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50`. These come from `menuPanelClass` so it reads as part of the same family of panels.

**Header**: `flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800`.
- **Title**: `text-sm font-semibold truncate`, with the text `Bass sound`. The instrument name follows in `hintClass truncate` when it differs from the track name. This uses the same `showInstrument` rule as the header.
- **Reset sound**: `rounded-md px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${focusRing}`, with `ml-auto`.
  - When the sound is already default, it gets `aria-disabled="true"` (the same pattern as the menu items) rather than `disabled`, so it stays focusable and discoverable.
  - There is no confirmation step because the reset is one undo step.
- **Close button**: `inline-flex size-7 pointer-coarse:size-9 items-center justify-center rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 ${focusRing}`, with `aria-label="Close sound panel"` and a `×` glyph marked `aria-hidden`.

### Desktop popover (`md+`)

- **Size**: `w-[47rem] max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto`.
- **Body**: `flex flex-col gap-2 p-3`, with two rows, each `flex flex-wrap gap-2`.
  - Row 1 is Tone, EQ, and Distortion. Row 2 is Chorus, Delay, and Reverb.
  - Groups are `flex-auto`, so each row fills the width.
  - Below about 50rem of viewport the groups wrap onto a third row. That is acceptable and avoids horizontal scrolling.
- **Position**:
  - The popover opens below the Sound button, with its left edge aligned to the button's left edge and a gap of `mt-1` (4px).
  - It flips above the button if it doesn't fit below.
  - It is clamped to 8px from every viewport edge.
  - It is repositioned on scroll (capture phase) and resize, using `requestAnimationFrame`.
- **DOM placement**: render the panel immediately after the Sound button in the DOM and position it with `fixed`, so the Tab order runs `Sound button → panel → next header control` without focus wiring. Only portal it if an ancestor's `transform` or `contain` breaks `fixed`, and in that case add the focus hand-off by hand.

```
┌─ Bass sound ─────────────────────────────── Fingered Bass ─── Reset sound  × ┐
│ ┌ TONE ──────────────────────────────────┐ ┌ EQ ●On ─────────┐ ┌ DIST ○Off ─┐│
│ │  Cutoff Resonance Attack Decay Sustain Release│ │ Low   Mid   High │ │ Drive  Mix ││
│ │   (◔)    (◑)     (◔)   (◑)   (◕)    (◔)│ │ (◑)  (◑)   (◕)  │ │ (◔)   (◑) ││
│ │  420 Hz   12%   5 ms  320 ms  70% 180 ms│ │ 0 dB 0 dB +3 dB │ │ 40%   50% ││
│ └────────────────────────────────────────┘ └─────────────────┘ └╌╌╌╌╌╌╌╌╌╌╌╌┘│
│ ┌ CHORUS ○Off ──────────┐ ┌ DELAY ●On ─────────────────┐ ┌ REVERB ○Off ──────┐│
│ │ Rate   Depth   Mix    │ │ [1/16|1/8|1/8.|1/4|1/2]    │ │ Decay   Mix       ││
│ │ (◔)    (◑)    (◑)    │ │ Feedback   Mix             │ │ (◔)    (◔)       ││
│ │1.5 Hz  50%    50%     │ │  (◔)      (◔)  35%  30%    │ │ 2.5 s   30%       ││
│ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ └────────────────────────────┘ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘│
└──────────────────────────────────────────────────────────────────────────────┘
  solid border = effect on, dashed border = effect off
```

### Narrow bottom sheet (below `md`)

- **Classes**: `fixed inset-x-0 bottom-0 max-h-[60dvh] rounded-t-2xl rounded-b-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]`. The body is `overflow-y-auto overscroll-contain p-3 flex flex-col gap-2`.
- **No backdrop**, because the sheet is non-modal. `60dvh` (less than the dock's `70dvh`) leaves the song header and arrangement visible and tappable above it.
- **Layout**: groups stack one per row in chain order, at full width. The knobs inside a group are `flex flex-wrap`, so all six Tone knobs wrap to 3+3 on a 360px screen.
- **Grab handle**: an `aria-hidden` handle `mx-auto mt-2 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700` above the header. It is decoration only. There is no swipe-to-dismiss, so dismissal works the same everywhere (the × button).
- **Animation**: none by default. If one is added, use `motion-safe:` only.

```
┌──────────── 360px ────────────┐
│ arrangement (still usable)    │
├───────────────────────────────┤
│            ▬▬▬                │
│ Bass sound     Reset sound  × │
│ ┌ TONE ─────────────────────┐ │
│ │ Cutoff  Resonance  Attack │ │
│ │  (◔)     (◑)     (◔)    │ │
│ │ Decay  Sustain  Release   │ │
│ │  (◑)    (◕)     (◔)     │ │
│ └───────────────────────────┘ │
│ ┌ EQ ─────────────── ●On ───┐ │
│ │ Low     Mid     High      │ │
│ ⋮      (scrolls)              │
└───────────────────────────────┘
```

### Group

The `<fieldset>` is the right semantic for the group, but put the switch inside it.

- **Element**: `<div role="group" aria-labelledby={headingId}>`, with classes `rounded-md border px-3 pt-2 pb-3`.
  - Tone and effects that are on: `border-zinc-200 dark:border-zinc-800`.
  - Effects that are off: `border-dashed border-zinc-300 dark:border-zinc-700`.
- **Header row**: `flex items-center justify-between gap-2 mb-2`.
  - The heading is `<h3 id={headingId} class="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">`, with the text `Tone`, `EQ`, `Distortion`, `Chorus`, `Delay`, or `Reverb`.
  - Effects also have the switch (§4) in this row.
- **Knob row**: `flex flex-wrap gap-1`.

### Delay time selector

This is a segmented radio group placed above the Feedback and Mix knobs.

- **Group**: `<div role="radiogroup" aria-label="Delay time" class="inline-flex rounded-md border border-zinc-300 dark:border-zinc-700 p-0.5 mb-2">`.
- **Options**: each option is a native `<input type="radio" class="peer sr-only">` inside a `<label>`. Native radios give arrow-key movement and a single Tab stop for free.
- **Option styling**:
  - Base: `px-2 py-1 pointer-coarse:py-2 min-w-9 text-center font-mono text-xs rounded cursor-pointer`.
  - Selected: `peer-checked:bg-indigo-600 peer-checked:text-white dark:peer-checked:bg-indigo-400 dark:peer-checked:text-zinc-950`.
  - Focus: `peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-black dark:peer-focus-visible:outline-white`.
  - The selected option also gets `font-semibold`, so the selection isn't shown by colour alone.
- **Labels**:

| Value | Visible text | `aria-label` |
|---|---|---|
| `1/16` | `1/16` | `Sixteenth` |
| `1/8` | `1/8` | `Eighth` |
| `1/8d` | `1/8.` | `Dotted eighth` |
| `1/4` | `1/4` | `Quarter` |
| `1/2` | `1/2` | `Half` |

  The dot is standard notation for a dotted note.
- The selector stays adjustable when Delay is off, like the knobs.

### Knob inventory, labels, and formats

The visible label is a full word, so WCAG 2.5.3 "label in name" holds. The `aria-label` is `"{Group} {label}"`. The exception is Tone, whose names are already self-describing: `Filter cutoff`, `Filter resonance`, `Attack`, `Decay`, `Sustain`, `Release`, and `Pitch`.

| Knob | Format (readout and `aria-valuetext`) | Polarity |
|---|---|---|
| Cutoff (log) | `85 Hz`, `420 Hz`, `2.4 kHz` (1 decimal at 1k–10k, 0 decimals above) | unipolar |
| Resonance, Sustain, Drive, Depth, Feedback, all Mix | `0%`–`100%` | unipolar |
| Attack, Decay, Release, Reverb Decay | `5 ms` when under 1 s, otherwise `1.20 s` | unipolar |
| Pitch | `−3 st`, `0 st`, `+5 st` (integer, with an explicit sign) | bipolar |
| EQ Low, Mid, High | `−4.5 dB`, `0 dB`, `+3.0 dB` | bipolar |
| Chorus Rate | `1.5 Hz` | unipolar |

Use the real minus sign (U+2212) visually. `aria-valuetext` should use words, for example `minus 3 semitones` and `plus 3 decibels`, because some screen readers drop the glyph.

### Panel behaviour

- **Opening**:
  - Activating the Sound button, or the "Sound…" menu item, opens the panel for that track.
  - If another track's panel is open, it is replaced. The open track id is UI state that lives in `StudioPage`.
  - Activating the same track's button again closes the panel.
- **Focus on open**: focus moves to the `section`, which has `tabIndex={-1}` and is outlined only with `focus-visible`. A screen reader then announces "Bass sound, dialog", and no arrow-key press can change a knob by accident. The next Tab reaches Reset sound.
- **Dismissal**:
  - The panel closes on: Escape anywhere inside it, the × button, the Sound button toggle, the track being deleted, or leaving the Studio route.
  - Escape calls `stopPropagation()`, following the same pattern as `useMenuBehavior`, so studio-level Escape handlers (clip deselect) don't also fire.
- **No auto-close**: the panel does not close on an outside click, on Tab leaving it, or on a scroll. It is non-modal so the user can tweak a sound while playing, editing notes in the dock, or using the mixer. Closing it on those clicks would defeat that.
- **Focus return**:
  - Escape and × return focus to the trigger: the Sound button, or the `⋯` trigger when the panel was opened from the menu.
  - A click outside leaves focus where the user put it.
- **When the open track changes** (another Sound button is clicked), focus moves into the new panel.
- **Space**: the knobs must not consume Space, so a global play/pause shortcut still works while a knob has focus. If the studio's key handler ignores events from `role="slider"`, it should be changed to ignore only keys the knob handles: the arrow keys, PageUp, PageDown, Home, End, and Delete.

## 3. Knob (generic)

### Sizes

The component takes a `size` prop with two values.

| Size | Used by | Dial | Coarse pointer | Visual |
|---|---|---|---|---|
| `sm` | header pan (`PanKnob`) | `size-7` | `size-9` | current PanKnob look, unchanged |
| `md` | Sound panel | `size-10` (40px) | `size-11` (44px, the touch minimum) | dial with a value arc |

Each `md` cell is a vertical stack, `flex w-14 flex-col items-center gap-1`:

1. **Label**: `text-[11px] leading-none text-zinc-700 dark:text-zinc-300 whitespace-nowrap`, as a `<span aria-hidden>`. Its text is in the accessible name.
2. **Dial**: `role="slider"`, `rounded-full border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900 cursor-ns-resize touch-none ${focusRing}`. Inside it is an `aria-hidden` SVG with `viewBox 0 0 40 40`:
   - **Track arc**: a 270° arc from −135° to +135°, radius 16, `stroke-width 3`, `stroke-linecap round`, with class `stroke-zinc-200 dark:stroke-zinc-800`.
   - **Value arc**: unipolar knobs draw from −135° to the value. Bipolar knobs (EQ, Pitch) draw from 0° to the value, which shows boost against cut at a glance. Use class `stroke-indigo-600 dark:stroke-indigo-400`.
   - **Pointer**: a line from the centre to the arc, `stroke-zinc-900 dark:stroke-zinc-100`, `stroke-width 2`.
   - **Default tick**: a 1px tick outside the arc at the default position, `stroke-zinc-400`. It shows where a double-click will send the value.
3. **Readout**: `<span aria-hidden class="font-mono text-[11px] leading-none tabular-nums text-zinc-600 dark:text-zinc-400">`. It shows the formatted value and is always visible, because musicians compare values at a glance. During a gesture it switches to `text-zinc-900 dark:text-zinc-100 font-medium` to show which knob is changing.

### Floating bubble

Keep the existing floating `<output>` bubble (`-top-7`, as in PanKnob and VolumeSlider) for both sizes while a knob is focused or being dragged. On touch, the finger covers both the dial and the readout below it, so the bubble is the only value the user can see. Its text is the same formatted string as the readout. PanKnob keeps its compact `L12`/`C`/`R12` text.

### Accessibility

`role="slider"` carries:
- `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and `aria-valuetext` (formatted with units);
- `aria-orientation="vertical"`;
- `aria-keyshortcuts="Delete"`;
- `title="{Label}. Double-click or press Delete to reset."`

For the log cutoff knob, `aria-valuenow` is in Hz and `aria-valuetext` gives the formatted value.

### Effect off

When the knob's effect is off:
- the value arc changes to `stroke-zinc-400 dark:stroke-zinc-600`;
- the readout keeps its normal colour (still AA);
- the knob stays fully interactive, so do **not** set `aria-disabled` or `opacity`.

The knob also gets `aria-describedby={switchId}`. A screen reader user hears that the effect is off, so a change they hear nothing from makes sense.

## 4. Effect on/off switch

- **Element**: `<button type="button" role="switch" aria-checked={enabled} aria-labelledby={headingId}>`. The name comes from the group heading, so a screen reader announces "Reverb, switch, off".
- **Classes**: `inline-flex items-center gap-1.5 rounded-full px-1 py-0.5 pointer-coarse:py-1.5 text-xs font-medium ${focusRing}`.
- **Track**: `<span aria-hidden class="relative h-4 w-7 rounded-full transition-colors motion-reduce:transition-none">`.
  - Off: `bg-zinc-300 dark:bg-zinc-700`.
  - On: `bg-indigo-600 dark:bg-indigo-400`.
- **Thumb**: `<span class="absolute top-0.5 size-3 rounded-full bg-white shadow-sm">`. It sits at `left-0.5` when off and `left-3.5` when on, with `motion-safe:transition-[left]`.
- **Visible text**: `On` or `Off`, inside a `<span aria-hidden>`. It gets `text-indigo-700 dark:text-indigo-300` when on and `text-zinc-600 dark:text-zinc-400` when off.
- **State is never colour-only**: the thumb position, the On/Off word, and the group border (solid when on, dashed when off) all show it.
- The Tone group has no switch.

## Out of scope / notes for implementation

- A "Sound" control on the single-instrument editor pages is excluded by the spec.
- There is a pre-existing issue to check separately: on phones (`9rem` gutter with coarse 36px controls), row 2 of `TrackHeader` already appears wider than the gutter. This design doesn't add to that row below `md`.
