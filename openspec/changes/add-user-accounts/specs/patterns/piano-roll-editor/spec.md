## MODIFIED Requirements

### Requirement: Work survives page reload
The current pattern and prompt SHALL be persisted in the browser, separately per signed-in user and per instrument, so that reloading the page restores them. No pattern data SHALL be sent to the server for storage. A user SHALL never see a pattern saved by another user in the same browser. Logging out, or being signed out after a `401`, SHALL delete every saved pattern and prompt from the browser, along with the user's last-opened song.

#### Scenario: Reload restores pattern
- **WHEN** the user edits a pattern and reloads the page
- **THEN** the same pattern, including edits, is displayed

#### Scenario: Patterns are not shared between users
- **WHEN** user A edits a piano pattern, logs out, and user B signs in on the same browser and opens the piano page
- **THEN** user B sees an empty piano pattern, not user A's

#### Scenario: Logout clears patterns
- **WHEN** a user logs out
- **THEN** no pattern or prompt saved by the editor pages remains in browser storage
