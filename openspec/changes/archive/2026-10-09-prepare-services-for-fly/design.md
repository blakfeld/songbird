# Design

## Context

- `backend/crates/api/src/main.rs:146-151` calls `axum::serve` with no shutdown handling, so on SIGTERM the process stops at once. Litestream (added by `add-fly-deployment`) wraps the API with `-exec` and syncs its last changes once the child exits, so a clean exit matters for backups as well as for streams.
- The chat stream's deadline is 2 x `SONGBIRD_GENERATION_TIMEOUT_SECS` + 30 s, which is 150 s by default, and it sends a keepalive every 15 s (`songs.rs:146-150`).
- Next 16 standalone `server.js` registers SIGTERM/SIGINT handlers that call `process.exit` immediately (`next/dist/server/lib/start-server.js:371-388`). Setting `NEXT_MANUAL_SIG_HANDLE=1` turns those handlers off and leaves shutdown to the host process.
- `auth/http.rs:136-146` (`client_address`) returns the first `X-Forwarded-For` entry when `trust_proxy` is true and the peer address otherwise. Fly's edge appends to `X-Forwarded-For` rather than replacing it, so on Fly the first entry is controlled by the client. Fly documents `Fly-Client-IP` as set by its proxy and not spoofable.
- `frontend/src/lib/securityHeaders.ts:3` leaves HSTS to "the proxy", and `securityHeaders(dev)` already receives a dev flag from `next.config.ts`.

## Goals / Non-Goals

**Goals:**
- A deploy or stop never cuts off a chat stream that would otherwise finish within its deadline.
- On Fly, login throttling identifies clients by an address they cannot forge.

**Non-Goals:**
- Distributed or shared rate limiting. The deployment runs exactly one API instance.
- Draining streams longer than 190 s. Anyone who raises `SONGBIRD_GENERATION_TIMEOUT_SECS` above about 80 s accepts that a deploy may cut their streams off, and the README says so.
- Making the app aware of which host it runs on. The only Fly-specific item is a configuration value.

## Decisions

### D1. The API drains with `with_graceful_shutdown` plus a hard cap
The shutdown future resolves on the first SIGTERM or SIGINT, received through `tokio::signal::unix`. The whole serve future is wrapped in `tokio::time::timeout(190 s)` measured from the signal: a `select!` between the graceful serve and a sleep that starts when the signal arrives. When the cap expires, `main` returns, which drops the remaining connections. The process exits with status 0 whether the drain finishes or times out. A timeout is logged at `warn` with the number of connections still open, if axum exposes it; otherwise only the event is logged.

190 s sits between the 150 s default stream deadline and the 200 s `kill_timeout` that `add-fly-deployment` sets, which leaves 10 s for Litestream's final sync.

*Alternative:* honour a second signal as "exit now". This was rejected because Fly sends only one signal and then SIGKILL; on a laptop, Ctrl-C twice is the expected escape. The spec therefore says a second signal doesn't *shorten* the drain, and a developer can still use SIGKILL. Locally, `just dev` will wait up to 190 s if a stream is open. That is acceptable because the wait only happens while a stream is open.

The hourly session sweeper is a detached task, and it ends when the runtime does. It needs no changes.

### D2. The frontend uses a small wrapper around standalone `server.js`
A new file, `frontend/server-wrapper.mjs`, is copied into the runner image and becomes the container's `CMD`. It sets `NEXT_MANUAL_SIG_HANDLE=1` before importing `./server.js`. On a signal it calls `close()` on the HTTP server Next created and exits when that callback fires, with the same 190 s cap.

The wrapper reaches the server by replacing `http.Server.prototype.listen` for one call before importing `./server.js`, capturing `this`, then restoring the original. Calling Next's `startServer` directly was rejected: `server.js` is generated at build time with the serialized Next config inlined, so calling it ourselves would duplicate that config and drift on upgrades, and `startServer` doesn't return the server anyway. The spike confirmed on `next build` output that SIGTERM during a slow `/api` rewrite lets the response finish, refuses new connections, and exits 0.

*Alternative:* accept that frontend deploys cut streams off. This was rejected because the web app is deployed as often as the API.

### D3. `SONGBIRD_TRUST_PROXY` becomes an enum
`enum ClientAddressSource { Peer, XForwardedFor, FlyClientIp }` is parsed from `false`, `x-forwarded-for` or `true`, and `fly-client-ip`, case-insensitively. Anything else fails startup with the variable named, which matches how every other invalid value is handled.

`client_address` takes the source. For `FlyClientIp` it parses the single header value as an `IpAddr`. When the header is missing or malformed it falls back to the peer address and logs at `debug`; it does not reject the request, because a health check or an operator's `curl` inside the private network won't carry the header. The existing /64 grouping then applies unchanged.

The startup warning, which fires when `Peer` is used with an https origin, keeps its condition. The README and `.env.example` document all three values and when each one is safe.

*Alternative:* add a separate `SONGBIRD_CLIENT_IP_HEADER` that takes any header name. That is more general, but it lets an operator name a header no proxy guarantees, and it adds a second setting that interacts with the first. A closed enum keeps every option one that has been checked.

*Scope check:* the login throttle is the only current caller of `client_address`. The in-flight `add-share-links` change adds per-address comment limits. It should call the same function, and if it does it gets the right behaviour with no further work.

### D4. HSTS goes in `securityHeaders(dev)`
The header is added only when `dev` is false. It uses `max-age=31536000` without `includeSubDomains` or `preload`, because the first deployment is on `*.fly.dev`, a domain this project doesn't own.

## Risks / Trade-offs

- [Next's rewrite proxy may not forward `Fly-Client-IP` to the backend] → Task 3.3 checks it with a request through `next start`. If the header is dropped, the frontend must add it. The likely fix is a `headers` passthrough in the rewrite, or setting the header in `proxy.ts`. If that is needed, it becomes a design decision for this change.
- [The wrapper relies on Next's internal server startup] → The wrapper is pinned to the observed Next 16 behaviour and has a unit test that fails if `NEXT_MANUAL_SIG_HANDLE` stops being honoured.
- [A 190 s drain makes local Ctrl-C slow while a stream is open] → Accepted. SIGKILL still works.
