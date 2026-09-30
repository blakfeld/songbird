# Spec Delta

## MODIFIED Requirements

### Requirement: Send pattern to a song
Each single-instrument editor page SHALL offer a "Send to song" action whenever a pattern is displayed.
- **Choosing a song:** the action SHALL let the user choose a new song, or an existing song whose time signature matches the pattern's.
- **What is added:** the action SHALL add a new track that uses the page's instrument and is named after the pattern. The track SHALL have one loop, named after the pattern, holding the pattern's notes and as long as the pattern. That loop SHALL be placed as one clip starting at measure 1 and as long as the pattern.
- **Song length:** if the pattern is longer than the chosen song, the song SHALL be lengthened to the pattern's length.
- **New song settings:** a new song SHALL take the pattern's tempo, time signature, and swing.
- **Availability:** the action SHALL be unavailable for a song that already has 16 tracks.
- **The source pattern:** the action SHALL NOT change the pattern on the editor page.

#### Scenario: Send a drum pattern to a new song
- **WHEN** the user on the Drum Machine page sends an 8-measure 4/4 pattern named "Boom Bap" at 90 BPM to a new song
- **THEN** a new song at 90 BPM in 4/4 exists with 8 measures
- **AND** it has one Drums track named "Boom Bap", whose loop "Boom Bap" holds the pattern's notes and is placed as one clip covering measures 1–8

#### Scenario: Mismatched time signature is not offered
- **WHEN** the pattern is in 3/4 and the user opens the song chooser
- **THEN** only songs in 3/4, plus the option to create a new song, are offered

#### Scenario: Song lengthened to fit
- **WHEN** a 16-measure pattern is sent to an existing 8-measure song
- **THEN** the song becomes 16 measures, and its existing tracks have no clips in measures 9–16

#### Scenario: Short pattern into a longer song
- **WHEN** a 2-measure pattern is sent to an existing 16-measure song
- **THEN** the new track has one 2-measure clip covering measures 1–2, and the song stays 16 measures long
