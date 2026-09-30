# Spec Delta

## ADDED Requirements

### Requirement: Recording onto the Studio timeline
On the Studio page, a take (see `patterns/midi-input` "Recording a take") SHALL record onto the track that was selected when the take started. Each recorded note's position SHALL be the song step at which it was played.
- **Inside an existing clip:** a note that starts inside a clip SHALL be merged into that clip's loop at the matching position inside the loop, counted from the clip's start and wrapping every loop length. Every clip that uses that loop SHALL therefore play it.
- **Over empty lane space:** notes that start where the track has no clip SHALL be gathered into runs of empty measures. A run ends at the next clip or at the end of the song.
  - For each run that receives notes, the take SHALL create one new loop and one clip.
  - The clip SHALL start at the measure of the run's first recorded note and end at the end of the measure where the run's last recorded note ends, never going past the run.
  - The loop SHALL be exactly as long as its clip, and SHALL be named as a New clip's loop is named.
- **Cycling over empty space:** while looping is on, notes recorded on later passes over the same empty measures SHALL go into the loop created on an earlier pass of the same take.
- **The song's length:** the take SHALL NOT change the song's length.
- **Limits:** when a new loop or clip would exceed the track's limits, the notes that needed it SHALL be discarded. After the take, the user SHALL be told how many notes were not recorded and why.
- **Undo:** the whole take, including any loops and clips it created, SHALL be one undo step.
- **Changing tracks mid-take:** selecting another track during a take SHALL NOT move the take. Live play SHALL follow the newly selected track, and recording SHALL stay on the original track until the take ends.

#### Scenario: Record into an existing linked clip
- **WHEN** clips of "Groove A", a 2-measure loop, cover measures 1–2 and 5–6, and the user records a snare on the first step of measure 6
- **THEN** "Groove A" gains a snare on the first step of its second measure, and both clips play it

#### Scenario: Record over empty space
- **WHEN** a Bass track has no clips in measures 9–16 of a 16-measure song, and the user records notes in measures 10 and 11 only
- **THEN** a new loop and clip covering measures 10–11 are created and hold those notes at matching positions

#### Scenario: A take across a clip and empty space
- **WHEN** a clip covers measures 1–4 and measures 5–8 are empty, and the user records notes in measures 3–6
- **THEN** the notes in measures 3–4 go into the existing clip's loop, and a new 2-measure loop and clip covering measures 5–6 holds the rest

#### Scenario: Clip limit during a take
- **WHEN** the selected track already has 256 clips and the user records notes over empty lane space
- **THEN** those notes are not recorded, and after the take the user is told how many notes were not recorded because of the clip limit

#### Scenario: Undo a take that created a clip
- **WHEN** a take created a new clip and added notes to an existing loop, and the user presses Cmd/Ctrl+Z
- **THEN** the new clip and its loop are gone, and the existing loop's notes are as they were before the take
