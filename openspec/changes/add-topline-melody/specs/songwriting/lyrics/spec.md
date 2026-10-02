# Spec Delta

## ADDED Requirements

### Requirement: Generate a topline from a lyric heading
Each heading in the notepad that is linked to a song section SHALL offer a "Generate topline" action. The action SHALL open the topline dialog (see `songwriting/topline`) for that lyric section and the first song section it is linked to. Unlinked headings SHALL NOT offer the action. The action SHALL be reachable by keyboard and SHALL NOT change the lyrics text or the notepad's undo history.

#### Scenario: Linked heading offers the action
- **WHEN** the notepad contains `[Chorus]` linked to the song's Chorus section
- **THEN** the heading offers "Generate topline", and choosing it opens the topline dialog for the Chorus

#### Scenario: Unlinked heading has no action
- **WHEN** the notepad contains `[Hook]` and no section is named "Hook"
- **THEN** the heading offers no "Generate topline" action
