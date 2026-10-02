# Tasks

Prerequisite: `add-user-accounts` (and so `add-database-foundation`) is merged. That includes `CurrentUser`, `login_as`, `ApiError::TooManyRequests`, the per-user AI rate limit, and the cascading `user delete`. For every backend group, done means `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` pass from `backend/`.

## 1. Deployment mode and configuration

- [x] 1.1 Add `SONGBIRD_ENV`, `SONGBIRD_MASTER_KEYS`, and `SONGBIRD_OPENAI_MODEL` to `api/src/config.rs`, along with the `user` and `user-mock` provider kinds and the production rules from D1: default production; reject non-`user` providers and a non-blank `ANTHROPIC_API_KEY`; require a valid keyring. Verify with unit tests for every forbidden combination and for each error naming its variable without echoing values.
- [x] 1.2 Parse the keyring into an ordered `Keyring` of `(version, SecretBox<[u8; 32]>)`, rejecting a bad format, a key that is not 32 bytes, an empty list, and duplicate versions. Give it a `Debug` that prints only versions. Verify with unit tests, including one asserting that `format!("{config:?}")` contains no key bytes.
- [x] 1.3 Log a startup `warn` in development mode. Update the config tests' `mock()` helper and the other `from_lookup` callers to set `SONGBIRD_ENV=development`. Verify that `cargo test -p api` passes.
- [x] 1.4 Update `backend/.env.example` (`SONGBIRD_ENV=development`, the keyring, and the OpenAI model, each with a why-comment), `docker-compose.yml`, the justfile dev recipes, and the README config table. Verify that the env-example parity test passes and that `just dev` starts with no extra setup.

## 2. Provider errors and the OpenAI transport (`music`)

- [x] 2.1 Add `ProviderError::{Unauthorized, QuotaExhausted, RateLimited { retry_after }}`. Classify Claude's HTTP errors from the status and the error `type` only (D6), with `retry-after` capped at 3600. Verify with wiremock tests for 401, 403, 429 with and without `retry-after`, a billing error, and 529, each asserting that the body text is absent from the error.
- [x] 2.2 Pin that the generation retry loop does not retry the new variants. Verify with a counting-transport test that sees exactly one call.
- [x] 2.3 Extend `prompt::strictify` to set `additionalProperties: false` on every object, and regenerate the schema snapshots. Add a test that walks every registered instrument's draft schema and the plan schema and asserts OpenAI strict-mode rules. Verify that the snapshot and contract tests pass for Claude, Ollama, and Codex.
- [x] 2.4 Implement `OpenAiProvider` (`ai/openai.rs`) over Chat Completions with strict `json_schema` (D7), with a redacting `Debug`, `with_base_url`, and `with_max_tokens`. Verify with wiremock tests covering the request shape, the bearer header, refusal, the `length` finish reason, empty content, non-JSON content, and the HTTP error classes (401, 429 `insufficient_quota`, 429 rate limit), with no echoed body.
- [x] 2.5 Add `check_key` probes for Anthropic (`GET /v1/models?limit=1`) and OpenAI (`GET /v1/models`) under a caller-supplied timeout. Verify with wiremock tests for 200 (ok), 401 (rejected), 5xx and timeout (unreachable), and an error body containing the key that does not appear in the result.
- [x] 2.6 Add an `openai_pattern` case to `tests/provider_contract.rs`, an ignored `live_openai` test in `tests/live.rs`, and a `just test-live-openai` recipe. Verify that the contract test passes and that the live test is skipped by default.

## 3. Storage and encryption (`api`)

- [x] 3.1 Add `chacha20poly1305`, and the `0003_user_api_keys.sql` migration (or the next free number) for `user_api_keys` and `user_ai_settings` in both migration sets, per D4. Verify that the foundation's migration parity test passes on SQLite and Postgres.
- [x] 3.2 Implement `encrypt` and `decrypt` with XChaCha20-Poly1305, a random 24-byte nonce, and the AAD `songbird/user-api-key/v1\0{user_id}\0{provider}`, with the plaintext only ever in a `SecretString`. Verify with unit tests for the round trip, a different ciphertext for the same key, and decrypt failure for a swapped user, a swapped provider, a wrong version key, and a tampered ciphertext.
- [x] 3.3 Implement the key store: get the summary, upsert, delete, and set the active provider, with the D4 active-provider rules in one transaction. Verify with integration tests on both backends for first-key-becomes-active, fallback on remove, and isolation between users.
- [x] 3.4 Verify that accounts' `user delete` cascades keys and settings, with an integration test on both backends. If SQLite foreign keys turn out to be off, report it to accounts rather than working around it here.

## 4. Per-request providers

- [x] 4.1 Split `over_transport` into a check-free `Providers::over(Arc<dyn StructuredProvider>)`. Replace `AppState.providers` with `AiAccess::{Shared, PerUser}`, and build it in `main.rs` from the provider kind. Verify that existing tests pass with `Shared`.
- [x] 4.2 Add the `UserProviders` trait and the real factory: a shared `reqwest::Client`, overridable base URLs, the per-provider models, and the `check_key` delegation. Verify with a unit test that it builds a Claude or OpenAI bundle carrying the given key, using wiremock header matchers.
- [x] 4.3 Add the `RequestProviders` extractor (after `CurrentUser`): load the active row, decrypt, and build the bundle. Return `ApiKeyRequired` when there is none, and `api_key_invalid` plus a `warn` log (user id, provider, and version only) on decrypt failure. Switch the `patterns/generate`, `songs/tracks/generate`, and `songs/chat` handlers to it, so both chat calls use one bundle. Verify with integration tests showing `409 api_key_required` on each route with zero wiremock hits, and a valid key reaching wiremock with that user's header.
- [x] 4.4 Add `ApiError` variants and codes: `api_key_required`, `api_key_invalid`, `api_key_quota_exhausted`, `api_key_rate_limited` (with `Retry-After`), `invalid_api_key_format`, `api_key_rejected`, `provider_unreachable`, and `api_keys_unavailable`. Map the new `ProviderError` variants with fixed, provider-named messages. Verify with integration tests for each mapping, including `Retry-After: 20` passthrough, and two concurrent users each reaching wiremock with their own key.
- [x] 4.5 Implement `MockUserProviders` for `user-mock` with the spec's suffix table (D9). Verify with integration tests for each suffix's save and generate outcome, with no network.
- [x] 4.6 Add `ai_provider` to request spans for AI routes, and confirm that the accounts per-user AI rate limit still runs before provider resolution. Verify with an integration test showing that `429 too_many_requests` makes no provider call.

## 5. Key-management API

- [x] 5.1 Add `GET /api/v1/account/ai-keys`, `PUT` and `DELETE /api/v1/account/ai-keys/{provider}`, and `PUT /api/v1/account/ai-provider` on the protected router, with `Cache-Control: no-store`, the `Bytes`-parsed `SaveKey` body (D5), the format check, the 10-second `check_key`, and `404` for an unknown provider. Export the TS bindings. Verify with integration tests for every scenario under "Saving a key", "Removing a key", and "Active provider", and with the ts-bindings test.
- [x] 5.2 Add the per-user save throttle (10 attempts per hour, counting every attempt). Verify that an integration test's 11th attempt gets `429` with `Retry-After` and that wiremock sees no 11th call.
- [x] 5.3 Return `503 api_keys_unavailable` from the key routes when the server runs in development with an operator provider and no keyring, and report `keys_required: false` in the summary otherwise. Verify with integration tests.

## 6. Rotation and startup checks

- [x] 6.1 Add the `api keys generate-master-key`, `api keys rotate`, and `api keys purge --version <v>` subcommands per D3: an optimistic `UPDATE`, counts-only output, undecryptable rows left in place, and a confirm prompt on purge. Verify with integration tests on both backends: after rotating, every row uses the new version and still decrypts, a concurrent save is not clobbered, and purge removes only the named version.
- [x] 6.2 On startup in per-user mode, fail if any stored `key_version` is missing from the keyring, with a message naming the versions and `api keys rotate`. Verify with an integration test.

## 7. Secrecy verification

- [x] 7.1 Add the D8 leak test: a `TRACE` capturing subscriber, a sentinel key, and every save, generate, remove, and rotate path, including the malformed bodies and a wiremock provider that echoes the auth header. Assert that no 8-character window of the sentinel appears in logs, response bodies, headers, or the `Debug` output of `Config`, `AppState`, the keyring, the factory, and the transports. Verify that it passes, and that it fails when a deliberate `tracing::info!(?key)` is added locally.
- [x] 7.2 Run the `security-researcher` agent over the backend diff (key storage, the extractor, the routes, and the CLI) and fix every verified finding. Verify that a re-run reports no open findings.

## 8. Frontend

- [x] 8.1 Get a `ui-designer` spec for the `/settings/ai-keys` page, the `AiKeyGate` notice, and the error action link. Verify that the spec is recorded in the PR description.
- [x] 8.2 Add the `lib/api.ts` calls and messages (D10): `getAiKeys`, `saveAiKey`, `removeAiKey`, `setAiProvider`, the new `USER_MESSAGES`, and the readable codes. Verify with `api.test.ts` cases for each code's message.
- [x] 8.3 Add the `AiKeysProvider` context, and call `refresh()` on any `api_key_*` error in `useTrackGeneration`, `useChat`, and `PromptForm`. Verify with Vitest that a mocked `api_key_required` response triggers a summary refetch.
- [x] 8.4 Add `AiKeyGate` around Generate in `PromptForm`, track generation in `TrackGenerateDialog`, and send in `AssistantPanel`. Add an `action` link to `ErrorAlert`. Verify with Vitest for each control: disabled with a settings link when keys are required and none is active, and enabled when `keys_required` is false.
- [x] 8.5 Build the `/settings/ai-keys` page (rows, masked input, Set, Replace, Remove with confirm, and the provider radio) and link it from the accounts user menu. Verify with Vitest that the input is cleared after both a successful and a failed save, that no storage key contains the value, and that the masked suffix is shown.
- [x] 8.6 Run `pnpm lint`, `pnpm typecheck`, and `pnpm test`, and verify that they pass.

## 9. End-to-end

- [x] 9.1 Switch the Playwright backend to `SONGBIRD_ENV=development`, `SONGBIRD_AI_PROVIDER=user-mock`, and a fixed test-only keyring. In `globalSetup`, save a healthy mock key for the e2e user and create a second, key-less user. Verify that every existing e2e spec passes unchanged.
- [x] 9.2 Add `ai-keys.spec.ts`: the key-less user sees gated AI actions; then set, replace, and remove; the `-rejected` save error; the `-revoked` generation error with a settings link; and switching the active provider. Verify that `just test-e2e` passes.

## 10. Docs and deployment follow-up

- [x] 10.1 Document per-user keys in the README: `SONGBIRD_ENV`, generating and storing the keyring separately from database backups, rotate and purge, master-key loss (A6), and backup retention of ciphertext (A7). Verify that the documented commands run as written against a local SQLite database.
- [x] 10.2 Leave a follow-up for `add-vps-deployment`, as a PR note or issue, without editing that change. It needs to: drop `ANTHROPIC_API_KEY` and `SONGBIRD_AI_PROVIDER` from the deploy `.env.example` and D8 env list; add `SONGBIRD_MASTER_KEYS` and `SONGBIRD_OPENAI_MODEL`; hard-set `SONGBIRD_ENV: production` under the backend's compose `environment:`; and replace the "Anthropic spend limit" README section with the per-user key note and a step to revoke the old operator key. Verify that the note is filed and linked from this change's PR.
- [x] 10.3 Run `just lint` and `just test`, then run `code-reviewer` on the full branch, and verify that both commands pass and that no review findings are left open.
