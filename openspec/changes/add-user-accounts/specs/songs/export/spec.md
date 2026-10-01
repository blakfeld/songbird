## MODIFIED Requirements

### Requirement: Project file import
The Studio page SHALL provide an "Open project" action that accepts a `.songbird.json` file of at most 5 MB, validates it, and adds it to the signed-in user's projects as a new project (see `songs/project-storage`), then opens it. The file SHALL be rejected, with a message stating the reason and without changing the library, when:
- it is not valid JSON, or its `format` is not `"songbird-song"`;
- its project-file `version` is newer than the version this app supports;
- its song document cannot be opened by the song library, including when its loops and clips break the song document's rules;
- any track uses an instrument this service does not list;
- any value is outside the ranges of the song document.

A song document from an older song `version` SHALL be converted exactly as the song library converts it on load.

Fields of the song document that this app does not recognise SHALL NOT cause rejection and SHALL be kept unchanged, because later versions add optional fields without changing `version`. The `version` SHALL only increase for a change that older apps cannot read correctly.

The imported song SHALL always receive a new id from the server, so that it never replaces an existing project. The file SHALL be checked in the browser before anything is sent to the server. If the server then refuses the song, the import SHALL fail with the server's message, and the library SHALL be unchanged.

#### Scenario: Round trip
- **WHEN** the user downloads a project and then opens that file while signed in to another account
- **THEN** the song opens with identical name, settings, tracks, loops, clips, and mixer values

#### Scenario: Newer version rejected
- **WHEN** the user opens a file with project-file `"version": 2`
- **THEN** the import is rejected with a message saying the file was made by a newer version of Songbird, and the library is unchanged

#### Scenario: Unrecognised optional field kept
- **WHEN** the user opens a version 1 file whose song has an extra field `"mood": "wistful"` that this app does not know
- **THEN** the import succeeds and downloading the project again produces a song that still contains `"mood": "wistful"`

#### Scenario: Invalid clips rejected
- **WHEN** the user opens a file in which two clips on the same track overlap
- **THEN** the import is rejected with a message naming that track, and the library is unchanged

#### Scenario: Unknown instrument rejected
- **WHEN** the user opens a file containing a track with instrument `"theremin"` that the service does not list
- **THEN** the import is rejected with a message naming `theremin`

#### Scenario: Duplicate id kept separately
- **WHEN** the user opens a project file whose song id matches a project already in their library
- **THEN** the library contains both songs, and the imported one has a new id
