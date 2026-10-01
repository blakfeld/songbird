# UI Spec: Transport recording controls (task 4.1)

Covers design D7. These controls are added to `frontend/src/components/editor/Transport.tsx`, which is used by `components/studio/StudioPage.tsx:310` and `components/editor/PatternEditorPage.tsx:133` (the latter serves `/drum-machine` and `/instruments/[id]`). Every page gets the same controls. Only the target of a take differs.

## Goal

A player with a keyboard can connect it, hear a click, count in, and record without leaving the transport. The control always shows which of these is true:
- the transport is idle;
- a count-in is running;
- a take is being recorded;
- MIDI can't be used, and why.

## Layout

The outer row stays `flex flex-wrap items-center gap-x-6 gap-y-3`. New groups are appended after Follow. A group never splits internally (`flex items-center gap-2`). Only whole groups wrap.

```
Wide (sm and up):
[▶ Play] [⟲ Loop]   [x] Follow playhead   [● Record] [◷ Count-in] [♪ Metronome]   [⌨ All inputs ▾]   Bar 3 · Beat 2

While counting in:
[■ Stop] [⟲ Loop]   [x] Follow playhead   [● Record]* [◷ Count-in] [♪ Metronome]   [⌨ KeyStep ▾]     Count-in (3)

While recording (the dot pulses):
[■ Stop] [⟲ Loop]   [x] Follow playhead   [● Recording]* [◷ Count-in] [♪ Metronome] [⌨ KeyStep ▾]   Bar 5 · Beat 1
                                          * = pressed (red border and fill)

Phone (under sm, about 320–639 px). Loop, Count-in and Metronome collapse to icons:
[▶ Play] [⟲]   [x] Follow playhead
[● Record] [◷] [♪]   [⌨ All inputs ▾]
Bar 3 · Beat 2
```

### Groups, in DOM order

This is also the tab order.

1. **Play and Loop.** The existing group, unchanged except that the Loop text collapses on narrow screens.
2. **Follow playhead.** Unchanged.
3. **Record group** (new): Record, Count-in, and Metronome. These three sit together because the count-in only matters to Record, and the metronome is what a player turns on when recording.
4. **MIDI input** (new). It is its own group so that it wraps on its own when the device name is long.
5. **Readout slot.** This is the existing `PositionReadout`. During a count-in the same slot shows the countdown (see "Count-in indicator"). The countdown is a "bar 0" of position, and sharing the slot means the layout doesn't shift.

### Narrow viewports

- **Icon-only below sm:** the Loop, Count-in, and Metronome labels use `max-sm:sr-only`. Their `min-w-20` becomes `sm:min-w-20`. Each one keeps its `aria-label` and `title`, so the accessible name and the tooltip don't change.
- **Record always keeps its text,** because the word "Recording" is the non-colour signal for the recording state.
- **MIDI trigger text truncates** at `max-w-40 sm:max-w-56`. It is never hidden, because it carries the unsupported, denied, and disconnected states.
- **The readout wraps** onto its own line last.
- **Popover panels** use `max-w-[calc(100vw-2rem)]` so they never cause horizontal scroll at 320 px.

## Shared classes

Add these to `Transport.tsx`. Extract the pressed-toggle string from the existing Loop button (`Transport.tsx:101`) so that Loop, Count-in, and Metronome can't drift apart:

```ts
// Shared so the transport's on/off toggles read as one family.
const toggleClass =
  "sm:min-w-20 aria-pressed:border-zinc-900 aria-pressed:bg-zinc-200 aria-pressed:inset-ring-1 aria-pressed:inset-ring-zinc-900 aria-pressed:hover:bg-zinc-300 dark:aria-pressed:border-zinc-100 dark:aria-pressed:bg-zinc-800 dark:aria-pressed:inset-ring-zinc-100 dark:aria-pressed:hover:bg-zinc-700";

const iconClass = "size-4 shrink-0"; // same as the Loop svg; viewBox 0 0 20 20, stroke 1.5, round caps/joins
```

Recommended small refactors. These are presentational only:
- **Export the Button variants.** Export `buttonClass(variant)` from `components/ui/Button.tsx`, so that the `Menu` trigger, which takes a `triggerClassName` string, can look exactly like a secondary `Button` without copying its classes.
- **Move `components/studio/Menu.tsx` to `components/ui/Menu.tsx`.** `Transport` lives in `components/editor` and is used outside the Studio, and `EditorDock` already imports it across that boundary.

## Controls

### Record

- **Component:** `<Button>` with `aria-pressed={armed}`, `aria-keyshortcuts="R"`, `aria-label="Record"`, and `title="Record (R)"`.
  - `armed` is true from the moment Record is pressed through the count-in and the take.
  - The accessible name stays "Record" in every state. State is conveyed by `aria-pressed`. "Record" is a prefix of the visible text "Recording", so the visible label is still in the name (WCAG 2.5.3).
- **Classes:**
  ```
  min-w-32 aria-pressed:border-red-600 aria-pressed:bg-red-50 aria-pressed:text-red-700 aria-pressed:inset-ring-1 aria-pressed:inset-ring-red-600 aria-pressed:hover:bg-red-100 dark:aria-pressed:border-red-400 dark:aria-pressed:bg-red-950/40 dark:aria-pressed:text-red-300 dark:aria-pressed:inset-ring-red-400 dark:aria-pressed:hover:bg-red-950/60 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-white dark:aria-disabled:hover:bg-zinc-950
  ```
  `min-w-32` fits "Recording" so the row doesn't shift when the label changes.
- **Dot:** `<span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-red-600 dark:bg-red-500 {pulse}" />`, where `pulse` is `motion-safe:animate-pulse` only while a take is active.
  - The dot is red in every state, following the hardware record-button convention.
  - Under reduced motion the dot stays solid, and the "Recording" text carries the state.

| State | `aria-pressed` | Dot | Visible text | Notes |
|---|---|---|---|---|
| Unavailable (no MIDI access yet, unsupported, or denied) | false | solid | Record | `aria-disabled="true"` (see below) |
| Sounds loading (`playback.status === "loading"`) | false | solid | Record | `aria-disabled="true"`, reason "Loading sounds…" |
| Idle | false | solid | Record | |
| Counting in | true | solid | Record | the readout slot shows the countdown |
| Recording | true | pulsing | Recording | |

- **When disabled:** use `aria-disabled`, not `disabled`, so the button stays focusable and can explain itself.
  - Clicking it or pressing `R` does nothing except announce the reason in the status region.
  - `aria-describedby` points at an `sr-only` span with the reason, and the same text is the `title`. When MIDI isn't available, the reason is "Connect a MIDI keyboard to record." When sounds are loading, it is "Loading sounds…".
- **Pressing Record during a count-in** cancels it, exactly as Stop does: nothing is recorded and playback doesn't start. Pressing again while recording ends the take and playback continues (spec). *Behaviour to confirm with the implementer. The spec only defines Stop during the count-in.*
- **Play and Stop during a count-in:** the Play button shows **■ Stop**, because pressing it cancels the count-in.

### Count-in toggle

- **Component:** `<Button aria-pressed={countIn} aria-label="Count-in" title="Count-in: one bar of clicks before recording from stopped" className={toggleClass}>`.
- **Icon** (a stopwatch): `<circle cx="10" cy="11" r="6"/><path d="M10 11V8M8 2.5h4M10 2.5V5"/>`.
- **Text:** `<span className="max-sm:sr-only">Count-in</span>`.
- **Default:** on (from `songbird.metronome.v1`). It is always enabled, even without MIDI, because it is a setting rather than an action.

### Metronome toggle

- **Component:** `<Button aria-pressed={metronome} aria-label="Metronome" title="Metronome: click on every beat" className={toggleClass}>`.
- **Icon:** `<path d="M7.5 3h5l3 14h-11z"/><path d="M10 13l4-8"/>`.
- **Text:** `<span className="max-sm:sr-only">Metronome</span>`.
- **Default:** off.
- **Toggling while playing** takes effect from the next scheduled bar, because the engine schedules a bar at a time. No UI is needed for this.

### Count-in indicator

- **Where:** it replaces the position text in the readout slot while the pre-roll runs, driven by `subscribeCountIn`.
- **What it counts:** the beats remaining in the bar, which is beats per bar (`stepsPerMeasure / beatSteps`). That is 4-3-2-1 in 4/4, 3-2-1 in 3/4, and 2-1 in 6/8.

```tsx
<span aria-hidden="true" className="inline-flex min-w-28 items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
  Count-in
  <span className="inline-flex size-7 items-center justify-center rounded-full bg-red-50 font-mono text-base font-semibold tabular-nums text-red-700 inset-ring-1 inset-ring-red-600 dark:bg-red-950/40 dark:text-red-300 dark:inset-ring-red-400">3</span>
</span>
```

- **Colours** match the pressed Record button, which ties the countdown to the action it leads into.
- **Motion:** none. The number simply changes, so there is nothing to gate for reduced motion.
- **Screen readers:** `aria-hidden`, like the position readout, so screen readers aren't flooded with one message per beat. A single announcement covers the count-in (see "Announcements").
- **Wrapper:** both the readout and the countdown sit in one `<div className="min-w-28">` so the slot keeps its width.

### MIDI input control

The control has four forms, depending on `MidiAccess.status`.

**1. `prompt`: never asked, or not remembered.**
- A plain `<Button>`, not a menu, with a keyboard icon and the text **Connect MIDI**.
  - Keyboard icon: `<rect x="2.5" y="5" width="15" height="10" rx="1.5"/><path d="M6.5 5v6M10 5v6M13.5 5v6"/>`.
- Activating it calls `requestMIDIAccess`. This is the only place access is first requested (spec "Requesting access").
- **While the browser prompt is open:** the button is `aria-busy="true"` and `aria-disabled="true"`, and shows `<Spinner />` with "Waiting for permission…".
- **Granted:** the control becomes the menu (form 2), which opens with focus on "All inputs". Announce "MIDI connected." Record becomes enabled.
- **Denied:** the control switches to form 4 and announces "MIDI access was blocked."

**2. `granted`: a menu.** It uses the existing `Menu` (`components/studio/Menu.tsx`).
- **Trigger content:** keyboard icon, then `<span className="truncate">{label}</span>`, then `<span aria-hidden="true">▾</span>`.
- **Trigger classes:** `buttonClass("secondary")` plus `max-w-40 sm:max-w-56 min-w-0`.
- **Trigger label:**
  - "All inputs" when that is chosen;
  - the device name when one is chosen;
  - "{name} (disconnected)" when the chosen device is unplugged;
  - "No keyboard" when "All inputs" is chosen and no inputs exist.
- **Trigger accessible name:** "MIDI input: {label}". `Menu` currently uses one `label` for both the trigger and the panel. Add an optional `triggerLabel` prop so that the trigger's name contains its visible text, while the panel is named simply "MIDI input".
- **Panel:** `panelClassName="w-72 max-w-[calc(100vw-2rem)]"` and `align="left"`.

```
┌ MIDI input ─────────────────────────┐   ← text-xs heading, not focusable
│ ✓ All inputs                        │   ← menuitemradio, aria-checked
│   KeyStep                           │
│   Launchkey Mini MK3   Disconnected │   ← only if it's the chosen one and unplugged
│─────────────────────────────────────│
│ Plug in a keyboard and it appears   │   ← hint
│ here.                               │
└─────────────────────────────────────┘
```

- **Heading:** `<p role="presentation" className="px-3 pt-1.5 pb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">MIDI input</p>`.
- **Items:** `role="menuitemradio"`, `aria-checked`, and `className={menuItemClass}`.
  - A leading check svg (`size-4 shrink-0`, `<path d="M4 10.5l4 4 8-8.5"/>`) gets `invisible` when unchecked, so names stay aligned and the checked state isn't shown by colour alone.
  - The name uses `truncate`.
  - The "Disconnected" tag is `ml-auto shrink-0 text-xs text-zinc-600 dark:text-zinc-400`.
- **"All inputs"** is always first. Devices follow in the order the browser reports them, and are relabelled live as they are hot-plugged.
- **Divider:** `my-1 border-t border-zinc-200 dark:border-zinc-800`.
- **Hint:** `${hintClass} px-3 py-1.5`.
  - With no devices it reads "No MIDI keyboards connected. Plug one in and it appears here."
  - With devices it reads "Plug in a keyboard and it appears here."
- **Choosing an item:** it closes the menu, returns focus to the trigger, and saves to `songbird.midi.v1`. There is no announcement, because the trigger's new name is read when focus returns.

**3. `unsupported`** (for example Safari) **and 4. `denied`: a disclosure.**
- **Trigger:** keyboard icon, then the text **MIDI not supported** or **MIDI blocked**, then ▾. It has `aria-expanded` and `aria-controls`, with the same trigger classes as form 2.
- **Panel:** a plain `<div>`, not a `role="menu"`, because it holds text rather than choices. Classes: `absolute z-50 mt-1 ${menuPanelClass} w-72 max-w-[calc(100vw-2rem)] p-3 text-sm text-zinc-700 dark:text-zinc-300`.
  - **Unsupported:** "MIDI keyboards aren't supported in this browser. To play or record with one, open Songbird in Chrome, Edge, or Firefox. Everything else on this page still works."
  - **Denied:** "This site isn't allowed to use MIDI devices. Allow MIDI in your browser's site settings, then try again. Everything else on this page still works." Below the text is `<Button className="mt-3">Try again</Button>`, which calls `requestMIDIAccess` again and moves to form 2 on success.

## Keyboard and focus

- **`R`:**
  - add it to `ShortcutActions` as `toggleRecord?`;
  - use the same guards as Space: `isTextEntryTarget`, `defaultPrevented`, and no open `dialog`/`[role=dialog]`;
  - ignore it when `e.repeat` is set or a modifier key is held;
  - when Record is `aria-disabled`, `R` announces the reason instead.
  - Tab order is the DOM order in "Layout".
- **The MIDI menu** reuses `useMenuBehavior`, with two changes:
  - Selectors match `[role^="menuitem"]`, so that `menuitemradio` items take part in arrow-key navigation (today it only matches `menuitem`).
  - On open, focus goes to the **checked** item rather than the first one, following the ARIA APG pattern for radio menus. It falls back to the first item.
  - Existing behaviour is kept: Down and Up arrows wrap; Escape closes and returns focus to the trigger; Tab closes without trapping focus; clicking outside closes.
  - Add Home and End to jump to the first and last items.
  - Enter and Space choose an item.
  - If the focused device is unplugged while the menu is open, move focus to "All inputs".
- **The disclosure panel (forms 3 and 4):**
  - Escape closes it and returns focus to the trigger, and clicking outside closes it.
  - Focus stays on the trigger when the panel opens. Tab moves into "Try again" naturally.
  - The panel text is also linked from the trigger with `aria-describedby`, so a screen-reader user hears the reason without opening it.
- **Focus rings:** every new button uses `focusRing` (via `Button` or `menuItemClass`). Nothing removes outlines.

## Announcements

Announcements are polite and go through each page's existing `role="status"` paragraph: `StudioPage.tsx:306` and `PatternEditorPage.tsx:95`. Add an `onAnnounce: (msg: string) => void` prop to `Transport` (the pages pass `setStatus`), and let the recording adapters call the same function. Send one message per event, with nothing per beat or per note.

| Event | Message |
|---|---|
| Count-in starts | "Count-in. Recording starts after one bar." |
| Take starts (after a count-in, or punch-in) | "Recording from bar {n}." |
| Take ends, with notes | "Recorded {k} note(s). Undo removes the take." |
| Take ends, empty | "Take ended. No notes recorded." |
| Take ends with dropped notes (Studio) | Appended to the line above: " {d} note(s) weren't recorded because the song has the most clips it can hold." for `clip-limit`, or "…the most loops it can hold." for `loop-limit`. If both apply, use two sentences. |
| Stop or Record during a count-in | "Count-in cancelled. Nothing was recorded." |
| Record or `R` while unavailable | The disabled reason (see "Record") |
| Access granted / blocked | "MIDI connected." / "MIDI access was blocked." |
| Chosen device unplugged / replugged | "{name} disconnected." / "{name} reconnected." |

Bar numbers are 1-based, matching the position readout. The take-end message replaces the "Recording…" message, so the status line never goes stale.

## Accessibility checklist

- **Colour is never the only signal:**
  - recording is shown by the red dot, the "Recording" text, and `aria-pressed`;
  - the count-in by the word "Count-in" and the number;
  - the chosen input by a check mark;
  - unavailable MIDI by text.
- **Contrast:**
  - red-700 on red-50 is about 6:1;
  - red-300 on red-950/40 over zinc-950 is above 7:1;
  - the red-600 dot against white is about 4.8:1, above the 3:1 needed for non-text.
- **Reduced motion:** the only animation is `motion-safe:animate-pulse` on the dot.
- **Target size:** controls are no smaller than the existing secondary `Button`, about 36 px tall, which meets WCAG 2.5.8.
- **Live changes:** the menu list updates live, and focus is never lost when a device disappears.
