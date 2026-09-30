# Spec Delta

## Purpose

Gives songwriters a lyric notepad for each song and an AI co-writer that knows the song's sections, section notes, and chords. It suggests lyrics that the user explicitly chooses to apply.

## ADDED Requirements

### Requirement: Lyric notepad per song
Each song SHALL have exactly one lyric notepad, shown on the song page as a multi-line plain-text editor. The lyrics SHALL be saved with the song in the browser as the user types, so reloading the page restores them. They SHALL be included in the song project file. No lyrics SHALL be sent to the server for storage. A song or project file without lyrics SHALL load with an empty notepad.

#### Scenario: Lyrics survive reload
- **WHEN** the user types lyrics into a song's notepad and reloads the page
- **THEN** the same song shows the same lyrics

#### Scenario: Lyrics are per song
- **WHEN** the user writes lyrics in song A and then opens song B
- **THEN** song B's notepad shows song B's lyrics, not song A's

#### Scenario: Older song without lyrics
- **WHEN** a song saved before lyrics existed is opened
- **THEN** its notepad is empty and the song otherwise loads unchanged

### Requirement: Lyrics length limit
The notepad SHALL hold at most 20,000 characters (Unicode scalar values). It SHALL show the current count against the limit once the lyrics exceed 18,000 characters. Input that would exceed the limit SHALL be refused, and the existing lyrics SHALL be left unchanged.

#### Scenario: Paste past the limit
- **WHEN** the notepad holds 19,990 characters and the user pastes 50 characters
- **THEN** the paste is refused, the lyrics still hold 19,990 characters, and the user is told the limit was reached

### Requirement: Lyric section headings
A notepad line that consists only of a bracketed name, such as `[Chorus]` or `[Verse 1]`, SHALL start a lyric section. The section runs until the next heading line or the end of the notepad. A lyric section SHALL be linked to the song section whose name matches the bracketed name, ignoring case and surrounding whitespace. Headings SHALL be visually distinguished from lyric lines, and a heading with no matching song section SHALL be marked as unlinked. The notepad SHALL offer an "Add section headings" action. The action appends a heading line for each song section that has no heading yet, in song order, and leaves existing text untouched.

#### Scenario: Heading links to a section
- **WHEN** the song has a section named "Chorus" and the notepad contains the line `[chorus]`
- **THEN** that line is shown as a heading linked to the "Chorus" section

#### Scenario: Unknown heading
- **WHEN** the notepad contains `[Hook]` and no song section is named "Hook"
- **THEN** the heading is shown as unlinked and the lyrics are otherwise unaffected

#### Scenario: Scaffold headings
- **WHEN** the song has sections Intro, Verse 1, Chorus, the notepad already contains `[Verse 1]`, and the user chooses "Add section headings"
- **THEN** `[Intro]` and `[Chorus]` heading lines are appended in that order and the existing text is unchanged

### Requirement: Lyric assistant chat panel
The song page SHALL show a chat panel beside the notepad. The user types a message and sends it to the AI lyric assistant, and replies appear in order. The message input SHALL show a live estimated token count against the service's `max_input_tokens`, using the same estimation rule and limits endpoint as the pattern prompt form. Send SHALL be disabled while the message is empty, over the limit, or while a request is in flight. While a request is in flight the panel SHALL show a loading state. If the request fails, the panel SHALL show the error message, keep the user's unsent text in the input, and leave the conversation and lyrics unchanged.

#### Scenario: Send a message
- **WHEN** the user types "help me write a hopeful chorus" and presses Send
- **THEN** the message appears in the conversation, a loading state is shown, and the assistant's reply appears below it

#### Scenario: Over the limit
- **WHEN** the message's token estimate exceeds `max_input_tokens`
- **THEN** the counter is flagged and Send is disabled

#### Scenario: Failed request keeps work
- **WHEN** a request returns an error
- **THEN** an error message is shown, the typed message is still in the input, and neither the conversation nor the lyrics change

### Requirement: Conversation persistence
The conversation SHALL be saved with the song in the browser and included in the song project file, keeping at most the 20 most recent messages. The user SHALL be able to clear the conversation, and doing so SHALL NOT change the lyrics.

#### Scenario: Conversation survives reload
- **WHEN** the user has exchanged messages with the assistant and reloads the page
- **THEN** the same messages are shown for that song

#### Scenario: Clear conversation
- **WHEN** the user chooses "Clear conversation"
- **THEN** the conversation is empty and the lyrics are unchanged

### Requirement: Applying suggestions
Each suggestion in an assistant reply SHALL be shown with its label, its text, and one action matching its kind:
- `insert` inserts the text at the notepad cursor, or at the end if the notepad has never had focus.
- `replace_selection` replaces the text that was selected when the message was sent.
- `replace_section` replaces the body of the named lyric section, keeping its heading line. If the notepad has no heading for that section, it appends the heading and the text at the end.

Lyrics SHALL change only when the user activates a suggestion's action. Each application SHALL be a single edit that one undo in the notepad reverts. If the selected text for a `replace_selection` suggestion has changed since the message was sent, the action SHALL insert at the cursor instead and tell the user it did so.

#### Scenario: Replies never auto-apply
- **WHEN** an assistant reply containing suggestions arrives
- **THEN** the lyrics are unchanged until the user activates a suggestion

#### Scenario: Replace a section
- **WHEN** the notepad contains `[Chorus]` followed by two lines, and the user applies a `replace_section` suggestion for the Chorus section
- **THEN** the two lines are replaced by the suggestion text and the `[Chorus]` heading remains

#### Scenario: Replace a missing section
- **WHEN** the user applies a `replace_section` suggestion for "Bridge" and the notepad has no `[Bridge]` heading
- **THEN** a `[Bridge]` heading line followed by the suggestion text is appended to the end of the notepad

#### Scenario: Stale selection falls back to insert
- **WHEN** the user sent a message with a line selected, then edited that line, then applies a `replace_selection` suggestion
- **THEN** the suggestion is inserted at the cursor, the edited line is kept, and a notice explains the fallback

#### Scenario: Undo an applied suggestion
- **WHEN** the user applies a suggestion and then presses Cmd/Ctrl+Z in the notepad
- **THEN** the lyrics return to exactly their state before the suggestion was applied

### Requirement: Lyric assist endpoint
The system SHALL expose `POST /api/v1/lyrics/assist`. The request body is a JSON object with these fields:
- `song_context`: `{name, key?, tempo_bpm, time_signature, sections: [{id, name, kind, measures, notes, chords}]}`. `chords` is a list of chord symbols in order and may be empty.
- `lyrics`: a string.
- `selection` (optional): `{from, to}`, character offsets into `lyrics`.
- `messages`: a list of `{role, content}`, where `role` is `"user"` or `"assistant"`.

On success the endpoint SHALL respond `200` with `{"reply": <string>, "suggestions": [...]}`. Each suggestion is `{id, label, text, action, section_id?}`, where `action` is one of `insert`, `replace_selection`, or `replace_section`, and `section_id` is present exactly when `action` is `replace_section`. The endpoint SHALL NOT store any request data.

#### Scenario: Successful assist
- **WHEN** a client posts a valid body whose last message is `{"role": "user", "content": "suggest a chorus about leaving home"}`
- **THEN** the response is `200` with a non-empty `reply` and a `suggestions` list, which may be empty

#### Scenario: Same contract across providers
- **WHEN** the same valid request is served by any configured provider
- **THEN** the response has the same shape and obeys the same normalization rules

### Requirement: Lyric assist input validation
The system SHALL reject a request with status `422` and SHALL NOT invoke the AI provider when any of the following holds:
- `messages` is empty, has more than 20 entries, has an entry with an unknown `role`, or does not end with a `user` message. Error code: `invalid_messages`.
- The last user message is blank, or any assistant message exceeds 4,000 characters. Error code: `invalid_messages`.
- Any user message's estimated tokens exceed `max_input_tokens`, using the same estimation rule as pattern prompts. Error code: `prompt_too_long`.
- `lyrics` exceeds 20,000 characters. Error code: `lyrics_too_long`.
- `selection` is outside `lyrics` or has `from` greater than `to`. Error code: `invalid_selection`.
- `song_context` has more than 64 sections, a section's `notes` exceeds 5,000 characters, a section has more than 64 chords, or `tempo_bpm` or `time_signature` is invalid. Error code: `invalid_song_context`.

#### Scenario: History too long
- **WHEN** a client posts 21 messages
- **THEN** the response is `422` with error code `invalid_messages` and no provider call is made

#### Scenario: Last message is from the assistant
- **WHEN** the final entry of `messages` has role `assistant`
- **THEN** the response is `422` with error code `invalid_messages`

#### Scenario: User message over the token limit
- **WHEN** the limit is 256 and the last user message is 1,025 characters
- **THEN** the response is `422` with error code `prompt_too_long` and no provider call is made

#### Scenario: Lyrics too long
- **WHEN** a client posts lyrics of 20,001 characters
- **THEN** the response is `422` with error code `lyrics_too_long`

#### Scenario: Selection out of bounds
- **WHEN** `lyrics` is 100 characters and `selection` is `{"from": 90, "to": 120}`
- **THEN** the response is `422` with error code `invalid_selection`

### Requirement: Lyric assist output normalization
The system SHALL validate and normalize every provider response before returning it:
- Truncate `reply` to 4,000 characters.
- Keep at most 5 suggestions.
- Truncate each suggestion's `text` to 2,000 characters and its `label` to 80 characters.
- Drop suggestions with empty text or an unknown action.
- Drop `replace_section` suggestions whose `section_id` is not in `song_context.sections`.
- Drop `replace_selection` suggestions when the request had no selection or an empty selection.
- Assign each surviving suggestion a unique `id`.

If the response cannot be parsed into a reply after one retry, the system SHALL respond `502` with error code `generation_failed`. A request that exceeds the configured generation timeout SHALL be aborted with `504` and error code `generation_timeout`.

#### Scenario: Unknown section dropped
- **WHEN** the provider returns a `replace_section` suggestion whose `section_id` is `"s99"` and no such section was sent
- **THEN** the response omits that suggestion

#### Scenario: Selection suggestion without a selection
- **WHEN** the request had no `selection` and the provider returns a `replace_selection` suggestion
- **THEN** the response omits that suggestion

#### Scenario: Provider output unparseable twice
- **WHEN** the provider returns unparseable output on the first attempt and on the retry
- **THEN** the response is `502` with error code `generation_failed` and a user-safe message

#### Scenario: Provider hangs
- **WHEN** the provider does not respond within the generation timeout
- **THEN** the response is `504` with error code `generation_timeout`

### Requirement: User text is treated as data
The lyrics, section names and notes, and every message in the conversation SHALL be passed to the AI provider as quoted material that the provider is told to treat as content, not as instructions to the system. Text supplied by the user SHALL NOT be able to end that quoting early. The assistant SHALL only produce lyric-writing help in the reply-and-suggestions format.

#### Scenario: Fence cannot be closed by the user
- **WHEN** the lyrics contain a closing tag identical to the one used to fence the lyrics in the provider prompt
- **THEN** the provider receives that text escaped, still inside the fence

### Requirement: Deterministic mock assistant
When the service is configured with the mock provider, the assistant SHALL return, for the same request, the same reply and suggestions every time, without any network access. When the request has a selection, the mock SHALL include at least one `replace_selection` suggestion. When the request names at least one section, it SHALL include one `replace_section` suggestion, so every application path can be tested end to end.

#### Scenario: Mock is repeatable
- **WHEN** the mock provider receives the same request twice
- **THEN** both responses are identical and no outbound network request is made

#### Scenario: Mock exercises section replacement
- **WHEN** the mock provider receives a request whose `song_context` has a section with id `"chorus-1"`
- **THEN** the response contains a `replace_section` suggestion with `section_id` `"chorus-1"`
