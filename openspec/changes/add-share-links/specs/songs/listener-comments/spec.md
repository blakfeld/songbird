# Spec Delta

## Purpose

Lets people listening through a share link leave short feedback pinned to a moment in the song, and lets the owner see and work through that feedback in the Studio, while keeping anonymous input from becoming a channel for spam or script injection.

## ADDED Requirements

### Requirement: Posting a comment
`POST /api/v1/listen/{token}/comments` SHALL require no session and SHALL accept a body with:
- `name`: the listener's display name;
- `body`: the comment text;
- `at_step`: an integer position in the song, in steps from its start;
- `website`: an optional field that the listen page never fills (a honeypot).

For an active link with `allow_comments` true and a valid body, it SHALL store the comment and respond `201` with the comment's id, name, body, `at_step`, section name, and `created_at`. The server SHALL determine the section from `at_step` and the song the link serves at that moment, and SHALL store the section's id and name with the comment; a section sent by the client SHALL be ignored. For a live link, it SHALL also store the project revision the comment was made against. For a link that is unknown, revoked, or expired, or has `allow_comments` false, the response SHALL be `404` with code `not_found`, and nothing SHALL be stored. When `website` is non-empty, the response SHALL be `201` in the same shape, and nothing SHALL be stored. Session cookies SHALL be ignored.

#### Scenario: Comment pinned to the chorus
- **WHEN** a listener posts `{"name":"Sam","body":"Love this lift","at_step":160}` and step 160 falls in the section "Chorus"
- **THEN** the response is `201`, and the owner's comment list shows Sam's comment at step 160 in "Chorus"

#### Scenario: Comments turned off
- **WHEN** a listener posts a comment through a link with `allow_comments` false
- **THEN** the response is `404` with code `not_found` and nothing is stored

#### Scenario: Honeypot filled
- **WHEN** a client posts a valid comment with `website` set to `http://spam.example`
- **THEN** the response is `201`, and the owner's comment list does not contain it

### Requirement: Comment validation
The server SHALL validate every comment and refuse an invalid one with `422` and code `invalid_comment`, storing nothing:
- `name`, after trimming surrounding whitespace and collapsing internal runs of whitespace to one space, SHALL be 1 to 40 characters;
- `body`, after trimming surrounding whitespace, SHALL be 1 to 2,000 characters and at most 30 lines;
- neither SHALL contain control characters, other than line feeds in `body`, nor Unicode bidirectional override or isolate characters (U+202A–U+202E, U+2066–U+2069);
- `at_step` SHALL be an integer from 0 to the song's length in steps;
- unknown fields SHALL be refused.

Lengths SHALL be counted in Unicode scalar values. Text SHALL be stored as received after trimming, without HTML escaping or other transformation. A request body larger than 8 KiB SHALL be refused with `413` and code `payload_too_large`.

#### Scenario: Empty comment
- **WHEN** a listener posts a body made only of spaces
- **THEN** the response is `422` with code `invalid_comment`

#### Scenario: Direction override refused
- **WHEN** a listener posts a name containing U+202E
- **THEN** the response is `422` with code `invalid_comment`

#### Scenario: Position past the end
- **WHEN** a listener posts `at_step` one step beyond the end of the song
- **THEN** the response is `422` with code `invalid_comment`

#### Scenario: Markup kept as text
- **WHEN** a listener posts the body `<img src=x onerror=alert(1)>`
- **THEN** the comment is stored with exactly that text

### Requirement: Comment rate limits and caps
Comment posting SHALL be limited:
- per client address, by default to 5 comments per 10 minutes and 30 per day, across all links;
- per share link, by default to 200 comments per day.

A request over a limit SHALL get `429` with code `too_many_requests` and a `Retry-After` header, and SHALL store nothing. A request refused for any reason SHALL still count toward the per-address limits, so invalid requests cannot be used to probe without cost. The limits SHALL be configurable by environment variable. The client address SHALL be determined the same way as for login throttling. The limits are held in the memory of the single service instance and need not survive a restart. A share link SHALL hold at most 1,000 comments; posting more SHALL be refused with `409` and code `comment_limit`.

#### Scenario: Burst from one address
- **WHEN** one address posts 6 valid comments within 10 minutes
- **THEN** the 6th gets `429` with a `Retry-After` header and is not stored

#### Scenario: Other listeners unaffected
- **WHEN** address A has reached its limit and address B posts a valid comment on the same link
- **THEN** address B's comment is stored

#### Scenario: Link full
- **WHEN** a link holds 1,000 comments and a listener posts another
- **THEN** the response is `409` with code `comment_limit`

### Requirement: Comment privacy
Listener comments SHALL be visible only to the project's owner. There SHALL be no endpoint that lists a link's comments without the owner's session. After posting, the listen page SHALL show the comments posted from that browser through that link, kept only in that browser.

#### Scenario: Another listener cannot read comments
- **WHEN** listener B opens a link on which listener A has commented
- **THEN** listener B's page does not show listener A's comment

#### Scenario: Own comments shown
- **WHEN** a listener posts a comment and reloads the listen page in the same browser
- **THEN** the page shows that comment under "Your comments"

### Requirement: Owner comment API
For a project the current user owns:
- `GET /api/v1/projects/{id}/comments` SHALL respond `200` with every comment on the project's links, including revoked and expired ones, oldest position first. Each entry SHALL include id, share id, share label and token prefix, name, body, `at_step`, section id and name, the project revision it was made against (live links), `created_at`, and `resolved_at`.
- `PUT /api/v1/projects/{id}/comments/{comment_id}` with `{"resolved": true|false}` SHALL resolve or reopen the comment and respond `200` with it.
- `DELETE /api/v1/projects/{id}/comments/{comment_id}` SHALL permanently delete the comment and respond `204`.

For a project or comment the user does not own, each SHALL respond `404` with code `not_found`.

#### Scenario: Resolve a comment
- **WHEN** the owner resolves a comment
- **THEN** its `resolved_at` is set, and listing comments shows it as resolved

#### Scenario: Comments from a revoked link kept
- **WHEN** the owner revokes a link that has 3 comments and lists the project's comments
- **THEN** all 3 comments are listed

#### Scenario: Another user's comment
- **WHEN** user B sends `DELETE /api/v1/projects/{id}/comments/{comment_id}` for a comment on user A's project
- **THEN** the response is `404` with code `not_found`, and the comment is unchanged

### Requirement: Comments rendered as text
Everywhere a comment's name or body is shown, in the listen page and the Studio, it SHALL be rendered as plain text. It SHALL NOT be interpreted as HTML or Markdown, and URLs in it SHALL NOT be turned into links. Line breaks in a body SHALL be shown as line breaks.

#### Scenario: Script text shown literally
- **WHEN** the owner views a comment whose body is `<script>alert(1)</script>`
- **THEN** the Studio shows those characters as text, and no script runs

#### Scenario: URL not linked
- **WHEN** the owner views a comment containing `https://example.com`
- **THEN** the text is shown and is not a clickable link

### Requirement: Commenting on the listen page
When the link allows comments, the listen page SHALL show a comment form with a name field and a comment field. The comment SHALL be pinned to the playhead's position when the listener starts writing, shown as the time and section name, for example "at 1:23 in Chorus". The listener SHALL be able to move the position by clicking the timeline before posting. The name SHALL be remembered in that browser for later comments. The form SHALL enforce the same length limits as the server, and SHALL show the server's message when a comment is refused or rate limited. When the link does not allow comments, the page SHALL show no comment form.

#### Scenario: Pin to playhead
- **WHEN** a listener pauses at 1:23 in the Chorus and starts typing a comment
- **THEN** the form shows "at 1:23 in Chorus", and the posted comment's `at_step` is the playhead's step

#### Scenario: Rate limited
- **WHEN** a listener's comment gets `429`
- **THEN** the form keeps their text and says to try again later

### Requirement: Comment markers in the Studio
When the Studio opens a project that has comments, it SHALL show a marker on the section ruler at each unresolved comment's position. A comment whose position is past the current end of the song SHALL be shown at the end, marked as no longer in the song. Selecting a marker SHALL move the playhead to the comment's position and open the comment in the comments panel. The comments panel SHALL list the project's comments with name, body, time, section name, and link label, with unresolved ones first, and SHALL let the owner resolve, reopen, delete after confirming, and jump to each comment. Resolved comments SHALL be hidden from the ruler, and shown in the panel only when "Show resolved" is on. The Studio SHALL show the number of unresolved comments on the control that opens the panel, and SHALL refresh comments when the project is opened, when the panel is opened, and when the owner chooses "Refresh". Loading, resolving, and deleting comments SHALL NOT add steps to the song's undo history or change the song document.

#### Scenario: Marker opens the comment
- **WHEN** the owner selects the marker of Sam's comment at step 160
- **THEN** the playhead moves to step 160, and the comments panel shows Sam's comment

#### Scenario: Resolved marker hidden
- **WHEN** the owner resolves a comment
- **THEN** its marker disappears from the ruler, and the unresolved count drops by one

#### Scenario: Undo unaffected
- **WHEN** the owner resolves a comment and then presses Cmd/Ctrl+Z
- **THEN** the comment stays resolved, and the song's last edit is undone instead
