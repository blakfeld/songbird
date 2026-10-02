## ADDED Requirements

### Requirement: Audio tracks and generation
Audio tracks SHALL take no part in AI generation:
- **Chat:** the song chat SHALL never add an audio track. The planner SHALL be offered only instruments listed by `GET /api/v1/instruments`, and a plan naming `audio` SHALL be treated as an unknown instrument.
- **Generate:** "Generate part with AI" SHALL NOT be offered on audio tracks. The track generation endpoint SHALL reject a target that is an audio track with `400` and a validation error code.
- **Context:** audio tracks SHALL NOT be sent as context for generation (see "Other tracks as generation context"), because they have no notes. They SHALL still count toward the 16-track limit when the chat checks whether it can add a track.

#### Scenario: Chat ignores audio tracks
- **WHEN** a song has a Piano track and a recorded Vocals track, and the user asks the chat for a bass part
- **THEN** a bass track is added, and the generation request carries only the Piano track as context

#### Scenario: Generate on an audio track refused
- **WHEN** a client asks the track generation endpoint to generate into an audio track
- **THEN** the response is `400` with a validation error code and no provider is called

#### Scenario: No generate menu item
- **WHEN** the user opens the options menu of an audio track
- **THEN** it does not offer "Generate part with AI"
