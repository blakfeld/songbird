# Tasks

## 1. Backend graceful shutdown

- [ ] 1.1 In `backend/crates/api/src/main.rs`, serve with `with_graceful_shutdown` on the first SIGTERM or SIGINT, capped at 190 s after the signal (D1), and log both outcomes. Add a short comment explaining why the cap sits between the stream deadline and the platform's `kill_timeout`. To verify, add an integration test that starts the server on an ephemeral port, opens a slow streaming request, triggers shutdown, and asserts that the stream's final event arrives and a new connection is refused. Then run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`.
- [ ] 1.2 Add a test for the drain cap that injects a short cap (make the cap a parameter of the serve function so the test needn't wait 190 s), and assert that a stuck request doesn't keep the process alive. Verify with `cargo test -p api`.

## 2. Frontend graceful shutdown

- [ ] 2.1 Spike: find out how a wrapper can reach the HTTP server that Next 16's standalone `server.js` creates when `NEXT_MANUAL_SIG_HANDLE=1` is set, and record the chosen approach in design.md D2. Verify by running `next build` and then the wrapper locally: SIGTERM during a slow `/api` request must let it complete.
- [ ] 2.2 Add `frontend/server-wrapper.mjs` and make it the `CMD` in `frontend/Dockerfile`, with the 190 s cap. Verify with `docker compose up frontend backend`: start a chat stream, run `docker compose stop frontend`, and check that the stream completes in the browser. Also add a Vitest unit test of the wrapper's signal handling, with a fake server, that passes.

## 3. Client address source

- [ ] 3.1 Replace the boolean `SONGBIRD_TRUST_PROXY` in `backend/crates/api/src/config.rs` with the `ClientAddressSource` enum (D3). Add config tests for `false`, `true`, `x-forwarded-for`, `fly-client-ip`, mixed case, and an unknown value, which must fail and name the variable. Keep the https-origin warning. Verify with `cargo test -p api config` plus fmt and clippy.
- [ ] 3.2 Update `client_address` in `backend/crates/api/src/auth/http.rs` to use the source. Add tests for the spec scenarios: "Fly client address used", "Missing Fly header falls back to the peer", and "Spoofed forwarding header ignored", plus a malformed `Fly-Client-IP` value. Verify with `cargo test -p api auth`, fmt, and clippy.
- [ ] 3.3 Check whether Next's `/api` rewrite forwards `Fly-Client-IP`. Send a login through `next start` with the header set and the backend trusting `fly-client-ip`, and assert in the backend's log or with a test hook that the header's address was counted. If it isn't forwarded, stop and raise a design decision before working around it.
- [ ] 3.4 Document the three `SONGBIRD_TRUST_PROXY` values, and when each one is safe, in the README and `.env.example`. Verify by reading the rendered README section.

## 4. HSTS

- [ ] 4.1 Add `Strict-Transport-Security: max-age=31536000` in `frontend/src/lib/securityHeaders.ts` when not in dev (D4), and update its unit test so production includes the header and dev omits it. Verify with `npx vitest run src/lib/securityHeaders`.

## 5. Integration checks

- [ ] 5.1 Run `just lint` and the full backend and frontend test suites, including Playwright e2e, and confirm they pass.
- [ ] 5.2 Run `code-reviewer` on the branch and resolve its findings.
