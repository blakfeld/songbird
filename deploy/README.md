# Deploying to Fly.io

Production is one Fly app, `songbird-op1hog`, running one Machine built from the root `Dockerfile`:

- Next serves the public port and proxies `/api`, `/healthz`, and `/readyz` to the API on loopback.
- SQLite lives on the `songbird_data` volume at `/app/data`.

Run every command below from the repo root.

## First launch

```sh
# The volume must be in the app's primary region (fly.toml)
fly volumes create songbird_data --region iad --size 1 -a songbird-op1hog

# Production refuses to start without it. Generate the value locally, never on a shared machine.
fly secrets set SONGBIRD_MASTER_KEYS="$(cd backend && cargo run -q -p api -- keys generate-master-key)" -a songbird-op1hog

fly deploy
```

If the deploy fails because an existing Machine has no volume, that Machine predates the mount, and Fly can't add one to it. Destroy it and deploy again:

```sh
fly machine list -a songbird-op1hog
fly machine destroy <id> --force -a songbird-op1hog
fly deploy
```

To check that the database is on the volume: `fly ssh console -C "ls -l /app/data"`. It should list `songbird.db`.

## Secrets

- `SONGBIRD_MASTER_KEYS`: required.
- `SONGBIRD_ENV` and `SONGBIRD_DATABASE_URL`: never set these as secrets. A secret overrides `fly.toml` and the image, and the container refuses to start if the database moves off the volume.
- `ANTHROPIC_API_KEY`: never set. Production stops if it is present, because users pay with their own keys.

## Operator commands

Run them as `songbird`, not root. Otherwise the root-owned `-wal` and `-shm` files they leave behind stop the app writing.

```sh
fly ssh console -C "setpriv --reuid=songbird --regid=songbird --init-groups songbird-api user create you@example.com"
```

## Rules

- **Never scale past one Machine.** Each new Machine gets its own empty volume, and so its own separate database.
- **Backups are Fly's daily volume snapshots only** (`fly volumes snapshots list <vol-id>`). Continuous backups are a planned follow-up.
- **Every deploy restarts both services.** Open chat streams drain for up to 190 s first, so requests 502 briefly during the restart.
