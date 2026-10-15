# Spec Delta

## MODIFIED Requirements

### Requirement: User accounts
The system SHALL store user accounts. Each account SHALL have:
- an `id`;
- an `email` of at most 254 characters, unique without regard to letter case;
- an optional `username` (see "Usernames"), unique without regard to letter case;
- a password, stored only as a salted argon2id hash and never in plain text or in logs;
- a `disabled` flag;
- creation and update times.

A password SHALL be 12–256 characters. The system SHALL NOT offer public sign-up: accounts SHALL be created only by an operator.

#### Scenario: Email is unique regardless of case
- **WHEN** an account exists for `ana@example.com` and an operator creates one for `Ana@Example.com`
- **THEN** the creation fails with a message saying the email is already in use

#### Scenario: Password never stored in plain text
- **WHEN** an account is created with a password
- **THEN** the stored record holds an argon2id hash and does not contain the password

#### Scenario: No sign-up endpoint
- **WHEN** a client looks for a way to create an account through the HTTP API
- **THEN** there is none, and the login page offers no sign-up link

#### Scenario: Existing accounts have no username
- **WHEN** the service is upgraded and an account created earlier signs in
- **THEN** `GET /api/v1/auth/me` returns its `username` as `null`

### Requirement: Operator account management
The service binary SHALL provide operator commands, run against the configured database, to:
- create an account from an email, a password, and an optional username;
- set a new password for an account;
- disable an account;
- re-enable an account;
- delete an account, together with all of its projects, sessions, usage records, and the listener comments it wrote, after the operator confirms by retyping the email or, when not interactive, by passing an explicit confirmation flag;
- list accounts, showing email, username, disabled flag, and creation time, but never password hashes.

Passwords SHALL be read from an interactive prompt or standard input and SHALL NOT be accepted as command-line arguments, because command lines are visible to other processes and shell history. A password that breaks the length rule SHALL be refused with a message. A username that breaks the username rules or is already taken SHALL be refused with a message, and no account SHALL be created. Disabling an account or setting its password SHALL end all of that account's sessions. The operator documentation SHALL state that a deleted account's data remains in database backups until they age out.

#### Scenario: Create an account
- **WHEN** an operator runs the create command for `ana@example.com` and enters a 16-character password
- **THEN** the account exists, is enabled, has no username, and can sign in with that password

#### Scenario: Create an account with a username
- **WHEN** an operator runs the create command for `ana@example.com` with username `ana`
- **THEN** the account exists with username `ana`, and the account list shows it

#### Scenario: Taken username refused
- **WHEN** an account with username `ana` exists and an operator creates another account with username `Ana`
- **THEN** the command exits non-zero with a message that the username is taken, and no account is created

#### Scenario: Short password refused
- **WHEN** an operator enters an 8-character password
- **THEN** the command exits non-zero, the message states the minimum length, and no account is created or changed

#### Scenario: Disable ends sessions
- **WHEN** a user is signed in and an operator disables their account
- **THEN** the user's next API request gets `401` with code `unauthenticated`

#### Scenario: New password ends every session
- **WHEN** a user is signed in on two browsers and an operator sets a new password for the account
- **THEN** the next API request from each browser gets `401` with code `unauthenticated`

#### Scenario: Delete removes the user's data
- **WHEN** an operator deletes `ana@example.com`, who owns two projects, has commented on another user's share link, and is signed in, and confirms
- **THEN** the account, both projects, the comment, and the session no longer exist, and the session's next request gets `401`

#### Scenario: Delete needs confirmation
- **WHEN** an operator runs the delete command from a script without the confirmation flag
- **THEN** the command exits non-zero and the account is unchanged

### Requirement: Current user and logout
The system SHALL expose `GET /api/v1/auth/me`, returning `200` with `{"user": {"id", "email", "username"}}` for a valid session, where `username` is `null` when none is set. It SHALL also expose `POST /api/v1/auth/logout`, which ends the current session, clears the cookie using the same name, `Path`, `Secure`, `HttpOnly`, and `SameSite` attributes it was set with, and responds `204`. Logging out without a valid session SHALL also respond `204`.

#### Scenario: Who am I
- **WHEN** a signed-in client with username `ana` requests `GET /api/v1/auth/me`
- **THEN** the response is `200` with that user's id, email, and username `ana`

#### Scenario: Logout ends the session
- **WHEN** a client logs out and then reuses its old cookie value
- **THEN** the request gets `401` with code `unauthenticated`

#### Scenario: Logout removes the cookie from the browser
- **WHEN** a browser holding `__Host-songbird_session` logs out
- **THEN** the response's `Set-Cookie` names `__Host-songbird_session` with `Path=/`, `Secure`, `HttpOnly`, and `SameSite=Lax` and an expiry in the past, and the browser no longer sends the cookie

### Requirement: Authentication required for the API
Every endpoint under `/api/v1` SHALL require a valid session, with these exceptions:
- `POST /api/v1/auth/login`;
- `POST /api/v1/auth/logout`;
- the public share link listen endpoints `GET /api/v1/listen/{token}` and `GET /api/v1/listen/{token}/midi` (see `songs/share-links`).

The listen endpoints that act for a user SHALL require a valid session like any other endpoint:
- `POST /api/v1/listen/{token}/comments` (see `songs/listener-comments`);
- `POST /api/v1/listen/{token}/remix` (see `songs/remix`).

A request without a session SHALL get `401` with code `unauthenticated` in the standard error shape, and the handler SHALL NOT run. That includes calling an AI provider.

The public listen endpoints SHALL ignore any session the request carries. No listen endpoint SHALL call an AI provider, and each SHALL give access only to the one shared song its token names. `GET /healthz` and `GET /readyz` SHALL remain public. No GET or HEAD endpoint SHALL change state.

A state-changing request (any method other than GET or HEAD) to any `/api/v1` endpoint SHALL be refused with `403` and code `forbidden` when its `Origin` header is present and is not one of the configured frontend origins. This includes login, logout, posting a listener comment, and remixing. The service SHALL NOT treat its own `Host` as an allowed origin, because behind the frontend's proxy that host is the internal service name, not the address the browser used.

#### Scenario: Generation without a session
- **WHEN** a client without a session posts to `/api/v1/patterns/generate`
- **THEN** the response is `401` with code `unauthenticated` and no provider is called

#### Scenario: Instruments need a session
- **WHEN** a client without a session requests `GET /api/v1/instruments`
- **THEN** the response is `401`

#### Scenario: Health stays public
- **WHEN** a client without a session requests `GET /healthz`
- **THEN** the response is `200`

#### Scenario: Listen endpoint is public
- **WHEN** a client without a session requests `GET /api/v1/listen/<token>` for an active share link
- **THEN** the response is `200`

#### Scenario: Commenting needs a session
- **WHEN** a client without a session posts a comment to `/api/v1/listen/<token>/comments` for an active link that allows comments
- **THEN** the response is `401` with code `unauthenticated`, and nothing is stored

#### Scenario: Listen prefix does not open other routes
- **WHEN** a client without a session requests `GET /api/v1/projects/{id}/shares`
- **THEN** the response is `401` with code `unauthenticated`

#### Scenario: Cross-site write refused
- **WHEN** a request carrying a valid session cookie posts to `/api/v1/projects` with `Origin: https://evil.example`
- **THEN** the response is `403` with code `forbidden` and nothing is stored

#### Scenario: Cross-site comment refused
- **WHEN** a signed-in client posts a comment to `/api/v1/listen/<token>/comments` with `Origin: https://evil.example`
- **THEN** the response is `403` with code `forbidden` and nothing is stored

#### Scenario: Cross-site remix refused
- **WHEN** a signed-in client posts to `/api/v1/listen/<token>/remix` with `Origin: https://evil.example`
- **THEN** the response is `403` with code `forbidden` and no project is created

#### Scenario: Cross-site login refused
- **WHEN** a client posts correct credentials to `/api/v1/auth/login` with `Origin: https://evil.example`
- **THEN** the response is `403` with code `forbidden`, no session is created, and no cookie is set

#### Scenario: Own host is not an allowed origin
- **WHEN** the backend receives a write with `Host: backend:8080` and `Origin: http://backend:8080`, and that origin is not configured
- **THEN** the response is `403` with code `forbidden`

### Requirement: Signed-out users are sent to login
Every page except `/login` and the share link listen pages under `/listen/` SHALL require a signed-in user. A visitor without a session cookie SHALL be redirected to `/login` before the page renders, with the original path kept as the return target. The health endpoints `/healthz` and `/readyz` SHALL NOT be redirected, so that monitors and deploy checks without a cookie reach the backend.

While the app is open, any API response of `401 unauthenticated` SHALL sign the user out of the app:
- unsaved local per-user state SHALL be discarded;
- per-user browser storage SHALL be cleared (see "Per-user browser storage");
- the browser SHALL go to `/login` with the current path as the return target.

A listen page SHALL be the exception. It SHALL render the song the same way with or without a session cookie. It is permitted to check for a session in order to offer commenting and "Remix" (see `songs/listener-comments` and `songs/remix`). It SHALL NOT sign anyone out, clear per-user browser storage, or navigate to `/login` on its own, whatever its API responses are. Following a "Sign in to comment" or "Sign in to remix" link that the visitor chooses is not navigating on its own.

#### Scenario: Visit without a session
- **WHEN** a visitor with no session cookie opens `/drum-machine`
- **THEN** they are redirected to `/login?next=/drum-machine`

#### Scenario: Legacy Studio link redirects home
- **WHEN** a signed-in user opens `/studio?song=abc`
- **THEN** they are permanently redirected to `/?song=abc`

#### Scenario: Legacy Studio link without a session
- **WHEN** a visitor with no session cookie opens `/studio?song=x`
- **THEN** they are redirected to `/login?next=%2F%3Fsong%3Dx`

#### Scenario: Listen page without a session
- **WHEN** a visitor with no session cookie opens `/listen/<token>`
- **THEN** the listen page renders and there is no redirect

#### Scenario: Listen page leaves a signed-in user alone
- **WHEN** a signed-in user opens a revoked share link in a new tab
- **THEN** the page says the link isn't available, and the user is still signed in to the Studio in their other tab

#### Scenario: Listen page session check with a stale cookie
- **WHEN** a visitor whose session has expired opens an active share link, and the listen page's session check gets `401`
- **THEN** the page renders the song, does not navigate to `/login`, and does not clear per-user browser storage

#### Scenario: Health check through the frontend
- **WHEN** a client with no cookie requests `GET /healthz` from the frontend
- **THEN** the response is the backend's `200` with `{"status":"ok"}`, not a redirect

#### Scenario: Session ends while working
- **WHEN** a user's session expires while the Studio is open and the next autosave gets `401`
- **THEN** the browser goes to `/login`, and after signing in again the user returns to the Studio

#### Scenario: Disabled while working
- **WHEN** an operator disables a user who has the app open
- **THEN** the user's next API request leads to `/login`, and signing in fails with "Email or password is incorrect"

### Requirement: Signed-in user and log out in the app
Every page except `/login` and the share link listen pages under `/listen/` SHALL show the signed-in user's email and a Log out control. The account menu SHALL offer "Profile", linking to the Profile page (see "Profile page").

A listen page SHALL NOT show the visitor's email or a Log out control, even when the visitor is signed in. The only account information it is permitted to show is the visitor's own username, next to the comment form (see `songs/listener-comments`).

Logging out SHALL call the logout endpoint, clear per-user browser storage, and go to `/login`. Any unsaved project change SHALL be saved before logging out, or the user SHALL be warned that it will be lost.

#### Scenario: Log out
- **WHEN** the user activates Log out
- **THEN** the session ends, the browser shows `/login`, and pressing Back does not show the user's projects

#### Scenario: Instruments reachable from the account menu
- **WHEN** the service lists `drums` and `piano` and the user opens the account menu
- **THEN** it offers "Drum Machine" linking to `/drum-machine` and "Piano" linking to `/instruments/piano`, grouped under an "Instruments" heading, and the item for the current page is marked as current

#### Scenario: Profile reachable from the account menu
- **WHEN** the user opens the account menu
- **THEN** it offers "Profile", linking to the Profile page

#### Scenario: No account shown on a listen page
- **WHEN** a signed-in user with username `ana` opens a share link that allows comments
- **THEN** the listen page shows neither their email nor a Log out control, and is permitted to show "Commenting as ana"

## ADDED Requirements

### Requirement: Usernames
A username SHALL follow these rules:
- it is 3 to 30 characters long;
- it contains only lowercase ASCII letters, digits, `_`, and `-`;
- it starts with a letter.

Uniqueness SHALL be checked without regard to letter case. The server SHALL store and return usernames lowercased. Uniqueness SHALL hold even when two users claim the same name at once.

`PUT /api/v1/account/username` with body `{"username": "<string>"}` SHALL set or change the current user's username and respond `200` with the same body as `GET /api/v1/auth/me`. It SHALL respond:

| Case | Status | Code |
|---|---|---|
| The username breaks the rules above | `422` | `invalid_username` |
| Another account has the username | `409` | `username_taken` |

Either refusal SHALL leave the username unchanged. Setting the username the user already has SHALL respond `200`. Username changes SHALL be limited per user, by default to 5 per hour. A change over the limit SHALL get `429` with code `too_many_requests` and a `Retry-After` header.

Changing a username SHALL NOT change the name shown on comments already posted (see `songs/listener-comments`). A username SHALL NOT be removable once set, only changed.

#### Scenario: Set a username
- **WHEN** a signed-in user with no username sends `{"username": "ana"}`
- **THEN** the response is `200` with username `ana`, and `GET /api/v1/auth/me` returns it

#### Scenario: Taken regardless of case
- **WHEN** an account has username `ana` and another user sends `{"username": "ANA"}`
- **THEN** the response is `409` with code `username_taken`

#### Scenario: Invalid username
- **WHEN** a user sends `{"username": "1ana!"}`
- **THEN** the response is `422` with code `invalid_username`, and their username is unchanged

#### Scenario: Concurrent claims
- **WHEN** two users send `{"username": "ana"}` at the same moment
- **THEN** one gets `200` and the other gets `409` with code `username_taken`

#### Scenario: Old comments keep their name
- **WHEN** user `ana` comments on a link and then changes their username to `ana-b`
- **THEN** the owner still sees the earlier comment as by `ana`

### Requirement: Profile page
The app SHALL provide a Profile page, reachable from the account menu. It SHALL show the signed-in user's email and their username, or "No username set" when there is none. It SHALL let the user set or change their username:
- the form SHALL check the username rules as the user types and explain any rule broken;
- it SHALL show the server's message for `username_taken`;
- it SHALL disable saving while a request is in flight;
- it SHALL confirm when the username is saved.

The page SHALL say that the username is shown to song owners on the user's comments.

#### Scenario: Set username from Profile
- **WHEN** a user with no username opens Profile, enters `ana`, and saves
- **THEN** the page shows `ana` as their username

#### Scenario: Taken name
- **WHEN** a user enters a username another account has and saves
- **THEN** the page says the username is taken and keeps what they typed
