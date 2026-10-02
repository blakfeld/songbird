# Proposal

## Why

Songbird only runs on a developer's machine. To use it from anywhere, or show it to anyone, it needs a production deployment. The app is two stateless containers, so one small VPS is the cheapest fit, at about $5 a month, with the data in a provider-managed Postgres whose automated backups the provider runs. Serverless hosting doesn't fit well: long AI requests run up to 10 minutes through the Next proxy. Every API endpoint is currently unauthenticated, so the deployment must also keep strangers out until `add-user-accounts` ships. AI requests run on each user's own provider key (`add-user-api-keys`), so the deployment must never hold an operator AI key, and must not be switchable into the development mode that would accept one.

## What Changes

- **Production stack.** A `deploy/` directory with a production `compose.yaml`:
  - the backend and frontend run from prebuilt images;
  - only Caddy is publicly reachable, and it provides automatic HTTPS and an HTTP→HTTPS redirect;
  - the backend and frontend run on an internal network with no published ports;
  - restart policies and log rotation;
  - Caddy replaces any client-supplied `X-Forwarded-For`, so the backend can trust it for login throttling (`SONGBIRD_TRUST_PROXY=true` on this server only).
- **Access gate.** Caddy puts HTTP basic auth in front of every path except `/healthz`. The credentials are configured on the server and never stored in the repo. Turning the gate off is a single setting, for after accounts ship.
- **Per-user AI keys.** The production compose file hard-sets `SONGBIRD_ENV: production` for the backend, so editing `.env` on the server cannot switch it to development mode, where operator providers are allowed. The server holds no `ANTHROPIC_API_KEY` or `SONGBIRD_AI_PROVIDER`; production rejects both. `SONGBIRD_MASTER_KEYS`, which encrypts users' stored keys, is a server-only secret kept out of the repository and out of database backups.
- **Images built in CI.** A GitHub Actions workflow builds the backend and frontend images on each push to `main` that passes CI, and pushes them to GHCR, tagged with the commit SHA and `main`.
- **Deploy and rollback.** The same workflow then deploys over SSH, with a forced-command deploy key: the server pulls the SHA-tagged images, restarts, and waits for `/healthz`. If the health check fails, it rolls back to the previous SHA. Any earlier SHA can be redeployed by hand.
- **Server provisioning.** A `cloud-init` file sets up a fresh Ubuntu VPS:
  - Docker, a firewall (22, 80, and 443 only), unattended security upgrades, a swap file, and SSH key-only login;
  - a `deploy` user and the `/opt/songbird` layout.
- **Database and backups.** Once `add-database-foundation` lands, production uses a provider-managed Postgres with the provider's automated backups and point-in-time restore. `SONGBIRD_DATABASE_URL` is a server-only secret; the connection requires verified TLS; the app uses a least-privilege role; and only the VPS may connect. Each deploy records a restore point, and rolling back a release that migrated the database is a provider point-in-time restore or a snapshot taken before it. A documented, rehearsed restore procedure is included.
- **Docs.** `deploy/README.md` covers:
  - choosing a VPS, DNS, first-time setup, and secrets;
  - per-user AI keys (users add theirs at `/settings/ai-keys`), generating, storing, rotating, and recovering from loss of the master key, and revoking the old operator Anthropic key;
  - setting up the managed database (role, TLS, trusted sources) and when `SONGBIRD_TRUST_PROXY` is safe;
  - deploying, rolling back, restoring, and rotating the basic-auth password;
  - cost estimates.

## Capabilities

### New Capabilities
- `platform/deployment`: how production is reached and protected (HTTPS only, a single public entry point, the access gate, client-address forwarding, and public health), how it is updated (built, deployed, verified, rolled back), and how its managed database is connected and backed up.

### Modified Capabilities
<!-- None: application behaviour is unchanged. -->

## Impact

- **New files:**
  - `deploy/compose.yaml`
  - `deploy/Caddyfile`
  - `deploy/cloud-init.yaml`
  - `deploy/deploy.sh`, the forced-command target
  - `deploy/.env.example`
  - `deploy/README.md`
  - `.github/workflows/release.yml`
- **Existing files:**
  - Backend Dockerfile: `WORKDIR /app` and a `HEALTHCHECK`.
  - Frontend Dockerfile: `HEALTHCHECK`.
  - The root `docker-compose.yml` stays the local dev and demo stack.
- **GitHub settings:**
  - repository secrets `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, and `DEPLOY_KNOWN_HOSTS`;
  - a `production` environment, to optionally require approval;
  - GHCR package visibility.
- **Ongoing cost:**
  - a VPS of about $4–6 a month (Hetzner CX22 class);
  - a managed Postgres plan with automated backups and point-in-time restore, from about $15 a month at the smallest size;
  - a domain;
  - no AI provider usage for the operator: each user pays for their own key.
- **No application code changes.**
