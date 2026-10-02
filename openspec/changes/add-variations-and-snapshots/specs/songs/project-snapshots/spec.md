# Spec Delta

## Purpose

Keeps a saved version history for each project, so songwriters can always get back to the song as it was before an AI change or at a point they named. They can preview and restore those versions from the Studio.

## ADDED Requirements

### Requirement: Snapshots belong to a project and its owner
A snapshot SHALL be a stored copy of a project's song document. It SHALL also record:
- an id;
- a `kind`, which is `auto` or `manual`;
- for `auto` snapshots, a `reason`, which is one of `chat`, `track_generation`, `variation`, `chords`, or `restore`;
- an optional `label`;
- `size_bytes`;
- a creation time.

Every snapshot operation SHALL act only on snapshots of a project owned by the user of the request's session. A project or snapshot that does not exist, belongs to another user's project, or belongs to a different project than the one in the path SHALL be treated identically: `404` with code `not_found`, the same body, for every method.

Deleting a project SHALL delete all of its snapshots.

#### Scenario: Another user's snapshots are invisible
- **WHEN** user B requests `GET /api/v1/projects/{id}/snapshots` for a project owned by user A
- **THEN** the response is `404` with code `not_found`, the same as for an id that was never used

#### Scenario: Snapshot id under the wrong project
- **WHEN** user A requests `GET /api/v1/projects/{p2}/snapshots/{s}`, where snapshot `s` belongs to user A's project `p1`
- **THEN** the response is `404` with code `not_found`

#### Scenario: Project delete removes snapshots
- **WHEN** a user deletes a project that has 12 snapshots
- **THEN** none of those snapshots can be listed or opened, and their bytes no longer count against the user's storage

### Requirement: List snapshots
`GET /api/v1/projects/{id}/snapshots` SHALL respond `200` with `{"snapshots": [...]}`, newest first. Each entry SHALL have:
- `id`, `kind`, `reason` (null for manual), `label` (or null), `created_at`, and `size_bytes`;
- `facts`: `name`, `tempo_bpm`, `time_signature`, `key` (or null), `measures`, and `tracks` (each track's `id`, `name`, and `instrument`).

The list SHALL NOT include song contents.

#### Scenario: Newest first, without songs
- **WHEN** a project has a manual snapshot from Monday and an auto snapshot from Tuesday, and its owner lists snapshots
- **THEN** the Tuesday snapshot is first, and neither entry contains a `song` field

### Requirement: Create a snapshot
`POST /api/v1/projects/{id}/snapshots` SHALL accept `{"song", "kind", "reason"?, "label"?}`.

**Validation.** The following SHALL be rejected with `422`, storing nothing:
- An `auto` snapshot without a valid `reason`, or a `manual` snapshot with a `reason`: code `invalid_snapshot`.
- A `label` that is empty after trimming whitespace, or longer than 80 characters: code `invalid_snapshot`.
- A song that fails project validation (see `songs/project-storage`, "Project validation"): the same codes as project save.
- A song whose `id` is not the project id: code `id_mismatch`.

**Storage and response.** The song SHALL be stored exactly as sent, including fields this version of the service does not recognise. On success the response SHALL be `201` with `{"snapshot": <list entry>}`.

**De-duplication.** When an `auto` snapshot's song is byte-for-byte identical to the song of the project's newest snapshot, the system SHALL store nothing and SHALL respond `200` with that newest snapshot's entry.

**Rate limit.** A user SHALL be limited to 30 snapshot creates per minute. Creates beyond that SHALL get `429` with code `too_many_requests` and a `Retry-After` header.

#### Scenario: Manual snapshot
- **WHEN** a user posts their project's song with `kind` `manual` and `label` "Before the bridge rewrite"
- **THEN** the response is `201`, and the snapshot is listed with that label and no reason

#### Scenario: Identical auto snapshot is not stored twice
- **WHEN** an auto snapshot is created, and then a second auto snapshot is posted with an identical song
- **THEN** the second response is `200` with the first snapshot's id, and the project's snapshot count is unchanged

#### Scenario: Auto without reason refused
- **WHEN** a user posts `kind` `auto` with no `reason`
- **THEN** the response is `422` with code `invalid_snapshot`, and nothing is stored

### Requirement: Open, rename, and delete a snapshot
- `GET /api/v1/projects/{id}/snapshots/{snapshot_id}` SHALL respond `200` with `{"snapshot": <list entry plus "song">}`. The song SHALL be exactly as stored.
- `PATCH /api/v1/projects/{id}/snapshots/{snapshot_id}` SHALL accept `{"label"}`, validated as on create. It SHALL set the label and SHALL make the snapshot `manual`, keeping its `reason` for display, so that a named snapshot is never pruned automatically. It SHALL respond `200` with the updated entry. Renaming an auto snapshot SHALL be refused with `409` and code `snapshot_limit` when the project already has 25 manual snapshots.
- `DELETE /api/v1/projects/{id}/snapshots/{snapshot_id}` SHALL delete the snapshot and respond `204`.

#### Scenario: Naming an auto snapshot keeps it
- **WHEN** a user renames an auto `chat` snapshot to "Good groove", and 60 more auto snapshots are created afterwards
- **THEN** "Good groove" is still listed, as `manual`, with reason `chat`

#### Scenario: Unknown fields survive
- **WHEN** a snapshot is created from a song containing `"mood": "wistful"` and then opened
- **THEN** the returned song contains `"mood": "wistful"`

### Requirement: Snapshot retention and quota
Each project SHALL keep at most 50 `auto` snapshots. Creating another SHALL delete the oldest `auto` snapshots of that project until 50 remain. `auto` snapshots older than 30 days SHALL be deleted no later than the next create or list for that project.

Each project SHALL hold at most 25 `manual` snapshots. A manual create beyond that SHALL be refused with `409` and code `snapshot_limit`, storing nothing.

Snapshot bytes SHALL count, together with project songs, against the user's 100 MiB storage limit (see `songs/project-storage`). When a create would exceed the limit:
- For an `auto` snapshot, the system SHALL first delete that project's oldest `auto` snapshots, as far as needed and possible. When the limit would still be exceeded, the create SHALL be refused with `409` and code `project_limit`.
- For a `manual` snapshot, the create SHALL be refused with `409` and code `project_limit`.

These limits SHALL hold even when several creates for the same user arrive at once.

#### Scenario: Oldest auto snapshot pruned
- **WHEN** a project has 50 auto snapshots and 3 manual snapshots, and a new auto snapshot is created
- **THEN** the project has 50 auto snapshots, the oldest has been deleted, and all 3 manual snapshots remain

#### Scenario: Old auto snapshots expire
- **WHEN** a project has an auto snapshot created 31 days ago and its owner lists snapshots
- **THEN** that snapshot is not listed

#### Scenario: Manual limit
- **WHEN** a project has 25 manual snapshots and the user creates another manual snapshot
- **THEN** the response is `409` with code `snapshot_limit`, and nothing is stored

#### Scenario: Concurrent auto creates stay within the cap
- **WHEN** a project has 49 auto snapshots and two different auto snapshots are created at the same moment
- **THEN** both succeed, and the project has exactly 50 auto snapshots

### Requirement: Automatic snapshots before AI-applied changes
Before the Studio applies an AI result to the song, it SHALL create an `auto` snapshot of the song exactly as it was immediately before the change. The reasons are:
- `track_generation`: a generated track part, including "Regenerate bars";
- `chat`: a track added by the song chat;
- `variation`: keeping a take;
- `chords`: applying generated chords or rendering chords to a track, once chord generation exists.

The change SHALL be applied without waiting for the snapshot to be stored. When the snapshot cannot be stored, the change SHALL still be applied, and the Studio SHALL show a notice that no restore point was saved and that Undo still works.

A chat reply that adds no track, a failed generation, and a discarded variation session SHALL NOT create a snapshot.

#### Scenario: Snapshot before generation
- **WHEN** the user generates measures 5–8 of the Keys track and the result is applied
- **THEN** the project's newest snapshot is `auto` with reason `track_generation`, and its song has the Keys track as it was before the generation

#### Scenario: Snapshot failure does not block the change
- **WHEN** the server refuses the auto snapshot with `409` `project_limit` while a chat-added track is applied
- **THEN** the track is added, and a notice says no restore point was saved

#### Scenario: Reply-only chat takes no snapshot
- **WHEN** the song chat answers with a reply and no track
- **THEN** no snapshot is created

### Requirement: History panel
The Studio's right column SHALL have a History tab for the open song. It SHALL list the song's snapshots, newest first. Each entry SHALL show:
- the label, or for an unnamed auto snapshot a description of its reason (for example "Before song chat");
- the relative creation time;
- a summary of how it differs from the current song, computed from the listed `facts`: tracks added or removed by name, tempo, meter, key, and song length. When none of these differ, it SHALL say "Same tracks and settings".

The panel SHALL also show the total storage used by the song's snapshots, because snapshots count against the user's storage limit.

The panel SHALL offer:
- "Save snapshot", with an optional name, which creates a `manual` snapshot of the current song;
- for each snapshot: Preview, Restore, Rename, and Delete. Delete SHALL ask for confirmation.

The History tab SHALL be unavailable while a track generation is in flight or a variation session is open, and SHALL say why.

#### Scenario: At-a-glance difference
- **WHEN** a snapshot was taken before the chat added a Strings track and the tempo was then changed from 90 to 100 BPM
- **THEN** its entry says the current song adds Strings and changes tempo from 90 to 100 BPM

#### Scenario: Save a named snapshot
- **WHEN** the user chooses "Save snapshot" and names it "Verse locked"
- **THEN** "Verse locked" appears at the top of the History list as a manual snapshot

### Requirement: Previewing a snapshot
Preview SHALL show the snapshot's song in the arrangement and play it, read-only, with a banner that names the snapshot and offers Restore and Exit preview. While previewing:
- no song edit, generation, chat, or variation session SHALL be possible;
- the snapshot SHALL NOT be saved as the project;
- undo history SHALL be unchanged.

Exit preview SHALL return to the current song exactly as it was, keeping the playhead position. Previewing SHALL NOT trigger a save.

#### Scenario: Preview leaves the song untouched
- **WHEN** the user previews last week's snapshot, plays it, and exits the preview
- **THEN** the song is exactly as it was before the preview, no save is made, and Cmd/Ctrl+Z still undoes the last edit made before the preview

### Requirement: Restoring a snapshot
Restore SHALL first create an `auto` snapshot of the current song with reason `restore`. It SHALL then replace the open song with the snapshot's song. The following SHALL be kept from the current song rather than taken from the snapshot:
- the song `id`;
- the song chat (`chat`);
- the lyric chat (`lyric_chat`).

The replacement SHALL be one undo step, and SHALL be saved to the project by the usual autosave. Restore SHALL NOT need a confirmation, because it can be undone and the replaced song is kept as a snapshot. When the "before restore" snapshot cannot be stored, Restore SHALL ask the user to confirm before replacing the song.

#### Scenario: Restore and reload
- **WHEN** the user restores the snapshot "Verse locked" and reloads the page
- **THEN** the song opens with the tracks and settings of "Verse locked", and the History list has a "Before restore" auto snapshot holding the song as it was before the restore

#### Scenario: Chat survives restore
- **WHEN** the user restores a snapshot taken before the last three chat messages
- **THEN** the chat panel still shows all the messages
