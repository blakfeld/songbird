# songs/listener-comments Specification

## Purpose
Lets people listening through a share link leave short feedback pinned to a moment in the song, and lets the owner see and work through that feedback in the Studio, while keeping anonymous input from becoming a channel for spam or script injection.

## Requirements

### Requirement: Posting a comment
`POST /api/v1/listen/{token}/comments` SHALL require a valid session (see `platform/accounts`, "Authentication required for the API"), and SHALL accept a body with:
- `body`: the comment text;
- `at_step`: an integer position in the song, in steps from its start.

**Success.** For an active link with `allow_comments` true, a signed-in user with a username, and a valid body, the server SHALL store the comment and respond `201`. The response SHALL include the comment's id, name, body, `at_step`, section name, and `created_at`. The comment SHALL record:
- its name: the commenter's username at the moment of posting;
- the commenting account;
- the section's id and name. The server SHALL determine the section from `at_step` and the song the link serves at that moment. A section sent by the client SHALL be ignored.
- for a live link, the project revision the comment was made against.

**Refusals.** The server SHALL refuse a comment in these cases, and nothing SHALL be stored:

| Case | Status | Code |
|---|---|---|
| No session | `401` | `unauthenticated` |
| The user has no username | `409` | `username_required` |
| The link is unknown, revoked, or expired | `404` | `not_found` |
| The link has `allow_comments` false | `404` | `not_found` |

**Owners.** The owner of the project SHALL be able to comment on their own link like anyone else.

#### Scenario: Comment pinned to the chorus
- **WHEN** signed-in user `sam` posts `{"body":"Love this lift","at_step":160}` and step 160 falls in the section "Chorus"
- **THEN** the response is `201` with name `sam`, and the owner's comment list shows sam's comment at step 160 in "Chorus"

#### Scenario: Signed out
- **WHEN** a client without a session posts a valid comment to an active link that allows comments
- **THEN** the response is `401` with code `unauthenticated`, and nothing is stored

#### Scenario: No username yet
- **WHEN** a signed-in user with no username posts a valid comment
- **THEN** the response is `409` with code `username_required`, and nothing is stored

#### Scenario: Comments turned off
- **WHEN** a signed-in user posts a comment through a link with `allow_comments` false
- **THEN** the response is `404` with code `not_found` and nothing is stored

#### Scenario: Honeypot filled
- **WHEN** a signed-in user posts a valid comment that also has `website` set to `http://spam.example`, a field earlier versions accepted as a honeypot
- **THEN** the response is `422` with code `invalid_comment`, and nothing is stored

### Requirement: Comment validation
The server SHALL validate every comment and refuse an invalid one with `422` and code `invalid_comment`, storing nothing. A comment is invalid when any of these is true:
- `body`, after trimming surrounding whitespace, is not 1 to 2,000 characters, or has more than 30 lines;
- `body` contains a control character other than a line feed;
- `body` contains a Unicode bidirectional override or isolate character (U+202A–U+202E, U+2066–U+2069);
- `at_step` is not an integer from 0 to the song's length in steps;
- the request has an unknown field. This includes `name` and `website`, which earlier versions accepted.

Lengths SHALL be counted in Unicode scalar values. Text SHALL be stored as received after trimming, without HTML escaping or other transformation. A request body larger than 8 KiB SHALL be refused with `413` and code `payload_too_large`.

#### Scenario: Empty comment
- **WHEN** a signed-in user posts a body made only of spaces
- **THEN** the response is `422` with code `invalid_comment`

#### Scenario: Direction override refused
- **WHEN** a signed-in user posts a body containing U+202E
- **THEN** the response is `422` with code `invalid_comment`

#### Scenario: Position past the end
- **WHEN** a signed-in user posts `at_step` one step beyond the end of the song
- **THEN** the response is `422` with code `invalid_comment`

#### Scenario: Name field refused
- **WHEN** a signed-in user posts `{"name":"Someone Else","body":"Hi","at_step":0}`
- **THEN** the response is `422` with code `invalid_comment`

#### Scenario: Markup kept as text
- **WHEN** a signed-in user posts the body `<img src=x onerror=alert(1)>`
- **THEN** the comment is stored with exactly that text

### Requirement: Comment rate limits and caps
Comment posting SHALL be limited:
- per user, by default to 5 comments per 10 minutes and 30 per day, across all links;
- per share link, by default to 200 comments per day.

A request over a limit SHALL get `429` with code `too_many_requests` and a `Retry-After` header, and SHALL store nothing. A signed-in request refused for any reason SHALL still count toward the per-user limits, so that invalid requests cannot be used to probe without cost. The limits SHALL be configurable by environment variable. The limits are held in the memory of the single service instance and need not survive a restart. A share link SHALL hold at most 1,000 comments; posting more SHALL be refused with `409` and code `comment_limit`.

#### Scenario: Burst from one address
- **WHEN** one signed-in user posts 6 valid comments within 10 minutes from one address
- **THEN** the 6th gets `429` with a `Retry-After` header and is not stored

#### Scenario: Other listeners unaffected
- **WHEN** user A has reached their limit and user B posts a valid comment on the same link from the same address
- **THEN** user B's comment is stored

#### Scenario: Link full
- **WHEN** a link holds 1,000 comments and a signed-in user posts another
- **THEN** the response is `409` with code `comment_limit`

### Requirement: Comment privacy
Listener comments SHALL be visible only to the project's owner. There SHALL be no endpoint that lists a link's comments without the owner's session. The owner SHALL see a comment's name, which is the commenter's username at the time of posting. No response SHALL give the owner, or anyone else, the commenting account's id or email. After posting, the listen page SHALL show the comments posted from that browser through that link, kept only in that browser.

#### Scenario: Another listener cannot read comments
- **WHEN** listener B opens a link on which listener A has commented
- **THEN** listener B's page does not show listener A's comment

#### Scenario: Own comments shown
- **WHEN** a listener posts a comment and reloads the listen page in the same browser
- **THEN** the page shows that comment under "Your comments"

#### Scenario: Commenter's account not revealed
- **WHEN** the owner lists their project's comments
- **THEN** each comment shows a name, and the response contains no commenter account id or email

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
When the link allows comments, the listen page SHALL check whether the visitor is signed in, without signing anyone out or navigating away. It SHALL show one of the following:

| Visitor | Page shows |
|---|---|
| Signed out, or the session check fails | A "Sign in to comment" link to `/login`, with the listen page's path as the return target |
| Signed in, no username | A note that commenting needs a username, with a link to the Profile page (see `platform/accounts`) where it can be set. The listen page SHALL NOT offer its own username field. |
| Signed in, with a username | A comment field and "Commenting as <username>", with no name field |

The comment SHALL be pinned to the playhead's position when the listener starts writing, shown as the time and section name, for example "at 1:23 in Chorus". The listener SHALL be able to move the position by clicking the timeline before posting.

The form SHALL enforce the same length limits as the server, and SHALL show the server's message when a comment is refused or rate limited. A `401` on posting SHALL keep the listener's text and switch the form to "Sign in to comment". A `409 username_required` SHALL keep the listener's text and show the note linking to the Profile page. When the link does not allow comments, the page SHALL show no comment form or comment sign-in prompt.

#### Scenario: Pin to playhead
- **WHEN** a signed-in listener with a username pauses at 1:23 in the Chorus and starts typing a comment
- **THEN** the form shows "at 1:23 in Chorus", and the posted comment's `at_step` is the playhead's step

#### Scenario: Signed out
- **WHEN** a visitor with no session opens a link that allows comments
- **THEN** the page shows "Sign in to comment" linking to `/login?next=/listen/<token>`, no comment form, and the song still plays

#### Scenario: Username needed first
- **WHEN** a signed-in user without a username opens a link that allows comments
- **THEN** the page shows no comment field and no username field, only a note that commenting needs a username and a link to the Profile page

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

### Requirement: Comments deleted with their author
Deleting an account SHALL delete every listener comment that account posted, on any project. Comments posted before this change have no recorded account. They SHALL be kept with their typed name until the owner deletes them or the project is deleted.

#### Scenario: Author account deleted
- **WHEN** user `sam` has commented on user A's link and an operator deletes `sam`'s account
- **THEN** user A's comment list no longer contains `sam`'s comment

#### Scenario: Earlier anonymous comment kept
- **WHEN** a project has a comment posted anonymously before this change
- **THEN** the owner still sees it with the name it was posted under
