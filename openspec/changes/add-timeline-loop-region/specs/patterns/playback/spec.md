# Spec Delta

## MODIFIED Requirements

### Requirement: Play and stop
The page SHALL provide Play and Stop controls. The Space bar SHALL toggle play and stop when focus is not in a text field.

Where Play starts:
- With looping on, Play SHALL start at the first measure of the loop region.
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
Looping SHALL be a setting that is either on or off, together with a loop region. The loop region SHALL be a range of whole measures, at least 1 measure long and inside the pattern.
- **Looping on:** the loop region SHALL repeat seamlessly.
- **Looping off:** playback SHALL play through once, as described in "Play and stop".
- **Default:** a new pattern, or one saved before loop regions existed, SHALL have looping on and a region covering its whole length.

The transport SHALL provide a Loop toggle beside Play and Stop.
- It SHALL show whether looping is on through its pressed state and its accessible name.
- It SHALL switch looping on or off without changing the region.

Changes during playback SHALL take effect at the next measure boundary without restarting the transport:
- Turning looping off SHALL let playback continue to the end.
- Turning looping on while the playhead is outside the region SHALL make the next measure played the region's first measure.
- Moving or resizing the region SHALL make the next measure played fall inside the new region when looping is on.

When the pattern's length changes:
- A region that covered the whole previous length SHALL cover the whole new length.
- Any other region SHALL be clamped to lie inside the new length, keeping at least 1 measure.
- The on/off setting SHALL NOT change.

#### Scenario: Loop the whole pattern
- **WHEN** playback reaches the end of the pattern with looping on and the region covering the whole pattern
- **THEN** it continues seamlessly from measure 1

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

#### Scenario: A whole-length region grows with the pattern
- **WHEN** an 8-measure pattern whose region covers measures 1–8 is lengthened to 16 measures
- **THEN** the region covers measures 1–16

## ADDED Requirements

### Requirement: Editing the loop region on the ruler
The measure ruler above the timeline SHALL show the loop region as a highlighted strip. Its start and end edges SHALL be visible. While looping is off, the strip SHALL remain visible but visibly dimmed. Measures outside the region SHALL be shaded in the grid only while looping is on and the region is not the whole length. All pointer edits SHALL snap to whole measures.
- **Draw:** pressing on the ruler outside the region and dragging SHALL draw a new region from the measure pressed to the measure under the pointer, in either direction. On release, it SHALL replace the previous region and turn looping on. A press and release with no drag outside the region SHALL NOT change anything.
- **Move:** dragging the region's body SHALL move it without changing its length, and SHALL stop at the pattern's first and last measures.
- **Resize:** dragging the region's start or end edge SHALL move that edge. The region SHALL stay at least 1 measure long, and the edge SHALL NOT cross the opposite edge or pass the pattern's bounds.
- **Toggle:** a press and release on the region with no drag SHALL toggle looping.
- **Keeping the setting:** moving or resizing SHALL NOT change whether looping is on.
- **Keyboard:** the start edge and end edge SHALL each be keyboard-focusable sliders whose value is their measure.
  - Left and Right SHALL move an edge by one measure, and Home and End SHALL move it as far as allowed.
  - The region body SHALL be a keyboard-focusable toggle. Its accessible name SHALL include the measure span and whether looping is on.
  - Enter or Space on the body SHALL toggle looping, and Left or Right SHALL move the whole region by one measure.
  - These keys SHALL NOT start or stop playback while the region or an edge has focus.

#### Scenario: Draw a region
- **WHEN** looping is on with the region at measures 1–8, and the user drags on the ruler from measure 5 to measure 8
- **THEN** the region is measures 5–8 and looping is on

#### Scenario: Draw backwards
- **WHEN** the user drags on the ruler from measure 8 to measure 5
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

#### Scenario: Keyboard resize
- **WHEN** the end-edge slider of a region at measures 5–8 has focus and the user presses Right twice
- **THEN** the region is measures 5–10, and the slider's value is announced as measure 10

### Requirement: Loop region is saved
The loop region and the looping setting SHALL be saved with the work they belong to:
- on a single-instrument page, with that instrument's pattern;
- on the Studio page, with the song.

They SHALL be restored when the page reloads or the song is reopened, and duplicating a song SHALL copy them. Changing the region or the looping setting SHALL NOT be recorded in undo history. Undoing or redoing another edit SHALL NOT change the region or the looping setting, except that the region SHALL be clamped as described in "Looping" when the undone or redone edit changes the length.

#### Scenario: Reload restores the region
- **WHEN** the user sets the region to measures 3–4, turns looping off, and reloads the page
- **THEN** the region is measures 3–4 and looping is off

#### Scenario: Region changes are not undo steps
- **WHEN** the user adds a note, moves the loop region, and presses Cmd/Ctrl+Z
- **THEN** the note is removed and the region stays where it was moved to
