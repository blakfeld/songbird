# Spec Delta

## ADDED Requirements

### Requirement: Streamed song chat responses
When a request to `POST /api/v1/songs/chat` has an `Accept` header that includes `text/event-stream`, the system SHALL answer as a server-sent event stream instead of a single JSON body.

Each event SHALL have a named type and a JSON `data` payload:
- `progress`, with `{"stage": "planning"}` when the planner starts, and with `{"stage": "writing", "name", "instrument"}` when a track is being generated;
- `reply_delta`, with `{"text"}`: the next piece of the planner's reply. Concatenating every `reply_delta` since the last `reply_reset` SHALL give a prefix of the reply the planner produced;
- `reply_reset`, with `{}`, sent before the planner is retried after invalid output, so clients discard reply text streamed so far;
- `result`, with the same `{"reply", "track"}` object the JSON response would carry, validated under the same rules;
- `error`, with `{"code", "message"}` and, when the error is a rate limit, `"retry_after"` in seconds. It SHALL use the same codes as the non-streamed endpoint, such as `generation_timeout`, `generation_failed`, `api_key_rejected`, `api_key_quota_exhausted` and `api_key_rate_limited`. It SHALL NOT include text from the provider's response body.

A stream SHALL end after exactly one `result` or one `error` event. Track notes SHALL appear only in the `result` event, never in pieces. A provider that cannot stream SHALL send no `reply_delta` events; its reply SHALL arrive in the `result` event.

Errors detectable before any provider call, such as an invalid body, a missing sign-in, a missing AI key, or a busy server, SHALL be returned as plain HTTP errors with today's status codes and bodies, not as a stream. The response SHALL carry headers that keep proxies from buffering or compressing the stream.

#### Scenario: Streamed request for a part
- **WHEN** a client posts "give me the drums to match" with `Accept: text/event-stream`
- **THEN** the response is `200` with content type `text/event-stream`, and the events are a `planning` progress event, any `reply_delta` events, a `writing` progress event naming the drums track, then one `result` event whose `track` has instrument `drums`

#### Scenario: Streamed question gets a reply only
- **WHEN** a client posts "what tempo is this song?" with `Accept: text/event-stream`
- **THEN** the stream has no `writing` progress event and ends with a `result` event whose `track` is null

#### Scenario: Error after the stream started
- **WHEN** a streamed request's track generation times out after the planner finished
- **THEN** the stream ends with one `error` event with code `generation_timeout`, and no `result` event is sent

#### Scenario: Rate limit inside the stream
- **WHEN** the user's provider key is rate limited during a streamed request and the provider gives a retry delay of 30 seconds
- **THEN** the stream ends with an `error` event with code `api_key_rate_limited` and `retry_after` 30

#### Scenario: Validation error is not streamed
- **WHEN** a client posts 21 messages with `Accept: text/event-stream`
- **THEN** the response is `400` with a JSON validation error, and no provider is called

#### Scenario: Planner retry resets the reply
- **WHEN** the planner's first output streams part of a reply and then fails validation, and the second attempt succeeds
- **THEN** a `reply_reset` event is sent before the second attempt's `reply_delta` events, and the `result` reply is the second attempt's

#### Scenario: Provider without streaming
- **WHEN** a streamed request is served by a provider that cannot stream
- **THEN** the stream has progress events, no `reply_delta` events, and a `result` event carrying the full reply

### Requirement: Song chat stream keepalives
While a streamed song chat response is open, the server SHALL send a keepalive at least every 15 seconds whenever no other event has been sent in that time, until the stream ends. A keepalive SHALL be a server-sent event comment line, which clients ignore, so it never appears as an event and never changes the result. Keepalives SHALL continue through every stage, including while waiting for a provider that sends nothing, so that proxies and hosting platforms that close idle connections keep the stream open for as long as the generation timeouts allow.

#### Scenario: Silent provider call stays alive
- **WHEN** a streamed request's track generation takes 3 minutes and the provider sends nothing during it
- **THEN** the client receives a keepalive at least every 15 seconds for those 3 minutes, and the stream then ends with the `result` event

#### Scenario: Keepalives are not events
- **WHEN** a client reads a stream that contained keepalives
- **THEN** the events it parses are the same as they would be without the keepalives

#### Scenario: Idle proxy timeout survived
- **WHEN** the stream passes through a proxy that closes connections after 60 seconds without data, and the request takes 5 minutes
- **THEN** the client receives the `result` event

### Requirement: Song chat stream cancellation
When the client disconnects from a streamed song chat response before it ends, the server SHALL stop the request's provider calls and SHALL NOT start any further provider call for it. A server-busy limit on concurrent AI requests SHALL count a streamed request until its stream ends or the client disconnects, not only until the stream starts.

#### Scenario: Client disconnects during planning
- **WHEN** a client disconnects while the planner call is in progress
- **THEN** the planner call is stopped and no track generation call is made

#### Scenario: Open streams count as busy
- **WHEN** the configured number of concurrent AI requests are open as streams that have already started sending events
- **THEN** another AI request is refused as busy, as if the streams were still in progress

## MODIFIED Requirements

### Requirement: Global song chat builds the arrangement
The Studio's assistant column (laid out by #4 `add-multitrack-song`) SHALL provide one chat for the whole song, not tied to a selected track. The user SHALL be able to describe a part in plain language, such as "give me a piano that plays slow jazzy chords". The system SHALL then add a new track, pick an instrument from `GET /api/v1/instruments` that suits the request, and fill the track with generated notes over the chat range. The new track SHALL hold one loop named after the track and as long as the chat range, placed as one clip covering that range.

Later messages SHALL be understood in the light of the earlier conversation and the current arrangement. For example, "give me the drums to match" and then "now the bass" SHALL each add one new track whose part is generated with every other unmuted track as context, under the same rules as "Other tracks as generation context". Each message SHALL add at most one track. A message that does not ask for a part SHALL get a text reply and SHALL NOT change the song. The chat history SHALL show, for each assistant reply, which track was added and with which instrument.

When the user sends a message, by pressing Enter or the Send button, the message SHALL appear at the end of the chat history immediately, before the reply arrives, and the input SHALL be cleared. A pending assistant reply SHALL follow it until the final result arrives. It SHALL show the current step: first that the request is being planned, then, when a part is being written, the name and instrument of the track being written. When the provider streams the reply, the reply text SHALL appear in the pending reply as it is written. Screen readers SHALL be told each step change and the final reply, not each piece of streamed text. If the final result's reply differs from the streamed text, for example because the server enforced the track limit, the final reply SHALL replace it. The track SHALL be added only when the final result arrives. While a chat request is in flight, the Send button SHALL be disabled and Enter SHALL NOT send, but the text input SHALL remain enabled, keep focus, and accept typing, so the user can draft the next message. Editing, the mixer, and playback SHALL remain usable. The pending message SHALL NOT be saved with the song or recorded in undo history until the reply arrives; on success it SHALL be saved together with the reply. When the request fails, including after part of the reply has streamed, the pending message and any streamed reply text SHALL be removed from the history, the error SHALL be shown in the chat, and the message text SHALL be put back in the input if the input is empty; if the user has already typed something else, that text SHALL be kept. A track added from the chat SHALL be recorded as one undo step. When the user opens another song or leaves the Studio while a chat request is in flight, the request SHALL be cancelled, nothing SHALL be added to either song, and no error SHALL be shown. When the song already has 16 tracks, the reply SHALL say so and the song SHALL be unchanged. When generation fails, the song SHALL be unchanged.

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

#### Scenario: Progress steps while a part is written
- **WHEN** the user sends "give me a bass line" and the planner chooses to add a Bass track
- **THEN** the pending reply first shows that the request is being planned, then that the Bass track is being written, and the Bass track is added only when the final result arrives

#### Scenario: Reply text appears as it streams
- **WHEN** the provider streams the planner's reply "Here's a walking bass line." in several pieces
- **THEN** the pending reply shows the text growing piece by piece before the final result arrives, and screen readers are told the reply once, when it is final

#### Scenario: Streamed reply removed on failure
- **WHEN** part of the reply has streamed and generating the track then fails
- **THEN** the streamed text and the pending message are removed from the history, the error is shown in the chat, and no track is added

#### Scenario: Final reply replaces streamed text
- **WHEN** the song has 16 tracks, the planner streams a reply promising a new part, and the final result says the track limit is reached
- **THEN** the chat history shows only the track-limit reply and no track is added

#### Scenario: Leaving the song cancels the request
- **WHEN** a chat request is in flight and the user opens a different song
- **THEN** the request is cancelled, neither song gains a track or a chat message from it, and no error is shown

### Requirement: Song chat endpoint
The system SHALL expose `POST /api/v1/songs/chat`, accepting a JSON body with:
- `song`: a song document;
- `messages`: 1–20 `{role, content}` entries, where `role` is `user` or `assistant` and the last entry is from the user;
- optional `range`: `{start_measure, end_measure}`, the song's loop region, sent only while looping is on and a region exists that covers less than the whole song.

The last message SHALL follow the prompt rules of pattern generation. Assistant messages SHALL be at most 4,000 characters. On success it SHALL respond `200` with `{"reply", "track"}`, unless the client asks for a streamed response as in "Streamed song chat responses". `track` is either `null` or `{"name", "instrument", "range", "notes"}`, where `instrument` is an id listed by `GET /api/v1/instruments`, `name` is 1–40 characters, `range` is the chat range `{start_measure, end_measure}`, and `notes` follow the "Generate one track of a song" note rules, counted from the start of `range`, for that instrument and range. The generated part SHALL use the other unmuted tracks as context, as in "Other tracks as generation context". The endpoint SHALL NOT store the song or the conversation. Invalid bodies SHALL be rejected with `400` and a validation error code. Provider failures and timeouts SHALL use the same codes as track generation.

#### Scenario: Request for a part adds a track
- **WHEN** a client posts a song with a Piano track and the message "give me the drums to match"
- **THEN** the response is `200` with a `track` whose `instrument` is `drums` and whose notes all use drums rows within the song

#### Scenario: Question gets a reply only
- **WHEN** a client posts the message "what tempo is this song?"
- **THEN** the response is `200` with a non-empty `reply` and `track` null

#### Scenario: Unknown instrument from the model
- **WHEN** the provider's plan names an instrument id that is not listed, on both attempts
- **THEN** the response is `502` with `generation_failed`

#### Scenario: Track limit enforced by the server
- **WHEN** a client posts a song with 16 tracks and asks for another part
- **THEN** the response is `200` with `track` null and a reply saying the track limit is reached

#### Scenario: Conversation reaches the planner
- **WHEN** a client posts the messages "give me a piano that plays slow jazzy chords", then an assistant reply, then "now the bass"
- **THEN** the planner request contains all three messages, and the generation request contains the planner's rewritten prompt rather than the text "now the bass"

#### Scenario: Too many messages
- **WHEN** a client posts 21 messages
- **THEN** the response is `400` with a validation error and no provider is called

#### Scenario: Plain JSON without a stream request
- **WHEN** a client posts a valid chat body without `Accept: text/event-stream`
- **THEN** the response is `200` with content type `application/json` and the `{reply, track}` body, as before this change
