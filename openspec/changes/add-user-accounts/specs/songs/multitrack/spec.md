## ADDED Requirements

### Requirement: Account song library
Songs SHALL be saved to the signed-in user's projects (see `songs/project-storage`) automatically, within about a second after each change. The Studio page SHALL list the user's projects by name and last-modified time, most recent first, and SHALL show no one else's. It SHALL let the user create, open, rename, duplicate, and delete songs, and it SHALL ask for confirmation before deleting. Reloading the page SHALL reopen the song this user most recently opened in this browser, in the state it was last saved. A user with no projects SHALL get a new song created for them.
- **Save failure:** when a save fails for a reason other than `401`, the page SHALL show a message saying changes are not being saved, editing SHALL continue to work, and saving SHALL be retried.
- **Saving too often:** when a save gets `429`, the page SHALL save again after the `Retry-After` time and SHALL NOT show it as a failure, because it only means the server's minimum time between saves hasn't passed.
- **Conflict:** when a save gets `revision_conflict`, the page SHALL stop autosaving that song and tell the user that it was changed elsewhere. It SHALL offer to reload the saved version, discarding this tab's unsaved changes, or to save this tab's version as a new copy.
- **Leaving:** when the user tries to close or leave the page with a change that has not been saved yet, the browser SHALL warn them.

#### Scenario: Reload restores the song
- **WHEN** the user edits a track's notes and mixer settings and reloads the page
- **THEN** the same song opens with the same notes and mixer settings

#### Scenario: Songs follow the user to another browser
- **WHEN** the user saves "Late Train" in one browser and signs in on another
- **THEN** "Late Train" is in the Studio's song list there and opens with the same contents

#### Scenario: Duplicate a song
- **WHEN** the user duplicates the song "Demo"
- **THEN** a new song "Demo (copy)" with its own id and identical tracks appears in the list, and editing it does not change "Demo"

#### Scenario: Save deferred, not failed
- **WHEN** a save gets `429` with `Retry-After: 1`
- **THEN** no "not being saved" message appears, and the latest changes are saved about a second later

#### Scenario: Server unavailable
- **WHEN** the server cannot be reached when a save is attempted
- **THEN** the page shows a message saying changes are not being saved, and editing continues to work

#### Scenario: Edited in two tabs
- **WHEN** the user edits the same song in two tabs and the second tab's save gets a revision conflict
- **THEN** the second tab says the song was changed elsewhere and offers to reload it or save a copy

#### Scenario: Local songs are not migrated
- **WHEN** a user signs in on a browser that holds songs saved before accounts existed
- **THEN** those songs are not shown in the song list and are not uploaded

## REMOVED Requirements

### Requirement: Browser song library
**Reason**: Songs are now owned by user accounts and stored on the server, so a person can only see their own projects and can reach them from any browser.
**Migration**: Replaced by "Account song library". Songs in a browser's local library are not migrated. Users who need one can open it in a build from before this change, download it with "Download project", and then use "Open project" after signing in.
