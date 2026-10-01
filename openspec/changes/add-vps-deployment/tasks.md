# Tasks

## 1. Images

- [ ] 1.1 Backend Dockerfile: add `WORKDIR /app`, add cargo cache mounts, and add a `HEALTHCHECK` (D9). Verify that `docker build backend` succeeds and that `docker inspect` of a running container reports `healthy`.
- [ ] 1.2 Frontend Dockerfile: add a `HEALTHCHECK` using a `node` fetch of `/healthz` (D9). Verify with `docker compose up --build` from the repo root that both containers report `healthy`.

## 2. Production stack

- [ ] 2.1 Write `deploy/compose.yaml`:
  - Caddy is the only service with ports, and the other services sit on an internal network.
  - Images are `ghcr.io/blakfeld/songbird-{backend,frontend}:${SONGBIRD_TAG}`.
  - Use per-service `env_file`, `restart: unless-stopped`, log rotation, the `caddy-data`/`caddy-config` volumes, and health-ordered `depends_on` (D2, D8). No data volume.
  - Once the foundation ships: `SONGBIRD_DATABASE_URL: ${SONGBIRD_DATABASE_URL:?}` on the backend and a read-only mount of `certs/` for the database CA (D2, D6).

  Verify that `docker compose -f deploy/compose.yaml config` validates.
- [ ] 2.2 Write `deploy/Caddyfile`: the domain, HSTS, compression, `basic_auth` on everything but `/healthz` when `SONGBIRD_GATE` is on, and `reverse_proxy frontend:3000` with no `trusted_proxies` (D2, D3). Write `deploy/.env.example` documenting every variable, including `SONGBIRD_DATABASE_URL` as a secret with `sslmode=verify-full&sslrootcert=`, and `SONGBIRD_TRUST_PROXY=true` with a comment that it is valid only while Caddy is outermost. Verify the stack locally with `SONGBIRD_DOMAIN=localhost`, using Caddy's internal CA and locally built images tagged `local`:
  - `/healthz` returns 200 without credentials;
  - `/studio` and `POST /api/v1/patterns/generate` return 401 without credentials and work with them;
  - a 3-minute mock delay completes, using `SONGBIRD_AI_PROVIDER=mock` with an artificial delay or a long timeout setting;
  - a request sent with `X-Forwarded-For: 203.0.113.9` reaches the backend with the real client address as the first entry and without `203.0.113.9` (check with a request-logging echo container in place of the backend, or the backend's debug log). This also confirms that the Next rewrite keeps Caddy's entry first;
  - with `SONGBIRD_DATABASE_URL` unset (once the guard is in), `docker compose up` fails naming it.
- [ ] 2.3 Set up the managed Postgres (D6), once `add-database-foundation` has merged: an instance in the VPS's region with automated backups and point-in-time restore of at least 7 days, TLS-only connections, trusted sources limited to the VPS, a `songbird_app` role with `CONNECT` on `songbird` and ownership of its `public` schema only, and the provider CA in `/opt/songbird/certs/`. Write the role SQL and the restore runbook into `deploy/README.md`. Verify:
  - the backend starts against it with `sslmode=verify-full` and `/readyz` returns 200;
  - `psql` without TLS, and from an address outside the trusted sources, is refused;
  - `songbird_app` cannot `CREATE DATABASE` or `CREATE ROLE`;
  - a point-in-time restore into a scratch instance, with the URL pointed at it, serves the same rows.

## 3. Deploy script and server setup

- [ ] 3.1 Write `deploy/deploy.sh` (D5): forced-command SHA validation, `flock`, a `deploys.log` line (old tag, new SHA, UTC time) before the images change, pull and up with `SONGBIRD_TAG`, a health poll through Caddy for up to 120 s, rollback to the previous tag on failure, `current_tag` tracking, and image pruning beyond the last 3 tags. Make it `shellcheck`-clean. Verify with `shellcheck deploy/deploy.sh`, plus a local run against the stack from 2.2, where an image whose backend exits immediately triggers rollback and exit 1.
- [ ] 3.2 Write `deploy/cloud-init.yaml` (D7): users, SSH hardening, Docker from the official repo, `ufw` (22/80/443), unattended-upgrades, a 2 GB swap file, the `/opt/songbird` layout, and the forced-command `authorized_keys` entry template. Verify by launching it on a throwaway VPS or a local multipass/cloud-init VM:
  - `ssh deploy@host bash` runs only the deploy script and rejects a non-SHA command;
  - password SSH is refused;
  - an external `nmap` shows only 22, 80, and 443.

## 4. Release workflow

- [ ] 4.1 Write `.github/workflows/release.yml` (D4):
  - triggers: `workflow_run` on `ci` success for `main`, and `workflow_dispatch` with a `sha` input;
  - `concurrency: production`;
  - a build job pushing SHA and `main` tags to GHCR with gha cache and `packages: write`;
  - a deploy job in the `production` environment that sends the SHA over SSH with known hosts pinned from secrets.

  Verify with `actionlint`, then a manual dispatch on a test branch with the deploy job pointed at the throwaway server.
- [ ] 4.2 Set the GHCR package visibility to public, and document the private-repo token alternative. Verify that `docker pull ghcr.io/blakfeld/songbird-backend:<sha>` works from the server without logging in.

## 5. Documentation and first deploy

- [ ] 5.1 Write `deploy/README.md` covering:
  - cost table and VPS choice;
  - DNS;
  - cloud-init usage;
  - creating `.env` (hash generation with `caddy hash-password`);
  - GitHub secrets and the environment;
  - setting the Anthropic spend limit;
  - deploy, manual redeploy, and rollback;
  - choosing a managed Postgres provider, creating the least-privilege role, the TLS and trusted-sources setup, and the connection-limit headroom for `SONGBIRD_DATABASE_MAX_CONNECTIONS`;
  - the restore procedure (point-in-time to the `deploys.log` time, or a snapshot), the snapshot checklist for releases that add a migration, and that deleted data stays in backups until it ages out;
  - `SONGBIRD_TRUST_PROXY=true` and why it is safe only while Caddy is the outermost proxy;
  - rotating the basic-auth password;
  - turning the gate off after accounts ship;
  - an optional Cloudflare Access alternative;
  - a recommended external uptime check.

  Link it from the root README. Verify by following it end to end on a fresh server, fixing any step that doesn't work as written.
- [ ] 5.2 Do the first production deploy and run the smoke checks:
  - HTTP redirects to HTTPS;
  - 401 without credentials;
  - `/healthz` 200 without credentials;
  - ports 3000 and 8080 closed from outside;
  - the Studio loads and a generation succeeds with credentials;
  - after a reboot, `/healthz` is 200 again;
  - once `add-user-accounts` is live, a login with a spoofed `X-Forwarded-For` is throttled by the real client address.

  Verify that every check passes and record the results in the PR.
- [ ] 5.3 Run `code-reviewer` on the branch, with attention to secret handling, the forced-command script, the firewall, the database role and TLS settings, and the proxy-trust setting. Verify that the review findings are resolved.
