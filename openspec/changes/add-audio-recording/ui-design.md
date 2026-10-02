# UI design: add-audio-recording (task 4.1)

Scope: the audio track header recording controls, the headphones warning, the live recording overlay, the Takes list and Takes submenu, the recording offset, and how Record explains why it is unavailable. This spec reuses the foundation's primitives (`Menu`, `menuItemClass`, `AnchoredPopover`, `ModalDialog`, `Button`, `InlineNameInput`, `ErrorAlert`, `focusRing`, `hintClass`, and the `toggleBase`/`toggleOff`/`dotClass` header tokens). It adds no new colour tokens. Red is already used for recording in the Transport, and amber is already used for warnings and Solo.

All user-facing strings in this document are final copy. Text in `code` is a stable accessible name or attribute that tests can rely on.

---

## 0. Layout budget (why there is a third header row)

At `md` and wider, the header is 16rem. Row 2 (M, S, Volume, Pan, Sound behind `pl-12`) already uses its full width, and phones show 9rem. No recording control fits inline in rows 1 or 2. So audio tracks get a **third row**, and their lanes get taller to make room for it. Taller lanes also make waveforms easier to read, which is the usual DAW convention for audio lanes.

`frontend/src/components/studio/TrackLane.tsx:69`. When `track.instrument === "audio"`, swap the height classes:

| | today (all tracks) | audio tracks |
|---|---|---|
| fine pointer, md+ | `h-20` | `h-28` |
| `max-md` | `max-md:h-28` | `max-md:h-32` |
| `pointer-coarse` | `pointer-coarse:h-24` | `pointer-coarse:h-32` |

Wireframe of the header (md+, fine pointer, 16rem):

```
┌──────────────────────────────────────────┐
│ ⠿ 2 [♪] Vocals                       ⋯   │  row 1 (unchanged; subline can read "● Recording…")
│          [M][S] ───●──────── (◐) [≡]     │  row 2 (unchanged)
│          [🎤 Scarlett 2i2 ▾] ▮▮▮▮▮▯▯ ▢ [🎧] │  row 3 NEW: input · meter · clip · monitor
└──────────────────────────────────────────┘
```

Phones (`max-md`, 9rem, `pl-0`): the input trigger shows only its icon, and the meter takes the remaining width.

```
│ [🎤▾] ▮▮▮▮▯▯ ▢ [🎧] │
```

**Inline:** the input trigger (showing state), the meter, the clip indicator, and Monitor.
**In a popover:** the device list, mono/stereo, the permission request and permission help, the fallback notice, a larger level meter, and the recording offset.

---

## 1. Header recording row

**New file:** `frontend/src/components/studio/audio/AudioInputRow.tsx`. `TrackHeader.tsx` renders it after row 2 when `isAudio`, with the same `pl-12 max-md:pl-0` indent:

```
<div className="flex min-w-0 items-center gap-2 pl-12 max-md:pl-0">
```

`TrackHeader` also needs an `onAnnounce` prop so it can reach the page status region (`StudioPage.tsx:651`), and access to the input device manager or hook from `lib/audio/recorder`.

### 1a. Input trigger

The trigger opens `AudioInputPopover` (1d). It is a dialog rather than a `Menu`, because it holds radios, a number field, and buttons. That is the same reason `AnchoredPopover` exists.

Classes (header family, wider than a size-7 toggle):
`inline-flex h-7 min-w-0 max-w-28 items-center gap-1 rounded border border-zinc-300 bg-white px-1.5 text-xs text-zinc-700 hover:bg-zinc-100 aria-expanded:border-zinc-900 aria-expanded:bg-zinc-200 aria-expanded:inset-ring-1 aria-expanded:inset-ring-zinc-900 pointer-coarse:h-9 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:aria-expanded:border-zinc-100 dark:aria-expanded:bg-zinc-800 dark:aria-expanded:inset-ring-zinc-100 ${focusRing}`
- These are the expanded-state classes of the Sound button (`TrackHeader.tsx:345`), so the two popover triggers look alike.
- Content: a mic icon (`size-3.5`, `aria-hidden`), then `<span className="truncate max-md:hidden">{label}</span>`, then `<span aria-hidden>▾</span>`.

| State | Visible label | Extra cue | Accessible name (`aria-label`) |
|---|---|---|---|
| Permission not asked yet | Allow mic | — | `Input for Vocals: allow microphone` |
| Waiting for the browser prompt | Allow mic + `Spinner` | `aria-busy` | `Input for Vocals: waiting for permission` |
| Device chosen and present | Scarlett 2i2 | — | `Input for Vocals: Scarlett 2i2, mono` |
| Remembered device missing, using default | Default | amber dot (`dotClass`, with `bg-amber-500` in place of indigo) | `Input for Vocals: default input (Scarlett 2i2 not connected)` |
| Permission denied | Blocked | ⊘ glyph, `text-red-700 dark:text-red-300` | `Input for Vocals: microphone blocked` |
| No input devices | No input | ⊘ glyph | `Input for Vocals: no input found` |
| Unsupported (no `getUserMedia` or insecure context) | Unavailable | ⊘ glyph | `Input for Vocals: recording not supported` |

On phones the visible label is hidden, but the dot or ⊘ glyph still shows the state without relying on colour alone. `title` repeats the accessible name. Tests should match the prefix `/^Input for Vocals/`.

### 1b. Level meter

**New file:** `frontend/src/components/studio/audio/InputMeter.tsx`. The header and the popover share it, through a `size: "sm" | "md"` prop.

- Track: `relative h-2 min-w-10 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800`. The `md` size in the popover is `h-3`.
- Fill: width is the peak in dBFS, mapped linearly from −60 to 0 dB.
  - Below −6 dB: `bg-indigo-600 dark:bg-indigo-400`.
  - From −6 to −0.1 dB: `bg-amber-400`.
  - At or above full scale: `bg-red-600 dark:bg-red-500`.
- Scale ticks: 1px marks at −18 and −6 dB, `bg-zinc-900/30 dark:bg-zinc-50/30`. The level is carried by the fill's length and position. The colour zones are an extra hint, so the amber-on-zinc contrast isn't load-bearing.
- Peak hold: a 2px line, `bg-zinc-900 dark:bg-zinc-50`, held for 1.5 s and then dropped. It does not animate a fall.
- **Rendering:** subscribe to the ~30 Hz peak stream and write `style.width` through a ref, as `PositionReadout` does, without a React render. Add no CSS transition. This keeps it cheap, and it respects reduced motion without special-casing, because the meter shows information rather than decoration.
- **Live vs idle:** the meter is live while the track is selected, monitoring, or recording, as the spec requires. When idle it shows an empty track at `opacity-40` with `title="Select Vocals to see its input level"`. It is hidden when no input is available (states blocked, no input, unsupported, and not asked yet). In those states the trigger takes the freed width (`flex-1`).
- **A11y:** `role="meter"`, `aria-label="Vocals input level"`, `aria-valuemin={-60}`, `aria-valuemax={0}`, with `aria-valuenow` and `aria-valuetext` (for example "minus 18 decibels", or "silent" below −60) throttled to 4 Hz. It is not focusable. Screen readers reach it by browsing, and clip events are announced (1c).

### 1c. Clip indicator

The clip indicator is in the same file as the meter, directly to its right. It is **always rendered**, so the layout doesn't shift and keyboard focus isn't lost when it is cleared.

- Button: `inline-flex h-7 w-6 shrink-0 items-center justify-center rounded pointer-coarse:h-9 ${focusRing}`. This meets the 24px minimum target size.
- LED inside:
  - Unlit: `h-3 w-2 rounded-sm border border-zinc-400 dark:border-zinc-600` (hollow).
  - Lit: `h-3 w-2 rounded-sm bg-red-600 dark:bg-red-500` (filled).
  - Filled versus hollow is the cue that doesn't depend on colour.
- Accessible name: `Clear clip indicator for Vocals`, always.
  - Unlit: `aria-disabled="true"` and `tabIndex={-1}`.
  - Lit: enabled, `data-clipped="true"`, `title="Input clipped. Click to clear."`
- Behaviour:
  - Any sample at or above full scale lights it. It stays lit until it is clicked, whether or not the meter is still live.
  - Clicking clears it. Focus stays on the button, which becomes `tabIndex -1` only after blur.
- Announcement: on each unlit → lit change only (not on every overload), call `onAnnounce("Vocals input clipped. Turn down the gain on your microphone or interface.")`.
- The popover's `md` meter shows the same latched state, and clearing it in either place clears both.

**Scenario "Clipping shown"**
1. Drive a full-scale peak.
2. Expect `button "Clear clip indicator for Vocals"` to be enabled, with `data-clipped="true"`, and the status text to read "Vocals input clipped…".
3. Drive more quiet peaks, and expect it to stay lit.
4. Click it, and expect `aria-disabled="true"`.

### 1d. Input popover

**New file:** `frontend/src/components/studio/audio/AudioInputPopover.tsx`. It uses `AnchoredPopover` with:
- `label="Input for Vocals"`;
- `panelClassName="w-72 max-w-[calc(100vw-2rem)] p-3"`;
- the anchor below the trigger;
- `returnFocusTo` and `anchorElement` set to the trigger.

Opening it the first time requests microphone permission, as the spec requires.

```
┌ Input for Vocals ─────────────────────────┐
│ ⚠ Scarlett 2i2 isn't connected, so Vocals  │  fallback notice (only when falling back)
│   is using the default input.              │
│ Device                                     │
│ ○ Default input (MacBook Pro Microphone)   │
│ ● Scarlett 2i2               Not connected │
│ ○ AirPods Pro                              │
│ Channels                                   │
│ [ Mono · input 1 ][ Stereo · inputs 1–2 ]  │
│ Level  ▮▮▮▮▮▮▮▯▯▯▯▯▯  ▢                    │
│ ───────────────────────────────────────── │
│ Recording offset  [   0 ] ms   Reset       │
│ hint (§5)                                  │
│ Saved in this browser only.                │
└────────────────────────────────────────────┘
```

- **Heading:** `<h2 className="text-sm font-semibold">Input for Vocals</h2>`.
- **Device:** a `<fieldset>` with `<legend className={labelClass}>Device</legend>`. Use native `<input type="radio" className="size-4 accent-indigo-600">` with labels `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900`. These match the Transport's "Follow playhead" checkbox.
  - The first option is "Default input (<system default label>)".
  - Each option's accessible name is the device label, so tests can use `getByRole("radio", { name: "Scarlett 2i2" })`.
  - A remembered device that is missing stays listed and checked, with a trailing tag `text-xs text-zinc-600 dark:text-zinc-400` that reads "Not connected". This is the MIDI control's "Disconnected" pattern (`MidiInputControl.tsx:297`). Choosing it again keeps it remembered, and recording resumes on it when it is plugged back in.
  - Changing the choice takes effect immediately. The popover stays open so the user can watch the level, and the choice is stored per track in browser storage.
- **Channels:** a `<fieldset>` with `<legend>Channels</legend>`, made of two radios styled as a segmented pair. Use `peer` radios with `sr-only` inputs and labels `flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-center text-sm peer-checked:border-zinc-900 peer-checked:bg-zinc-200 peer-checked:inset-ring-1 peer-checked:inset-ring-zinc-900 peer-focus-visible:outline-2 …` (the transport toggle look).
  - Labels: "Mono · input 1" and "Stereo · inputs 1–2". Accessible names: `Mono` and `Stereo`, with the input numbers in `aria-describedby`.
  - When the device reports one channel, Stereo is disabled, with the hint "This input has one channel."
  - The default is Mono.
- **Fallback notice:** `role="status"`, styled `rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200`, with an `aria-hidden` ⚠ glyph.
  - Copy: "Scarlett 2i2 isn't connected, so Vocals is using the default input."
- **Level:** `InputMeter size="md"` with its clip indicator, labelled "Level". The meter is always live while the popover is open, so the user can set gain here.
- **Footer:** `<p className={hintClass}>Saved in this browser only. Plug in a microphone or interface and it appears here.</p>`

**Permission states inside the popover** (they replace the Device, Channels, and Level sections):

| State | Content |
|---|---|
| Asking | `Spinner` and "Waiting for permission… Your browser is asking to use the microphone. Choose Allow." (`aria-live="polite"`) |
| Denied | The text below, plus a `Button` labelled "Try again" that queries the permission again and requests it if the browser allows. |
| No input | "No microphone or audio interface found. Plug one in and it appears here." |
| Unsupported | "Recording isn't supported in this browser. To record, open Songbird in a current version of Chrome, Edge, Firefox, or Safari." |

Denied copy (`DENIED_MIC_TEXT`, kept beside the MIDI copy so that both read alike):
> Microphone access is blocked for this site, so audio can't be recorded. To allow it, click the site settings icon beside the address bar, set Microphone to Allow, then choose Try again. Everything else still works.

**Scenario "Choose an interface input"**
1. Click `button /^Input for Vocals/`. A dialog "Input for Vocals" opens.
2. Choose `radio "Scarlett 2i2"`, then `radio "Mono"`.
3. Expect the trigger name to be `Input for Vocals: Scarlett 2i2, mono`.
4. Remount, and expect the same name.

**Scenario "Permission denied"**
1. Mock `getUserMedia` to reject with `NotAllowedError`.
2. Expect the trigger name to be `Input for Vocals: microphone blocked`.
3. Opening the trigger shows the denied copy.
4. Expect `button "Record"` to have `aria-disabled="true"` and a description that equals `RECORD_MIC_BLOCKED` (§6).

### 1e. Monitor toggle

The toggle is in `AudioInputRow.tsx`, at the end of row 3.

- It uses `toggleBase` with `inline-flex items-center justify-center`.
  - Off: `toggleOff` with `hover:bg-zinc-100 dark:hover:bg-zinc-800`.
  - On: `bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950`. The filled neutral is deliberately different from M (indigo) and S (amber), so that the three toggles can't be confused, and it adds no token.
- Content: a headphones icon (`size-4`, `aria-hidden`).
- `aria-label="Monitor Vocals"`, `aria-pressed`, and `title="Monitor: hear your input through this track's effects"`.
- It is off by default, and the setting is not saved in the song.
- When there is no permission or no input, it uses `aria-disabled="true"` with `aria-describedby` pointing at the input trigger's state text. Pressing it in that state opens the input popover, so that the user lands on the explanation.
- When permission hasn't been asked yet, the first press shows the warning (§2) if needed, and then requests permission.
- While Mute is on (or the track is silenced by another track's solo), the toggle stays pressed, and the button takes `opacity-60` with `title="Monitor: silenced by Mute"`. This shows that monitoring is armed but not heard, which matches the spec's mute and solo rules.

---

## 2. Headphones warning (first time Monitor is turned on)

The warning is a **modal dialog that appears before monitoring starts**, not an inline note. On speakers, feedback starts the instant the route opens, so a warning shown after the fact is too late.

**New file:** `frontend/src/components/studio/audio/MonitorWarningDialog.tsx`. It uses `ModalDialog` with `role="alertdialog"`, `labelledBy`, and the default class. Its layout copies `RemoveSampleDialog.tsx` (`flex flex-col gap-3`, an `h2 text-base font-semibold`, body `text-sm text-zinc-700 dark:text-zinc-300`, and `flex justify-end gap-2` for the buttons).

Copy:
- **Title:** "Wear headphones to monitor"
- **Body:** "Monitor plays your microphone back to you as you sing or play. Through speakers, the microphone can pick that sound up again and cause loud feedback. Plug in headphones first, or keep the volume low."
- **Small print** (`hintClass`): "You won't be asked again in this browser."
- **Buttons:** `Cancel` (secondary, `autoFocus`, so the safer choice is the default for Enter) and `Turn on Monitor` (primary).

Behaviour:
- "Turn on Monitor" stores the browser flag, turns Monitor on, and returns focus to `button "Monitor Vocals"`.
- Cancel or Escape leaves Monitor off, does **not** store the flag, and returns focus to the toggle.
- The dialog is shown once per browser, not once per track.

Test names: `alertdialog "Wear headphones to monitor"`, `button "Turn on Monitor"`, and `button "Cancel"`.

---

## 3. Live recording overlay on the lane

**New file:** `frontend/src/components/studio/audio/RecordingOverlay.tsx`. `AudioClipLane.tsx` renders it after the clips, while the store's transient recording overlay targets this track.

- Position: `ticksStyle(punchInTicks, elapsedTicks)` (the same helper the clips use), with `pointer-events-none absolute top-1 bottom-1 z-10 overflow-hidden rounded-md border border-red-600 bg-red-50/90 dark:border-red-400 dark:bg-red-950/70`.
  - The near-opaque fill visually replaces the clips it covers, which previews the "replace only in the recorded span" result.
- Header strip: this matches the clip block's name strip (`AudioClipBlock.tsx:76`), with `absolute inset-x-0 top-0 flex h-4 items-center gap-1 px-2 text-[11px] leading-4 font-medium text-red-800 dark:text-red-200`. It holds:
  - a dot, `size-1.5 rounded-full bg-red-600 motion-safe:animate-pulse`, which is static under reduced motion;
  - the text "Recording · Take 4". When looping, it becomes "Recording · Take 5 · pass 2".
  - The word "Recording" is the cue that doesn't depend on colour.
- Waveform: an SVG `<path>` in `fill-red-600/70 dark:fill-red-400/70`, built from the peaks stream with `top-4 bottom-0.5`, the same geometry as `Waveform`.
  - Append to it and update it through a ref on `requestAnimationFrame` (coalescing the 30 Hz posts), not through React state.
  - Its width grows with the playhead, using the same clock as `subscribePosition`.
- **During count-in:** draw only a 2px start marker, `absolute inset-y-0 w-0.5 bg-red-600 dark:bg-red-400`, at the punch-in point, so the user sees where the take will land.
- **Loop wrap:** the overlay restarts at the loop start, and the pass number increments. Earlier passes are not drawn, because the clip will play the last one.
- **End:** the overlay unmounts in the same render as the new clip mounts, so nothing flashes.
- **A11y:** `aria-hidden="true"`. Recording state reaches assistive technology through the Transport's Record button (`aria-pressed`, the "Recording" label) and these status messages (add them to `frontend/src/components/editor/recordingMessages.ts`):

| Event | Message |
|---|---|
| Start | "Recording Vocals from bar 3." |
| End, single take | "Recorded Vocals Take 4, 8 bars. Undo removes the take." |
| End, loop | "Recorded 3 takes on Vocals. The clip plays Take 6. Earlier passes are in its Takes list." |
| Auto-stop at 20 min | "Recording stopped after 20 minutes. What was recorded is kept." |
| Auto-stop at 128 measures | "Recording stopped at measure 128, the end of the song. What was recorded is kept." |
| Input lost mid-take | "Vocals input disconnected. Recording stopped. What was recorded is kept." |
| Storage write failed | "Couldn't save the recording because browser storage is full. Nothing was added." Also show `ErrorAlert` under the Transport with the same text and " Remove unused samples or takes, then try again." |

- **Header cue:** while recording, the row-1 subline in `TrackHeader.tsx` shows `● Recording…` (dot `aria-hidden`) in `text-xs text-red-700 dark:text-red-300`. It sits where "Generating…" goes, and uses that same pattern.

---

## 4. Takes list (audio clip panel) and Takes submenu

### 4a. Panel section

**New file:** `frontend/src/components/studio/audio/TakesList.tsx`. `AudioClipPanel.tsx` renders it after the knobs row, as `<section aria-labelledby={headingId} className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">`.

```
Takes (4)                            [Delete unused (2)]
┌──────────────────────────────────────────────────────┐
│ Vocals Take 4        0:42 · Mono           [Current] ⋯ │
│ Vocals Take 3        0:42 · Mono                      ⋯ │
│ Vocals Take 2        0:42 · Mono  [Unused] [In library] ⋯ │
│ Vocals Take 1        0:31 · Mono  [Unused]            ⋯ │
└──────────────────────────────────────────────────────┘
```

- **Header:** `<h3 id className="text-sm font-semibold">Takes <span className={hintClass}>(4)</span></h3>`, and on the right a `Button` labelled `Delete unused (2)`, `className="!py-1"` as in `ErrorAlert`. The button is hidden when nothing is unused. It is one undo step.
- **Order:** newest first, by take number. The order is stable, so the current take is marked but not pinned to the top. When the panel opens, scroll the current row into view.
- **List:** `<ul aria-label="Takes on Vocals">`. Rows copy `SampleRow.tsx:82`: `flex h-12 items-center gap-2 border-b border-zinc-200 px-2 dark:border-zinc-800`, with `aria-current` on the current row's `li`.
  - **Main button** (`flex min-w-0 flex-1 items-center gap-2 rounded text-left ${focusRing}`):
    - It holds the name (`block truncate text-sm`, `font-semibold` when current) and, under it, `${hintClass} tabular-nums` with "0:42 · Mono", built with `formatLength`.
    - `aria-label="Use Vocals Take 2"`, with `aria-describedby` pointing at the length line.
    - The current take's button has `aria-current="true"` and `aria-disabled="true"`, because pressing it does nothing.
  - **Badges** use the `SampleRow` badge class `shrink-0 rounded bg-zinc-100 px-1 text-[11px] dark:bg-zinc-800`: "Current", "Unused" (no clip uses it), and "In library". The badges are visible text, so they don't rely on colour.
  - **Row menu:** a `Menu` with `label="Take actions for Vocals Take 2"`, the `⋯` trigger, and the same trigger class as the panel's clip-actions menu. Items:
    - `Rename…`: swaps the main button for `InlineNameInput`, with `label="Take name Vocals Take 2"` and the sample name maximum length.
    - `Add to library`: after it is added, it becomes `aria-disabled` and reads "In library".
    - `Delete take`: `aria-disabled` when the take is in use, with the hint "Used by 1 clip" or "Used by 2 clips" (`hintClass`), as for Duplicate's "No room after this clip".
- **Keyboard:** use the sample list's model.
  - Roving `tabIndex` across the main buttons. ↑/↓ and Home/End move between them.
  - Enter uses the focused take, and F2 renames it.
  - Delete or Backspace deletes the take if it is unused. If it is in use, nothing is deleted, and the status region says why.
  - Shift+F10 opens the row's menu. Tab moves to the row's ⋯ and then out of the list.
- **Empty** (the track has no recorded takes): `<p className={hintClass}>No takes on Vocals yet. Select the track and press Record.</p>`. It stays visible, so users who only import audio learn that recording exists.
- **After an action,** focus and announce:

| Action | Result |
|---|---|
| Switch | "Clip now plays Vocals Take 2." If the take is shorter than the clip, add " Shortened to fit the take." Focus stays on the row, which is now current. |
| Rename | Commit returns focus to the main button. No announcement is needed, because the name is visible. |
| Delete | "Deleted Vocals Take 1. Undo restores it." Focus moves to the next row, or to the previous row if it was the last. There is **no confirmation**, because it is one undo step, unlike library removal. |
| Add to library | "Added Vocals Take 2 to Samples." |
| Delete unused | "Deleted 2 unused takes. Undo restores them." |

- **Refusal at the takes limit:** this belongs to Record (§6). The Takes list shows the hint "64 of 64 takes. Delete unused takes to record more." in `text-xs text-amber-800 dark:text-amber-300` once a track has 60 or more takes.

**Scenario "Switch to an earlier take"**
1. Click `button "Use Vocals Take 2"`.
2. Expect the clip's accessible name to start with "Vocals Take 2", its `start_ticks` to be unchanged, the row to have `aria-current`, and one undo step (Cmd/Ctrl+Z restores Take 3).

**Scenario "Delete an unused take"**
1. Open `button "Take actions for Vocals Take 1"` and choose `menuitem "Delete take"`.
2. Expect `song.samples` to no longer contain it, and the row to be gone.
3. For a take that is in use, the item is `aria-disabled`, with the hint "Used by 1 clip".

**Scenario "Add a take to the library"**
1. Open `button "Take actions for Vocals Take 2"` and choose `menuitem "Add to library"`.
2. Expect the "In library" badge, and the Samples panel to list "Vocals Take 2".

### 4b. "Takes" in the clip context menu

This goes in `frontend/src/components/studio/audio/AudioClipMenu.tsx` (`AudioClipMenuItems`), with the items in a new `TakesMenuItems.tsx`.
- Because `AudioClipMenuItems` is shared, right-click, Shift+F10, and the dock's ⋯ all get it with no change to `Menu` or `ContextMenu`.
- It is a **drill-in submenu inside the same panel**, not a flyout. A flyout would need new positioning and collision code, and it breaks on phones. A drill-in reuses the panel's existing viewport clamping and `max-h-80` scrolling.

Main list, after Loop and its separator:

```
Loop                 ✓
───────────────
Takes (4)            ›     ← role=menuitem, aria-haspopup="menu", aria-expanded=false
Replace sample…
Duplicate          ⌘D
Delete            Del
```

When the user opens Takes (Enter, Space, →, or a click), the items swap in place:

```
‹ Back
───────────────
TAKES (heading, role=presentation)
✓ Vocals Take 4
  Vocals Take 3
  Vocals Take 2         Unused
  Vocals Take 1         Unused
───────────────
Rename current take…
Add current take to library
Delete unused takes (2)
All takes…
```

- Hold the drill-in state locally in `TakesMenuItems`. On swap, focus the checked take, or the first take if none is checked. ← or `Back` returns to the main list with focus on "Takes". Escape closes the whole menu, as it does today.
- Take items use `role="menuitemradio"` with `aria-checked`, the accessible name equal to the take name, and the check mark rendered as in `MidiInputControl`'s `InputItem`. Choosing one switches the take and closes the menu.
- **Rename current take…** opens the dock (if it is closed) and starts the inline rename on that row in the Takes list. Renaming needs a text field, and a menu can't own one.
- **Add current take to library** becomes `aria-disabled` with the label "Current take is in library" once it has been added.
- **Delete unused takes (N)** does the same as the panel's button. It is hidden when N is 0.
- **All takes…** opens the dock and focuses the Takes heading.
- When the clip plays an imported sample (not a take): Rename and Add are `aria-disabled`, with `<p className={hintClass}>This clip doesn't play a take</p>` and `aria-describedby` wiring, as for Duplicate's hint.
- The "Takes" item is hidden when the track has no takes.
- Test names: `menuitem "Takes (4)"` (match with `/^Takes/`), `menuitem "Back"`, `menuitemradio "Vocals Take 2"`, `menuitem "Delete unused takes (2)"`, and `menuitem "All takes…"`.

---

## 5. Recording offset

- **Where:** in the input popover (§1d), under a separator, labelled as a Studio-wide setting. There is no Studio settings surface today. The offset is something the user calibrates while setting up an input, so putting it where they choose the device makes it findable without adding a new settings page for one value. Every audio track's popover shows the same value.
- **New file:** `frontend/src/components/studio/audio/RecordingOffsetField.tsx`, with storage in a `useRecordingOffset` hook built like `useMetronomeSettings`.
- **Control:**
  - `<label className={labelClass}>Recording offset</label>`, then `<input type="number" min={-200} max={200} step={1} inputMode="numeric" className={`${inputClass} h-8 w-20 text-right tabular-nums`}>`, then the suffix `<span className={hintClass}>ms</span>`.
  - A "Reset" text button (`text-sm underline-offset-2 hover:underline ${focusRing}`) is shown only when the value is not 0. Reset sets the value to 0 and keeps focus on the field.
  - Native ↑/↓ change the value by 1. Clamp it to the range on blur and on Enter. Out-of-range input gets `aria-invalid` with the hint "Between −200 and +200 ms". An invalid value is never stored.
- **Hint** (`aria-describedby`, `hintClass`):
  > Applies to all tracks. If recordings land late, raise it; if early, lower it. Clap test: record a few claps on the beat with the metronome on, see how far each clap lands from the beat line, and enter that distance. Takes already recorded don't move.
- **Test name:** `spinbutton "Recording offset"`.

---

## 6. How Record explains why it is unavailable

Keep the existing mechanism. In `Transport.tsx:240–260` the reason is shown through `aria-disabled`, `title`, an `sr-only` description, and an announcement on press, all through `useRecordControl`. Only the reasons change.

- **Constants and logic:** `frontend/src/components/editor/useRecordControl.ts`.
  - `RECORD_NEEDS_MIDI` applies only when `needsMidi(selectedTrack)`.
  - `RECORD_NOT_ON_AUDIO` in `StudioPage.tsx:273` is replaced by the audio reasons below.

| Condition (audio track selected, idle) | Reason string | Inline cue in the header |
|---|---|---|
| Permission not asked yet | *(not blocked)* Pressing Record requests permission, then starts or counts in. The press counts as the user gesture. | Trigger reads "Allow mic". |
| Permission denied | `RECORD_MIC_BLOCKED` = "Microphone access is blocked. Allow it in your browser's site settings to record audio." | Trigger reads "Blocked". |
| No input device | `RECORD_NO_INPUT` = "No audio input found. Connect a microphone or interface to record." | Trigger reads "No input". |
| Unsupported | `RECORD_AUDIO_UNSUPPORTED` = "This browser can't record audio." | Trigger reads "Unavailable". |
| 64 takes on the track | `RECORD_TAKES_FULL` = "Vocals has 64 takes, the most a track can hold. Delete unused takes to record more." | Takes list hint. |
| 256 samples in the song | `RECORD_SAMPLES_FULL` = "This song has 256 samples, the most it can hold. Remove unused samples or takes to record more." | — |
| Not enough storage | `RECORD_NO_SPACE` = "Not enough browser storage to record. Remove unused samples or takes, then try again." | — |

- **Visible explanation for sighted and touch users:** pressing a blocked Record already writes the reason to the visible status line (`StudioPage.tsx:651`). For mic-blocked and no-input, the press **also opens that track's input popover**. That puts the how-to-allow help (§1d) in front of the user, without a separate banner. Keyboard focus moves into the popover, and Escape returns it to Record.
- The per-track reasons name the track, so that the reason stays correct when the selection changes. Recompute `recordBlockedReason` from the selected track on every render.

---

## 7. Files

| File | Change |
|---|---|
| `frontend/src/components/studio/TrackHeader.tsx` | Render `AudioInputRow` for audio tracks, add the "● Recording…" subline, add the `onAnnounce` prop |
| `frontend/src/components/studio/TrackLane.tsx` | Audio lane height classes (§0) |
| `frontend/src/components/studio/audio/AudioInputRow.tsx` | **new**: trigger, meter, clip indicator, Monitor |
| `frontend/src/components/studio/audio/InputMeter.tsx` | **new**: meter and clip indicator (`sm` and `md` sizes) |
| `frontend/src/components/studio/audio/AudioInputPopover.tsx` | **new**: devices, channels, permission states, offset |
| `frontend/src/components/studio/audio/RecordingOffsetField.tsx` | **new** |
| `frontend/src/components/studio/audio/MonitorWarningDialog.tsx` | **new** |
| `frontend/src/components/studio/audio/RecordingOverlay.tsx` | **new**, rendered by `AudioClipLane.tsx` |
| `frontend/src/components/studio/audio/TakesList.tsx` | **new**, rendered by `AudioClipPanel.tsx` |
| `frontend/src/components/studio/audio/TakesMenuItems.tsx` | **new**, rendered by `AudioClipMenu.tsx` |
| `frontend/src/components/editor/recordingMessages.ts` | Audio start, end, and stop messages (§3), and `DENIED_MIC_TEXT` |
| `frontend/src/components/editor/useRecordControl.ts` | Audio reasons (§6) |

## 8. Out of scope here

- Choosing which interface input feeds mono (always input 1, per the spec).
- Previewing a take before switching to it.
- A per-track record-arm button: Record follows the selected track.
