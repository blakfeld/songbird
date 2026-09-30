# UI Spec: Timeline Loop Region

Visual and interaction spec for design D3 (`LoopRegion` over `MeasureRuler`) and D4 (the transport Loop toggle). It reuses the current tokens: zinc neutrals, the `focusRing` outline from `components/ui/classes.ts`, `Button` variants, `cursor-grab`/`cursor-ew-resize` from `ClipLane`/`NoteBar`, and `min-w-[3px]` from clip blocks. It adds no new theme tokens.

## 1. Colour and why it stays neutral

- The region keeps the **existing loop colour**, which is zinc, as in today's `MeasureRuler` `data-in-loop` cells and its `zinc-700/300` edges.
- Amber is taken by the playhead (`Playhead.tsx`). Indigo, amber, teal, rose, sky, and lime are taken by the clip palette (`loopPalette.ts`). A coloured region would read as a clip or as the playhead.
- On/off is never signalled by colour alone. **Solid** vs **dashed** strokes carry it, together with the accessible name and `aria-pressed`.

## 2. Structure and mounting

```
MeasureRuler root (sticky top-0 z-30 flex h-7, becomes `relative` context)
├─ measure cells …                          (unchanged, static)
└─ {children} → <LoopRegion>  absolute inset-0
   ├─ hit layer        div   absolute inset-0 z-0      draw surface (always rendered)
   ├─ set button       button "Set loop region"          (only when there is no region; section 9)
   ├─ group            div   role="group" aria-label="Loop region" className="group/loop"   (only when a region exists)
   │  ├─ start handle  div   role="slider"   z-20
   │  ├─ body          button aria-pressed   z-10
   │  └─ end handle    div   role="slider"   z-20      (DOM order = tab order: start, body, end)
   ├─ readout chip     div   aria-hidden, only while dragging or keyboard-focused
   └─ live region      p     sr-only aria-live="polite"   (always rendered, so the first draw is announced)
```

- `MeasureRuler` gains an optional `children` prop, rendered as the last child of its root. The root is already `sticky`, which is a containing block, so no extra wrapper is needed and the overlay scrolls and sticks with the ruler on both pages.
- Remove `loop` from `MeasureRuler`, along with the `data-in-loop`, `data-loop-start`, `data-loop-end` attributes, the `bg-zinc-200` in-loop fill, the zinc-700 loop edges, and the forced start/end labels. The overlay now draws all of these. At narrow Studio widths the forced labels collide (see section 7).
- Geometry uses the same unit as `LoopShade`. Let `unit = calc(${stepsPerMeasure} * var(--cell-w))`. Then `left: calc(${start - 1} * unit)` and `width: calc(${end - start + 1} * unit)`.
- Test hooks on the body: `data-testid="loop-region"`, `data-enabled="true|false"`, `data-start`, `data-end`. With no region there is no `loop-region` element, which is how tests assert the default.

### No region

With `loop.region === null` (the default for new and legacy work), the ruler shows **nothing beyond the ruler itself**: the measure cells, numbers, and ticks, with no strip, edge, handle, grip, or chip, whether looping is on or off. Only the transparent hit layer is present, with `cursor-crosshair`, so the whole ruler is a draw surface, plus the visually hidden "Set loop region" button (section 9), which appears only while it has focus. The Loop toggle is the only visible sign that looping is on in this state. No `LoopShade` renders.

## 3. Region styles

The body fills the full 28px ruler height (`inset-y-0`), so measure numbers and beat ticks show through the translucent fill.

| Part | Enabled | Disabled (dimmed) |
|---|---|---|
| Body fill | `bg-zinc-900/10 hover:bg-zinc-900/15 dark:bg-white/15 dark:hover:bg-white/20` | `bg-zinc-900/[0.04] hover:bg-zinc-900/10 dark:bg-white/5 dark:hover:bg-white/10` |
| Top band (the "cycle bar", 3px, above the labels at `top-1`) | `before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-zinc-800 dark:before:bg-zinc-200` | `before:… before:h-0 before:border-t-2 before:border-dashed before:border-zinc-500 dark:before:border-zinc-400` |
| Edges (2px, inside the bounds) | `border-x-2 border-zinc-800 dark:border-zinc-200` | `border-x-2 border-dashed border-zinc-500 dark:border-zinc-400` |

Shared body classes:

```
absolute inset-y-0 z-10 min-w-[3px] cursor-grab select-none touch-none transition-colors
motion-reduce:transition-none active:cursor-grabbing
```

- **Contrast:** zinc-800 on white is about 14:1 and zinc-500 on white is about 4.8:1, so both pass the 3:1 non-text rule. zinc-700 labels over the 10% tint stay above 7:1.
- **Dragging** (move, resize, or a draw preview): render the region with the **enabled** style whatever the setting, because drawing turns looping on and the preview should show the result. Add `shadow-sm` and switch to `cursor-grabbing` (move) or `cursor-ew-resize` (resize/draw). The preview is local state; commit on release (D3).
- **Whole-length region:** a drawn region that covers every measure keeps the same style and spans the ruler. A drag on its body moves it (which does nothing at full length); there is no draw exception for it. To draw elsewhere, the user shrinks it by an edge first. `LoopShade` renders nothing in this case (D3).
- **`LoopShade`:** keep its classes as they are. Render it only when `enabled && region !== null && !whole`.

## 4. Edge handles

Each handle is a transparent hit strip with a visible grip. The 2px edge line belongs to the body, so the edge is always visible even while the grip is hidden.

```
start handle: group/handle absolute inset-y-0 z-20 w-3 cursor-ew-resize touch-none pointer-coarse:w-6
              (+ focus ring, section 6)
grip:         aria-hidden span, absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2
              h-3.5 w-1 rounded-full bg-zinc-800 dark:bg-zinc-200
              opacity-0 group-hover/loop:opacity-100 group-focus-visible/handle:opacity-100 (and while dragging)
              pointer-coarse:opacity-100 (touch has no hover)
```

- **Hit width:** 12px (`w-3`) for fine pointers and 24px (`pointer-coarse:w-6`) for touch. This meets the design's 8px minimum and WCAG 2.5.8 (24px target) on touch.
- **Placement, normal case** (the region is at least `2 × hit + 8px` wide in pixels): each handle straddles its edge, half inside and half outside. For the start handle, `left: calc(<startX> - 6px)`. The body keeps at least 8px of grab area in the middle.
- **Placement, compact case** (a narrower region, as on most of the Studio at 128 measures): both handles sit **fully outside** the region. The start handle's right edge is on the start line and the end handle's left edge is on the end line. The body keeps its whole pixel width for click-to-toggle and move. The component needs the pixel width of a measure to decide this, so it takes a `measurePx` prop:
  - `Arrangement` already computes `measureWidth`;
  - `PianoRoll` passes `spm * 28`, which is always the normal case.
- **Ruler bounds:** hit strips never extend past the ruler.
  - If `start === 1`, the start handle is placed at `left: 0` inside the region.
  - If `end === measures`, the end handle is placed at `right: 0` inside the region.
  - Here the handles overlap the body, and the handle wins because it is at z-20 over z-10.
  - Otherwise they would slip under the sticky gutter/corner (`z-40`) and be unreachable.
- **Handles overlapping each other:** this only happens with a 1-measure region at the ruler edge. The **end handle stacks above the start handle** (`z-[21]`), because growing a tiny region rightwards is the common intent.
- **Handles over the draw layer:** press positions inside a handle's outside half resize rather than draw. That is intended, because near an edge "resize" and "draw from here" produce nearly the same result, and resizing keeps the other edge.

## 5. Cursors

| Target | Idle | During drag |
|---|---|---|
| Empty ruler (hit layer) | `cursor-crosshair` (draw) | `cursor-ew-resize` |
| Body | `cursor-grab` (matches `ClipLane`) | `cursor-grabbing` |
| Handle | `cursor-ew-resize` (matches `NoteBar`/`ClipLane` resize) | `cursor-ew-resize` |

With pointer capture, the capturing element owns the cursor, so set the drag cursor on the element that captured the pointer. Add `select-none` to the hit layer so a draw never selects label text.

**Touch trade-off:** the overlay uses `touch-none`, so on the single-instrument pages a horizontal swipe **on the 28px ruler** draws instead of scrolling. The grid below still scrolls. This is acceptable because a drag on the ruler now has a meaning, and it matches how clip blocks behave.

## 6. Focus rings

All three use the `focusRing` colours (`outline-black` / `dark:outline-white`) with an **inset** offset. They sit inside the sticky ruler, next to the sticky corner, where an outward ring would be clipped.

| Part | Classes | Reads as |
|---|---|---|
| Start handle | `focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-black dark:focus-visible:outline-white` + grip shown | a tall narrow box straddling the start edge |
| End handle | same | the same box on the end edge |
| Body | `focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-black dark:focus-visible:outline-white` | a box inset inside the region's edges, so it is distinguishable from a focused edge |

- In the compact case the body can be narrower than its inset ring. Fall back to `focus-visible:outline-offset-0` there (use `data-compact`: `data-[compact]:focus-visible:outline-offset-0`).
- The readout chip (section 8) also appears on `:focus-visible`, which names the focused part.
- Never remove the outline on `:focus` for mouse users. Use `focus-visible` only, as the codebase already does.

## 7. The 128-measure Studio ruler

Numbers assume the arrangement lane (`100cqw` minus the gutter). At a 1000px lane each measure is about 7.8px. At a 390px phone (a lane of about 240px) each measure is about 1.9px.

- **Region width** is true to scale, with a `min-w-[3px]` floor so a 1-measure region never disappears.
  - Below 6px the body collapses to a solid block. Drop `border-x-2` and use `bg-zinc-800 dark:bg-zinc-200`, or the dashed outline `outline-1 outline-dashed outline-zinc-500` when disabled, because two 2px edges plus a tint cannot be told apart at that size.
- **Handles** use the compact placement from section 4. Their hit strips are much wider than a measure: 12 or 24px against 2 to 8px measures. That is the intent, since pixel precision comes from the keyboard sliders and the readout chip, not from the pointer.
- **Snapping** follows `floor(x / measurePx)` (D3). The readout chip shows the snapped measures live during a drag, so the user can see which tiny measure they are on.
- **Labels:** `MeasureRuler` keeps its `labelEvery` thinning and no longer forces start/end labels, which would collide at 2 to 8px measures. The body's `title` gives the exact span on hover: `Loop region: measures 5–8 (looping on)`.
- **Grips:**
  - On fine pointers they are hidden until hover, focus, or drag, because adjacent grips on a 1-measure region would overlap into a blob.
  - On touch (`pointer-coarse`) they show all the time. If `regionPx < 8`, render only the end grip, since its handle is the one on top.
- **Body click-to-toggle** stays available at any width of 3px or more. For a 1-measure region at measure 1 on a phone, the start handle covers the body. The Loop toggle in the transport is the fallback, and that is the reason it exists (D4).

## 8. Readout chip and announcements

- **Chip:** it shows while dragging and while any part has `:focus-visible`.
  - Classes: `pointer-events-none absolute top-full z-50 mt-1 rounded bg-zinc-900 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums text-white dark:bg-zinc-100 dark:text-zinc-900`.
  - Anchor it at `left` of the region, or at `right` when `start > measures / 2`, so it never runs off the ruler.
  - Text: `5–8` for a span or `5` for a single measure, with ` · off` appended when disabled and not dragging.
  - Mark it `aria-hidden`, because the live region and the slider values carry the information for screen readers.
- **Live region:** `<p className="sr-only" aria-live="polite">`, updated **on pointer commit and on "Set loop region"**. Other keyboard changes are already announced through `aria-valuetext` and the button name; after "Set loop region" the focused slider announces only its value, so the live region adds that looping is on.
  - Copy: `Loop region measures 5 to 8, looping on.`
  - Draw announces the same, because drawing turns looping on.

## 9. ARIA and keyboard

**Body:** a native `<button type="button">`, not a `div role="button"`. That way `useEditorShortcuts`' `SELF_ACTIVATING` rule already keeps Space from also toggling playback outside the roll.

```
aria-pressed={enabled}
aria-label={`Loop region, measures ${start} to ${end}, looping ${enabled ? "on" : "off"}`}
aria-describedby={helpId}
title={`Loop region: measures ${start}–${end} (looping ${enabled ? "on" : "off"})`}
```

- For a single-measure region, the name reads `measure ${start}`.
- The accessible name is always of the form `Loop region, measures 5 to 8, looping on` (or `looping off`); the body exists only when a region does, so there is no "no region" name.
- The help text is `sr-only`: "Enter or Space turns looping on or off. Left and Right move the region. Drag on the ruler outside the region to draw a new one."
- Keys:
  - Enter or Space toggles looping;
  - Left and Right move the region by 1 measure;
  - Home and End move it to the start or the end.

**Handles:** `div tabIndex={0} role="slider" aria-orientation="horizontal"`

| | Start edge | End edge |
|---|---|---|
| `aria-label` | `Loop region start` | `Loop region end` |
| `aria-valuemin` / `aria-valuemax` | `1` / `end` | `start` / `measures` |
| `aria-valuenow` | `start` | `end` |
| `aria-valuetext` | `Measure ${start}` | `Measure ${end}` |

- Keys:
  - Left and Right move by 1 measure;
  - PageDown and PageUp move by 4 measures (a standard slider key, needed at 128 measures);
  - Home and End move as far as allowed.
- Every handled key calls `preventDefault()`, and arrow-key edits commit immediately (D3).

**"Set loop region" button** (only when `region === null`): the keyboard path to the first region.

```
<button type="button" aria-describedby={setHelpId}
  className="sr-only focus:not-sr-only focus:absolute focus:inset-y-0 focus:left-0 focus:z-20
    focus:flex focus:items-center focus:whitespace-nowrap focus:rounded-sm focus:px-2
    focus:bg-white focus:text-xs focus:font-medium focus:text-zinc-900
    dark:focus:bg-zinc-900 dark:focus:text-zinc-100
    focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-black
    dark:focus-visible:outline-white">
  Set loop region
</button>
```

- **Hidden until focused:** `sr-only` keeps it out of sight but in the tab order, where it is the only stop in the ruler. `focus:not-sr-only` (not `focus-visible`) shows it for any focus, because pointer users never reach a hidden control, and programmatic focus must not leave it invisible.
- **Shown:** at the ruler's left edge, the full 28px height, as an opaque chip over the measure numbers, with the standard `focusRing` colours and the same inset offset as the handles (section 6).
- **ARIA:** a native button, so its name is its visible text, "Set loop region". The `sr-only` help text (`setHelpId`) reads: "Creates a one-measure loop region at measure 1 and turns looping on. Then use Left and Right to extend it." It is not a toggle, so no `aria-pressed`.
- **Activation:** Enter or Space commits `{ region: { start: 1, end: 1 }, enabled: true }`, updates the live region (`Loop region measure 1, looping on.`), and moves focus to the end handle, which then shows its grip, focus ring, and the readout chip. The button unmounts because a region now exists.
- It sits inside the `data-loop-region` root, so the exemption below keeps its Space and Enter from reaching the transport or editor shortcuts.

**Stopping Space and Enter from reaching playback (the developer must handle this).**
- Inside the piano roll, `useEditorShortcuts` treats Space as playback **even on buttons** (`insideRoll` overrides `SELF_ACTIVATING`), and it `preventDefault`s Space keyup, which would stop the body from clicking.
- Add `data-loop-region` to the `LoopRegion` root, and have both Space checks in `useEditorShortcuts` bail out when `e.target.closest("[data-loop-region]")`, in the same way `[data-key]` is exempted.
- This also covers Space on the sliders, which do nothing with it but must not start playback, as the spec's keyboard rule requires.

## 10. Transport Loop toggle

**Placement.** Play/Stop is one toggling button, so group it with Loop. The existing `gap-x-6` then separates the transport buttons from Follow playhead and the readout:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ( ▶ Play ) ( ⟲ Loop )      [x] Follow playhead      Bar 3 · Beat 2                │
└──────────────────────────────────────────────────────────────────────────────────┘
  └ flex items-center gap-2 ┘
```

**Markup.** Use `Button` (secondary variant) with these props:

```
aria-pressed={loop.enabled}
aria-label="Loop playback"   title="Loop playback"
onClick={() => onLoopChange({ ...loop, enabled: !loop.enabled })}
className="min-w-20
  aria-pressed:border-zinc-900 aria-pressed:bg-zinc-200 aria-pressed:inset-ring-1 aria-pressed:inset-ring-zinc-900
  aria-pressed:hover:bg-zinc-300
  dark:aria-pressed:border-zinc-100 dark:aria-pressed:bg-zinc-800 dark:aria-pressed:inset-ring-zinc-100
  dark:aria-pressed:hover:bg-zinc-700"
```

Children are the icon plus the visible text `Loop`.

- **Name:** the accessible name stays constant ("Loop playback"), and `aria-pressed` carries the state. This is ARIA toggle-button practice, and screen readers announce "Loop playback, toggle button, pressed". Changing the name as well would double-announce. The visible "Loop" is contained in the name (WCAG 2.5.3).
- **With no region:** the toggle works the same. Pressing it sets `enabled` and leaves `region` null, which loops the whole length; the ruler stays empty.
- **Pressed look:**
  - pressed has a filled zinc-200 background with an effective 2px dark border (border plus inset ring);
  - unpressed is the plain secondary style (white background, 1px zinc-300 border);
  - fill weight and border weight both change, so the state doesn't rely on hue.
- **Why not solid black when pressed:** it would look identical to the adjacent primary Play button.
- **During loading:** do **not** disable Loop while sounds are loading ("Loading sounds…"). It is a setting, not an action on audio.

**Icon.** An inline SVG in the `InstrumentIcon` style, decorative because the text is always visible:

```
<svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5}
     strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0">
  <path d="M4 9V7.5A2.5 2.5 0 0 1 6.5 5H15M12.5 2.5 15 5l-2.5 2.5" />
  <path d="M16 11v1.5a2.5 2.5 0 0 1-2.5 2.5H5M7.5 17.5 5 15l2.5-2.5" />
</svg>
```

**Removed.** The "Loop measures" label, both `Select`s, the "to" text, the "Loop whole pattern/song" button, and the `wholeLabel` and `measures` props, if nothing else uses them.

## 11. Responsive and motion

- The transport row already `flex-wrap`s. The Play+Loop group stays together because it is one flex item, so at phone width Follow and the readout wrap below it. There is no horizontal scroll.
- Nothing animates position. The region, handles, and chip move instantly during a drag. `transition-colors` on hover gets `motion-reduce:transition-none`.

## 12. States checklist

| State | Ruler | Toggle | Shade |
|---|---|---|---|
| Default (new/legacy work): no region, off | nothing beyond the ruler | not pressed | none |
| No region, "Set loop region" focused | the button shown at the ruler start with its focus ring | unchanged | none |
| No region, on | nothing beyond the ruler | pressed | none |
| Partial, on | enabled, partial | pressed | outside measures shaded |
| Partial, off | dashed, dimmed | not pressed | none |
| Whole (drawn), on | enabled, full width | pressed | none |
| Whole (drawn), off | dashed, dimmed, full width | not pressed | none |
| Drawing / moving / resizing | enabled preview + chip | unchanged until release (draw then sets pressed) | follows committed value only |
| Keyboard focus | inset ring on the part + chip | — | — |
| Dock ruler (Studio) | no overlay (no `loop`/`onLoopChange` passed) | — | none |
