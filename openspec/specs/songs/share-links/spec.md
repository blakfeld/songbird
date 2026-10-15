# songs/share-links Specification

## Purpose
Lets the owner of a project give other people a revocable, read-only link to hear the song, with its timeline and lyrics, without an account and without exposing anything else the owner has.

## Requirements

### Requirement: Share link tokens
Each share link SHALL be identified publicly by a token of at least 256 bits from a cryptographically secure random source, encoded as unpadded base64url (43 characters). The server SHALL store only a SHA-256 hash of the token, never the token itself, and SHALL look links up by that hash. The full token SHALL be returned exactly once, in the response that creates the link. Every later response about the link SHALL identify it by its id and a 6-character token prefix, and SHALL NOT contain the token or its hash. A token that is not 43 base64url characters SHALL be treated as unknown without a database lookup.

#### Scenario: Token shown once
- **WHEN** an owner creates a share link and then lists the project's share links
- **THEN** the create response contains the full `/listen/<token>` URL, and the list response contains the link's id and token prefix but not the token

#### Scenario: Stored token is not usable
- **WHEN** someone with a copy of the database requests `/api/v1/listen/<value>` using a stored token hash as `<value>`
- **THEN** the response is `404` with code `not_found`

#### Scenario: Malformed token
- **WHEN** a client requests `GET /api/v1/listen/abc`
- **THEN** the response is `404` with code `not_found`

### Requirement: Creating a share link
`POST /api/v1/projects/{id}/shares` SHALL create a share link for a project the current user owns and respond `201` with the link, including its token and URL. The body SHALL contain:
- `mode`: `live` or `snapshot`;
- `expires_at`: a time in Unix milliseconds that is in the future and at most 365 days away, or `null` for no expiry;
- `allow_comments`: a boolean;
- `allow_downloads`: a boolean;
- `allow_remix`: an optional boolean, `false` when omitted, that lets signed-in listeners copy the song into their own projects (see `songs/remix`);
- `label`: an optional plain-text label of at most 80 characters, shown only to the owner.

A **live** link SHALL always serve the project's latest saved song. A **snapshot** link SHALL serve the shared song projection (see "Shared song projection") of the project as saved at creation, and later saves SHALL NOT change it.

A snapshot's size SHALL count toward the owner's stored-bytes quota (see `songs/project-storage`). The server SHALL refuse a request in each of these cases:

| Case | Response |
|---|---|
| Creating a snapshot would exceed the owner's stored-bytes quota | `409`, code `project_limit` |
| The project already has 20 share links that are not revoked | `409`, code `share_limit` |
| The body is invalid | `422`, code `invalid_share` |
| The user does not own the project | `404`, code `not_found` |

#### Scenario: Create a live link
- **WHEN** the owner posts `{"mode":"live","expires_at":null,"allow_comments":true,"allow_downloads":false}` for their project
- **THEN** the response is `201` with a link whose URL is `/listen/<43-character token>` and whose `allow_remix` is false

#### Scenario: Create a remixable link
- **WHEN** the owner posts a link with `"allow_remix": true`
- **THEN** the response is `201` with `allow_remix` true, and the link's listen API reports `allow_remix` true

#### Scenario: Snapshot does not follow later edits
- **WHEN** the owner creates a snapshot link, then renames a section from "Chorus" to "Hook" and saves
- **THEN** the listen API for that link still returns the section named "Chorus"

#### Scenario: Live link follows later edits
- **WHEN** the owner creates a live link, then renames a section from "Chorus" to "Hook" and saves
- **THEN** the listen API for that link returns the section named "Hook"

#### Scenario: Expiry in the past
- **WHEN** the owner creates a link with `expires_at` one minute in the past
- **THEN** the response is `422` with code `invalid_share` and no link is created

#### Scenario: Link limit
- **WHEN** a project already has 20 unrevoked links and the owner creates another
- **THEN** the response is `409` with code `share_limit`

#### Scenario: Another user's project
- **WHEN** user B posts to `/api/v1/projects/{id}/shares` for user A's project
- **THEN** the response is `404` with code `not_found`, and no link is created

### Requirement: Managing share links
`GET /api/v1/projects/{id}/shares` SHALL list every share link of a project the current user owns, newest first. Each entry SHALL include:
- id and token prefix;
- mode and label;
- `allow_comments`, `allow_downloads`, and `allow_remix`;
- `expires_at`, `created_at`, and `revoked_at`;
- status: `active`, `expired`, or `revoked`;
- the number of unresolved comments.

`PUT /api/v1/projects/{id}/shares/{share_id}` SHALL change `label`, `expires_at`, `allow_comments`, `allow_downloads`, and `allow_remix` of an unrevoked link, with the same validation as creation. An omitted `allow_remix` SHALL leave it unchanged. The `PUT` SHALL NOT change the link's mode, token, or snapshot.

`DELETE /api/v1/projects/{id}/shares/{share_id}` SHALL revoke the link and respond `204`. Revoking SHALL:
- take effect for the next request;
- be permanent;
- keep the link's comments for the owner.

Revoking an already revoked link SHALL respond `204`. All three endpoints SHALL respond `404` with code `not_found` for a project or link the user does not own.

#### Scenario: Revoke immediately
- **WHEN** the owner revokes a link and a listener then reloads its listen page
- **THEN** the listen API responds `404` with code `not_found`, and the owner's link list shows the link as revoked with its comments still available

#### Scenario: Turn off comments
- **WHEN** the owner sets `allow_comments` to false on a link
- **THEN** the next comment posted through that link is refused

#### Scenario: Turn off remixing
- **WHEN** the owner sets `allow_remix` to false on a link
- **THEN** the next remix request through that link gets `404` with code `not_found`, and projects already remixed from it are unaffected

#### Scenario: Revoked link cannot be edited
- **WHEN** the owner sends a `PUT` for a revoked link
- **THEN** the response is `404` with code `not_found`

### Requirement: Public listen API
`GET /api/v1/listen/{token}` SHALL require no session. For an active link it SHALL respond `200` with:
- `share`: mode, `allow_comments`, `allow_downloads`, `allow_remix`, and `expires_at`;
- `song`: the shared song projection;
- `instruments`: the instrument descriptions needed to play the song's tracks, and no others;
- `shared_at` for a snapshot, or the project's `updated_at` for a live link.

The response SHALL NOT include:
- the owner's id or email;
- the project id;
- the label;
- any other project;
- anything about the owner's AI keys or settings.

These tokens SHALL all get the same `404` response with code `not_found`, so a response never reveals that a link once existed:
- an unknown or malformed token;
- a revoked or expired token;
- a token whose project was deleted.

A link SHALL be expired from the moment the server's clock reaches `expires_at`. A session cookie sent with a listen request SHALL be ignored: the response SHALL be the same with or without one.

#### Scenario: Listener without an account
- **WHEN** a client with no cookie requests `GET /api/v1/listen/<token>` for an active link
- **THEN** the response is `200` with the song and its instruments

#### Scenario: Expired link
- **WHEN** a link's `expires_at` has passed and a client requests it
- **THEN** the response is the same `404` body a never-issued token gets

#### Scenario: Nothing about the owner
- **WHEN** a client fetches an active link
- **THEN** the response body contains neither the owner's email nor user id nor the project id

#### Scenario: Owner's session changes nothing
- **WHEN** the owner, signed in, opens their own link's listen API
- **THEN** the response is identical to the one a client without a cookie gets

### Requirement: Shared song projection
The song served through a share link SHALL be the song document with the owner's working material removed: the song chat, the lyric assistant conversation, and every section's notes. Everything needed to play and follow the song SHALL be kept, including tracks, loops, clips, mixer settings, sections, key, chords, tempo, time signature, lyrics, and sample metadata. The projection SHALL be computed by the server; a field removed by the projection SHALL never be sent to a listener for either mode.

#### Scenario: Chat removed
- **WHEN** a song with a song chat, a lyric conversation, and notes on its Chorus is shared and fetched
- **THEN** the served song has no chat, no lyric conversation, and no section notes, and has the same tracks, sections, and lyrics as the project

### Requirement: Listen API abuse limits
Requests to `GET /api/v1/listen/{token}` and its MIDI download SHALL be limited per client address, by default to 60 per minute. A request over the limit SHALL get `429` with code `too_many_requests` and a `Retry-After` header. The client address SHALL be determined the same way as for login throttling, including the trusted-proxy setting. The limit SHALL be configurable by environment variable.

#### Scenario: Read flood
- **WHEN** one address makes 61 listen requests within a minute
- **THEN** the 61st gets `429` with a `Retry-After` header

### Requirement: MIDI download from a share link
`GET /api/v1/listen/{token}/midi` SHALL respond with the shared song as a Standard MIDI File, with the same contents and file name rules as the Studio's song MIDI export (see `songs/export`), when the link is active and `allow_downloads` is true. When `allow_downloads` is false, it SHALL respond `404` with code `not_found`.

#### Scenario: Downloads allowed
- **WHEN** a listener requests the MIDI of an active link with downloads allowed
- **THEN** the response is a MIDI file of the shared song

#### Scenario: Downloads not allowed
- **WHEN** a listener requests the MIDI of a link with downloads turned off
- **THEN** the response is `404` with code `not_found`

### Requirement: Listen page
The frontend SHALL serve `/listen/<token>` to visitors without an account. The page SHALL show:
- the song name, tempo, key (if set), and time signature;
- a play/stop control and a playhead;
- a timeline with the section ruler (see `songwriting/sections`, "Section ruler"), where clicking a position moves the playhead there;
- the song's lyrics, read-only, with lyric headings shown as headings;
- the name of the section under the playhead.

It SHALL offer no way to change the song, and no AI features. It SHALL render the song the same way whether or not the visitor is signed in. It SHALL check for a session only when the link allows comments or remixing. The only endpoints it calls that involve a session SHALL be:
- `GET /api/v1/auth/me`, to learn whether to offer commenting and "Remix";
- `PUT /api/v1/account/username`, when a signed-in visitor chooses a username in order to comment (see `songs/listener-comments`);
- the comment endpoint (see `songs/listener-comments`);
- the remix endpoint (see `songs/remix`).

It SHALL NOT act on a `401` from any of them by signing anyone out, clearing browser storage, or navigating away.

Responses from the listen API SHALL be handled as follows:

| Listen API response | Page shows |
|---|---|
| `404` | "This link isn't available", and nothing else about why |
| `429` | A request to try again shortly |

Responses for listen pages SHALL carry `X-Robots-Tag: noindex, nofollow`, and the page SHALL include a `robots` meta tag with the same value.

#### Scenario: Play a shared song
- **WHEN** a visitor with no account opens an active link and presses play
- **THEN** the song plays, and the playhead moves across the section ruler

#### Scenario: Unavailable link
- **WHEN** a visitor opens a revoked link
- **THEN** the page says "This link isn't available" and offers no further detail

#### Scenario: Not indexed
- **WHEN** a client requests `/listen/<token>`
- **THEN** the response has `X-Robots-Tag: noindex, nofollow`

#### Scenario: Signed-out session check is harmless
- **WHEN** a visitor whose session cookie is stale opens an active link
- **THEN** the session check gets `401`, the song still renders and plays, and the page neither navigates to `/login` nor clears browser storage

### Requirement: Audio tracks on the listen page
Sample and recording audio is stored only in the owner's browser, so the listen page SHALL play every track except audio tracks. Each audio track SHALL be shown as unavailable on the listen page, and a notice SHALL say that some audio tracks aren't included. The listen page SHALL NOT read any browser sample store. When the owner creates a share link for a song with at least one audio track that has clips, the share dialog SHALL warn that those tracks will be silent for listeners before the link is created.

#### Scenario: Song with a recorded vocal
- **WHEN** a listener plays a shared song that has a drum track and a recorded vocal track
- **THEN** the drums play, the vocal track is shown as unavailable, and the notice is shown

#### Scenario: Owner warned
- **WHEN** the owner opens the share dialog for a song with a sample clip on an audio track
- **THEN** the dialog warns that audio tracks will be silent for listeners

### Requirement: WAV download from the listen page
When `allow_downloads` is true, the listen page SHALL offer "Download MIDI" and "Download WAV". "Download WAV" SHALL render the shared song in the browser with the same renderer as the Studio's WAV mixdown (see `songs/export`, "Download WAV mixdown"), without audio tracks. When `allow_downloads` is false, neither action SHALL be shown.

#### Scenario: Downloads hidden
- **WHEN** a listener opens a link with downloads turned off
- **THEN** the page shows neither "Download MIDI" nor "Download WAV"

#### Scenario: WAV rendered in the browser
- **WHEN** a listener chooses "Download WAV" on a link with downloads allowed
- **THEN** a WAV file of the song, without audio tracks, is downloaded and no song audio is uploaded or fetched from the server

### Requirement: Share dialog in the Studio
The Studio SHALL offer a "Share" action for a saved project. A project that has never been saved to the server SHALL NOT offer "Share". The action SHALL open a dialog where the owner can:
- create a link, choosing the options below;
- copy a newly created link's URL, with a note that it will not be shown again;
- see the project's links with label, mode, status, expiry, whether remixing is allowed, and unresolved comment count;
- change a link's toggles and expiry, and revoke it after confirming.

| Option | Choices | Default |
|---|---|---|
| Mode | live or snapshot | live |
| Expiry | never, 1 day, 7 days, or 30 days | never |
| Comments | on or off | on |
| Downloads | on or off | off |
| Allow remixing | on or off | on |

Next to "Allow remixing", the dialog SHALL explain that signed-in listeners will be able to save their own copy of the song, without its chat or section notes.

#### Scenario: Create and copy
- **WHEN** the owner opens "Share", keeps the defaults, and chooses "Create link"
- **THEN** the dialog shows the new URL with a copy button and the note that it won't be shown again, and the link appears in the list as active with remixing on

#### Scenario: Allow remixing on an existing link
- **WHEN** the owner turns on "Allow remixing" for an active link in the dialog
- **THEN** the link's listen page offers "Remix" to signed-in listeners

#### Scenario: Revoke from the dialog
- **WHEN** the owner chooses "Revoke" on a link and confirms
- **THEN** the link shows as revoked, and its listen page reports that it isn't available

### Requirement: Share data is deleted with its project
Deleting a project SHALL delete its share links, their snapshots, and their comments. Deleting a user SHALL delete the share links and comments of all their projects. Afterwards every token of those links SHALL get `404` with code `not_found`.

#### Scenario: Project deleted
- **WHEN** the owner deletes a project that has an active link
- **THEN** requests for that link's token get `404` with code `not_found`
