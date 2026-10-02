# UI design: sampler instrument

Input for task 3.2. It reuses the studio language from `add-audio-tracks` (`archive/2026-10-01-add-audio-tracks/ui-design.md`): zinc neutrals, `focusRing`, `menuItemClass`/`menuPanelClass`, `Menu`, `ContextMenu`, `Knob`, `Switch`, `Select`, `Button`, `ErrorAlert`, `LoopSwatch` + `loopColour`, the sample drag types (`SAMPLE_MIME`, `Files`) and `useDragActive`, `useSampleImport`, `getSamplePreview`, the `bg-zinc-900 font-mono text-xs` drag tooltip, and the page `role="status"` line (`onAnnounce`). No new colour tokens.

## 0. Shared pieces

| File | Change |
|---|---|
| `components/studio/samples/PickSampleDialog.tsx` | Rename `ReplaceSampleDialog` to `PickSampleDialog` and add `title: string` and `onImport?: () => void`. The audio panel passes `title="Replace sample"`. When `onImport` is set, the header gets a secondary `Button` "Import audio…" next to the heading. This is the keyboard path for files, since dropping a file is mouse-only. |
| `components/studio/AnchoredPopover.tsx` | Extract `ContextMenu`'s portal + viewport clamp into a popover with `role="dialog"`, `aria-label`, `anchor: {x,y}`, `returnFocusTo`, `onClose`. Escape closes and returns focus. Pointer-down outside closes. Tab past the last control closes it without returning focus, as `Menu` does. No focus trap. On open it focuses the first button. **Why not `role="menu"`:** the pad panel holds two sliders, and a `menu` may only own `menuitem`s; arrow keys would also fight the knobs. |
| `components/studio/InstrumentIcon.tsx` | Add `sampler-keys`: `<path d="M3 5h14v10H3zM7 5v6M11 5v6M15 5v6M3 3l3 1 3-2 3 2 3-1 2 1"/>` (keys under a waveform tick). Add `sampler-pads`: `<path d="M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z"/>` (2×2 pads). |
| `components/studio/TrackSoundPanel.tsx` | Export the existing `decibels`, `spokenDecibels`, `semitones`, and `spokenSemitones` formatters so the pad knobs speak and read exactly like the tone knobs. |
| `lib/audio/useSampleMissing.ts` | `useSampleMissing(sampleId \| null): boolean`. This is the same signal `AudioClipPanel` gets from `useSampleOverview(id) === "missing"`, so it may just wrap that hook. |

**Sample colour.** As for audio clips, a sample's swatch is `loopColour(song.samples.findIndex(s => s.id === id))`. The same sample then has the same colour on a pad, on the keys strip, and on audio clips.

**Announcements** (all through `onAnnounce`):

| Event | Message |
|---|---|
| Keys sample chosen | `Sampler plays vox-ah.` |
| Keys cleared | `Cleared vox-ah from Sampler.` |
| Pad assigned | `Pad 3 is now kick-808.` (`Pad 3 is now kick-808, replacing snare.` when it replaced a sample) |
| Pad cleared | `Cleared Pad 3.` |
| Multi-file pad drop | `Pads 3 to 5 are now kick, snare, hat.` (`… 2 files didn't fit after Pad 16 and stay in the library.`) |
| Root / one-shot | `Root note E3.` / `One-shot on.` |

## 1. Track creation and dock entry

### 1.1 Add Track (`AddTrackMenu.tsx`)

- In the existing `role="group" aria-label="Audio"` group, add two `role="menuitem"` buttons after "Audio", with the same `menuItemClass` and `size-6` icon:
  - `<InstrumentIcon instrumentId="sampler-keys"/> Sampler (keys)`
  - `<InstrumentIcon instrumentId="sampler-pads"/> Sampler (pads)`
- They stay above the loading and error states, since built-ins don't need the instruments request.
- New prop: `onAddSampler: (kind: "keys" | "pads") => void`.
- **Filter the reserved ids out of the Drums and Melodic groups.** `withBuiltIns()` appends sampler infos with `kind` drums and melodic, so they would otherwise also appear there under their info names. Filter on `i.id.startsWith("sampler-")`, or better, export a `BUILT_IN_IDS` set beside `withBuiltIns()`.
- The 16-track limit already disables the trigger.

### 1.2 New sampler tracks open on the roll

The scenario "Add a pad sampler" expects the piano roll with 16 pad rows right after adding. `addTrack` creates no clips today, so the dock would show `EmptyState` and the pad labels (the only place pads are assigned) would be unreachable.

**Decision:** `onAddSampler` adds the track ("Sampler" / "Pads" naming) **and one empty loop + clip at measure 1** (`NEW_CLIP_MEASURES` long), as one undo step. It selects that clip and opens the dock with focus on the strip's Choose button (keys) or the first pad label (pads). Without a clip, the user would have to write a clip before they could load a sound, which is backwards for a sampler.

If the user deletes every clip anyway:
- **Keys:** the strip still shows above `EmptyState`, so a sample can still be chosen.
- **Pads:** `EmptyState`'s hint reads "Add a clip, then drop samples on the pad names to build a kit."

### 1.3 Dock layout

`EditorDock` resolves sampler infos via `withBuiltIns()` like any instrument. The strip renders in a slot directly above the `PianoRoll`, below the Loop toolbar:

```
┌ role=toolbar "Loop" (unchanged) ─────────────────────────────────────── [⋯] [×] ┐
├ role=group "Sampler" (keys only) ────────────────────────────────────────────────┤
│ [■ vox-ah ▾]  [▶]  [Clear]   Root [C4 ▾]   [◯─ One-shot]          0:01.2 · Mono │
├──────────────────────────────────────────────────────────────────────────────────┤
│ corner: [⌨ icon] Sampler     │ ruler …                                          │
│ keyboard / pad labels        │ grid …                                           │
```

- **Keys:** a `SamplerStrip` row.
- **Pads:** no strip row, per D5. Assignment lives on the row labels (§3).
- The corner shows `InstrumentIcon` for the built-in id. The second line (`info.name`) reads "Sampler (keys)" / "Sampler (pads)".
- The track options and dock never render "Generate part with AI…" for sampler tracks.

## 2. `SamplerStrip` (keys): `components/studio/sampler/SamplerStrip.tsx`

```ts
props: {
  song: Song; track: Track;                  // track.sampler.keys
  actions: SamplerActions;                   // choose, clear, setRoot, setOneShot, importAndChoose
  onAnnounce: (m: string) => void;
}
```

Container: `<div role="group" aria-label="Sampler" className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800">`. It uses `shrink-0` for the same reason as the Loop toolbar: wrapped controls must not slide under the roll's sticky ruler.

### 2.1 Controls (left to right)

| Control | Element | Detail |
|---|---|---|
| Sample | `button` styled like the Loop picker: `inline-flex h-8 items-center gap-2 rounded-md px-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${focusRing}` | Contains `LoopSwatch` (sample colour), the name `max-w-48 truncate text-sm font-semibold`, and `▾` (`aria-hidden`). `aria-haspopup="dialog"`. **Accessible name:** `Sample vox-ah. Choose sample`, or `Choose sample` when empty. Opens `PickSampleDialog` with title `Choose sample for {track.name}`, `currentSampleId`, and `onImport`. |
| Preview | `button size-7 pointer-coarse:size-9 rounded-full border` (same as `SampleRow` preview) | `aria-label="Preview vox-ah"`, `aria-pressed`, glyph `▶`/`■`, pressed classes `bg-indigo-600 text-white dark:bg-indigo-400 dark:text-zinc-950`. It toggles `getSamplePreview()`, which plays the raw sample, dry, at its own pitch, matching the library. Clicking a key auditions it pitched and through the track. |
| Clear | `Button` (secondary, `h-8 px-2 text-sm`), text "Clear" | `aria-label="Clear sample"`. After clearing, focus moves to the Sample button. |
| Root | visible `<label>` "Root" (`labelClass text-xs`) + `Select` with `className="h-8 w-20"` | Options are MIDI 0–127 named like rows (`C-1` … `G9`, sharps as `C#4`), default `C4`. Native select: typing "C4" jumps there, and it works on phones. `aria-describedby` hint (sr-only): "The note that plays the sample at its original pitch." Each change is one undo step. |
| One-shot | `Switch` label "One-shot" | `describedBy` sr-only hint. When on: "Notes play the whole sample, whatever their length." When off: "Notes hold the sample for their length, then release." Also set `title` to the hint. |
| Meta | `p hintClass tabular-nums ml-auto max-md:hidden` | `formatLength(len, rate) · Mono/Stereo`. Omitted when empty or missing. |

On narrow screens the row wraps. Sample, Preview, and Clear stay together in one `flex items-center gap-1` cluster so the actions never separate from the name.

### 2.2 States

| State | Treatment |
|---|---|
| **Empty** (`sample_id` null) | Swatch becomes `size-3 rounded-sm border border-dashed border-zinc-400 dark:border-zinc-600`. The button text is "Choose sample…" (`font-medium`, not semibold). Preview and Clear get `aria-disabled="true"` with `opacity-50`, and are no-ops. A `hintClass max-sm:hidden` line next to them reads "or drop a sample here". Root and One-shot stay enabled, because they are document settings. |
| **Ready** | As in §2.1. |
| **Missing audio** | The name gets `⚠ ` before it, in `text-red-800 dark:text-red-300`. The swatch becomes a dashed `border-red-700 dark:border-red-400`. The accessible name is `Sample vox-ah, audio missing. Choose sample`. Preview is `aria-disabled` with `title="Audio missing"`. Below the strip (inside the group): `ErrorAlert` "The audio for vox-ah isn't in this browser, so this sampler is silent. Choose another sample, or open the project bundle that includes it." Text, glyph, and dashes carry the meaning, not just red. |
| **Drag active** (`useDragActive()` with `sample` or `files`) | Container gets `ring-1 ring-inset ring-indigo-600/40 dark:ring-indigo-400/40`. |
| **Drag over** | `ring-2 ring-inset ring-indigo-600 bg-indigo-50/60 dark:ring-indigo-400 dark:bg-indigo-950/40`, plus the drag tooltip at the pointer: `vox-ah → Sampler` (library) or `Import → Sampler` (file). `dropEffect="copy"`. |
| **Drag invalid** | Every `dataTransfer.items[i].type` is known and none is `audio/*`, or more than one item is dragged. The ring becomes `ring-red-700 dark:ring-red-400` and the tooltip reads `⊘ Not an audio file` / `⊘ Drop one sample`, with `dropEffect="none"`. |
| **Importing** (file dropped) | The Sample button shows `Spinner` + "Importing… 40%" (`motion-safe:` only, from `useSampleImport` rows) and has `aria-busy="true"`. Failures use the existing per-file `ErrorAlert` messages, shown under the strip and dismissible. |

## 3. Pad row labels: `components/studio/sampler/PadRowLabels.tsx`

### 3.1 Integration with `PianoRoll`

`PianoRoll`/`RowLabels` stay sampler-agnostic. Add an optional `PianoRoll` prop:

```ts
renderRowLabels?: (p: { rows: Row[]; ref: Ref<HTMLDivElement>; gutterClassName?: string }) => ReactNode
```

When it is set, the roll renders it instead of `<RowLabels>`. The `ref` must stay attached so the label-width measurement in `PianoRoll` still works. `EditorDock` passes `PadRowLabels` for `sampler-pads`. Row ids stay `pad-N`, and only display text changes (D1).

Container: identical to the drum branch of `RowLabels`, i.e. `sticky left-0 z-30 ${gutterClassName}`. Each row is `style={{height: "var(--row-h)"}}` (32/40px).

### 3.2 Row anatomy

```
idle, assigned   │■ kick-808                 ⋯│
idle, empty      │□ Pad 3                    ⋯│      □ = dashed swatch
missing          │⚠ snare                    ⋯│      red text, dashed red swatch
drag over        ║■ kick-808 → hat-open      ⋯║      indigo ring
```

Each row is a `div.group/pad relative flex items-center border-r border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950` containing two buttons:

1. **Audition / label button** (`data-pad-label`): `flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-1 text-left text-sm max-sm:pl-2 max-sm:text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900 focus-visible:z-20 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600`. This is the same inset outline as the piano keys, so the focus ring isn't clipped by the gutter.
   - Contents: a `size-3 shrink-0 rounded-sm` swatch, then a name span `min-w-0 truncate`.
   - Click / Enter: `onAudition(row)`. This is unchanged: clicking the label plays the pad.
2. **More button** (`data-pad-more`): `inline-flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 pointer-coarse:size-9 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50 ${focusRing}`, glyph `⋯`.
   - It is always visible, not hover-only, because touch has no hover and the gutter is 9rem even on phones.
   - `aria-label="Pad 3 settings"`, `aria-haspopup="dialog"`, `aria-expanded`.

The two hit areas don't overlap, so audition and settings never conflict.

| Look | Swatch | Name text |
|---|---|---|
| Assigned | `LoopSwatch`-style fill in the sample colour | sample name, `font-medium text-zinc-900 dark:text-zinc-100` |
| Empty | `border border-dashed border-zinc-400 dark:border-zinc-600`, no fill | `Pad N`, `font-normal text-zinc-600 dark:text-zinc-400` (≥ 4.5:1 on both backgrounds) |
| Missing | `border border-dashed border-red-700 dark:border-red-400` | `⚠ name`, `text-red-800 dark:text-red-300` |
| Importing | `Spinner` (size-3) | `Importing… 40%`, `aria-busy="true"` on the row |

`title` on the label button: `Pad 3 · kick-808 · −6.0 dB · +3 st` (gain and pitch only when not 0), or `Pad 3 · empty · drop a sample here`.

### 3.3 Accessible names (test queries)

- Label button: `Pad 3, kick-808`, or `Pad 3, empty`, or `Pad 3, snare, audio missing`. Add `aria-description` `gain minus 6 decibels, pitch plus 3 semitones` when either is non-zero.
- Scenario "Drop a kick on a pad": `getByRole("button", { name: "Pad 1, kick-808" })`, and the visible text `kick-808`.
- More button: `Pad 3 settings`.

### 3.4 Drop affordance

Uses `useDragActive()`, `dragKind`, and `readDrop` from `useSampleDrop.ts`. The whole row `div` is the drop target, including the ⋯ button.

| State | Row classes | Tooltip (drag tip style, beside the row, `aria-hidden`) |
|---|---|---|
| Idle, no drag | as above | – |
| Drag active elsewhere | `ring-1 ring-inset ring-indigo-600/40 dark:ring-indigo-400/40` on every pad row. This shows the column is a target. | – |
| Drag over, library sample | `ring-2 ring-inset ring-indigo-600 bg-indigo-50 dark:ring-indigo-400 dark:bg-indigo-950/40`. The name shows `kick-808 → hat-open` when replacing, or `hat-open` when the pad is empty, in `italic`. | `hat-open → Pad 3` |
| Drag over, file(s) | same ring | `Import → Pad 3`, or `3 files → Pads 3–5` |
| Drag over, invalid (known non-audio types, or the files would start past Pad 16) | `ring-2 ring-inset ring-red-700 dark:ring-red-400`, `⊘` before the name, `dropEffect="none"` | `⊘ Not an audio file` |

- **Multi-file drop:** files fill pads from the drop row downward, replacing what is there, up to Pad 16. This is one undo step. Files past Pad 16 are still imported to the library and reported (§0). This is the fast way to build a kit from a folder of one-shots.
- A drop is one undo step that adds the sample to `song.samples` if needed. Focus does not move on drop.
- Instrument (non-pad) drum rows keep `RowLabels` and get no drop affordance.

### 3.5 Pad settings popover: `components/studio/sampler/PadSettings.tsx`

Opened by:
- **⋯ click:** anchored under the button (`anchor = button rect bottom-left`).
- **Right-click on the row** (label or ⋯): anchored at the pointer. `preventDefault` the native menu.
- **Keyboard:** Shift+F10 or the ContextMenu key on the label button, anchored to the label. The ⋯ button also takes Enter/Space.

All three open the same `AnchoredPopover`: `role="dialog"`, `aria-label="Pad 3: kick-808"` (or `Pad 3: empty`), `panelClassName="w-64"`, using `menuPanelClass`. Closing returns focus to the label button (or to ⋯ if that opened it).

```
┌──────────────────────────────┐
│ Pad 3 · kick-808             │  p.px-3.pt-2 text-sm font-semibold truncate
│ 0:00.8 · Mono                │  hintClass tabular-nums
│ ──────────────────────────── │
│ Choose sample…               │  menuItemClass buttons
│ ▶ Preview                    │
│ Clear pad                    │
│ ──────────────────────────── │
│   (Gain)        (Pitch)      │  flex justify-around p-2
│   −6.0 dB       +3 st        │
└──────────────────────────────┘
```

| Item | Behaviour |
|---|---|
| Choose sample… | Closes the popover and opens `PickSampleDialog` (`title="Choose sample for Pad 3"`, `currentSampleId`, `onImport`). On pick, focus returns to the pad label and the result is announced. |
| Preview | `aria-label="Preview Pad 3"`. Auditions the **row through the track** (`onAudition(row)`), so gain, pitch, and tone are heard while you adjust the knobs. The popover stays open. Unlike the keys Preview, this is not raw, because this panel exists to tune the pad. |
| Clear pad | One undo step. Closes, focuses the label, announces. |
| Gain | `Knob size="md" bipolar label="Pad 3 gain"`, −24…+12, step 0.5, `defaultValue 0`, `snap {value:0, within:0.5}`, `format=spokenDecibels`, `formatReadout=decibels`. Uses `onGestureStart`/`onGestureEnd`, so one drag (or held arrow) is one undo step. Delete or double-click resets. |
| Pitch | `Knob size="md" bipolar label="Pad 3 pitch"`, −24…+24, step 1, `defaultValue 0`, `snap {value:0, within:0.5}`, `format=spokenSemitones`, `formatReadout=semitones`. Same gesture rule. |

- **Empty pad:** Preview and Clear pad are `aria-disabled`. In place of the knobs, `hintClass px-3 pb-2` reads "Choose or drop a sample to set gain and pitch." A pad entry exists only with a sample, so there is nothing to adjust.
- **Missing audio:** below the header, a compact `ErrorAlert` reads "kick-808's audio isn't in this browser, so this pad is silent." Choose sample… stays first. Preview is `aria-disabled`. The knobs stay enabled, because they are document edits.

### 3.6 Keyboard in the pad column

The column has a single tab stop, using a roving `tabIndex` like `Keyboard` in `RowLabels`. Initial focus is on Pad 1, or the last focused pad.

| Key | On the label button |
|---|---|
| ↑ / ↓, Home / End | Previous or next pad label, first or last |
| → / ← | To this row's ⋯ / back to the label |
| Enter | Audition (same as a click). Space behaves exactly as it does on the piano keys today, so transport behaviour stays consistent. |
| Shift+F10, ContextMenu | Open pad settings |
| Delete / Backspace | Clear the pad (one undo step, announced). Does nothing on an empty pad. |

- Set `aria-keyshortcuts="Shift+F10 Delete"` on the label buttons and `aria-describedby={PAD_LABELS_HELP_ID}`.
- The sr-only help reads: "Up and Down move between pads. Enter plays the pad. Shift F10 or the settings button opens the pad's sample, preview, clear, gain and pitch. Delete clears the pad."

## 4. Assigning without drag and drop

| Goal | Keyboard path |
|---|---|
| Keys: library sample | Tab to Sample → Enter → `PickSampleDialog` → ↑/↓ → Enter |
| Keys: new file | Sample → dialog "Import audio…" → file picker. After the import, the imported sample is chosen. |
| Pad: library sample | Tab to the pad column → ↑/↓ to the pad → Shift+F10 (or → then Enter) → Choose sample… → pick |
| Pad: new file | Same as above, then "Import audio…" in the dialog |
| Pad gain / pitch | Open settings → Tab to the knob → arrows / PageUp / PageDown / Delete |

Optional (P2, not required by the spec): when a sampler track is selected, the Samples panel's target line could read "Enter assigns to: Sampler" or "Enter assigns to: Pad 3 on Pads" (the last-focused pad), with Enter assigning. Skip it if it complicates `SampleList`'s library mode.

## 5. Accessibility checklist

- Icon-only controls have names: Preview (`Preview vox-ah` / `Preview Pad 3`), ⋯ (`Pad N settings`), close. Toggles use `aria-pressed` (Preview), `role="switch"` + `aria-checked` (One-shot), and `aria-expanded` (⋯).
- Meaning is never carried by colour alone:
  - empty pads by the "Pad N" text and the dashed outline;
  - missing audio by the ⚠ glyph, the accessible-name suffix, and the dashes;
  - invalid drops by the ⊘ glyph, the tooltip text, and the cursor;
  - previewing by the glyph and `aria-pressed`.
- Contrast:
  - names use zinc-900/100 and empty names zinc-600/400 (≥ 4.5:1);
  - red text uses red-800/300 (≥ 4.5:1 on white and zinc-950);
  - the ring and dashed outlines are ≥ 3:1 against adjacent colours.
- Focus is visible everywhere. Label buttons use the inset indigo outline, because the sticky gutter clips outset outlines.
- Focus is never lost:
  - after Clear, it goes to the Sample button (keys) or the pad label (pads);
  - after a pick, it goes to the invoker;
  - after the popover closes, it goes to its opener.
- Motion: spinners and import pulses are `motion-safe:` only. Drag states and rings don't animate.
- Phones: the strip wraps with `flex-wrap`. Pad names truncate inside the 9rem gutter. ⋯ grows to `size-9` on coarse pointers inside 40px rows. Nothing scrolls horizontally except the roll grid itself.

## 6. Files

**New:** `components/studio/sampler/SamplerStrip.tsx`, `PadRowLabels.tsx`, `PadSettings.tsx`; `components/studio/AnchoredPopover.tsx`; `components/studio/samples/PickSampleDialog.tsx` (renamed from `audio/ReplaceSampleDialog.tsx`); `lib/audio/useSampleMissing.ts`.

**Modified:** `AddTrackMenu.tsx` (entries, built-in filter), `InstrumentIcon.tsx`, `EditorDock.tsx` (strip slot, `renderRowLabels`, built-ins), `editor/PianoRoll.tsx` (`renderRowLabels` prop), `TrackSoundPanel.tsx` (export formatters), `TrackHeader.tsx` (no AI item for sampler tracks), `AudioClipPanel.tsx` (uses `PickSampleDialog`), `StudioPage.tsx` (`onAddSampler`, starter clip).
