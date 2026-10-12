# platform/deployment Specification

## Purpose

Defines how production Songbird is reached, where its data lives, and how it starts, stops, and reports health, when it runs as one Fly.io app on SQLite.

## Requirements

### Requirement: Public entry through the web server
Production SHALL be reachable from the internet only through the web server's HTTPS address.
- **HTTPS:** an HTTP request SHALL be redirected to HTTPS.
- **Private API:** the API SHALL listen only on the Machine's loopback interface. Only the web server on the same Machine SHALL reach it.
- **Long requests:** a chat stream that ends within its deadline SHALL reach the client complete. The keepalive events the service already sends SHALL keep the stream inside the platform's idle timeout.
- **Client address:** the API SHALL be configured to take the client address from `Fly-Client-IP`, and the web server SHALL pass that header through to the API unchanged.

#### Scenario: HTTP redirects
- **WHEN** a client requests `http://<web-host>/login`
- **THEN** the response redirects to `https://<web-host>/login`

#### Scenario: API not exposed
- **WHEN** a client on the internet tries to reach the API's port 8080 on the app's address
- **THEN** no connection to the API is made

#### Scenario: Slow generation completes
- **WHEN** a chat request streams for 140 seconds in production
- **THEN** the client receives the whole stream, including its final event

#### Scenario: Forged client address ignored
- **WHEN** a client that has failed 20 logins sends another with `X-Forwarded-For: 203.0.113.9`
- **THEN** the response is `429`, because the API identifies the client by the address Fly's edge saw

### Requirement: One Machine with a persistent database
Production SHALL run as exactly one Machine. Its SQLite database SHALL be stored on a Fly volume mounted at `/app/data`, and a deploy SHALL keep using the same volume.
- **Mount check:** the container SHALL refuse to start when `/app/data` is not a mounted volume.
- **Location check:** the container SHALL refuse to start when `SONGBIRD_DATABASE_URL` does not point to a SQLite file under `/app/data`.
- **One writer:** the deployment documentation SHALL state that the app must never be scaled above one Machine, and why. A second Machine would get its own empty volume.
- **Migrations:** schema migrations SHALL keep running at API startup, because platform release commands cannot access the volume.
- **Backups:** the documentation SHALL state that the volume's daily platform snapshots are the only backup.

#### Scenario: Data survives a deploy
- **WHEN** a user saves a song and a new release is deployed
- **THEN** the song is still in the user's projects after the deploy

#### Scenario: Missing volume stops the Machine
- **WHEN** the container starts without a volume mounted at `/app/data`
- **THEN** it exits non-zero with a message saying no volume is mounted, and does not serve requests

#### Scenario: Database outside the volume refused
- **WHEN** the container starts with `SONGBIRD_DATABASE_URL` pointing outside `/app/data`
- **THEN** it exits non-zero with a message saying the database must be on the volume, and does not serve requests

### Requirement: Both services supervised together
The web server and the API SHALL run as one unprivileged user, started by one entrypoint.
- **Shutdown:** on SIGTERM the entrypoint SHALL pass the signal to both services, wait for both to finish draining, and exit 0. The platform's kill timeout SHALL be longer than the services' drain limit.
- **Failure:** when either service exits on its own, the entrypoint SHALL stop the other and exit non-zero, so the platform restarts the Machine.

#### Scenario: Deploy drains streams
- **WHEN** the Machine receives SIGTERM while a chat stream is open
- **THEN** the stream completes within its deadline before the Machine stops

#### Scenario: Crashed API restarts the Machine
- **WHEN** the API process dies while the web server is running
- **THEN** the container exits non-zero

### Requirement: Health reflects the whole stack
The platform health check SHALL request `/readyz` through the web server. It SHALL pass only when the web server, the API, and the database all answer.

#### Scenario: Database unavailable
- **WHEN** the API cannot run a query within its readiness timeout
- **THEN** the health check fails

### Requirement: Per-user AI keys in production
Production SHALL serve AI requests only with each requesting user's own provider key.
- **Fixed mode:** the app's configuration in the repository SHALL set the environment mode to production, and the deployment documentation SHALL forbid overriding it with a secret.
- **No operator key:** production SHALL NOT be given an operator AI credential or an operator AI provider.
- **Master key:** the key that encrypts users' stored provider keys SHALL be stored only as a platform secret. It SHALL NOT appear in the repository, CI configuration or logs, or the image.

#### Scenario: Leftover operator key stops the API
- **WHEN** the app is given a non-blank `ANTHROPIC_API_KEY`
- **THEN** the API refuses to start, and the error names the setting

#### Scenario: User without a key
- **WHEN** a signed-in user who has not added a provider key opens the Studio
- **THEN** AI actions are disabled, with a link to `/settings/ai-keys`
