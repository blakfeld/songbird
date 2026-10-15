# Spec Delta

## Purpose

Lets a signed-in listener turn a song shared with them into a new project of their own. The owner allows this per link, and the original project is never changed.

## ADDED Requirements

### Requirement: Remix API
`POST /api/v1/listen/{token}/remix` SHALL require a valid session. Without one, it SHALL respond `401` with code `unauthenticated`.

When the token names an active share link (see `songs/share-links`) whose `allow_remix` is true, the server SHALL create a new project owned by the session's user and respond `201` with `{"project": {"id", "revision", "updated_at", "song"}}`, the same shape as `POST /api/v1/projects`. The request body SHALL be ignored, so the copied song always comes from the server's own copy of the shared song and never from the client.

The endpoint SHALL respond `404` with code `not_found`, with the same body for every case below, so a response never reveals that a link once existed or that remixing is turned off:
- the token is unknown, malformed, revoked, or expired;
- the link's project was deleted;
- `allow_remix` is false.

#### Scenario: Remix a shared song
- **WHEN** signed-in user B posts to `/api/v1/listen/<token>/remix` for user A's active link with remixing allowed
- **THEN** the response is `201` with a new project id and revision 1, and the project appears in user B's project list

#### Scenario: Remixing turned off
- **WHEN** signed-in user B posts to the remix endpoint for a link with `allow_remix` false
- **THEN** the response is `404` with code `not_found`, the same body a never-issued token gets, and user B's project list is unchanged

#### Scenario: Not signed in
- **WHEN** a client with no session cookie posts to the remix endpoint for an active link with remixing allowed
- **THEN** the response is `401` with code `unauthenticated`, and no project is created

#### Scenario: Revoked link
- **WHEN** a signed-in user posts to the remix endpoint for a revoked link
- **THEN** the response is `404` with code `not_found`

#### Scenario: Client-sent song ignored
- **WHEN** a signed-in user posts to the remix endpoint with a body containing a different song
- **THEN** the created project holds the shared song, not the posted one

### Requirement: Remix contents
The remixed project's song SHALL be the link's shared song projection (see `songs/share-links`, "Shared song projection"), as follows:
- **Live link:** the projection of the project's latest saved song.
- **Snapshot link:** the projection saved at the snapshot.

The song SHALL therefore never contain the owner's song chat, lyric conversation, or section notes. The server SHALL assign a fresh project id, and the song's `id` SHALL equal that new id. The song's name SHALL be the shared song's name followed by " (remix)", shortened if necessary so that the full name fits the song-name length limit. Everything else in the projection SHALL be kept, including:
- tracks, loops, clips, and mixer settings;
- sections, key, chords, tempo, and time signature;
- lyrics;
- audio tracks, audio clips, and sample metadata.

The new project SHALL keep no link to the source project, its owner, or the share link. The response and the stored project SHALL NOT contain the source project's id or the owner's id or email.

#### Scenario: Owner's private material not copied
- **WHEN** user A's song has a song chat, a lyric conversation, and notes on its Chorus, and user B remixes it through a live link
- **THEN** user B's project has no chat, no lyric conversation, and no section notes, and has the same tracks, sections, and lyrics as user A's song

#### Scenario: Snapshot remix
- **WHEN** user A creates a snapshot link, renames "Chorus" to "Hook" and saves, and user B then remixes through the snapshot link
- **THEN** user B's project has a section named "Chorus"

#### Scenario: Name
- **WHEN** user B remixes a shared song named "Late Train"
- **THEN** user B's new project is named "Late Train (remix)"

#### Scenario: No trace of the source
- **WHEN** user B remixes user A's song
- **THEN** neither the response nor user B's stored project contains user A's project id, user id, or email

### Requirement: The source project is untouched
Remixing SHALL NOT change the source project, its revision, its `updated_at`, its share links, or their comments. Later edits to either project SHALL NOT affect the other.

#### Scenario: Original unchanged
- **WHEN** user B remixes user A's project at revision 7 and then edits and saves the remix
- **THEN** user A's project is still at revision 7 with its original contents

#### Scenario: Owner's later edits don't reach the remix
- **WHEN** user B remixes through a live link, and user A then renames "Chorus" to "Hook" and saves
- **THEN** user B's project still has a section named "Chorus"

### Requirement: Remix limits
A remix SHALL count as creating a project for the remixing user. It SHALL be subject to the same per-user project count and stored-bytes limits as `POST /api/v1/projects` (see `songs/project-storage`, "Create a project"). It SHALL be refused with `409` and code `project_limit` when it would exceed either limit, storing nothing. Remix requests SHALL also be limited per user, by default to 10 per minute. A request over the limit SHALL get `429` with code `too_many_requests` and a `Retry-After` header. The per-user limit SHALL be configurable by environment variable. Remix requests SHALL also count toward the per-address limit on listen requests (see `songs/share-links`, "Listen API abuse limits").

#### Scenario: Project limit
- **WHEN** a user who owns 500 projects remixes a shared song
- **THEN** the response is `409` with code `project_limit`, and they still own 500 projects

#### Scenario: Remix flood
- **WHEN** one user sends 11 remix requests within a minute
- **THEN** the 11th gets `429` with a `Retry-After` header

### Requirement: Remix on the listen page
The listen page SHALL find out whether the visitor is signed in without ever signing them out, clearing per-user browser storage, or navigating to `/login` on its own. When the link's `allow_remix` is true:
- **Signed-in visitor:** the page SHALL show a "Remix" button. While the remix request is in flight, the button SHALL be disabled. On success, the browser SHALL open the Studio with the new project (`/?song=<new project id>`).
- **Signed-out visitor:** the page SHALL show a "Sign in to remix" link to `/login`, with the listen page's path as the return target. After signing in, the visitor SHALL return to the same listen page and SHALL choose "Remix" themselves. Signing in SHALL NOT start a remix automatically.
- **Song with audio tracks that have clips:** before the remix starts, the page SHALL say that audio tracks will be copied without their audio.

When `allow_remix` is false, the page SHALL show no remix control, signed in or not. These are the messages for a failed remix:

| Response | Message | Effect on visitor |
|---|---|---|
| `project_limit` | The visitor is at their project limit | Stays on the page |
| `429` | Try again shortly | Stays on the page |
| `404` | Remixing isn't available for this link | Stays on the page |
| `401` | Sign in to remix | The page shows the sign-in link; the visitor is not signed out elsewhere |

#### Scenario: Remix and open in the Studio
- **WHEN** a signed-in user opens an active link with remixing allowed and chooses "Remix"
- **THEN** the browser opens the Studio with a new project named "<song name> (remix)", and the user can edit and save it

#### Scenario: Signed out
- **WHEN** a visitor with no session opens a link with remixing allowed
- **THEN** the page shows "Sign in to remix" linking to `/login?next=/listen/<token>`, and the song still plays

#### Scenario: Return after sign-in
- **WHEN** a signed-out visitor chooses "Sign in to remix" and signs in
- **THEN** they are back on the same listen page with a "Remix" button, and no project has been created yet

#### Scenario: Remixing not allowed
- **WHEN** a signed-in user opens a link with `allow_remix` false
- **THEN** the page shows no remix control

#### Scenario: Stale cookie
- **WHEN** a visitor whose session cookie has expired opens a link with remixing allowed
- **THEN** the page shows "Sign in to remix", the song plays, and the page does not navigate to `/login` or clear browser storage

#### Scenario: Audio warning
- **WHEN** a signed-in user opens a shared song with a recorded vocal clip on an audio track
- **THEN** the page says that audio tracks will be copied without their audio before they remix
