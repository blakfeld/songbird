## MODIFIED Requirements

### Requirement: Global song chat builds the arrangement
The Studio's assistant column (laid out by #4 `add-multitrack-song`) SHALL provide one chat for the whole song, not tied to a selected track. The user SHALL be able to describe a part in plain language, such as "give me a piano that plays slow jazzy chords". The system SHALL then add a new track, pick an instrument from `GET /api/v1/instruments` that suits the request, and fill the track with generated notes over the chat range. The new track SHALL hold one loop named after the track and as long as the chat range, placed as one clip covering that range.

Later messages SHALL be understood in the light of the earlier conversation and the current arrangement. For example, "give me the drums to match" and then "now the bass" SHALL each add one new track whose part is generated with every other unmuted track as context, under the same rules as "Other tracks as generation context". Each message SHALL add at most one track. A message that does not ask for a part SHALL get a text reply and SHALL NOT change the song. The chat history SHALL show, for each assistant reply, which track was added and with which instrument.

When the user sends a message, by pressing Enter or the Send button, the message SHALL appear at the end of the chat history immediately, before the reply arrives, and the input SHALL be cleared. A pending indicator SHALL follow it until the reply arrives. While a chat request is in flight, the Send button SHALL be disabled and Enter SHALL NOT send, but the text input SHALL remain enabled, keep focus, and accept typing, so the user can draft the next message. Editing, the mixer, and playback SHALL remain usable. The pending message SHALL NOT be saved with the song or recorded in undo history until the reply arrives; on success it SHALL be saved together with the reply. When the request fails, the pending message SHALL be removed from the history, the error SHALL be shown in the chat, and the message text SHALL be put back in the input if the input is empty; if the user has already typed something else, that text SHALL be kept. A track added from the chat SHALL be recorded as one undo step. When the song already has 16 tracks, the reply SHALL say so and the song SHALL be unchanged. When generation fails, the song SHALL be unchanged.

When the user's message names a length of 1–32 measures (for example "16 bars"), the chat SHALL generate over measures 1 to that length, extending the song if it is shorter. Otherwise, when no track of the song has any clip, the chat SHALL generate over measures 1–8. Otherwise the chat SHALL generate over the whole song when the song has at most 32 measures, and otherwise over the song's loop region when looping is on, a region exists, it covers less than the whole song, and it spans at most 32 measures. When none of these applies, the reply SHALL ask the user to turn on looping and set a loop region of at most 32 measures, and no track SHALL be added. The conversation, up to its latest 20 messages, SHALL be saved with the song and restored on reload.

#### Scenario: Build a song one part at a time
- **WHEN** in an empty song the user sends "give me a piano that plays slow jazzy chords", then "give me the drums to match", then "now the bass"
- **THEN** the song gains a piano-family track, then a drums track, then a bass track, in that order, each with one clip playing generated notes. The drums request carries the piano track as context, and the bass request carries both the piano and drums tracks.

#### Scenario: Undo a chat-added track
- **WHEN** the chat adds a Bass track and the user presses Cmd/Ctrl+Z
- **THEN** the Bass track is removed and the other tracks are unchanged

#### Scenario: Track limit in chat
- **WHEN** the song has 16 tracks and the user asks the chat for another part
- **THEN** the chat replies that the track limit is reached and no track is added

#### Scenario: Chat failure leaves the song unchanged
- **WHEN** a chat request fails
- **THEN** the error is shown in the chat and no track is added

#### Scenario: Named length grows the song
- **WHEN** the song is 1 measure long and the user asks the chat for "16 bars of slow jazzy piano"
- **THEN** a Piano track is added whose one clip covers measures 1–16, and the song is 16 measures long

#### Scenario: Default length for an empty song
- **WHEN** no track has any clip and the user asks the chat for a drum beat without naming a length
- **THEN** a Drums track is added whose one clip covers measures 1–8

#### Scenario: Long song without a loop range
- **WHEN** the song is 48 measures long, looping is off, and the user asks the chat for a bass part
- **THEN** the reply asks the user to turn on looping and set a loop region of at most 32 measures, and no track is added

#### Scenario: Conversation survives reload
- **WHEN** the user has exchanged three messages with the chat and reloads the page
- **THEN** the same messages are shown in the chat history

#### Scenario: Sent message appears immediately
- **WHEN** the user types "give me a bass line" and presses Enter
- **THEN** "give me a bass line" appears at the end of the chat history and the input is empty, before the reply arrives
- **AND** a pending indicator is shown below it

#### Scenario: Send is disabled while waiting
- **WHEN** a chat request is in flight
- **THEN** the Send button is disabled, pressing Enter in the input sends nothing, and the input still accepts typing

#### Scenario: Failed message goes back to the input
- **WHEN** the user sends "now the bass" and the request fails while the input is empty
- **THEN** "now the bass" is removed from the chat history, the error is shown in the chat, and the input contains "now the bass"
