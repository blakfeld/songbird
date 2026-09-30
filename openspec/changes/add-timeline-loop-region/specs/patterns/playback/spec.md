# Spec Delta

## MODIFIED Requirements

### Requirement: Play and stop
The page SHALL provide Play and Stop controls. The Space bar SHALL toggle play and stop when focus is not in a text field.

Where Play starts:
- With looping on, Play SHALL start at the first measure of the loop region, or at measure 1 when there is no region.
- With looping off, Play SHALL start at measure 1, unless the page has set a start measure by seeking.

Stop SHALL silence playback and reset the playhead.

With looping off, playback SHALL continue until the last measure has been scheduled. It SHALL let notes that are still sounding finish their scheduled length, then stop by itself and reset the playhead, as if Stop had been pressed.

#### Scenario: Play a pattern
- **WHEN** the user presses Play on a pattern with notes
- **THEN** the instrument's sounds are heard for each note in time order at the pattern's tempo

#### Scenario: Space toggles transport
- **WHEN** focus is on the piano roll and the user presses Space
- **THEN** playback starts, and pressing Space again stops it

#### Scenario: Play once with looping off
- **WHEN** looping is off on an 8-measure pattern and the user presses Play
- **THEN** measures 1–8 play once, playback stops by itself after measure 8, the playhead is hidden, and the Play control is shown again

#### Scenario: Last note rings out
- **WHEN** looping is off and a sustained note starts in the last measure and lasts to the end of the pattern
- **THEN** the note sounds for its full length before playback stops

### Requirement: Looping
Looping SHALL be a setting that is either on or off, together with an optional loop region. When present, the loop region SHALL be a range of whole measures, at least 1 measure long and inside the pattern.
- **Looping on:** the loop region SHALL repeat seamlessly. With no region, the whole pattern SHALL repeat.
- **Looping off:** playback SHALL play through once, as described in "Play and stop".
- **Default:** a pattern opened for the first time, or stored without loop data (including one saved before loop regions existed), SHALL have no loop region and looping off. Replacing the pattern, by "Start blank" or by generating a new one, SHALL keep its region and looping setting, with the region clamped to the new length as for a length change.
- **No clearing:** once a region has been drawn, it SHALL be possible to redraw, move, resize, and toggle it, but there SHALL be no way to remove it.

The transport SHALL provide a Loop toggle beside Play and Stop.
- It SHALL show whether looping is on through its pressed state and its accessible name.
- It SHALL switch looping on or off without changing the region. With no region, turning looping on SHALL NOT create one.

Changes during playback SHALL take effect at the next measure boundary without restarting the transport:
- Turning looping off SHALL let playback continue to the end.
- Turning looping on while the playhead is outside the region SHALL make the next measure played the region's first measure.
- Moving or resizing the region SHALL make the next measure played fall inside the new region when looping is on.

When the pattern's length changes:
- A region SHALL be clamped to lie inside the new length, keeping at least 1 measure, and SHALL otherwise stay where it is.
- With no region, there SHALL still be no region, and looping (when on) SHALL cover the new length.
- The on/off setting SHALL NOT change.

#### Scenario: New pattern plays once
- **WHEN** the user opens a new 8-measure pattern and presses Play
- **THEN** no loop region is shown, the Loop toggle is not pressed, and measures 1–8 play once before playback stops by itself

#### Scenario: Loop the whole pattern
- **WHEN** a pattern has no loop region, the user turns on the Loop toggle, and playback reaches the end of the pattern
- **THEN** it continues seamlessly from measure 1, and the ruler still shows no loop region

#### Scenario: Loop a range
- **WHEN** the loop region is measures 5–8, looping is on, and the user presses Play
- **THEN** only measures 5–8 play, repeating

#### Scenario: Toggle beside Play
- **WHEN** looping is on and the user activates the Loop toggle
- **THEN** looping is off, the toggle shows as not pressed, and the region is still shown, dimmed, at the same measures

#### Scenario: Turn looping off mid-play
- **WHEN** a 16-measure pattern is playing with the region at measures 5–8 and looping on, and the user turns looping off during measure 6
- **THEN** playback continues through measures 7–16 and then stops by itself

#### Scenario: Turn looping on outside the region
- **WHEN** looping is off, playback is in measure 12, and the region is measures 5–8, and the user turns looping on
- **THEN** after measure 12 finishes, playback continues at measure 5 and repeats measures 5–8

#### Scenario: Shortening clamps a partial region
- **WHEN** a 16-measure pattern has the region at measures 13–16 and is shortened to 8 measures
- **THEN** the region is clamped to lie within measures 1–8

#### Scenario: Replacing the pattern keeps the region
- **WHEN** a 16-measure pattern has the region at measures 5–8 with looping on, and the user generates a new 16-measure pattern
- **THEN** the region is still measures 5–8 and looping is still on

#### Scenario: Lengthening keeps a drawn region
- **WHEN** an 8-measure pattern whose region covers measures 1–8 is lengthened to 16 measures
- **THEN** the region still covers measures 1–8

#### Scenario: No region follows the length
- **WHEN** a pattern has no region, looping is on, and it is lengthened from 8 to 16 measures
- **THEN** there is still no region, and playback loops measures 1–16

## ADDED Requirements

### Requirement: Editing the loop region on the ruler
The measure ruler above the timeline SHALL show the loop region, when one exists, as a highlighted strip. Its start and end edges SHALL be visible. While looping is off, the strip SHALL remain visible but visibly dimmed. With no region, the ruler SHALL show only its measures, whether looping is on or off. Measures outside the region SHALL be shaded in the grid only while looping is on and a region exists that is not the whole length. All pointer edits SHALL snap to whole measures.
- **Draw:** pressing on the ruler outside the region and dragging SHALL draw a new region from the measure pressed to the measure under the pointer, in either direction. With no region, the whole ruler SHALL count as outside. On release, the new region SHALL replace any previous region and turn looping on. A press and release with no drag outside the region SHALL NOT change anything.
- **Move:** pressing on the region's body and dragging SHALL move it without changing its length, and SHALL stop at the pattern's first and last measures. This SHALL hold for a region of any length, including one that covers every measure; to draw elsewhere, the user first shrinks such a region by an edge.
- **Resize:** dragging the region's start or end edge SHALL move that edge. The region SHALL stay at least 1 measure long, and the edge SHALL NOT cross the opposite edge or pass the pattern's bounds.
- **Toggle:** a press and release on the region with no drag SHALL toggle looping.
- **Keeping the setting:** moving or resizing SHALL NOT change whether looping is on.
- **Keyboard:** when a region exists, the start edge and end edge SHALL each be keyboard-focusable sliders whose value is their measure.
  - Left and Right SHALL move an edge by one measure, and Home and End SHALL move it as far as allowed.
  - The region body SHALL be a keyboard-focusable toggle. Its accessible name SHALL include the measure span and whether looping is on.
  - Enter or Space on the body SHALL toggle looping, and Left or Right SHALL move the whole region by one measure.
  - With no region, the ruler SHALL provide a keyboard-focusable "Set loop region" button that is visually hidden until it has focus. Enter or Space on it SHALL create a region covering measure 1, turn looping on, and move focus to the region's end-edge slider. It SHALL NOT be shown once a region exists.
  - These keys SHALL NOT start or stop playback while the region, an edge, or the "Set loop region" button has focus.

#### Scenario: Draw a region
- **WHEN** a 16-measure pattern has no loop region and looping is off, and the user drags on the ruler from measure 5 to measure 8
- **THEN** the region is measures 5–8 and looping is on

#### Scenario: Dragging a full-length region moves it
- **WHEN** an 8-measure pattern's region covers measures 1–8 and the user drags its body from measure 3 to measure 5
- **THEN** the region stays at measures 1–8 and no new region is drawn

#### Scenario: Draw backwards
- **WHEN** the pattern has no loop region and the user drags on the ruler from measure 8 to measure 5
- **THEN** the region is measures 5–8

#### Scenario: Replace by drawing elsewhere
- **WHEN** the region is measures 5–8 and the user drags on the ruler from measure 13 to measure 14
- **THEN** the region is measures 13–14, and measures 5–8 are no longer marked

#### Scenario: Drawing turns looping on
- **WHEN** looping is off and the user draws a region on the ruler
- **THEN** looping is on

#### Scenario: Move the region
- **WHEN** the region is measures 5–8 and the user drags its body two measures to the right
- **THEN** the region is measures 7–10

#### Scenario: Move stops at the end
- **WHEN** a 16-measure pattern has the region at measures 13–16 and the user drags its body to the right
- **THEN** the region stays at measures 13–16

#### Scenario: Resize from either edge
- **WHEN** the region is measures 5–8, and the user drags its end edge to measure 12 and then its start edge to measure 3
- **THEN** the region is measures 3–12

#### Scenario: Resize keeps one measure
- **WHEN** the region is measures 5–8 and the user drags its end edge left past measure 5
- **THEN** the region is measures 5–5

#### Scenario: Click the region to toggle
- **WHEN** looping is on and the user clicks the region without dragging
- **THEN** looping is off and the region is shown dimmed; clicking it again turns looping back on

#### Scenario: Create a region from the keyboard
- **WHEN** the pattern has no loop region, and the user tabs to "Set loop region" and presses Enter
- **THEN** the region covers measure 1, looping is on, focus is on the region's end-edge slider, and playback has not started

#### Scenario: Keyboard resize
- **WHEN** the end-edge slider of a region at measures 5–8 has focus and the user presses Right twice
- **THEN** the region is measures 5–10, and the slider's value is announced as measure 10

### Requirement: Loop region is saved
The loop region and the looping setting SHALL be saved with the work they belong to:
- on a single-instrument page, with that instrument's pattern;
- on the Studio page, with the song.

They SHALL be restored when the page reloads or the song is reopened, and duplicating a song SHALL copy them. A stored pattern or song with no loop data SHALL open with no region and looping off. Changing the region or the looping setting SHALL NOT be recorded in undo history. Undoing or redoing another edit SHALL NOT change the region or the looping setting, except that the region SHALL be clamped as described in "Looping" when the undone or redone edit changes the length.

#### Scenario: Reload restores the region
- **WHEN** the user sets the region to measures 3–4, turns looping off, and reloads the page
- **THEN** the region is measures 3–4 and looping is off

#### Scenario: Stored work without loop data
- **WHEN** a pattern saved before loop regions existed is opened
- **THEN** it has no loop region, looping is off, and Play plays it once

#### Scenario: Region changes are not undo steps
- **WHEN** the user adds a note, moves the loop region, and presses Cmd/Ctrl+Z
- **THEN** the note is removed and the region stays where it was moved to
