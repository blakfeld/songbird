# Design

## Context

- **Images:** `backend/Dockerfile` is a `rust:1.92-bookworm` build feeding a `debian:bookworm-slim` runtime. It runs as a system user and listens on `0.0.0.0:8080`. `frontend/Dockerfile` is a `node:22-slim` build feeding the Next `standalone` runtime on :3000.
- **API URL is baked in:** the frontend bakes `SONGBIRD_API_URL` into its rewrites at build time. The default, `http://backend:8080`, already matches a compose service name, so the image works unchanged in production.
- **Long requests:** the Next rewrite proxy waits up to 10 minutes (`proxyTimeout`) for long AI calls.
- **Dev compose:** the root `docker-compose.yml` publishes 8080 and 3000, defaults to the mock provider, and has an optional `ollama` profile. It stays as the local stack.
- **CI:** `.github/workflows/ci.yml` runs `just lint` and `just test` on every push and PR. There is no release workflow.
- **Auth:** every `/api/v1` endpoint is unauthenticated until `add-user-accounts`.
- **Database:** `add-database-foundation` (not yet built) chooses the backend by `SONGBIRD_DATABASE_URL`: SQLite at `/app/data/songbird.db` when unset, Postgres by URL, with TLS through rustls. Migrations run at startup, and an older build refuses a database with a migration it doesn't know.
- **Decision by the user:** production runs on Postgres, with automated backups provided by the hosting provider (managed Postgres). This replaces an earlier plan for SQLite on the VPS with Litestream replication to Backblaze B2.
- **Security review:** findings on proxy trust (H1) and database handling are folded in below. Defaults the user had no answer for are marked *default chosen pending user confirmation*.
- **Repository:** `github.com/blakfeld/songbird`.

## Goals / Non-Goals

**Goals:**
- Lowest steady cost with acceptable reliability for a personal or small-group app.
- Push to `main` → production in minutes, with an automatic rollback when the new release is unhealthy.
- Nothing secret in the repository, and nothing on the server reachable except the proxy.

**Non-Goals:**
- High availability, multiple servers, zero-downtime deploys (a few seconds of restart gap is acceptable), staging environments, and Kubernetes.
- Running Postgres on the VPS. Backups, point-in-time restore, patching, and failover would all become ours, which is exactly what the managed service is paid for.
- Hosting a local LLM. Ollama needs a much larger server and is out of budget.
- Monitoring dashboards. An external uptime check on `/healthz` (for example, a free UptimeRobot plan) is recommended in the README only.

## Decisions

### D1. One VPS running Docker Compose
- The target is a Hetzner CX22 (x86, 2 vCPU, 4 GB, 40 GB disk) on Ubuntu 24.04. Any comparable VPS works, and the docs list alternatives.
- *Why x86 over the cheaper ARM CAX11:* the images build on GitHub's x86 runners natively. ARM would need QEMU (very slow for the Rust build) or ARM runners. The difference is about €1/month.
- *Alternatives:*
  - Fly.io: similar cost, but more platform coupling for no gain once the database is managed elsewhere.
  - Cloud Run or Vercel: request time limits that long AI calls exceed.
  - A PaaS such as Render or Railway: costs more for always-on.

### D2. Caddy as the only public service
`deploy/compose.yaml` defines:
- `caddy`: `caddy:2`, ports 80 and 443, volumes `caddy-data` and `caddy-config`, and `Caddyfile` mounted read-only;
- `frontend` and `backend`: GHCR images pinned by `${SONGBIRD_TAG}`, on an internal network, with no `ports:`. The backend's environment uses `SONGBIRD_DATABASE_URL: ${SONGBIRD_DATABASE_URL:?}`, so compose refuses to start without it. Otherwise the foundation's default would put a SQLite file inside the container, and every deploy would silently discard its data. This guard and the read-only `certs/` mount for the database CA certificate are added in the deploy that first sets the URL (Migration Plan step 5); before the foundation ships, the backend has no database. No data volume is mounted. The backend's `environment:` also hard-sets `SONGBIRD_ENV: production`. `environment:` overrides `env_file`, so editing `.env` on the server cannot switch the service to development mode, where operator AI providers are allowed (`add-user-api-keys`).

Every service uses `restart: unless-stopped` and the `json-file` log driver with `max-size: 10m, max-file: 3`, so logs can't fill the disk.

The `Caddyfile`:
```
{$SONGBIRD_DOMAIN} {
  encode zstd gzip
  header Strict-Transport-Security "max-age=31536000"
  @gated {
    not path /healthz
    expression "{$SONGBIRD_GATE:on}" == "on"
  }
  basic_auth @gated {
    {$SONGBIRD_BASIC_AUTH_USER} {$SONGBIRD_BASIC_AUTH_HASH}
  }
  reverse_proxy frontend:3000
}
```

- Caddy handles ACME and the HTTP→HTTPS redirect automatically.
- `reverse_proxy` has no response timeout by default, and the Next proxy enforces its own 10 minutes, so long AI calls pass through.
- Everything goes to `frontend:3000`, because Next already rewrites `/api`, `/healthz`, and `/readyz` to the backend. That keeps the browser same-origin, as in development, and requires no CORS changes.
- **`X-Forwarded-For`:** the Caddyfile sets no `trusted_proxies`, so Caddy discards any client-supplied `X-Forwarded-For` and sends the real peer address. That is what makes `SONGBIRD_TRUST_PROXY=true` safe on this server (D8). If a CDN or another proxy is ever put in front of Caddy, Caddy is no longer outermost and that flag must be revisited.
- **Security headers:** Caddy sends only HSTS, because it is where TLS terminates. The app's other security headers (CSP, framing, `nosniff`, referrer) come from the Next config in `add-user-accounts`, so they also apply outside this topology. *(Default chosen pending user confirmation.)*
- *Why Caddy:* automatic TLS with zero config and built-in `basic_auth`. Traefik and nginx with certbot need more moving parts.

### D3. Basic auth as the interim gate
- The bcrypt hash is generated with `docker run caddy caddy hash-password` and stored in `/opt/songbird/.env`. Browsers cache the credentials per origin and send them on same-origin `fetch` automatically, so the SPA and the API calls work without code changes.
- `SONGBIRD_GATE=off` disables the gate once `add-user-accounts` is live. Its session cookie and basic auth would otherwise both prompt.
- *Alternative:* Cloudflare Access (free for up to 50 users). It gives SSO and email login, but requires moving DNS to Cloudflare and proxying through it. It is documented as an optional upgrade, not the default, because basic auth needs no third party.
- *Spend control:* AI requests run on each user's own key (D8), so leaked gate credentials cost the operator no AI spend. The gate protects the unauthenticated endpoints, not a provider bill.

### D4. Release workflow: build once, deploy by SHA
`.github/workflows/release.yml`:
- **Trigger:** `workflow_run` of `ci` on `main` with `conclusion == success`, plus `workflow_dispatch` with a `sha` input for manual redeploys. `workflow_run` guarantees nothing ships unless CI passed on that exact commit.
- **Concurrency:** `group: production`, `cancel-in-progress: false`.
- **`build` job:**
  - It uses `docker/build-push-action` with GitHub Actions layer caching (`cache-from/to: type=gha`).
  - It pushes `ghcr.io/blakfeld/songbird-backend:<sha>`, `:main`, and the frontend equivalents.
  - It needs `permissions: packages: write`.
  - It is skipped for `workflow_dispatch` if the tag already exists.
- **`deploy` job:**
  - It uses the `environment: production` setting, so required reviewers can be turned on later.
  - It runs `ssh -i key deploy@$DEPLOY_HOST "<sha>"`, with known hosts pinned from the `DEPLOY_KNOWN_HOSTS` secret, never `StrictHostKeyChecking=no`.
- **GHCR visibility:** packages are public. The source is already public, so this avoids storing a registry token on the server. If the repository goes private, the README covers a read-only `GHCR_TOKEN` and `docker login` on the server.

### D5. Forced-command deploy script with health-gated rollback
In `authorized_keys` for `deploy`: `command="/opt/songbird/deploy.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 …`. The SSH "command" the client sends arrives as `$SSH_ORIGINAL_COMMAND`. The script accepts only a 40-hex SHA and rejects anything else.

`deploy.sh`:
1. Take a `flock` on `/opt/songbird/deploy.lock`.
2. Read the current tag from `/opt/songbird/current_tag`.
3. Set `SONGBIRD_TAG=<sha>` and run `docker compose pull`, then `docker compose up -d --remove-orphans`.
4. Poll `https://$SONGBIRD_DOMAIN/healthz` through Caddy, using `--resolve` to localhost so DNS isn't involved, every 3 s for up to 120 s.
5. On success, write `current_tag`, prune images older than the last 3 tags, and exit 0.
6. On failure, re-run `up -d` with the previous tag, wait for health, and exit 1 so the workflow fails.

Before step 3, the script appends the tag being replaced, the new SHA, and the current UTC time to `/opt/songbird/deploys.log`. That time is the exact target for a point-in-time restore if the release's migrations need undoing.

- `/healthz` reaches the backend through the Next rewrite, so it checks the whole chain: proxy → frontend → backend.
- When `add-database-foundation` adds `/readyz`, the script switches to polling it, so a release that can't reach the database counts as unhealthy.
- *Image rollback can't undo a migration:* the previous build refuses a database with a migration it doesn't know. If a release applied a migration and then failed health, the rollback in step 6 also fails health, and the operator follows the database restore in D6. For releases that add a migration, the README checklist has the operator take an on-demand provider snapshot before merging.
- *Trade-off:* `up -d` recreates containers, which leaves a gap of a few seconds. That is acceptable for this scale, and blue/green would double memory and complexity.

### D6. Provider-managed Postgres with provider backups
- **Service:** a managed Postgres 16 from a provider with a region next to the VPS (for example DigitalOcean Managed PostgreSQL), with automated daily backups and point-in-time restore over at least 7 days. The README lists alternatives and their prices. The backend reaches it over the internet, so latency is kept low by matching regions.
- **Connection secret:** `SONGBIRD_DATABASE_URL` lives only in `/opt/songbird/.env` (D8), because it holds the database password. It is never in the repository, CI, or the images.
- **TLS required:** the URL uses `sslmode=verify-full` with `sslrootcert=` pointing at the provider's CA certificate, mounted read-only into the backend. `sslmode=require` is not used, because it encrypts without checking the server's identity. The provider is also set to refuse non-TLS connections.
- **Network:** the provider's trusted-sources list allows only the VPS's addresses, so a leaked URL alone is not enough to connect.
- **Least-privilege role:** the app connects as `songbird_app`, not the provider's admin user. It has `LOGIN` and `CONNECT` on the `songbird` database only, owns that database's `public` schema (because the foundation runs migrations at startup), and has no `SUPERUSER`, `CREATEDB`, `CREATEROLE`, or `REPLICATION`. A separate migration role would be tighter, but would need migrations to run outside the app, which the foundation doesn't support.
- **Pool size:** `SONGBIRD_DATABASE_MAX_CONNECTIONS` is set below the plan's connection limit, leaving headroom for the operator's `psql` and the provider's own tooling.
- **Restore:** a point-in-time restore into a new instance, at the time from `deploys.log` or just before an incident, then pointing `SONGBIRD_DATABASE_URL` at it and redeploying. This is documented and rehearsed in tasks.
- *Why managed over SQLite with Litestream:* the user chose Postgres for production. The provider then owns backups, retention, and restore, and the VPS holds no data, so losing it needs no restore at all.
- *Deleted data in backups:* backups keep a deleted user's data until it ages out of the retention window. The README says so, next to `api user delete` from `add-user-accounts`.

### D7. Server provisioning with cloud-init
`deploy/cloud-init.yaml`, pasted into the VPS provider's user-data:
- creates `deploy` (in the `docker` group, no password, `authorized_keys` placeholder) and the admin user from the operator's key;
- turns off password and root SSH login;
- installs Docker Engine and the compose plugin from Docker's apt repo, plus `ufw`, which allows 22, 80, and 443 only;
- enables `unattended-upgrades` with automatic security patches;
- adds a 2 GB swap file, a safety margin for Next and Rust memory spikes;
- creates `/opt/songbird/{compose.yaml,Caddyfile,deploy.sh}` by fetching them from the repository at a pinned ref, plus a `certs/` directory for the database CA certificate;
- enables the `docker` service so `restart: unless-stopped` containers come back after a reboot.

Docker publishes ports by writing iptables rules that bypass `ufw`. Only Caddy publishes ports, so nothing else is exposed. A smoke test in the tasks checks 3000 and 8080 from outside.

### D8. Configuration on the server
`/opt/songbird/.env` is created by the operator from `deploy/.env.example`, with mode 600, owned by `deploy`. It holds:
- `SONGBIRD_DOMAIN`
- `SONGBIRD_GATE`
- `SONGBIRD_BASIC_AUTH_USER` / `_HASH`
- `SONGBIRD_AI_MODEL` (Anthropic) and, optionally, `SONGBIRD_OPENAI_MODEL` (defaults to `gpt-4.1-mini`)
- `SONGBIRD_MASTER_KEYS` (secret): the keyring that encrypts users' stored provider keys. Generate an entry with `api keys generate-master-key` from the backend image. It lives only in this file, never in the repository or alongside database backups, so a backup alone never exposes users' keys. The VPS itself is not backed up, and the operator keeps a separate offline copy.

`ANTHROPIC_API_KEY` and `SONGBIRD_AI_PROVIDER` are deliberately absent. Production defaults the provider to `user` and rejects any other value, and it refuses to start with a non-blank `ANTHROPIC_API_KEY`, so a leftover operator key is a startup failure, not a dormant liability.
- `SONGBIRD_CORS_ORIGINS=https://<domain>`. Once `add-user-accounts` ships, its Origin check accepts only configured origins, so this must be the exact public origin.
- `SONGBIRD_DATABASE_URL` (secret, D6) and `SONGBIRD_DATABASE_MAX_CONNECTIONS`
- `SONGBIRD_TRUST_PROXY=true`, once `add-user-accounts` ships. It is set on this server only, because here Caddy is the outermost proxy and replaces `X-Forwarded-For` (D2). Without it, login throttling would see Caddy's address for every client, and one stranger's failures would throttle everyone. Everywhere else it stays at its default, false. *(Default chosen pending user confirmation.)*

Compose reads it through `env_file` per service, so each container sees only what it needs: Caddy gets the domain and auth values, and the backend gets the AI, DB, and proxy values. Nothing secret goes through GitHub except the SSH deploy key.

### D9. Dockerfile adjustments
- **Backend:** `WORKDIR /app`. Production mounts no data volume, because the database is remote (D6). Add `HEALTHCHECK CMD` using a tiny static probe. Avoid adding curl: the probe is `songbird-api healthcheck` if the CLI exists, otherwise a `bash` `/dev/tcp` check against `:8080`.
- **Frontend:** `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.
- Compose uses `depends_on: condition: service_healthy`, so Caddy starts after the frontend and the frontend after the backend.

## Risks / Trade-offs

- [Single server failure] → The VPS holds no data. Provisioning is reproducible, so a rebuild with the same `.env` takes about 15 minutes and needs no restore. That is acceptable at this scale.
- [The managed database is reachable from the internet] → `verify-full` TLS, a trusted-sources list limited to the VPS, a least-privilege role, and a generated password (D6).
- [A release's migration has to be undone] → Image rollback can't do it (D5). The pre-deploy time in `deploys.log` and the on-demand snapshot for migration-bearing releases give an exact restore point.
- [Managed Postgres raises the monthly cost] → Accepted by the user for provider-run backups. The README shows the cost, and the cheapest plan with point-in-time restore is enough at this scale.
- [`SONGBIRD_TRUST_PROXY=true` behind a proxy that doesn't replace `X-Forwarded-For`] → Clients could choose their own address and dodge login throttling. It is safe only while Caddy is outermost with no `trusted_proxies`, and the README says so; a smoke check verifies that a spoofed header is ignored.
- [Basic auth is coarse: one shared password, no per-user revocation] → Interim only, until `add-user-accounts`. Rotating it is documented (change the hash and restart Caddy).
- [The GHCR images are public] → They contain no secrets, because all configuration is runtime env. If the repository goes private, switch to private packages plus a read-only token (README).
- [Docker bypassing `ufw`] → Only Caddy publishes ports, and the external port scan in the smoke test verifies it.
- [Restart gap on deploy] → A few seconds of 502s. Acceptable, and it is noted in the README.
- [Lost master key] → Every stored user key becomes unreadable. The operator installs a new keyring entry and runs `api keys purge --version <lost>`, and affected users re-enter their keys. Songs are unaffected. The offline copy (D8) makes this unlikely.
- [Backups keep encrypted user keys] → Managed Postgres backups keep the ciphertext of deleted users' keys until they age out. It is useless without the master key, which is never stored with backups. The README says so.
- [A Rust build in CI on each merge is slow] → GitHub Actions layer cache and `Swatinem/rust-cache` style caching in the Docker build via cache mounts (`--mount=type=cache,target=/usr/local/cargo/registry` and `/src/target`).

## Migration Plan

1. Buy or point a domain, create the VPS with `deploy/cloud-init.yaml`, and add the `A` and `AAAA` records.
2. Create `/opt/songbird/.env` on the server (D8), including a master key from `api keys generate-master-key`. Announce that AI actions stay disabled for each user until they add their own key at `/settings/ai-keys`.
3. Add the GitHub secrets (`DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`) and the `production` environment.
4. Merge this change. The release workflow builds and deploys it, and the gate is on.
5. When `add-database-foundation` merges: create the managed Postgres in the VPS's region, confirm that automated backups and point-in-time restore are on, create the `songbird_app` role, limit trusted sources to the VPS, install the CA certificate, set `SONGBIRD_DATABASE_URL`, rehearse a point-in-time restore into a scratch instance, then deploy.
6. When `add-user-accounts` merges: take a provider snapshot, then set `SONGBIRD_GATE=off`, `SONGBIRD_COOKIE_SECURE=true` (its default), and `SONGBIRD_TRUST_PROXY=true`. The last is valid only because Caddy is the outermost proxy and replaces `X-Forwarded-For` (D2, D8).
7. After the first deploy on per-user keys succeeds: revoke the old operator Anthropic key in the Anthropic console, so any copy left behind is dead.

Rollback: run the workflow by hand with an earlier SHA, or use `deploy.sh <sha>` on the server. When the release being rolled back applied a migration, first restore the database from the provider snapshot or by point-in-time restore to the time in `deploys.log`, then deploy the earlier SHA.

## Open Questions

- The domain name and DNS provider are the operator's choice and don't affect the plan.
- The managed Postgres provider is the operator's choice, as long as it offers automated backups, point-in-time restore, verified TLS, and a trusted-sources list.
- The defaults marked *pending user confirmation* (proxy topology and `SONGBIRD_TRUST_PROXY` in D2 and D8, and headers split between Caddy and Next in D2) are in effect unless the user changes them.
