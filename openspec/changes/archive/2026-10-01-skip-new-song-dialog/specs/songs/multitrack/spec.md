## ADDED Requirements

### Requirement: Creating a song
The Songs library SHALL offer a "New song" action that creates a song with the new-song defaults and opens it immediately, without asking for a name, a time signature, or confirmation. The new song SHALL be named "Untitled song". If the user already has a song with that name, it SHALL be named "Untitled song N", where N is the smallest number from 2 up that no existing song uses. Names SHALL be compared ignoring letter case and surrounding whitespace. The user SHALL be able to rename the song afterwards from the song header, and change its time signature from song settings.

#### Scenario: New song opens immediately
- **WHEN** the user chooses "New song" in the Songs library
- **THEN** a new song named "Untitled song" in 4/4 opens in the Studio, and no dialog is shown

#### Scenario: Default names stay distinct
- **WHEN** the library already has songs named "Untitled song" and "Untitled song 2", and the user chooses "New song"
- **THEN** the new song is named "Untitled song 3"

#### Scenario: Gap is reused
- **WHEN** the library has "Untitled song" and "Untitled song 3", but no "Untitled song 2", and the user chooses "New song"
- **THEN** the new song is named "Untitled song 2"

#### Scenario: Rename afterwards
- **WHEN** the user creates a new song and then renames it to "Late Train" from the song header
- **THEN** the song is listed as "Late Train" in the Songs library
