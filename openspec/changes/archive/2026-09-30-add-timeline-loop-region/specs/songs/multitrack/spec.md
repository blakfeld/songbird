# Spec Delta

## MODIFIED Requirements

### Requirement: Mixed song playback
The Studio page SHALL provide the transport behavior of `patterns/playback`, applied to the whole song. This SHALL include:
- Play, Stop, and Space to toggle;
- the Loop toggle, and an optional loop region in song measures that is drawn and edited on the arrangement's measure ruler above the lanes;
- playing once through the song when looping is off;
- a playhead shown across the lanes and the open piano roll;
- accurate timing, velocity, and note length for sustained and one-shot instruments;
- live edits being audible.

Every audible track SHALL be played at the same time with its own instrument's sounds, using the song's tempo, swing, and time signature.

- **Seeking:** clicking empty lane space to seek SHALL set where Play starts only while looping is off. While looping is on, Play SHALL start at the region's first measure, or at measure 1 when there is no region.
- **The dock's ruler:** the docked piano roll's ruler counts measures within the selected clip's loop. It SHALL NOT show or edit the song's loop region.
- **New songs:** a new song, or one saved before loop regions existed, SHALL open with no loop region and looping off, so Play plays the song once. Turning on the Loop toggle with no region SHALL loop the whole song.

#### Scenario: Tracks play together
- **WHEN** a song has a kick on step 0 of the Drums track and a `C3` on step 0 of the Bass track, and the user presses Play
- **THEN** both notes start at the same time with their own instruments' sounds

#### Scenario: New song has no region
- **WHEN** the user creates a new song
- **THEN** the arrangement ruler shows no loop region, the Loop toggle is not pressed, and no lane measures are shaded

#### Scenario: Loop a range across tracks
- **WHEN** the song has no loop region and the user drags across measures 5–8 on the arrangement ruler and presses Play
- **THEN** measures 5–8 of every audible track play, repeating

#### Scenario: Song plays once
- **WHEN** looping is off on a 16-measure song and the user presses Play
- **THEN** every audible track plays measures 1–16 once, and playback stops by itself

#### Scenario: Seek with looping off
- **WHEN** looping is off, the user clicks empty lane space in measure 9, and then presses Play
- **THEN** playback starts at measure 9 and stops by itself after the song's last measure

#### Scenario: Region is not in the dock
- **WHEN** the song's region is measures 5–8 and a clip's loop is open in the dock
- **THEN** the dock's ruler shows no loop region and no loop shading
