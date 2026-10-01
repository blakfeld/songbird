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
- delete an account, together with all of its projects, sessions, and usage records, after the operator confirms by retyping the email or, when not interactive, by passing an explicit confirmation flag;
- list accounts, showing email, disabled flag, and creation time, but never password hashes.

Passwords SHALL be read from an interactive prompt or standard input and SHALL NOT be accepted as command-line arguments, because command lines are visible to other processes and shell history. A password that breaks the length rule SHALL be refused with a message. Disabling an account or setting its password SHALL end all of that account's sessions. The operator documentation SHALL state that a deleted account's data remains in database backups until they age out.

#### Scenario: Create an account
- **WHEN** an operator runs the create command for `ana@example.com` and enters a 16-character password
- **THEN** the account exists, is enabled, and can sign in with that password

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
- **WHEN** an operator deletes `ana@example.com`, who owns two projects and is signed in, and confirms
- **THEN** the account, both projects, and the session no longer exist, and the session's next request gets `401`

#### Scenario: Delete needs confirmation
- **WHEN** an operator runs the delete command from a script without the confirmation flag
- **THEN** the command exits non-zero and the account is unchanged

### Requirement: Login
The system SHALL expose `POST /api/v1/auth/login`, accepting `{"email", "password"}`. When the email names an enabled account and the password matches, it SHALL create a session with a newly generated token, delete any session the request already carried, set the session cookie, and respond `200` with `{"user": {"id", "email"}}`. A token that existed before the login SHALL never become valid through it. Otherwise it SHALL respond `401` with code `invalid_credentials`. The response SHALL be the same for an unknown email, a wrong password, and a disabled account, and the request SHALL take a similar time in each case, so that the response does not reveal which accounts exist. Email matching SHALL ignore letter case and surrounding whitespace. When a successful login finds the stored hash was made with different hashing parameters than the current ones, the system SHALL replace it with a hash using the current parameters, without ending any session. The submitted password SHALL NOT appear in any log line or error message.

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

#### Scenario: Login replaces the carried session
- **WHEN** a client that already holds a session cookie with token T logs in successfully
- **THEN** the response sets a cookie with a different token, and a request carrying T gets `401` with code `unauthenticated`

#### Scenario: Old hash upgraded on login
- **WHEN** a user whose stored hash used older hashing parameters logs in successfully
- **THEN** the stored hash now uses the current parameters, and the user can still log in with the same password

#### Scenario: Credentials kept out of logs
- **WHEN** a client logs in, successfully or not, while all log output is captured
- **THEN** no log line contains the submitted password or the session token from `Set-Cookie`

### Requirement: Login throttling
Login attempts SHALL be limited over a sliding 15-minute window:
- **Per email and address:** after 5 failed logins for the same email from the same client address, further attempts for that email from that address SHALL be refused with `429` and code `too_many_requests`, even when the password is correct.
- **Per address:** after 20 failed logins from the same client address, for any emails, further attempts from that address SHALL be refused the same way.
- **Per email, from all addresses:** after 50 failed logins for the same email, further attempts for that email SHALL be answered only after a delay that grows with each further failure, up to 30 seconds, and SHALL NOT be refused for this reason, so that guessing from many addresses is slowed without locking the real user out.

Every `429` response SHALL include a `Retry-After` header. An attempt SHALL count toward these limits from the moment it starts, so that parallel attempts cannot all pass before any has failed. A successful login SHALL clear the failure count for its email and address. Throttling SHALL apply the same way whether or not the email has an account.

The client address SHALL be the connection's peer address, or, when the service is configured to trust its proxy, the first address in `X-Forwarded-For`. Trusting the proxy SHALL only be enabled when the outermost proxy replaces any client-supplied `X-Forwarded-For`, and the operator documentation SHALL say so. IPv6 addresses SHALL be grouped by their /64 prefix.

#### Scenario: Too many failures
- **WHEN** a client fails to log in 5 times for `ana@example.com` from one address within 15 minutes and then posts the correct password from that address
- **THEN** the response is `429` with code `too_many_requests` and a `Retry-After` header

#### Scenario: Another address is not blocked
- **WHEN** 5 logins for `ana@example.com` have failed from address X within 15 minutes, fewer than 50 have failed for that email in total, and Ana posts the correct password from address Y
- **THEN** the response is `200` and Ana is signed in

#### Scenario: Many addresses are slowed, not refused
- **WHEN** 60 logins for `ana@example.com` have failed from 60 different addresses within 15 minutes, and Ana posts the correct password from a new address
- **THEN** the response is delayed, and is then `200` rather than `429`

#### Scenario: Parallel attempts are counted
- **WHEN** a client sends 10 logins for `ana@example.com` with wrong passwords at the same moment from one address
- **THEN** at most 5 of them are checked against the password, and each of the rest gets `429` or `503`

#### Scenario: IPv6 neighbours share a limit
- **WHEN** 20 logins fail from addresses spread across one IPv6 /64, and another login arrives from a different address in that /64
- **THEN** the response is `429` with code `too_many_requests`

#### Scenario: Spoofed forwarding header ignored
- **WHEN** the service does not trust its proxy, and a client that has failed 20 times sends a login with `X-Forwarded-For: 203.0.113.9`
- **THEN** the response is `429`, because the client is still identified by its connection address

### Requirement: Bounded password hashing
The service SHALL hash or verify at most a small fixed number of passwords at once, between 2 and 4 depending on the server's CPUs. A login that arrives when that many are already in progress SHALL be answered at once with `503`, code `server_busy`, and a `Retry-After` header, without hashing and without waiting. Login throttling SHALL be checked before a password is hashed.

#### Scenario: Login burst stays bounded
- **WHEN** 50 logins for different emails arrive at the same moment
- **THEN** no more than 4 passwords are being hashed at any time, and every login that couldn't start hashing gets `503` with code `server_busy` and a `Retry-After` header, or `429`

#### Scenario: Throttled login is not hashed
- **WHEN** a login arrives for an email and address that have already failed 5 times in 15 minutes
- **THEN** the response is `429` and no password hash is computed for it

### Requirement: Sessions
A session SHALL be identified by a random token of at least 256 bits. The server SHALL store only a hash of the token. The token SHALL be sent to the browser in a cookie that is `HttpOnly`, `SameSite=Lax`, has `Path=/` and no `Domain`, and is `Secure` unless configuration turns that off for local development. When it is `Secure`, the cookie SHALL be named `__Host-songbird_session`, so that browsers refuse any copy set without those attributes; otherwise it SHALL be named `songbird_session`. A session SHALL end when any of these happens:
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

#### Scenario: Secure cookie uses the host prefix
- **WHEN** login sets the session cookie with `Secure` on
- **THEN** the cookie is named `__Host-songbird_session`, with `Secure`, `Path=/`, and no `Domain`

### Requirement: Current user and logout
The system SHALL expose `GET /api/v1/auth/me`, returning `200` with `{"user": {"id", "email"}}` for a valid session. It SHALL also expose `POST /api/v1/auth/logout`, which ends the current session, clears the cookie using the same name, `Path`, `Secure`, `HttpOnly`, and `SameSite` attributes it was set with, and responds `204`. Logging out without a valid session SHALL also respond `204`.

#### Scenario: Who am I
- **WHEN** a signed-in client requests `GET /api/v1/auth/me`
- **THEN** the response is `200` with that user's id and email

#### Scenario: Logout ends the session
- **WHEN** a client logs out and then reuses its old cookie value
- **THEN** the request gets `401` with code `unauthenticated`

#### Scenario: Logout removes the cookie from the browser
- **WHEN** a browser holding `__Host-songbird_session` logs out
- **THEN** the response's `Set-Cookie` names `__Host-songbird_session` with `Path=/`, `Secure`, `HttpOnly`, and `SameSite=Lax` and an expiry in the past, and the browser no longer sends the cookie

### Requirement: Authentication required for the API
Every endpoint under `/api/v1`, except `POST /api/v1/auth/login` and `POST /api/v1/auth/logout`, SHALL require a valid session. A request without one SHALL get `401` with code `unauthenticated` in the standard error shape, and the handler SHALL NOT run. That includes calling an AI provider. `GET /healthz` and `GET /readyz` SHALL remain public. No GET or HEAD endpoint SHALL change state. A state-changing request (any method other than GET or HEAD) to any `/api/v1` endpoint, including login and logout, SHALL be refused with `403` and code `forbidden` when its `Origin` header is present and is not one of the configured frontend origins. The service SHALL NOT treat its own `Host` as an allowed origin, because behind the frontend's proxy that host is the internal service name, not the address the browser used.

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

#### Scenario: Cross-site login refused
- **WHEN** a client posts correct credentials to `/api/v1/auth/login` with `Origin: https://evil.example`
- **THEN** the response is `403` with code `forbidden`, no session is created, and no cookie is set

#### Scenario: Own host is not an allowed origin
- **WHEN** the backend receives a write with `Host: backend:8080` and `Origin: http://backend:8080`, and that origin is not configured
- **THEN** the response is `403` with code `forbidden`

### Requirement: Login page
The frontend SHALL provide a `/login` page with an email field, a password field, and a Sign in button. On success, it SHALL navigate to the page the user originally asked for, or to `/` when there is none. The return target SHALL only be a path on this site, so that the login page cannot be used to send users to another site: it SHALL be resolved as a URL against the page's own origin, SHALL be ignored (going to `/`) unless the result has the same origin, and SHALL be followed using only its path, query, and fragment. On `invalid_credentials`, it SHALL show "Email or password is incorrect" and keep the email. On `too_many_requests` or `server_busy`, it SHALL say to try again later. The Sign in button SHALL be disabled while a login request is in flight. A signed-in user who opens `/login` SHALL be sent to `/`.

#### Scenario: Sign in and return
- **WHEN** a signed-out user opens `/studio`, is sent to `/login`, and signs in successfully
- **THEN** they are taken to `/studio`

#### Scenario: Wrong password on the page
- **WHEN** the user submits a wrong password
- **THEN** the page shows "Email or password is incorrect" and the email field keeps its value

#### Scenario: Off-site return target ignored
- **WHEN** the user signs in from `/login?next=https://evil.example`
- **THEN** they are taken to `/`

#### Scenario: Backslash return target ignored
- **WHEN** the user signs in from a login page whose `next` is `/\evil.example`
- **THEN** they stay on this site

#### Scenario: Encoded backslash return target ignored
- **WHEN** the user signs in from `/login?next=/%5Cevil.example`
- **THEN** they stay on this site

#### Scenario: Tab-smuggled return target ignored
- **WHEN** the user signs in from `/login?next=/%09/evil.example`
- **THEN** they stay on this site

#### Scenario: Script return target ignored
- **WHEN** the user signs in from `/login?next=javascript:alert(1)`
- **THEN** no script runs and they are taken to a page on this site

#### Scenario: Query and fragment kept
- **WHEN** the user signs in from `/login?next=%2Fstudio%3Fsong%3D1%23mixer`
- **THEN** they are taken to `/studio?song=1#mixer`

### Requirement: Signed-out users are sent to login
Every page except `/login` SHALL require a signed-in user. A visitor without a session cookie SHALL be redirected to `/login` before the page renders, with the original path kept as the return target. The health endpoints `/healthz` and `/readyz` SHALL NOT be redirected, so that monitors and deploy checks without a cookie reach the backend. While the app is open, any API response of `401 unauthenticated` SHALL sign the user out of the app: unsaved local per-user state SHALL be discarded, per-user browser storage SHALL be cleared (see "Per-user browser storage"), and the browser SHALL go to `/login` with the current path as the return target.

#### Scenario: Visit without a session
- **WHEN** a visitor with no session cookie opens `/studio`
- **THEN** they are redirected to `/login?next=/studio`

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
Every page except `/login` SHALL show the signed-in user's email and a Log out control. Logging out SHALL call the logout endpoint, clear per-user browser storage, and go to `/login`. Any unsaved project change SHALL be saved before logging out, or the user SHALL be warned that it will be lost.

#### Scenario: Log out
- **WHEN** the user activates Log out
- **THEN** the session ends, the browser shows `/login`, and pressing Back does not show the user's projects

### Requirement: Per-user browser storage
Everything the app keeps in browser storage under the `songbird.` localStorage prefix, and every IndexedDB store the app creates for a user's work (including stored audio samples), SHALL be treated as belonging to the signed-in user. Signing out, by logging out or after a `401`, SHALL delete all of it. The app SHALL keep one list of its per-user IndexedDB stores, and every new store SHALL be added to it. Songs saved in a browser's local library before accounts existed SHALL be left untouched (see `songs/multitrack`).

#### Scenario: Sign-out clears everything per-user
- **WHEN** a user with a saved pattern, a last-opened song, and stored samples logs out
- **THEN** no `songbird.` localStorage key and no per-user IndexedDB store remains in the browser

#### Scenario: Next user starts clean
- **WHEN** user A logs out and user B signs in on the same browser
- **THEN** nothing user A kept in browser storage is visible to user B
