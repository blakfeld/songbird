# songwriting/lyrics Specification

## Purpose

Gives each song a lyric notepad on the Studio page, so songwriters can write the words alongside the arrangement and keep them with the song wherever it is stored or exported.

## Requirements

### Requirement: Lyric notepad per song
Each song SHALL have exactly one lyric notepad: a multi-line plain-text editor on the Studio page. The notepad SHALL show the open song's lyrics. When a different song is opened, the notepad SHALL show that song's lyrics instead. A song without lyrics SHALL show an empty notepad with a placeholder inviting the user to write.

#### Scenario: Lyrics are per song
- **WHEN** the user writes lyrics in song A and then opens song B
- **THEN** the notepad shows song B's lyrics, and reopening song A shows song A's lyrics

#### Scenario: Song without lyrics
- **WHEN** a song saved before lyrics existed is opened
- **THEN** the notepad is empty and the song otherwise opens unchanged

### Requirement: Lyrics panel placement
On wide screens, the Studio's right column SHALL offer two tabs, "Assistant" and "Lyrics", and SHALL show one panel at a time. The selected tab SHALL be remembered in the browser across reloads. It SHALL NOT be stored in the song. On narrow screens, where the assistant opens in a drawer, the Studio SHALL offer a "Lyrics" button that opens the notepad in the same kind of drawer. Switching tabs or closing the drawer SHALL NOT lose unsaved typing.

#### Scenario: Switch to lyrics
- **WHEN** on a wide screen the user selects the "Lyrics" tab
- **THEN** the notepad replaces the assistant chat in the right column, and selecting "Assistant" brings the chat back with its history intact

#### Scenario: Tab remembered
- **WHEN** the user selects the "Lyrics" tab and reloads the page
- **THEN** the right column shows the Lyrics tab

#### Scenario: Narrow screen
- **WHEN** on a narrow screen the user presses "Lyrics", types a line, and closes the drawer
- **THEN** reopening the drawer shows the line

### Requirement: Lyrics saved with the song
Lyrics SHALL be part of the song document as an optional `lyrics` string. Editing lyrics SHALL save the song through the same autosave as other song edits, so reloading the page or opening the song on another device shows the latest saved lyrics. Lyrics SHALL be included in "Download project" files and SHALL be loaded from "Open project" files. A song or project file without `lyrics` SHALL load with empty lyrics. A song whose lyrics are empty SHALL be saved and downloaded without a `lyrics` field, exactly as before this change.

#### Scenario: Lyrics survive reload
- **WHEN** the user types lyrics, waits for the song to show as saved, and reloads the page
- **THEN** the same song shows the same lyrics

#### Scenario: Project file round trip
- **WHEN** the user downloads a project for a song with lyrics and opens that file
- **THEN** the new project's notepad shows the same lyrics

#### Scenario: Empty lyrics leave the file unchanged
- **WHEN** a song with no lyrics is downloaded as a project
- **THEN** the song document in the file has no `lyrics` field

### Requirement: Lyrics length limit
Lyrics SHALL hold at most 20,000 characters, counted as Unicode scalar values. The notepad SHALL show the current count against the limit once the lyrics exceed 18,000 characters. Input that would take the lyrics past the limit SHALL be refused as a whole: the lyrics SHALL stay unchanged and the user SHALL be told the limit was reached. Saving or creating a project whose song has lyrics over the limit SHALL be refused with `422` and code `invalid_song`, storing nothing. "Open project" SHALL reject such a file with a message naming the lyrics limit.

#### Scenario: Paste past the limit
- **WHEN** the notepad holds 19,990 characters and the user pastes 50 characters
- **THEN** the paste is refused, the lyrics still hold 19,990 characters, and the user is told the limit was reached

#### Scenario: Counter appears near the limit
- **WHEN** the lyrics grow from 18,000 to 18,001 characters
- **THEN** a counter showing 18,001 of 20,000 appears

#### Scenario: Server rejects oversized lyrics
- **WHEN** a client saves a project whose song has 20,001 characters of lyrics
- **THEN** the server responds `422` with code `invalid_song` and the stored project is unchanged

#### Scenario: Limit counts characters, not bytes
- **WHEN** a client saves a song whose lyrics are 20,000 multi-byte characters
- **THEN** the save succeeds

### Requirement: Lyric headings
A notepad line that consists only of a bracketed name, such as `[Chorus]` or `[Verse 1]`, optionally surrounded by whitespace, SHALL be shown visually distinct from lyric lines. Headings SHALL NOT change the stored text, which SHALL remain exactly what the user typed.

A heading SHALL start a lyric section, which runs until the next heading line or the end of the notepad. A heading SHALL be linked to every song section whose name matches the bracketed name, ignoring case and whitespace around both names. The song's sections are its real sections or, for a song without sections, its implicit sections ("Song", "Song 2", and so on; see `songwriting/sections`). A heading with no matching song section SHALL be marked as unlinked. Links SHALL follow the song: renaming, adding, or deleting a section, or giving an unsectioned song real sections, SHALL update which headings are linked without changing the text.

The notepad SHALL offer an "Add section headings" action. The action SHALL append, at the end of the notepad, one heading line for each song section that has no linked heading yet, in song order, skipping a name already added by the same action. It SHALL leave existing text untouched, SHALL NOT change the song's sections, SHALL be a single notepad undo step, and SHALL do nothing when every section already has a heading.

#### Scenario: Heading line styled
- **WHEN** the notepad contains the line `[Chorus]`
- **THEN** that line is shown as a heading and the lines under it are shown as lyric lines

#### Scenario: Brackets inside a lyric line
- **WHEN** a line reads `I said [softly] goodbye`
- **THEN** the line is shown as a lyric line, not a heading

#### Scenario: Heading links to a section
- **WHEN** the song has a section named "Chorus" and the notepad contains the line `[ chorus ]`
- **THEN** that line is shown as a heading linked to the "Chorus" section

#### Scenario: Unknown heading
- **WHEN** the notepad contains `[Hook]` and no song section is named "Hook"
- **THEN** the heading is shown as unlinked and the lyrics are otherwise unaffected

#### Scenario: Renaming a section relinks
- **WHEN** the notepad contains `[Hook]`, no section is named "Hook", and the user renames the section "Chorus" to "Hook"
- **THEN** the `[Hook]` heading is shown as linked and the lyrics are unchanged

#### Scenario: Scaffold headings
- **WHEN** the song has sections Intro, Verse 1, Chorus, the notepad already contains `[Verse 1]`, and the user chooses "Add section headings"
- **THEN** `[Intro]` and `[Chorus]` heading lines are appended in that order and the existing text is unchanged

#### Scenario: Scaffold an unsectioned song
- **WHEN** a 40-measure song has no sections, the notepad is empty, and the user chooses "Add section headings"
- **THEN** the notepad holds `[Song]` and `[Song 2]` heading lines, and the song still has no sections

#### Scenario: Headings survive giving the song sections
- **WHEN** an unsectioned song's notepad contains `[Song]` and the user types notes for the implicit "Song" section, which turns it into a real section named "Song"
- **THEN** the `[Song]` heading is still linked

#### Scenario: Scaffold is one undo step
- **WHEN** the user chooses "Add section headings", which appends three headings, and then presses Cmd/Ctrl+Z in the notepad
- **THEN** all three headings are removed and the rest of the lyrics are unchanged

### Requirement: Lyrics undo is separate from song undo
The notepad SHALL provide its own undo and redo, via Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z while it has focus. Typing in the notepad SHALL NOT add steps to the song's undo history. Song undo and redo SHALL NOT change the lyrics, and notepad undo SHALL NOT change anything but the lyrics.

#### Scenario: Song undo keeps lyrics
- **WHEN** the user adds a track, then types a lyric line, then clicks the Studio's Undo button
- **THEN** the track is removed and the lyric line remains

#### Scenario: Notepad undo
- **WHEN** the user types a lyric line and presses Cmd/Ctrl+Z while the notepad has focus
- **THEN** the line is removed and the song's tracks are unchanged

### Requirement: Notepad keyboard isolation
While the notepad has focus, key presses SHALL edit the lyrics and SHALL NOT trigger Studio shortcuts. For example, Space SHALL NOT start or stop playback, `r` SHALL NOT start recording, and Cmd/Ctrl+D SHALL NOT duplicate a clip. Tab and Shift+Tab SHALL move focus out of the notepad rather than insert a tab, so keyboard users are never trapped. The notepad SHALL have an accessible name of "Lyrics".

#### Scenario: Space types a space
- **WHEN** the notepad has focus and the user presses Space
- **THEN** a space is inserted and playback does not start

#### Scenario: Tab leaves the notepad
- **WHEN** the notepad has focus and the user presses Tab
- **THEN** focus moves to the next focusable control and the lyrics are unchanged

### Requirement: Lyric assistant chat panel
The Lyrics panel SHALL show a lyric assistant chat below the notepad, wherever the notepad is shown: in the Studio's "Lyrics" tab on wide screens and in the Lyrics drawer on narrow screens. It SHALL be separate from the song chat in the "Assistant" tab, and neither SHALL show the other's messages. The user types a message and sends it, and replies appear in order.

The message input SHALL show a live estimated token count against the service's `max_input_tokens`, using the same estimation rule as the other prompt inputs. Send SHALL be disabled while the message is empty, over the limit, or while a request is in flight. While the user has no usable AI key, Send SHALL be disabled with the same notice the song chat shows. While a request is in flight the panel SHALL show a loading state. If the request fails, the panel SHALL show the error message, keep the user's unsent text in the input, and leave the conversation and lyrics unchanged. A reply that arrives after a different song was opened SHALL be discarded.

#### Scenario: Send a message
- **WHEN** the user types "help me write a hopeful chorus" and presses Send
- **THEN** the message appears in the lyric conversation, a loading state is shown, and the assistant's reply appears below it

#### Scenario: Separate from the song chat
- **WHEN** the user has exchanged messages with the lyric assistant and then selects the "Assistant" tab
- **THEN** the song chat shows only its own messages

#### Scenario: Over the limit
- **WHEN** the message's token estimate exceeds `max_input_tokens`
- **THEN** the counter is flagged and Send is disabled

#### Scenario: Failed request keeps work
- **WHEN** a request returns an error
- **THEN** an error message is shown, the typed message is still in the input, and neither the conversation nor the lyrics change

#### Scenario: Reply for a closed song
- **WHEN** the user sends a message and opens a different song before the reply arrives
- **THEN** the reply is not added to either song's conversation

### Requirement: Lyric conversation persistence
The lyric conversation SHALL be part of the song document as an optional list of messages, separate from the song chat. It SHALL be saved through the same autosave as other song edits, so reloading the page or opening the song on another device shows it, and it SHALL be included in "Download project" files and loaded from "Open project" files. It SHALL keep at most the 20 most recent messages, each of at most 4,000 characters. Each assistant message SHALL keep its suggestions, so they can still be applied after a reload. A song or project file without a lyric conversation SHALL load with an empty one, and a song with an empty lyric conversation SHALL be saved and downloaded without that field.

Sending a message or receiving a reply SHALL NOT add steps to the song's undo history, and song undo and redo SHALL NOT change the lyric conversation. The user SHALL be able to clear the conversation, and doing so SHALL NOT change the lyrics or the song chat. Saving a song whose lyric conversation exceeds these limits SHALL be refused with `422` and code `invalid_song`, storing nothing, and "Open project" SHALL reject such a file.

#### Scenario: Conversation survives reload
- **WHEN** the user has exchanged messages with the lyric assistant, waits for the song to show as saved, and reloads the page
- **THEN** the same messages and their suggestions are shown for that song

#### Scenario: Clear conversation
- **WHEN** the user chooses "Clear conversation"
- **THEN** the lyric conversation is empty and the lyrics and the song chat are unchanged

#### Scenario: Song undo keeps the conversation
- **WHEN** the user adds a track, then receives a lyric assistant reply, then clicks the Studio's Undo button
- **THEN** the track is removed and the reply remains

#### Scenario: Conversation trimmed to 20 messages
- **WHEN** the conversation holds 20 messages and the user sends another and receives a reply
- **THEN** the conversation holds the 20 most recent messages

#### Scenario: Server rejects an oversized conversation
- **WHEN** a client saves a project whose song has 21 lyric conversation messages
- **THEN** the server responds `422` with code `invalid_song` and the stored project is unchanged

### Requirement: Applying suggestions
Each suggestion in an assistant reply SHALL be shown with its label, its text, and one action matching its kind:
- `insert` inserts the text at the notepad cursor, or at the end if the notepad has not had focus since the song was opened.
- `replace_selection` replaces the text that was selected when the message was sent.
- `replace_section` replaces the body of the lyric section whose heading is linked to the suggestion's song section, keeping its heading line. If that song section has been renamed since the reply, its current name is used. If it no longer exists, the name it had when the reply arrived is used. If several headings match, the first is used. If none matches, the action appends the heading and the text at the end.

Lyrics SHALL change only when the user activates a suggestion's action. Each application SHALL be a single edit that one undo in the notepad reverts, and SHALL follow the lyrics length limit: an application that would take the lyrics past it SHALL be refused as a whole and the user told. If the selected text for a `replace_selection` suggestion has changed since the message was sent, the action SHALL insert at the cursor instead and tell the user it did so.

#### Scenario: Replies never auto-apply
- **WHEN** an assistant reply containing suggestions arrives
- **THEN** the lyrics are unchanged until the user activates a suggestion

#### Scenario: Replace a section
- **WHEN** the notepad contains `[Chorus]` followed by two lines, and the user applies a `replace_section` suggestion for the Chorus section
- **THEN** the two lines are replaced by the suggestion text and the `[Chorus]` heading remains

#### Scenario: Replace a missing section
- **WHEN** the user applies a `replace_section` suggestion for "Bridge" and the notepad has no `[Bridge]` heading
- **THEN** a `[Bridge]` heading line followed by the suggestion text is appended to the end of the notepad

#### Scenario: Replace an implicit section after it became real
- **WHEN** an unsectioned song's notepad contains `[Song]`, a reply suggests replacing the "Song" section, and the user then adds an Intro section before applying it
- **THEN** the body under `[Song]` is replaced by the suggestion text

#### Scenario: Stale selection falls back to insert
- **WHEN** the user sent a message with a line selected, then edited that line, then applies a `replace_selection` suggestion
- **THEN** the suggestion is inserted at the cursor, the edited line is kept, and a notice explains the fallback

#### Scenario: Suggestion past the lyrics limit
- **WHEN** the notepad holds 19,990 characters and the user applies an `insert` suggestion of 50 characters
- **THEN** the lyrics are unchanged and the user is told the limit was reached

#### Scenario: Undo an applied suggestion
- **WHEN** the user applies a suggestion and then presses Cmd/Ctrl+Z in the notepad
- **THEN** the lyrics return to exactly their state before the suggestion was applied

### Requirement: Lyric assist endpoint
The system SHALL expose `POST /api/v1/lyrics/assist`. The request body is a JSON object with these fields:
- `song_context`: `{name, key?, tempo_bpm, time_signature, sections: [{id, name, kind, measures, notes, chords}]}`. `key`, `time_signature` and `kind` use the song document's formats. `chords` is a list of chord symbols in order and may be empty.
- `lyrics`: a string.
- `selection` (optional): `{from, to}`, offsets into `lyrics` counted in UTF-16 code units.
- `messages`: a list of `{role, content}`, where `role` is `"user"` or `"assistant"`.

On success the endpoint SHALL respond `200` with `{"reply": <string>, "suggestions": [...]}`. Each suggestion is `{id, label, text, action, section_id?}`, where `action` is one of `insert`, `replace_selection`, or `replace_section`, and `section_id` is present exactly when `action` is `replace_section`. The endpoint SHALL NOT store any request data.

The endpoint SHALL require a signed-in user and SHALL apply the same AI access rules as the other AI endpoints: the same provider selection, including the user's own API key when keys are per user, the same per-minute and daily AI request limits, the same limit on concurrent generations, and the same error codes for a missing, rejected, exhausted, or rate-limited key. Its body limit SHALL be the same as the song endpoints'.

#### Scenario: Successful assist
- **WHEN** a client posts a valid body whose last message is `{"role": "user", "content": "suggest a chorus about leaving home"}`
- **THEN** the response is `200` with a non-empty `reply` and a `suggestions` list, which may be empty

#### Scenario: Same contract across providers
- **WHEN** the same valid request is served by any configured provider
- **THEN** the response has the same shape and obeys the same normalization rules

#### Scenario: No AI key
- **WHEN** keys are per user and a signed-in user without a stored key posts a valid body
- **THEN** the response is `409` with error code `api_key_required`, no provider call is made, and the request does not count against the daily limit

#### Scenario: Counts against the AI limits
- **WHEN** a user has used every AI request allowed this minute and posts a valid body
- **THEN** the response is `429` with error code `too_many_requests` and no provider call is made

#### Scenario: Large lyrics accepted
- **WHEN** a client posts a valid body of about 500 KiB, holding 20,000 characters of lyrics and 100 sections with 5,000 characters of notes each
- **THEN** the body is accepted rather than rejected as too large

### Requirement: Lyric assist input validation
The system SHALL reject a request with status `422` and SHALL NOT invoke the AI provider when any of the following holds:
- `messages` is empty, has more than 20 entries, or does not end with a `user` message, or any message other than the last exceeds 4,000 characters. Error code: `invalid_messages`.
- The last message is blank. Error code: `invalid_prompt`.
- The last message's estimated tokens exceed `max_input_tokens`, using the same estimation rule as pattern prompts. Error code: `prompt_too_long`.
- `lyrics` exceeds 20,000 characters. Error code: `lyrics_too_long`.
- `selection` has `from` greater than `to`, or `to` past the end of `lyrics`. Error code: `invalid_selection`.
- `song_context` has no sections or more than 128, a blank or repeated section id or one longer than 64 characters, a section name that is empty or longer than 40 characters, a section length outside 1–32 measures, section notes over 5,000 characters, more than 64 chords in a section or a chord longer than 16 characters, a song name longer than 80 characters, or a tempo outside the song's tempo range. Error code: `invalid_song_context`.

A body that is not valid JSON for the endpoint, including an unknown `role`, `kind`, or `time_signature`, SHALL be rejected with `400` and error code `invalid_json`, without invoking the provider.

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

#### Scenario: Implicit section ids accepted
- **WHEN** a client posts `song_context.sections` with ids `implicit` and `implicit-2`, named "Song" and "Song 2"
- **THEN** the request is accepted

#### Scenario: Unknown role
- **WHEN** a message has role `system`
- **THEN** the response is `400` with error code `invalid_json` and no provider call is made

### Requirement: Lyric assist output normalization
The system SHALL validate and normalize every provider response before returning it:
- Truncate `reply` to 4,000 characters.
- Keep at most 5 suggestions.
- Truncate each suggestion's `text` to 2,000 characters and its `label` to 80 characters.
- Drop suggestions with empty text or an unknown action.
- Drop `replace_section` suggestions whose `section_id` is not in `song_context.sections`.
- Drop `replace_selection` suggestions when the request had no selection or an empty selection.
- Assign each surviving suggestion a unique `id`.

If the response cannot be parsed into a non-empty reply after one retry, the system SHALL respond `502` with error code `generation_failed`. A request that exceeds the configured generation timeout SHALL be aborted with `504` and error code `generation_timeout`.

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
The lyrics, the selected text, the song and section names, section notes, chords, and every message in the conversation, including assistant messages sent back by the client, SHALL be passed to the AI provider as quoted material that the provider is told to treat as content, not as instructions to the system. Text supplied by the client SHALL NOT be able to end that quoting early. The assistant SHALL only produce lyric-writing help in the reply-and-suggestions format.

#### Scenario: Fence cannot be closed by the user
- **WHEN** the lyrics contain a closing tag identical to the one used to fence the lyrics in the provider prompt
- **THEN** the provider receives that text escaped, still inside the fence

#### Scenario: Forged assistant turn stays quoted
- **WHEN** an assistant message in `messages` contains the closing tag used to fence messages
- **THEN** the provider receives that text escaped, still inside its message's fence

### Requirement: Deterministic mock assistant
When the service is configured with the mock provider, the assistant SHALL return, for the same request, the same reply and suggestions every time, without any network access. When the request has a non-empty selection, the mock SHALL include at least one `replace_selection` suggestion. When the request names at least one section, it SHALL include one `replace_section` suggestion for the first section, so every application path can be tested end to end.

#### Scenario: Mock is repeatable
- **WHEN** the mock provider receives the same request twice
- **THEN** both responses are identical and no outbound network request is made

#### Scenario: Mock exercises section replacement
- **WHEN** the mock provider receives a request whose first section has id `"chorus-1"`
- **THEN** the response contains a `replace_section` suggestion with `section_id` `"chorus-1"`

### Requirement: Generate a topline from a lyric heading
Each heading in the notepad that is linked to a song section SHALL offer a "Generate topline" action. The action SHALL open the topline dialog (see `songwriting/topline`) for that lyric section and the first song section it is linked to. Unlinked headings SHALL NOT offer the action. The action SHALL be reachable by keyboard and SHALL NOT change the lyrics text or the notepad's undo history.

#### Scenario: Linked heading offers the action
- **WHEN** the notepad contains `[Chorus]` linked to the song's Chorus section
- **THEN** the heading offers "Generate topline", and choosing it opens the topline dialog for the Chorus

#### Scenario: Unlinked heading has no action
- **WHEN** the notepad contains `[Hook]` and no section is named "Hook"
- **THEN** the heading offers no "Generate topline" action
