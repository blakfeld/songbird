# Spec Delta

## ADDED Requirements

### Requirement: Chord context for track generation
When a track-generation request's song has section chords that overlap the generation's context window, the system SHALL include the song key, if set, and those chords in the context given to the AI provider. The context window is the generation range plus its surrounding context measures.

For each chord, the context SHALL give its symbol and its absolute start and end within the song. The system SHALL instruct the provider to fit melodic and bass parts to the sounding chords.

Chord context SHALL count against the context token budget. When the budget is exceeded, chords SHALL be dropped starting with those farthest from the range, and chords inside the range SHALL be kept whenever any context is kept.

With the mock provider, every note generated for a melodic track SHALL have a pitch class belonging to the chord sounding at its start step, when such a chord exists.

Songs without chords SHALL be generated exactly as before this requirement.

#### Scenario: Chords reach the provider
- **WHEN** a Bass track is generated for measures 9–16, and the Chorus covering those measures has chords `F`, `G`, `C`, `Am`
- **THEN** the context sent to the provider contains those four chords with their absolute positions and the song key

#### Scenario: Mock output follows the chords
- **WHEN** the mock provider generates a Piano track over a section whose only chord is `Am`
- **THEN** every generated note's pitch class is A, C, or E

#### Scenario: No chords, unchanged behavior
- **WHEN** a track is generated for a song whose sections have no chords
- **THEN** the provider context contains no chord information, and the result equals what the same request produced before chord support existed
