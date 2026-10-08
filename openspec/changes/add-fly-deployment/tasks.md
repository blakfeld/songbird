# Tasks

## 1. Prerequisites

- [ ] 1.1 Confirm that `prepare-services-for-fly` is merged to `main`: graceful shutdown, `SONGBIRD_TRUST_PROXY=fly-client-ip`, and HSTS. Verify by running `git log main` and checking that its tasks are complete.
- [x] 1.2 Confirm that `add-vps-deployment` has been deleted, or that the user has decided its fate, so that only one change adds `platform/deployment`. Verify that `openspec list` no longer shows it.

## 2. Fly accounts and apps (operator, done once)

- [ ] 2.1 Create the Fly org and the two apps (D1), choosing available names, and record them in both `fly.toml` files and in the workflows. Create the `songbird_data` volume (1 GB) in the API app's region, and the Tigris bucket with `fly storage create -a <api-app>`. Verify that `fly volumes list` and `fly secrets list -a <api-app>` show the volume and the `BUCKET_NAME`/`AWS_*` secrets.
- [ ] 2.2 Set `SONGBIRD_MASTER_KEYS` (generated with `api keys`) as a secret on the API app. Create app-scoped deploy tokens and store them as `FLY_API_TOKEN_API` and `FLY_API_TOKEN_WEB` in a GitHub `production` environment. Verify with `fly secrets list` and the repository's environment settings page.

## 3. API image, Litestream, and config

- [ ] 3.1 Add `backend/litestream.yml` (D4). First check the v0.5 config schema, and whether Tigris needs `region: auto`, against the Litestream docs, then record the answer in design.md D4. Verify with `litestream databases -config backend/litestream.yml` inside the built image, which must list the DB and replica.
- [ ] 3.2 Add `backend/docker-entrypoint.sh` (D4 steps 1–5), and update `backend/Dockerfile` to install a checksummed, pinned `litestream` and to use the entrypoint (root, then `setpriv` to `songbird`). Verify with `docker run` in four cases:
  1. With no volume mounted, the container exits 1 with the mount message.
  2. With an empty volume and an empty bucket (MinIO in compose), it exits 1 with the no-backup message.
  3. The same, with `SONGBIRD_ALLOW_FRESH_DB=1`, it starts and replicates.
  4. Delete the volume and rerun without the flag: it restores the songs and starts.

  Then run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/` if any Rust changed.
- [ ] 3.3 Add `backend/fly.toml` (D2). Verify with `fly config validate -c backend/fly.toml`.
- [ ] 3.4 First launch:
  1. Set `SONGBIRD_ALLOW_FRESH_DB=1`, deploy the API with `fly deploy`, create the first user over `fly ssh console` as the `songbird` user (D6), and then unset the flag.
  2. Measure peak memory with `fly machine status` and metrics during 4 concurrent logins, and resize per D2 if needed.

  Verify that `fly logs` shows Litestream replicating and that the Tigris bucket contains generations.

## 4. Web image and config

- [ ] 4.1 Add `frontend/fly.toml` (D3) and deploy it with `fly deploy --image-label <sha>`. Confirm the image reference format that `--image-label` produces and record it in design.md D5. Verify the following:
  - `https://<web-app>.fly.dev/login` loads with an HSTS header.
  - `http://` redirects to HTTPS.
  - Signing in works.
  - `curl https://<api-app>.fly.dev` makes no connection.
- [ ] 4.2 Verify the spec scenario "Forged client address ignored": fail 20 logins through the public URL, then send one more with a forged `X-Forwarded-For`, and confirm the response is `429`.

## 5. CI deploy and rollback

- [ ] 5.1 Add the `deploy` job to `.github/workflows/ci.yml` (D5 steps 1–6), including the guard that fails if the API app has more than one Machine. Verify:
  - A pull request shows the job as skipped.
  - A push to `main` deploys, and the run summary records the restore point.
  - A deliberately broken API commit (e.g. an `[env]` value that fails config validation), pushed to a scratch branch that the job temporarily targets, gets redeployed to the previous image, and the job fails.
- [ ] 5.2 Verify streaming in production: run a chat that takes more than 60 s and confirm it arrives incrementally and completes. If it's buffered, set `compress: false` in `frontend/next.config.ts` and re-verify.
- [ ] 5.3 Add `.github/workflows/redeploy.yml` (manual, input SHA). Verify by redeploying the previous `main` SHA and checking that `/healthz` answers `200` and that `fly releases` shows that image.

## 6. Docs and restore drill

- [ ] 6.1 Write `deploy/README.md`. It covers:
  - first launch, including the `SONGBIRD_ALLOW_FRESH_DB` warning;
  - which secrets exist and that `SONGBIRD_ENV` must never be set as a secret;
  - operator commands as `songbird` (D6);
  - never scaling the API above one Machine;
  - custom-domain steps;
  - deleted data remaining in backups for 7 days;
  - the cost estimate.

  Verify by following the first-launch section on a scratch pair of apps.
- [ ] 6.2 Rehearse a point-in-time restore on a scratch API app:
  1. Write data, note the time, and write more.
  2. Restore with `litestream restore -timestamp` to the noted time.
  3. Confirm that only the earlier data is present.

  Record the exact commands in the README. Verify by running the README steps exactly as written.
- [ ] 6.3 Run `code-reviewer` on the branch and `security-researcher` on the deployment configuration (secrets handling, private API, header trust), then resolve their findings.
