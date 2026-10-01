# Spec Delta

## ADDED Requirements

### Requirement: Metronome and count-in
The transport SHALL offer a Metronome toggle and a Count-in toggle on the Studio page and on each single-instrument editor page.
- **The click:** while the metronome is on and the transport is running, a click SHALL sound on every beat of the time signature. In 4/4 and 3/4 a beat is a quarter note. In 6/8 it is a dotted quarter note. The first beat of each measure SHALL have a clearly different, accented click.
- **The count-in:** when the count-in is on, starting a recording from stopped (see `patterns/midi-input` "Recording a take") SHALL first play one measure of clicks at the current tempo and time signature, whether or not the metronome is on. The page SHALL show that a count-in is under way, and the first measure SHALL then start with no gap.
- **What the click belongs to:** clicks SHALL be timed with the same accuracy as notes. They SHALL NOT pass through any track's mixer, and SHALL NOT be part of the song, the pattern, or any export.
- **Settings:** both settings SHALL be saved in this browser and shared by all pages. The metronome SHALL default to off and the count-in to on.
- **Plain playback:** pressing Play SHALL NOT play a count-in.

#### Scenario: Metronome clicks on beats
- **WHEN** the metronome is on and a 4/4 pattern plays for one measure
- **THEN** four clicks are heard on steps 0, 4, 8, and 12, and the click on step 0 is accented

#### Scenario: 6/8 beats
- **WHEN** the metronome is on and a 6/8 song plays for one measure
- **THEN** two clicks are heard, on steps 0 and 6, and the click on step 0 is accented

#### Scenario: Count-in without the metronome
- **WHEN** the metronome is off, the count-in is on, and the user starts recording from stopped
- **THEN** one measure of clicks is heard, and after that no clicks are heard

#### Scenario: Play has no count-in
- **WHEN** the count-in is on and the user presses Play
- **THEN** playback starts at once, with no count-in
