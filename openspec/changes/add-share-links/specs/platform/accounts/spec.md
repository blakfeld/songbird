# Spec Delta

## MODIFIED Requirements

### Requirement: Authentication required for the API
Every endpoint under `/api/v1`, except `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, and the share link listen endpoints under `/api/v1/listen/` (see `songs/share-links` and `songs/listener-comments`), SHALL require a valid session. A request without one SHALL get `401` with code `unauthenticated` in the standard error shape, and the handler SHALL NOT run. That includes calling an AI provider. The listen endpoints SHALL ignore any session the request carries, SHALL NOT call an AI provider, and SHALL give access only to the one shared song their token names. `GET /healthz` and `GET /readyz` SHALL remain public. No GET or HEAD endpoint SHALL change state. A state-changing request (any method other than GET or HEAD) to any `/api/v1` endpoint, including login, logout, and posting a listener comment, SHALL be refused with `403` and code `forbidden` when its `Origin` header is present and is not one of the configured frontend origins. The service SHALL NOT treat its own `Host` as an allowed origin, because behind the frontend's proxy that host is the internal service name, not the address the browser used.

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

#### Scenario: Listen prefix does not open other routes
- **WHEN** a client without a session requests `GET /api/v1/projects/{id}/shares`
- **THEN** the response is `401` with code `unauthenticated`

#### Scenario: Cross-site write refused
- **WHEN** a request carrying a valid session cookie posts to `/api/v1/projects` with `Origin: https://evil.example`
- **THEN** the response is `403` with code `forbidden` and nothing is stored

#### Scenario: Cross-site comment refused
- **WHEN** a client posts a comment to `/api/v1/listen/<token>/comments` with `Origin: https://evil.example`
- **THEN** the response is `403` with code `forbidden` and nothing is stored

#### Scenario: Cross-site login refused
- **WHEN** a client posts correct credentials to `/api/v1/auth/login` with `Origin: https://evil.example`
- **THEN** the response is `403` with code `forbidden`, no session is created, and no cookie is set

#### Scenario: Own host is not an allowed origin
- **WHEN** the backend receives a write with `Host: backend:8080` and `Origin: http://backend:8080`, and that origin is not configured
- **THEN** the response is `403` with code `forbidden`

### Requirement: Signed-out users are sent to login
Every page except `/login` and the share link listen pages under `/listen/` SHALL require a signed-in user. A visitor without a session cookie SHALL be redirected to `/login` before the page renders, with the original path kept as the return target. A listen page SHALL render the same way with or without a session cookie. The health endpoints `/healthz` and `/readyz` SHALL NOT be redirected, so that monitors and deploy checks without a cookie reach the backend. While the app is open, any API response of `401 unauthenticated` SHALL sign the user out of the app: unsaved local per-user state SHALL be discarded, per-user browser storage SHALL be cleared (see "Per-user browser storage"), and the browser SHALL go to `/login` with the current path as the return target. A listen page SHALL NOT sign anyone out, clear per-user browser storage, or navigate to `/login`, whatever its API responses are.

#### Scenario: Visit without a session
- **WHEN** a visitor with no session cookie opens `/studio`
- **THEN** they are redirected to `/login?next=/studio`

#### Scenario: Listen page without a session
- **WHEN** a visitor with no session cookie opens `/listen/<token>`
- **THEN** the listen page renders and there is no redirect

#### Scenario: Listen page leaves a signed-in user alone
- **WHEN** a signed-in user opens a revoked share link in a new tab
- **THEN** the page says the link isn't available, and the user is still signed in to the Studio in their other tab

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
Every page except `/login` and the share link listen pages under `/listen/` SHALL show the signed-in user's email and a Log out control. A listen page SHALL NOT show any account information, even when the visitor is signed in. Logging out SHALL call the logout endpoint, clear per-user browser storage, and go to `/login`. Any unsaved project change SHALL be saved before logging out, or the user SHALL be warned that it will be lost.

#### Scenario: Log out
- **WHEN** the user activates Log out
- **THEN** the session ends, the browser shows `/login`, and pressing Back does not show the user's projects

#### Scenario: No account shown on a listen page
- **WHEN** a signed-in user opens a share link
- **THEN** the listen page shows neither their email nor a Log out control
