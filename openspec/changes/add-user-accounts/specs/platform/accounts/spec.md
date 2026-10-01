## Purpose

Lets several people use one Songbird service: each person signs in to their own account, and the service serves nothing but its health check to anyone without a valid session.

## ADDED Requirements

### Requirement: User accounts
The system SHALL store user accounts. Each account SHALL have:
- an `id`;
- an `email` of at most 254 characters, unique without regard to letter case;
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

### Requirement: Operator account management
The service binary SHALL provide operator commands, run against the configured database, to:
- create an account from an email and a password;
- set a new password for an account;
- disable an account;
- re-enable an account;
- list accounts, showing email, disabled flag, and creation time, but never password hashes.

Passwords SHALL be read from an interactive prompt or standard input and SHALL NOT be accepted as command-line arguments, because command lines are visible to other processes and shell history. A password that breaks the length rule SHALL be refused with a message. Disabling an account or setting its password SHALL end all of that account's sessions.

#### Scenario: Create an account
- **WHEN** an operator runs the create command for `ana@example.com` and enters a 16-character password
- **THEN** the account exists, is enabled, and can sign in with that password

#### Scenario: Short password refused
- **WHEN** an operator enters an 8-character password
- **THEN** the command exits non-zero, the message states the minimum length, and no account is created or changed

#### Scenario: Disable ends sessions
- **WHEN** a user is signed in and an operator disables their account
- **THEN** the user's next API request gets `401` with code `unauthenticated`

### Requirement: Login
The system SHALL expose `POST /api/v1/auth/login`, accepting `{"email", "password"}`. When the email names an enabled account and the password matches, it SHALL create a session, set the session cookie, and respond `200` with `{"user": {"id", "email"}}`. Otherwise it SHALL respond `401` with code `invalid_credentials`. The response SHALL be the same for an unknown email, a wrong password, and a disabled account, and the request SHALL take a similar time in each case, so that the response does not reveal which accounts exist. Email matching SHALL ignore letter case and surrounding whitespace.

#### Scenario: Successful login
- **WHEN** a client posts the correct email and password of an enabled account
- **THEN** the response is `200` with that user's id and email, and it sets the session cookie

#### Scenario: Wrong password
- **WHEN** a client posts an existing email with a wrong password
- **THEN** the response is `401` with code `invalid_credentials` and no cookie is set

#### Scenario: Unknown email looks the same
- **WHEN** a client posts an email with no account
- **THEN** the response is identical to the wrong-password response

#### Scenario: Disabled account
- **WHEN** a disabled account posts its correct password
- **THEN** the response is `401` with code `invalid_credentials`

### Requirement: Login throttling
After 5 failed logins for the same email within 15 minutes, or 20 failed logins from the same client address within 15 minutes, further login attempts for that email or from that address SHALL be refused with `429` and code `too_many_requests` until the window passes, even when the password is correct. The response SHALL include a `Retry-After` header. A successful login SHALL clear the failure count for that email. Throttling SHALL apply the same way whether or not the email has an account.

#### Scenario: Too many failures
- **WHEN** a client fails to log in 5 times for `ana@example.com` within 15 minutes and then posts the correct password
- **THEN** the response is `429` with code `too_many_requests` and a `Retry-After` header

### Requirement: Sessions
A session SHALL be identified by a random token of at least 256 bits. The server SHALL store only a hash of the token. The token SHALL be sent to the browser in a cookie that is `HttpOnly`, `SameSite=Lax`, has `Path=/`, and is `Secure` unless configuration turns that off for local development. A session SHALL end when any of these happens:
- it has not been used for the configured idle lifetime (default 7 days);
- 30 days have passed since login;
- the user logs out;
- an operator disables the account or sets its password.

Using a session SHALL extend its idle lifetime. Ended sessions SHALL be deleted from storage.

#### Scenario: Idle session expires
- **WHEN** a session has not been used for longer than the idle lifetime
- **THEN** a request carrying its cookie gets `401` with code `unauthenticated`

#### Scenario: Cookie is not readable by scripts
- **WHEN** login sets the session cookie
- **THEN** the cookie has the `HttpOnly` and `SameSite=Lax` attributes

### Requirement: Current user and logout
The system SHALL expose `GET /api/v1/auth/me`, returning `200` with `{"user": {"id", "email"}}` for a valid session. It SHALL also expose `POST /api/v1/auth/logout`, which ends the current session, clears the cookie, and responds `204`. Logging out without a valid session SHALL also respond `204`.

#### Scenario: Who am I
- **WHEN** a signed-in client requests `GET /api/v1/auth/me`
- **THEN** the response is `200` with that user's id and email

#### Scenario: Logout ends the session
- **WHEN** a client logs out and then reuses its old cookie value
- **THEN** the request gets `401` with code `unauthenticated`

### Requirement: Authentication required for the API
Every endpoint under `/api/v1`, except `POST /api/v1/auth/login` and `POST /api/v1/auth/logout`, SHALL require a valid session. A request without one SHALL get `401` with code `unauthenticated` in the standard error shape, and the handler SHALL NOT run. That includes calling an AI provider. `GET /healthz` SHALL remain public. A state-changing request (any method other than GET or HEAD) SHALL be refused with `403` and code `forbidden` when its `Origin` header is present and is not one of the configured frontend origins or the service's own origin.

#### Scenario: Generation without a session
- **WHEN** a client without a session posts to `/api/v1/patterns/generate`
- **THEN** the response is `401` with code `unauthenticated` and no provider is called

#### Scenario: Instruments need a session
- **WHEN** a client without a session requests `GET /api/v1/instruments`
- **THEN** the response is `401`

#### Scenario: Health stays public
- **WHEN** a client without a session requests `GET /healthz`
- **THEN** the response is `200`

#### Scenario: Cross-site write refused
- **WHEN** a request carrying a valid session cookie posts to `/api/v1/projects` with `Origin: https://evil.example`
- **THEN** the response is `403` with code `forbidden` and nothing is stored

### Requirement: Login page
The frontend SHALL provide a `/login` page with an email field, a password field, and a Sign in button. On success, it SHALL navigate to the page the user originally asked for, or to `/` when there is none. The return target SHALL only be a path on this site, so that the login page cannot be used to send users to another site. On `invalid_credentials`, it SHALL show "Email or password is incorrect" and keep the email. On `too_many_requests`, it SHALL say to try again later. The Sign in button SHALL be disabled while a login request is in flight. A signed-in user who opens `/login` SHALL be sent to `/`.

#### Scenario: Sign in and return
- **WHEN** a signed-out user opens `/studio`, is sent to `/login`, and signs in successfully
- **THEN** they are taken to `/studio`

#### Scenario: Wrong password on the page
- **WHEN** the user submits a wrong password
- **THEN** the page shows "Email or password is incorrect" and the email field keeps its value

#### Scenario: Off-site return target ignored
- **WHEN** the user signs in from `/login?next=https://evil.example`
- **THEN** they are taken to `/`

### Requirement: Signed-out users are sent to login
Every page except `/login` SHALL require a signed-in user. A visitor without a session cookie SHALL be redirected to `/login` before the page renders, with the original path kept as the return target. While the app is open, any API response of `401 unauthenticated` SHALL sign the user out of the app: unsaved local per-user state SHALL be discarded, per-user browser storage SHALL be cleared as described in `patterns/piano-roll-editor`, and the browser SHALL go to `/login` with the current path as the return target.

#### Scenario: Visit without a session
- **WHEN** a visitor with no session cookie opens `/studio`
- **THEN** they are redirected to `/login?next=/studio`

#### Scenario: Session ends while working
- **WHEN** a user's session expires while the Studio is open and the next autosave gets `401`
- **THEN** the browser goes to `/login`, and after signing in again the user returns to the Studio

#### Scenario: Disabled while working
- **WHEN** an operator disables a user who has the app open
- **THEN** the user's next API request leads to `/login`, and signing in fails with "Email or password is incorrect"

### Requirement: Signed-in user and log out in the app
Every page except `/login` SHALL show the signed-in user's email and a Log out control. Logging out SHALL call the logout endpoint, clear per-user browser storage, and go to `/login`. Any unsaved project change SHALL be saved before logging out, or the user SHALL be warned that it will be lost.

#### Scenario: Log out
- **WHEN** the user activates Log out
- **THEN** the session ends, the browser shows `/login`, and pressing Back does not show the user's projects
