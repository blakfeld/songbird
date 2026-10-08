# Spec Delta

## ADDED Requirements

### Requirement: Lyric meta-events in exported MIDI
For every note that a track's clips play and that carries a `lyric` (see `songwriting/topline`), the exported song MIDI file SHALL contain a Lyric meta-event (type `0x05`) in that note's MIDI track. The event SHALL be at the tick of the note's Note On, SHALL hold the lyric's text encoded as UTF-8, and SHALL come before that Note On. A note that plays more than once, because its clip repeats its loop, SHALL get an event every time it plays. A note that does not play SHALL get no event. Songs without lyrics on notes SHALL export exactly as before this requirement.

#### Scenario: Syllables become lyric events
- **WHEN** in a 4/4 song with no swing, a Vocal track's loop has notes carrying `hold` at step 0 and `me` at step 4, placed as one clip starting at measure 1
- **THEN** the Vocal MIDI track has a Lyric event `hold` at tick 0 before its Note On and a Lyric event `me` at tick 480 before its Note On

#### Scenario: Repeated clip repeats lyrics
- **WHEN** a 1-measure loop with one note carrying `la` at step 0 is placed as a 2-measure clip starting at measure 1 in 4/4
- **THEN** the track has Lyric events `la` at ticks 0 and 1920

#### Scenario: No lyrics, unchanged file
- **WHEN** a song whose notes carry no lyrics is exported
- **THEN** the file contains no Lyric meta-events and is byte-identical to the export before this requirement
