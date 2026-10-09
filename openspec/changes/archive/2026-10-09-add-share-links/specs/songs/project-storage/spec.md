# Spec Delta

## MODIFIED Requirements

### Requirement: Projects are owned by one user
The system SHALL store each project as a song document (see `songs/multitrack`, "Song document") together with an owner, a `revision` number, and creation and update times. The owner SHALL be the user who created the project, and SHALL never change. Every project operation SHALL act only on projects owned by the user of the request's session. The only exception SHALL be share links (see `songs/share-links`): an active share link gives anyone holding its token read-only access to the shared song projection of that one project, and nothing else about it or its owner. A share link SHALL NOT allow listing, saving, or deleting any project. A project owned by someone else SHALL be treated exactly as one that does not exist: `404` with code `not_found`, with the same response body and no difference in behavior, for every method. In particular, a save to another user's project SHALL get `404` whatever `revision` it sends, and never `409`, so that the response cannot reveal that the id exists.

#### Scenario: Another user's project is invisible
- **WHEN** user B requests `GET /api/v1/projects/{id}` for a project owned by user A
- **THEN** the response is `404` with code `not_found`, the same as for an id that was never used

#### Scenario: Shared project still invisible through the project API
- **WHEN** user A has an active share link for a project, and user B requests `GET /api/v1/projects/{id}` for it
- **THEN** the response is `404` with code `not_found`

#### Scenario: Cannot overwrite another user's project
- **WHEN** user B sends `PUT /api/v1/projects/{id}` for user A's project
- **THEN** the response is `404`, and user A's project is unchanged

#### Scenario: Stale revision on another user's project still 404
- **WHEN** user A's project is at revision 4, and user B sends `PUT /api/v1/projects/{id}` for it with revision 1, then with revision 4
- **THEN** both responses are `404` with code `not_found`, neither is `409`, and user A's project is still at revision 4

#### Scenario: Cannot delete another user's project
- **WHEN** user B sends `DELETE /api/v1/projects/{id}` for user A's project
- **THEN** the response is `404` with code `not_found`, and user A can still open the project

### Requirement: Delete a project
`DELETE /api/v1/projects/{id}` SHALL permanently delete a project the current user owns, together with its share links, their snapshots, and their comments, and respond `204`. For an id that does not exist or is owned by another user, it SHALL respond `404` with code `not_found`.

#### Scenario: Delete
- **WHEN** a user deletes their project "Demo"
- **THEN** the response is `204`, and "Demo" no longer appears in their list or opens

#### Scenario: Delete a shared project
- **WHEN** a user deletes a project that has an active share link with comments
- **THEN** the response is `204`, the link's listen API responds `404` with code `not_found`, and the comments no longer exist

#### Scenario: Delete a missing project
- **WHEN** a user sends `DELETE /api/v1/projects/{id}` for an id that was never used
- **THEN** the response is `404` with code `not_found`
