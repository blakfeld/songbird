## Purpose

Defines how the production Songbird service is reached, protected, updated, and backed up when it runs on a single server with a provider-managed database.

## ADDED Requirements

### Requirement: Single HTTPS entry point
Production SHALL be reachable only through one reverse proxy, on ports 80 and 443 of the configured domain.
- **HTTPS:** the proxy SHALL obtain and renew TLS certificates automatically. It SHALL redirect every HTTP request to HTTPS, and SHALL send `Strict-Transport-Security`.
- **Hidden services:** the backend and frontend services SHALL NOT be reachable from the internet directly. Only the proxy SHALL publish ports.
- **Long requests:** the proxy SHALL NOT end a request before the frontend does, so long AI requests complete as they do in development.
- **Body size:** the proxy SHALL NOT impose a body limit below the service's own limits.
- **Client address:** the proxy SHALL replace any `X-Forwarded-For` header sent by the client with the address of the connection it accepted. The service SHALL be configured to trust `X-Forwarded-For` only on a server where this proxy is the outermost one, and the deploy documentation SHALL state that condition.

#### Scenario: HTTP redirects
- **WHEN** a client requests `http://<domain>/studio`
- **THEN** the response redirects to `https://<domain>/studio`

#### Scenario: Backend not exposed
- **WHEN** a client connects to the server's public address on port 8080 or 3000
- **THEN** the connection is refused or times out

#### Scenario: Spoofed forwarding header replaced
- **WHEN** a client sends a request with `X-Forwarded-For: 203.0.113.9` through the proxy
- **THEN** the service sees the client's real address as the first `X-Forwarded-For` entry, and `203.0.113.9` does not appear in it

#### Scenario: Slow generation completes
- **WHEN** a chat request takes 3 minutes in production
- **THEN** the client receives the service's response rather than a proxy timeout

### Requirement: Access gate before accounts exist
While the access gate is enabled, every request except `GET /healthz` SHALL require HTTP basic authentication with the configured username and password. Without valid credentials, the proxy SHALL answer `401` without forwarding the request, so no AI provider is called. The password SHALL be stored on the server only as a bcrypt hash, and SHALL NOT appear in the repository or in CI logs. The gate SHALL be enabled by default, and SHALL be turned off only by an explicit server setting.

#### Scenario: Stranger blocked
- **WHEN** a client without credentials posts to `https://<domain>/api/v1/patterns/generate`
- **THEN** the response is `401` and the backend never receives the request

#### Scenario: Health is public
- **WHEN** an uptime monitor requests `https://<domain>/healthz` without credentials
- **THEN** the response is `200` with `{"status":"ok"}`

#### Scenario: Signed-in browser works normally
- **WHEN** a user has entered the basic-auth credentials and uses the Studio
- **THEN** pages, API calls, and downloads all work without asking for the credentials again

### Requirement: Built and deployed from main
Every push to `main` whose CI checks pass SHALL produce backend and frontend container images. The images SHALL be pushed to the GitHub Container Registry, tagged with the full commit SHA, and SHALL be deployed to production automatically.
- **Exact build:** a deploy SHALL run exactly the images for that commit.
- **Health check:** a deploy SHALL succeed only when `/healthz` answers `200` through the proxy within 2 minutes of the restart.
- **Rollback:** when the health check fails, the server SHALL return to the images that were running before, and the workflow SHALL fail.
- **Manual redeploy:** an operator SHALL be able to deploy any previously built commit SHA with a manual workflow run.
- **One at a time:** deploys SHALL NOT run concurrently.
- **Limited key:** the key used by CI SHALL be able to trigger a deploy and nothing else on the server.
- **Restore point:** before changing the running images, a deploy SHALL record the time and the tags involved on the server, so that the database can be restored to the moment before that release.

#### Scenario: Merge deploys
- **WHEN** a commit is pushed to `main` and CI passes
- **THEN** images tagged with that commit's SHA are pushed, and production runs them after the workflow finishes

#### Scenario: Failed CI does not deploy
- **WHEN** CI fails on a commit to `main`
- **THEN** no image is pushed for it and production is unchanged

#### Scenario: Unhealthy release rolled back
- **WHEN** a new release's backend fails to start
- **THEN** production returns to the previous images, `/healthz` answers `200`, and the workflow reports failure

#### Scenario: Deploy key cannot run commands
- **WHEN** someone uses the CI deploy key to request an interactive shell or an arbitrary command
- **THEN** the server runs only the deploy script and gives no shell

### Requirement: Managed database with provider backups
When the service stores data, production SHALL use a Postgres database managed by a hosting provider, not a database on the server.
- **Backups:** the provider's automated backups SHALL be on, with point-in-time restore covering at least the last 7 days.
- **Secret:** the database URL SHALL be stored only on the server, and SHALL NOT appear in the repository, CI configuration or logs, or the images.
- **TLS:** the service SHALL connect only over TLS that verifies the database server's certificate.
- **Access:** the database SHALL accept connections only from the production server. The service SHALL connect as a role that can use only its own database, with no superuser, role-creation, or database-creation rights.
- **Required setting:** production SHALL refuse to start the backend when the database URL is missing, rather than falling back to a local database that a redeploy would discard.
- **Restore:** a documented procedure SHALL restore the database to a chosen point in time and switch the service to it. It SHALL be rehearsed against a scratch instance before the first production deploy that stores data. Before deploying a release that adds a database migration, the operator SHALL take an on-demand snapshot.
- **Deleted data:** the documentation SHALL state that deleted data remains in backups until it ages out of the provider's retention window.

#### Scenario: Server lost
- **WHEN** the VPS is destroyed and the operator provisions a new one with the same server settings
- **THEN** the service starts with all its data, without any restore

#### Scenario: Bad migration undone
- **WHEN** a release applies a migration and then fails its health check
- **THEN** the operator restores the database to the time recorded before that deploy, deploys the previous release, and `/healthz` answers `200` with the data as it was before the release

#### Scenario: Plaintext connection refused
- **WHEN** a client tries to connect to the production database without TLS
- **THEN** the database refuses the connection

#### Scenario: Wrong server certificate refused
- **WHEN** the service's database host resolves to a server whose certificate is not signed by the provider's CA
- **THEN** the backend fails to connect and does not send the password

#### Scenario: Database closed to others
- **WHEN** a client from an address other than the production server tries to connect to the database with valid credentials
- **THEN** the connection is refused

#### Scenario: Missing URL stops the backend
- **WHEN** production is started without the database URL set
- **THEN** the stack does not start, and the error names the missing setting

### Requirement: Reproducible server setup
A fresh Ubuntu LTS server SHALL be made ready for deploys by applying the repository's cloud-init file and following the deploy README. After setup:
- only ports 22, 80, and 443 SHALL accept connections;
- SSH SHALL accept keys only, not passwords;
- security updates SHALL install automatically;
- containers SHALL restart after a reboot.

#### Scenario: Reboot recovers
- **WHEN** the production server reboots
- **THEN** the proxy, frontend, and backend are running again, and `/healthz` answers `200` without manual action
