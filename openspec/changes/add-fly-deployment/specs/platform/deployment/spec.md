# Spec Delta

## Purpose

Defines how production Songbird is reached, where its data lives, how that data is backed up and restored, and how CI deploys and rolls back releases, when it runs as two Fly.io apps backed by SQLite.

## ADDED Requirements

### Requirement: Public entry through the web app
Production SHALL be reachable from the internet only through the web app's HTTPS address.
- **HTTPS:** an HTTP request SHALL be redirected to HTTPS.
- **Private API:** the API app SHALL have no public address or service. Only the web app SHALL reach it, over Fly's private network.
- **Long requests:** a chat stream that ends within its deadline SHALL reach the client complete. The keepalive events the service already sends SHALL keep the stream inside the platform's idle timeout.
- **Client address:** the API SHALL be configured to take the client address from `Fly-Client-IP`, and the web app SHALL pass that header through to the API unchanged.

#### Scenario: HTTP redirects
- **WHEN** a client requests `http://<web-host>/login`
- **THEN** the response redirects to `https://<web-host>/login`

#### Scenario: API not exposed
- **WHEN** a client on the internet tries to reach the API app by its own `.fly.dev` name or any public address
- **THEN** no connection to the API is made

#### Scenario: Slow generation completes
- **WHEN** a chat request streams for 140 seconds in production
- **THEN** the client receives the whole stream, including its final event

#### Scenario: Forged client address ignored
- **WHEN** a client that has failed 20 logins sends another with `X-Forwarded-For: 203.0.113.9`
- **THEN** the response is `429`, because the API identifies the client by the address Fly's edge saw

### Requirement: One API instance with a persistent database
The API SHALL run as exactly one Machine. Its SQLite database SHALL be stored on a Fly volume mounted at `/app/data`, and a deploy SHALL keep using the same volume.
- **Mount check:** the API container SHALL refuse to start when `/app/data` is not a mounted volume.
- **One writer:** the deployment documentation SHALL state that the API app must never be scaled above one Machine, and why. A second Machine would get its own empty volume.
- **Migrations:** schema migrations SHALL keep running at API startup, because platform release commands cannot access the volume.

#### Scenario: Data survives a deploy
- **WHEN** a user saves a song and a new release of the API is deployed
- **THEN** the song is still in the user's projects after the deploy

#### Scenario: Missing volume stops the API
- **WHEN** the API container starts without a volume mounted at `/app/data`
- **THEN** it exits non-zero with a message saying the data volume is missing, and does not serve requests

### Requirement: Continuous backup and restore
Every committed change to the production database SHALL be replicated continuously to an object storage bucket, with point-in-time restore over at least the last 7 days.
- **Restore on boot:** when the API starts with no database file and the bucket holds a backup, it SHALL restore the latest state before serving.
- **No silent fresh start:** when the API starts with no database file and the bucket holds no backup, it SHALL refuse to start unless the operator has explicitly allowed a new database. The documentation SHALL say to allow it only for the first launch, or after confirming that the backups are truly lost, and to remove the allowance immediately afterwards.
- **Final sync:** on shutdown, replication SHALL finish sending committed changes before the process exits.
- **Secrets:** the bucket credentials SHALL be stored only as platform secrets, and SHALL NOT appear in the repository, CI configuration or logs, or the images.
- **Restore drill:** a documented procedure SHALL restore the database to a chosen time and switch production to it. It SHALL be rehearsed against a scratch app before the first launch.
- **Deleted data:** the documentation SHALL state that deleted data remains in the bucket until it ages out of the 7-day retention.

#### Scenario: Lost volume restored
- **WHEN** the API's volume is replaced by an empty one and the API starts
- **THEN** it restores the database from the bucket, and users' songs are present when it begins serving

#### Scenario: Empty bucket refused
- **WHEN** the API starts with no database file, the bucket holds no backup, and no fresh database has been allowed
- **THEN** it exits non-zero with a message saying no database or backup was found, and does not serve requests

#### Scenario: Bad migration undone
- **WHEN** a release applies a migration that corrupts data
- **THEN** the operator restores the database to the time recorded before that deploy, deploys the previous release, and users' data is as it was before the release

### Requirement: Built and deployed from main
Every push to `main` whose CI checks pass SHALL be deployed to production automatically, the API first and then the web app.
- **Gated:** the deploy SHALL run only after every CI job for that commit has passed.
- **Traceable:** each deployed image SHALL be labelled with the full commit SHA.
- **Health check:** a deploy SHALL succeed only when `https://<web-host>/healthz` answers `200` within 3 minutes of the release.
- **Rollback:** when the health check fails, the workflow SHALL redeploy the images that were running before and SHALL fail.
- **Restore point:** before changing the running API, the workflow SHALL record the current time and the images involved in its run summary.
- **Manual redeploy:** an operator SHALL be able to deploy any previously deployed SHA with a manual workflow run.
- **One at a time:** deploys SHALL NOT run concurrently, and a queued deploy SHALL NOT cancel one in progress.
- **Limited tokens:** each token used by CI SHALL be able to deploy only its own app.

#### Scenario: Merge deploys
- **WHEN** a commit is pushed to `main` and CI passes
- **THEN** production runs that commit's images after the workflow finishes

#### Scenario: Failed CI does not deploy
- **WHEN** a CI job fails on a commit to `main`
- **THEN** no deploy runs and production is unchanged

#### Scenario: Pull requests never deploy
- **WHEN** CI passes on a pull request
- **THEN** no deploy runs

#### Scenario: Unhealthy release rolled back
- **WHEN** a new release's API fails to start
- **THEN** the workflow redeploys the previous images, `/healthz` answers `200`, and the workflow reports failure

### Requirement: Per-user AI keys in production
Production SHALL serve AI requests only with each requesting user's own provider key.
- **Fixed mode:** the API app's configuration in the repository SHALL set the environment mode to production, and the deployment documentation SHALL forbid overriding it with a secret.
- **No operator key:** production SHALL NOT be given an operator AI credential or an operator AI provider.
- **Master key:** the key that encrypts users' stored provider keys SHALL be stored only as a platform secret. It SHALL NOT appear in the repository, CI configuration or logs, the images, or the database backups.

#### Scenario: Leftover operator key stops the API
- **WHEN** the API app is given a non-blank `ANTHROPIC_API_KEY`
- **THEN** the API refuses to start, and the error names the setting

#### Scenario: User without a key
- **WHEN** a signed-in user who has not added a provider key opens the Studio
- **THEN** AI actions are disabled, with a link to `/settings/ai-keys`
