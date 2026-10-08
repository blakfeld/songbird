# Proposal

## Why

Songbird will be deployed on Fly.io (see `add-fly-deployment`), and three of the app's assumptions don't hold there:

- **Shutdown.** Neither service shuts down gracefully. On SIGTERM the Rust API stops at once and Next's standalone server calls `process.exit`, so every deploy cuts off any AI chat that is streaming, and those can run for up to about 150 s.
- **Client IP.** Login throttling trusts the first `X-Forwarded-For` entry, which is safe only behind a proxy that overwrites the header. Fly's edge appends to it instead, so the first entry is whatever the client sent. Fly's unspoofable header is `Fly-Client-IP`.
- **HSTS.** HSTS was left to the Caddy proxy in the VPS plan. Fly's edge doesn't add it.

These fixes are independent of the host and can ship before the deployment exists.

## What Changes

- **API graceful shutdown.** On SIGTERM or SIGINT the API stops accepting new connections and lets in-flight requests, including SSE chat streams, finish. It exits once they're done or after a fixed drain limit of 190 s, whichever comes first.
- **Frontend graceful shutdown.** The production Next server does the same, so a frontend deploy doesn't cut off streams it is proxying.
- **Client address source.** `SONGBIRD_TRUST_PROXY` changes from a boolean to a choice: `false` (the connection's peer address, which stays the default), `x-forwarded-for` (today's `true`, which stays accepted as an alias), or `fly-client-ip`. Login throttling, and anything else that uses the client address, reads the chosen source.
- **HSTS.** Production frontend responses send `Strict-Transport-Security: max-age=31536000`. Development responses don't, so `http://localhost` keeps working.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `platform/service-operations`:
  - "Environment-based configuration" changes the description of `SONGBIRD_TRUST_PROXY`.
  - "Security response headers" adds HSTS in production.
  - A new "Graceful shutdown" requirement is added.
- `platform/accounts`: "Login throttling" changes how the client address is chosen.

## Impact

- **Backend:**
  - `backend/crates/api/src/main.rs`: shutdown signal handling and the drain limit.
  - `config.rs`: parsing `SONGBIRD_TRUST_PROXY`, with tests.
  - `auth/http.rs` (`client_address`): read the selected header, with tests.
- **Frontend:**
  - `frontend/Dockerfile` and a small server wrapper: `NEXT_MANUAL_SIG_HANDLE=1` plus a drain.
  - `frontend/src/lib/securityHeaders.ts`: HSTS in production.
- **Docs:** README and `.env.example` text for `SONGBIRD_TRUST_PROXY`.
- **Compatibility:** an existing `SONGBIRD_TRUST_PROXY=true` keeps its current meaning. Nothing else changes for local development or docker-compose.
