# Spec Delta

## MODIFIED Requirements

### Requirement: Undo and redo on the Studio page
The Studio page SHALL support undo and redo, via on-screen buttons and Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z, of note edits on any track, track add, rename, and delete, song setting changes, and mixer changes. A continuous volume or pan drag SHALL be recorded as one undo step. Selecting a track and transport actions SHALL NOT be recorded. Undo history SHALL be kept per open song and SHALL NOT survive a page reload.

Each change that applies an AI result to the arrangement SHALL be recorded as exactly one undo step. These changes are:
- writing a generated track part;
- adding a track from the song chat;
- keeping a take, together with any spare takes kept with it (see `songs/variations`).

Restoring a snapshot (see `songs/project-snapshots`) SHALL also be recorded as one undo step.

The following SHALL NOT be recorded: selecting measures, auditioning a take or switching between a take and the original, previewing a snapshot, and creating, renaming, or deleting snapshots. Leaving a take audition or a snapshot preview SHALL return the song to exactly the state it was in before, without adding an undo step or clearing redo.

#### Scenario: Undo a track deletion
- **WHEN** the user deletes the Bass track and presses Cmd/Ctrl+Z
- **THEN** the Bass track is restored with its notes and mixer settings

#### Scenario: One drag, one undo step
- **WHEN** the user drags a volume slider from 0 dB to −10 dB in one gesture and then presses Cmd/Ctrl+Z
- **THEN** the volume returns to 0 dB

#### Scenario: Undo a chat-added track
- **WHEN** the song chat adds a Strings track and the user presses Cmd/Ctrl+Z once
- **THEN** the Strings track is removed, and the chat conversation still shows the exchange

#### Scenario: Auditioning is not an undo step
- **WHEN** the user auditions three takes in turn, discards the session, and presses Cmd/Ctrl+Z
- **THEN** the undo reverses the edit made before the takes were requested, not anything about the takes

#### Scenario: Undo a restore
- **WHEN** the user restores a snapshot and then presses Cmd/Ctrl+Z
- **THEN** the arrangement is exactly as it was before the restore
