## ADDED Requirements

### Requirement: Reorder tracks
The Studio page SHALL let the user move a track to any position in the song's track order. The track SHALL keep its id, name, instrument, mixer and sound settings, loops, and clips. The other tracks SHALL keep their relative order.
- **Drag:** each track header SHALL have a drag handle. While the user drags it vertically, the page SHALL show where the track will land. Dropping it SHALL move the track there. Pressing Escape during the drag, or dropping where it started, SHALL leave the order unchanged.
- **Menu:** the track options menu SHALL offer "Move track up" and "Move track down". "Move track up" SHALL be disabled for the first track, and "Move track down" for the last.
- **Keyboard:** with focus on a track header's select control, Alt+Shift+Up and Alt+Shift+Down SHALL move the track one position, and focus SHALL stay on that track's header.
- **Announcement:** after each move, assistive technology SHALL be told the track's name and its new position out of the total, for example "Bass moved to position 2 of 4".
- **Undo:** each completed move SHALL be one undo step. A drag that ends where it started, or a move that can't happen, SHALL NOT add an undo step.
- **Effects of order:** track numbers, lane order, the order of tracks in exported MIDI and project files, MIDI channel assignment, and the generation-context trimming order SHALL all follow the new order. These requirements are already defined in terms of track order.
- The selected track and clip, the open editor dock, and playback SHALL NOT be interrupted by a move.

#### Scenario: Drag a track up
- **WHEN** a song has tracks Drums, Piano, and Bass, and the user drags Bass's handle above Piano and drops it
- **THEN** the order is Drums, Bass, Piano, and Bass is shown as track 2

#### Scenario: Cancel a drag
- **WHEN** the user drags Bass above Drums and presses Escape before dropping
- **THEN** the order is unchanged, and no undo step is added

#### Scenario: Move from the menu
- **WHEN** the user chooses "Move track down" in the Drums track's options menu in a song with tracks Drums, Piano, and Bass
- **THEN** the order is Piano, Drums, Bass

#### Scenario: Ends of the list
- **WHEN** the user opens the options menu of the first track
- **THEN** "Move track up" is disabled, and "Move track down" is enabled if there is more than one track

#### Scenario: Keyboard move keeps focus
- **WHEN** focus is on the Piano header in a song with tracks Drums, Piano, and Bass, and the user presses Alt+Shift+Down
- **THEN** the order is Drums, Bass, Piano, focus stays on the Piano header, and "Piano moved to position 3 of 3" is announced

#### Scenario: Undo a move
- **WHEN** the user moves Bass from position 3 to position 1 and presses Cmd/Ctrl+Z
- **THEN** Bass is at position 3 again, and the other tracks are in their original order

#### Scenario: Export follows the new order
- **WHEN** a song with melodic tracks Keys and then Bass is reordered to Bass then Keys and exported to MIDI
- **THEN** the file lists Bass before Keys, with Bass on channel 1 and Keys on channel 2

#### Scenario: Reorder while playing
- **WHEN** the song is playing and the user moves a track
- **THEN** playback continues without interruption, and every track still sounds the same
