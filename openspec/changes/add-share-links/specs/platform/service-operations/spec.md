# Spec Delta

## MODIFIED Requirements

### Requirement: Request logging protects credentials
Request logs SHALL NOT contain request or response headers, passwords, session tokens, or share link tokens. A request to a share link listen path (under `/api/v1/listen/`) SHALL be logged with the token replaced by a fixed placeholder, so the log still shows which kind of listen request it was. After a request is authenticated, its log records SHALL carry the user's id and SHALL NOT carry the user's email. A failed login SHALL be logged with the client address and a one-way hash of the normalised email instead of the email itself. Listener comment names and bodies SHALL NOT be logged.

#### Scenario: Authenticated request traced by user id
- **WHEN** a signed-in user requests `GET /api/v1/projects` while logs are captured
- **THEN** the request's log records include that user's id and do not include their email

#### Scenario: Failed login logged without the email
- **WHEN** a login for `ana@example.com` fails while logs are captured
- **THEN** a log line records the failure with the client address, and no log line contains `ana@example.com` or the submitted password

#### Scenario: Share token not logged
- **WHEN** a client requests `GET /api/v1/listen/<token>` and posts a comment through it while logs are captured
- **THEN** no log line contains the token or the comment's text, and the request lines show the path with a placeholder in place of the token

#### Scenario: Created token not logged
- **WHEN** an owner creates a share link while logs are captured
- **THEN** no log line contains the new token
