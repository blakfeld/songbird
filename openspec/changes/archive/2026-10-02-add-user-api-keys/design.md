# Design

## Context

- **Providers today.** `build_providers(&Config)` (`backend/crates/api/src/provider.rs`) runs once at startup.
  - It picks one transport from `SONGBIRD_AI_PROVIDER` (`claude` with the operator's `ANTHROPIC_API_KEY`, `ollama`, `codex`, or `mock`) and runs its `check()`.
  - It wraps the transport in the `Providers` bundle (`patterns: SchemaProvider`, `plans: SchemaPlanProvider`) over one shared `Arc` transport.
  - `AppState.providers` holds the bundle. Handlers in `patterns.rs` and `songs.rs` call `state.providers.patterns` and `state.providers.plans` under `with_timeout`.
  - `add-lyrics-assistant` and `add-section-chord-generation` each add one more field to `Providers`, filled from the same transport.
- **Transport seam.** `StructuredProvider::generate(&StructuredRequest) -> Value` (`music/src/ai/mod.rs`) is the per-vendor piece.
  - `StructuredRequest` carries `system`, `user`, a JSON `schema`, and `tool_name`/`tool_description`.
  - Claude (`ai/claude.rs`) forces a `tool_use` call to get schema-shaped JSON. It drops error bodies and redacts the key from `Debug`. Its `check()` only tests that the key is non-empty.
  - `prompt::strictify` already reshapes schemas for OpenAI-style strict modes, which the Codex CLI uses. The prompts never mention the tool name, so they are vendor-neutral.
- **Retry policy.** Generation retries only on unusable output. A `ProviderError::Request` is not retried.
- **Errors.** `ApiError` (`api/src/error.rs`) renders `{"error":{code,message}}`. Its messages are returned verbatim, so they must be user-safe. The frontend maps codes to messages in `lib/api.ts`. `ErrorAlert` renders the errors in `PromptForm`, `TrackGenerateDialog`, and `AssistantPanel`.
- **Accounts (dependency, not yet implemented).** `add-user-accounts` provides:
  - `users` and `sessions` on the `Db` layer from `add-database-foundation`, with SQLite in dev and managed Postgres in production;
  - a `CurrentUser` extractor, and an auth `route_layer` with an Origin check;
  - `ApiError::TooManyRequests` and in-memory throttles;
  - `SecretString` for secrets, and a no-secrets-in-logs rule;
  - `user_id` on request spans, and `Cache-Control: no-store`;
  - and, among its pending edits, a per-user AI rate limit and an operator `user delete` that cascades.

  This change builds on all of these and does not restate them.
- **Tests and e2e.** Backend tests build `Config` through `Config::from_lookup` and the app in-process. Provider tests use `wiremock`. Playwright boots `cargo run -p api` with `SONGBIRD_AI_PROVIDER=mock`.

## Goals / Non-Goals

**Goals:**
- No configuration of a production build can serve a user's AI request with an operator credential.
- Adding a provider means adding one transport and one key check. Handlers and domain code do not change.
- Every `Providers` field that exists now, and every field that lands later (lyrics, chords), automatically runs on the caller's key.

**Non-Goals:**
- Choosing a model per user, or any per-user model settings.
- Tracking usage or cost per user. Each provider's own dashboard covers this.
- Providers other than Anthropic and OpenAI, or a user-supplied base URL. An arbitrary URL would turn the server into an SSRF relay.
- Changing how Ollama, Codex, and the operator Claude path work in development.

## Decisions

### D1. Deployment mode is a separate, fail-closed setting
`SONGBIRD_ENV` is `production` (the default when unset) or `development`. `Config::from_lookup` enforces the production rules in `platform/service-operations`. In production, `SONGBIRD_AI_PROVIDER` defaults to `user`, and every other value is rejected. A non-blank `ANTHROPIC_API_KEY` is also rejected even though it would go unused, so a leftover operator key on the production host is a startup failure, not a dormant liability.
- *Why a new variable instead of inferring production from the provider:* the provider choice is exactly the setting that gets misconfigured. A second, independent setting that defaults to the strict mode means two separate mistakes are needed before an operator key is spent: unsetting production and selecting an operator provider.
- *Why not infer from the bind address or `SONGBIRD_COOKIE_SECURE`:* Docker binds `0.0.0.0` in dev too, and the cookie flag is about TLS, not who pays.
- *Belt and braces:* the production compose file in `add-vps-deployment` should hard-set `SONGBIRD_ENV: production` under `environment:`, which overrides `env_file`, so editing `.env` on the server cannot switch it. This is a follow-up task here, because that change is owned elsewhere.
- *Cost:* every dev entry point has to opt in: `.env.example`, `docker-compose.yml`, the justfile, and the Playwright `webServer`. The startup error message says exactly what to set, so a developer who misses it is told on first run.

### D2. Providers are resolved per request through an extractor
`AppState` replaces `providers: Providers` with `ai: AiAccess`:
- `AiAccess::Shared(Providers)`: used in development with an operator provider. This is the current behaviour.
- `AiAccess::PerUser(Arc<dyn UserProviders>)`: used for `user` and `user-mock`.

A `RequestProviders` extractor (`FromRequestParts`) runs after `CurrentUser`. For `PerUser`, it loads the user's active key row, decrypts it, and asks the factory for a `Providers` bundle bound to that key. With no active key it returns `ApiError::ApiKeyRequired`. Handlers take `RequestProviders` in place of `state.providers`. Because the extractor comes before the JSON body, a user without a key gets `409` instead of a validation error, which is the error they can act on.
- `UserProviders` has two methods:
  - `fn providers(&self, provider: AiProvider, key: UserApiKey) -> Providers`;
  - `async fn check_key(&self, provider, &UserApiKey) -> Result<(), KeyCheckError>`.
- The real implementation owns one shared `reqwest::Client`, because connection pools are per client and building one per request would redo TLS for every call. It also holds the base URLs (overridable for tests) and the per-provider models from config, and it builds `ClaudeProvider` or `OpenAiProvider` with the user's key.
- `over_transport` is split into a check-free `Providers::over(Arc<dyn StructuredProvider>)`. That is the single place where the lyrics and chords changes add their fields, so per-user mode covers them without further work.
- *Why per request and not cached per user:* decryption costs microseconds next to a multi-second generation. A cache would keep plaintext keys in memory indefinitely, and it would need invalidation on replace, remove, and delete.
- *Alternative:* pass the key down through `PatternProvider::generate`. Rejected because it would change every trait, mock, and test in `music` for something that only the transport needs.

### D3. AEAD: XChaCha20-Poly1305, row-bound AAD, versioned keyring
- **Cipher.** The `chacha20poly1305` crate's `XChaCha20Poly1305`, with a 24-byte nonce from `OsRng` on every encryption. The 192-bit nonce makes random nonces collision-safe without a counter. AES-GCM's 96-bit nonce would need one, or a key-use limit.
- **AAD.** The AAD is `songbird/user-api-key/v1\0{user_id}\0{provider}`. Copying ciphertext to another user or provider fails authentication. The version prefix leaves room for a future layout change.
- **Keyring.** `SONGBIRD_MASTER_KEYS=v2:<b64>,v1:<b64>` is parsed into an ordered list of `(version, SecretBox<[u8; 32]>)`. The first entry encrypts, and the row's `key_version` selects the key for decryption. `Debug` on the keyring prints only the versions.
- **Generating a master key.** A `api keys generate-master-key` subcommand prints a fresh `vN:<b64>` entry, so operators never hand-roll key material.
- **Startup check.** When `PerUser` is active, startup runs `SELECT DISTINCT key_version FROM user_api_keys`. Any version missing from the keyring aborts startup, with a message naming the versions and `api keys rotate`. Without this check, removing an old master key would surface later as every affected user's AI failing with `api_key_invalid`.
- **Rotation.** `api keys rotate` re-encrypts each row whose version is not the current one with `UPDATE ... WHERE user_id = $1 AND provider = $2 AND key_version = $old`. A save that lands while the rotation runs is never overwritten. The command prints counts only (rewritten, already current, and undecryptable). Undecryptable rows are left in place, so a wrong keyring cannot destroy data. The command is safe to run while the server is live.
- **Purge.** `api keys purge --version <v>` deletes the rows under a master key that has been lost (A6). It asks for confirmation and prints the count.
- **Decrypt failure at request time.** This means tampering, or a keyring mismatch the startup check missed. It maps to `api_key_invalid` so the user is told to re-enter the key. A `warn` log records `user_id`, `provider`, and `key_version`, and nothing else.

### D4. Schema: two tables, next migration number in both sets
The migration is `0003_user_api_keys.sql`, or the next free number after accounts' `0002`. It is added to both `migrations/sqlite/` and `migrations/postgres/` and follows the foundation's portable conventions.
- `user_api_keys`:
  - `user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`;
  - `provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai'))`;
  - `key_version TEXT NOT NULL`, `nonce TEXT NOT NULL`, `ciphertext TEXT NOT NULL` (the nonce and ciphertext are base64);
  - `last4 TEXT NOT NULL`, `created_at`, `updated_at`;
  - `PRIMARY KEY (user_id, provider)`, with an index on `key_version` for the startup check and rotation.
- `user_ai_settings`:
  - `user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE`;
  - `active_provider TEXT NULL` with the same `CHECK`, and `updated_at`.
- The active-provider rules (first key becomes active, fallback on remove) run in Rust inside the same transaction as the key write, so the summary is never seen half-updated.
- *Why base64 text and not `BLOB`/`bytea`:* the foundation keeps column types identical across backends. The accounts change makes the same choice for `token_hash`.
- *Why `last4` is stored in clear:* the summary has to show it without decrypting. Four characters of a key that is roughly 100 characters long gives an attacker nothing useful.
- *Why `ON DELETE CASCADE`:* accounts' `user delete` then removes keys without knowing they exist. The foundation must enable SQLite foreign keys (`PRAGMA foreign_keys = ON`) for this, and accounts' cascades already rely on it. A test asserts the cascade on both backends.

### D5. Key-management routes
These routes live on the protected `/api/v1` router, so accounts' auth and Origin check apply. Every response gets `Cache-Control: no-store`.
- `GET /api/v1/account/ai-keys` returns the summary.
- `PUT /api/v1/account/ai-keys/{provider}` and `DELETE /api/v1/account/ai-keys/{provider}` save and remove a key.
- `PUT /api/v1/account/ai-provider` sets the active provider. It is kept off the `{provider}` path, so its static segment can never collide with a provider name.
- **Save order:**
  1. throttle (an in-memory, per-`user_id` sliding window like accounts' D6: 10 per hour);
  2. format check;
  3. `check_key` with a 10-second `tokio::time::timeout`;
  4. encrypt, then upsert, then update the active provider, in one transaction.
- **Request body.** The save body is read as `Bytes` and parsed by hand into `struct SaveKey { key: SecretString }` with `deny_unknown_fields`. Any parse failure becomes the fixed `invalid_json` error. axum's `Json` rejection logs serde's error text at `trace` level, and that text can quote the offending value, such as a key sent as a number, so this route skips axum's `Json`.
- **Throttle scope.** The throttle counts attempts, not failures. Otherwise a working key would reset the window, and the endpoint would become a free oracle for checking whether stolen keys are valid.

### D6. Key checks and error classification
- **Live check.** Both checks use the provider's models list: `GET {anthropic}/v1/models?limit=1` (with `x-api-key` and `anthropic-version`) and `GET {openai}/v1/models` (with `Authorization: Bearer`). The check costs no tokens and needs no model id, so it passes even when the configured model is later renamed.
  - 401 or 403 → `api_key_rejected`.
  - Timeout, connection error, or 5xx → `provider_unreachable`.
  - Any other status is treated as rejected.
- **Classification.** `ProviderError` gains `Unauthorized`, `QuotaExhausted`, and `RateLimited { retry_after: Option<u64> }`. The transports classify from the status plus the provider's machine-readable error `type` or `code`. The body is parsed into a struct that has only those fields, and its text is dropped:
  - **Anthropic:** 401 `authentication_error` or 403 `permission_error` → `Unauthorized`. 429 `rate_limit_error` → `RateLimited`. A billing or credit error (`billing_error`, or the 400 "credit balance" case) → `QuotaExhausted`.
  - **OpenAI:** 401 → `Unauthorized`. 429 with `code: insufficient_quota` → `QuotaExhausted`. Any other 429 → `RateLimited`.
  - `retry-after` is read from the header and capped at 3600.
- **ApiError mapping.** The three new variants map to `api_key_invalid`, `api_key_quota_exhausted`, and `api_key_rate_limited`. Their messages are built from fixed strings plus the provider's display name, so they are user-safe and can be shown verbatim.
- **Retries and the operator path.** The retry loop already skips `Request`-class errors, and a test pins that it skips the new variants too. The same classification applies to the development `claude` path, which then also reports a bad operator key clearly.

### D7. OpenAI transport
`OpenAiProvider` (`music/src/ai/openai.rs`) implements `StructuredProvider` against `POST /v1/chat/completions` with:
- `messages`: a system message (`request.system`), then the user message;
- `response_format: {type: "json_schema", json_schema: {name: tool_name, description: tool_description, schema, strict: true}}`;
- `max_completion_tokens` (the same 4096 bound as Claude).

It parses `choices[0].message.content` as JSON. A `refusal`, an empty `content`, or a `finish_reason` of `length` → `InvalidOutput`, which the existing retry handles. `Debug` redacts the key, and error bodies are dropped, both mirroring `ClaudeProvider`.

- **Where Anthropic-specific behaviour lives, and how OpenAI matches it:**
  - *Schema-constrained output.* Claude gets it from a forced `tool_choice`. OpenAI gets it from strict `json_schema`, so `tool_name` and `tool_description` map to `json_schema.name` and `description`.
  - *Schema dialect.* OpenAI strict mode requires every property listed in `required`, `additionalProperties: false` on every object, and no `default` or `format`. `strictify` already handles `required`, `default`, and `format`. It is extended to set `additionalProperties: false` on every object, which today only appears where schemars `deny_unknown_fields` is set. The schema snapshots are regenerated, and a test walks every instrument's draft schema and the plan schema to assert strict-mode compliance. The Claude and Ollama paths accept the stricter schema unchanged.
  - *Prompt format.* Both vendors take one system string and one user turn. `add-lyrics-assistant` D1 deliberately serializes history into a single user message, so no multi-turn mapping is needed.
  - *Output location.* Claude returns `content[].tool_use.input`. OpenAI returns the message `content` string. Both converge to a `serde_json::Value` at the trait boundary, so `PatternDraft::from_json` and the normalizers are unchanged.
- *Why Chat Completions over the Responses API:* Chat Completions supports strict `json_schema`, its response shape is simple to fake with wiremock, and it needs no conversation state. Moving to the Responses API later is a transport-internal change (see Open Questions).
- `music/tests/provider_contract.rs` gains an `openai_pattern` case, so "same bad draft, identical normalization" covers OpenAI too.

### D8. Secrecy
- **Types.** User keys travel as `UserApiKey(SecretString)`. It has no `Display`, `Serialize`, or `Clone`. It has a redacting `Debug`, and `expose_secret()` is called only inside the transports' header builders and in `encrypt`. Plaintext from decryption goes straight into a `SecretString` (which zeroizes on drop) and is never formatted.
- **Logging.** No `tracing` field ever takes a key or a `Providers` value. Spans gain `ai_provider = "anthropic" | "openai"` and nothing about the key. `reqwest` errors are mapped to fixed strings, because their `Display` includes the URL, and while the URL never holds the key here, the habit keeps it that way.
- **Leak test.** Integration tests install a `tracing` subscriber at `TRACE` that captures every event and span field into a buffer. They drive save (accepted, rejected, unreachable, malformed body), generate (success, 401, 429, quota), remove, and rotate with a sentinel key, and assert that no 8-character window of the sentinel appears in:
  - the captured logs;
  - any response body or header;
  - the `Debug` output of `Config`, `AppState`, the keyring, the factory, and each transport.

  A wiremock provider that echoes the request's auth header back in its error body proves the body is never forwarded.

### D9. Mock per-user mode
`SONGBIRD_AI_PROVIDER=user-mock` (development only) installs `AiAccess::PerUser` with a `MockUserProviders`:
- `check_key` and `providers()` act on the key's suffix, following the table in the spec;
- a healthy key gets `Providers::mock()`;
- a failing suffix gets a bundle whose `generate` returns the matching `ProviderError` variant.

The rest of per-user mode runs for real, including encryption, storage, the extractor, and the error mapping. *Why:* e2e and frontend tests then exercise the production code path without a network, and CI never needs a real key.

### D10. Frontend
- **API.** `lib/api.ts` gains `getAiKeys`, `saveAiKey`, `removeAiKey`, and `setAiProvider`, with generated TS types from the backend DTOs. `USER_MESSAGES` gains `api_key_required` and `invalid_api_key_format`. `api_key_invalid`, `api_key_quota_exhausted`, `api_key_rate_limited`, and `api_key_rejected` join `READABLE_VALIDATION_CODES`, because their server messages name the provider and are user-safe by construction (D6).
- **State.** An `AiKeysProvider` context loads the summary once after `me` resolves and exposes `{keysRequired, activeProvider, keys, refresh}`. `ApiError` handling in `useTrackGeneration`, `useChat`, and `PromptForm` calls `refresh()` on any `api_key_*` code, so a key removed in another tab disables the actions immediately.
- **Gating.** An `AiKeyGate` component wraps each AI submit control. When `keysRequired && !activeProvider`, it renders the control disabled, with an inline notice and a link to `/settings/ai-keys`. `ErrorAlert` gains an optional `action` link, which is used for the key error codes. The lyrics and chords UIs use the same gate when they land.
- **Settings page.** The `/settings/ai-keys` page has one row per provider (status and `••••last4`, plus Set, Replace, and Remove with a confirm step) and an active-provider radio group when both keys exist. The input is `type="password"`, `autoComplete="off"`, and `spellCheck={false}`, and it is held in component state only. It is cleared in `finally` after submit, so neither a failed nor a successful save leaves it in the DOM. The page is linked from accounts' user menu. Before building, `ui-designer` reviews the layout.

### D11. Tests
- **`music`.** wiremock tests for `OpenAiProvider` cover the request shape, strict schema, refusal, the `length` finish reason, a non-JSON body, and HTTP errors without the body. Both `check_key`s are tested for 200, 401, 5xx, and timeout. A `provider_contract` case covers OpenAI. A test asserts the schemas are strict-compliant.
- **`api` unit.** Tests cover keyring parsing (format, length, duplicates, and the error not echoing values), AEAD round-trip, AAD mismatch for a swapped user or provider, fresh nonces, and config mode rules for every forbidden combination.
- **`api` integration.** These run on both backends through the foundation's `test_db()` and accounts' `login_as`:
  - save, replace, and remove, plus the active-provider rules;
  - the throttle;
  - `409 api_key_required` on every AI route, with no provider call;
  - each provider error mapping and `Retry-After`;
  - two users hitting wiremock with different keys concurrently;
  - cascade on `user delete`;
  - rotation, and the startup missing-version check;
  - the leak test (D8).
- **Vitest.** Tests cover the gate's disabled and enabled states, the settings page flows (input cleared, nothing in storage), and the error messages with links.
- **Playwright.** The e2e backend switches to `SONGBIRD_ENV=development`, `SONGBIRD_AI_PROVIDER=user-mock`, and a fixed test-only keyring. `globalSetup` gives the main e2e user a healthy mock key through the API, so existing specs are unchanged. It also creates a second user without a key for `ai-keys.spec.ts`, which covers the gate, set, replace, and remove, the `-rejected` and `-revoked` outcomes, and the active-provider switch.
- **Live tests.** `live.rs` gains an ignored `live_openai` test and a `just test-live-openai` recipe that reads `OPENAI_API_KEY` locally. CI never runs it.

## Assumptions

- **A1.** The model is fixed per provider by config: `SONGBIRD_AI_MODEL` for Anthropic (existing default) and the new `SONGBIRD_OPENAI_MODEL` for OpenAI. Users cannot pick, which keeps the UI to keys and one radio group.
- **A2.** Only the active provider is used. There is no automatic fallback to the other key when one fails, because a silent switch would bill an account the user didn't choose.
- **A3.** The prefix checks (`sk-ant-` for Anthropic, `sk-` for OpenAI, but not `sk-ant-`) match today's key formats, and they mainly catch pasting a key under the wrong provider. The live check is the real validation. If a vendor changes its prefix, the fix is a one-line change.
- **A4.** `409` is used for `api_key_required` and the stored-key-state errors (`api_key_invalid`, `api_key_quota_exhausted`), not `412`. `412` is tied to conditional request headers, and `409` says the request conflicts with the account's current state. Provider rate limits use `429` to match HTTP semantics and accounts' `too_many_requests`.
- **A5.** A disabled user keeps their keys. Disabling is reversible, and the keys cannot be used without a session. Deletion is the only path that destroys keys.
- **A6.** Losing the master key is recoverable but disruptive. Every key stored under it becomes unreadable. The operator installs a new keyring entry and runs `api keys purge --version <lost>`, which deletes those rows so the startup check passes. Affected users then see AI actions gated and re-enter their keys. Songs are unaffected. The master key is kept outside the database and its backups, so a database backup alone never exposes keys.
- **A7.** Managed Postgres backups keep the ciphertext of deleted users' keys until the backups expire. This is acceptable because it is useless without the master key. The operator docs say so.
- **A8.** The per-user AI rate limit from `add-user-accounts` is kept as an abuse limit, not a cost limit, at its proposed values. A stolen session is the threat it addresses.
- **A9.** In development with an operator provider, keys can still be managed when a keyring is set, but they are not used. That lets the settings UI be developed against `claude` or `ollama`.

## Risks / Trade-offs

- [A provider changes its error shapes, and quota or rate-limit failures get misclassified] → Unknown failures fall back to `generation_failed`. Classification is isolated in one function per transport, with fixture tests. Open Question 1 asks for a check against current docs at implementation time.
- [OpenAI strict mode rejects a schema keyword that a future instrument adds] → The strict-compliance test walks every registered instrument's schema, so a new instrument fails CI, not production.
- [OpenAI reasoning models spend completion tokens on reasoning and hit `length`] → `length` is mapped to `InvalidOutput`, so it is retried once. The default model is chosen to be a non-reasoning model, or one run at low reasoning effort.
- [The in-memory save throttle resets on restart] → The same trade-off accounts accepted for login, for a single instance. The live check is cheap for the provider.
- [Development mode reaches production through a copied `.env`] → The default is production, the deploy compose hard-sets `SONGBIRD_ENV` (follow-up task), and the startup warning appears in production logs if it ever happens.
- [A breaking default for existing local setups] → The error message names `SONGBIRD_ENV=development`, and every repo-provided dev entry point is updated in the same PR.
- [Ciphertext swap within one user (Anthropic ciphertext into the OpenAI row)] → The provider is part of the AAD, so the swap fails to decrypt.

## Migration Plan

1. Land after `add-user-accounts` (and so after `add-database-foundation`). The migration only adds tables.
2. Generate a master key with `api keys generate-master-key` and store it as `SONGBIRD_MASTER_KEYS` in the server's secret env, not in the repo and not with database backups.
3. Remove `ANTHROPIC_API_KEY` (and any `SONGBIRD_AI_PROVIDER` other than `user`) from the production env. Ensure `SONGBIRD_ENV` is `production` or unset. Set `SONGBIRD_OPENAI_MODEL` if the default isn't wanted.
4. Deploy. Users see AI actions disabled until they add a key on `/settings/ai-keys`. Announce this before deploying.
5. Revoke the old operator Anthropic key in the Anthropic console once the deploy is healthy, so a copy left anywhere is dead.

**Rollback:** redeploy the previous images, with the old env including `ANTHROPIC_API_KEY`. The new tables are ignored by the old build. Leaving them means users don't have to re-enter keys if the deploy is retried. Dropping them is a manual SQL step if wanted.

## Open Questions

1. Confirm the current Anthropic error `type` for exhausted credit (`billing_error` or 400 `invalid_request_error`), and the OpenAI `insufficient_quota` shape, against the live docs during implementation. This affects only the classifier's match arms.
2. Which OpenAI model `SONGBIRD_OPENAI_MODEL` defaults to. It must support strict `json_schema` and should be cheap and fast. Pick it at implementation from OpenAI's current list.
3. Chat Completions or the Responses API for OpenAI. Chat Completions is chosen now. Switching later is internal to `openai.rs`.
4. Whether the save throttle (10 per hour) and the 10-second check timeout need tuning after real use.
