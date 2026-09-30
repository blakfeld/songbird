# Spec Delta

## ADDED Requirements

### Requirement: Send pattern to a song
Each single-instrument editor page SHALL offer a "Send to song" action whenever a pattern is displayed. The action SHALL let the user choose a new song or an existing song whose time signature matches the pattern's. It SHALL add a new track using the page's instrument, named after the pattern, containing the pattern's notes starting at measure 1. If the pattern is longer than the chosen song, the song SHALL be lengthened to the pattern's length. A new song SHALL take the pattern's tempo, time signature, and swing. The action SHALL be unavailable for a song that already has 16 tracks, and SHALL NOT change the pattern on the editor page.

#### Scenario: Send a drum pattern to a new song
- **WHEN** the user on the Drum Machine page sends an 8-measure 4/4 pattern named "Boom Bap" at 90 BPM to a new song
- **THEN** a new song at 90 BPM in 4/4 exists with 8 measures and one Drums track named "Boom Bap" containing the pattern's notes

#### Scenario: Mismatched time signature is not offered
- **WHEN** the pattern is in 3/4 and the user opens the song chooser
- **THEN** only songs in 3/4, plus the option to create a new song, are offered

#### Scenario: Song lengthened to fit
- **WHEN** a 16-measure pattern is sent to an existing 8-measure song
- **THEN** the song becomes 16 measures, and its existing tracks are empty in measures 9–16
