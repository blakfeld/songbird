# Proposal

## Why

Once `add-user-accounts` lets more than one person sign in, every AI request is still paid for by the operator's `ANTHROPIC_API_KEY`. The operator's bill then grows with other people's usage, and one careless or compromised account can exhaust it. Users must instead bring their own Anthropic or OpenAI key, so each person pays for and controls their own usage, and the operator's key is never spent on anyone else.

## What Changes

- **Per-user provider keys.** A signed-in user can save, replace, and remove an Anthropic key, an OpenAI key, or both. Each key is stored in the database, encrypted at rest with an AEAD cipher under a server master key. The ciphertext is bound to its user and provider. The server decrypts a key only to call the provider. No API response ever returns a key. The most the UI shows is the provider and the last 4 characters.
- **Validated on save.** A key is format-checked, then checked live against the provider with a cheap, timed models-list call before it is stored. Saving is throttled, so the endpoint cannot be used to test stolen keys in bulk.
- **Active provider.** When a user has both keys, they choose which one their AI features use. The model is fixed per provider by server config.
- **Every AI endpoint uses the caller's key.** That covers pattern generation, track generation, and song chat today, plus lyric assist and chord generation when they land. If the user has no key, the endpoint returns `409 api_key_required`. A key that the provider rejects, a key out of quota, and a key that is rate limited each map to their own clear error.
- **OpenAI as a new HTTP provider.** An `openai` transport calls the OpenAI API directly with strict JSON-schema output, behind the same `StructuredProvider` seam as Claude. It is unrelated to the `codex` CLI provider.
- **Deployment mode.** A new `SONGBIRD_ENV` (`production` by default, or `development`) decides who pays. In production the only AI mode is per-user keys. The server refuses to start if an operator provider (`claude`, `ollama`, `codex`, `mock`) is selected, if `ANTHROPIC_API_KEY` is set, or if no master key is configured. Operator providers and `mock` remain available in development, which dev, CI, and e2e set explicitly. **BREAKING:** a deployment that sets neither variable now starts in production mode and needs a master key.
- **Key rotation.** The master keyring is versioned. An operator CLI re-encrypts every stored key under the current master key. Startup fails if any stored key uses a master key version that is missing from the keyring.
- **Lifecycle.** A user's keys are deleted with the user, through the accounts change's cascading `user delete`.
- **Frontend.** A new "AI keys" settings page holds the set/replace/remove flow and the active-provider choice. When a key is required and missing, every AI action is disabled and explains how to add a key, so nothing fails silently. An `api_key_*` error from the API shows a message that links to the settings page.
- **Abuse limit kept.** The per-user AI rate limit from `add-user-accounts` stays even though users now pay for their own usage, because a stolen session could otherwise burn the victim's key.

## Capabilities

### New Capabilities
- `platform/user-api-keys`: storing, encrypting, validating, masking, and deleting per-user provider keys; the active-provider choice; the key-management API and settings page; using the caller's key on every AI endpoint and the errors for a missing, rejected, exhausted, or rate-limited key; master-key rotation; and the guarantee that keys never leave the server.

### Modified Capabilities
- `patterns/generation`: the "Pluggable AI provider" requirement gains the `openai` transport, per-user-key mode, and the rule that operator providers are development-only.
- `platform/service-operations`: an added requirement for deployment mode (`SONGBIRD_ENV`) and the master-key configuration, with fail-closed startup checks in production.

## Impact

- **Depends on** `add-user-accounts` (users, sessions, `CurrentUser`, per-user AI rate limit, `user delete`) and therefore on `add-database-foundation`. Production hosting changes from `add-vps-deployment` are listed only as follow-up tasks here, and that change is not edited.
- **Backend (`backend/crates/music`):** a new `ai/openai.rs` transport. `ProviderError` gains variants that classify provider failures (rejected key, quota, rate limit). A shared, timed `check_key` probe is added for Claude and OpenAI.
- **Backend (`backend/crates/api`):**
  - new `keys` module for the AEAD keyring, storage, and routes;
  - `AppState` resolves providers per request from the caller's key rather than once at startup;
  - new `Config` vars (`SONGBIRD_ENV`, `SONGBIRD_MASTER_KEYS`, `SONGBIRD_OPENAI_MODEL`), so the env-example parity test changes;
  - new migration for `user_api_keys` and `user_ai_settings` in both migration sets;
  - an `api keys rotate` CLI subcommand;
  - new `ApiError` codes.
- **New dependency:** `chacha20poly1305`. The `rand`/`OsRng` dependency comes from accounts.
- **Frontend:** a `/settings/ai-keys` page, a hook that reports whether a key is configured, gating in `PromptForm`, `TrackGenerateDialog`, and `AssistantPanel` (and later in the lyric and chord UIs), new `lib/api.ts` calls, and user-facing messages for the new codes.
- **Tests:** wiremock-backed tests for the OpenAI transport and the key checks; encryption, AAD, and rotation tests; tests that a sentinel key never appears in logs, responses, or Debug output; and Vitest and Playwright tests for the key flow on a `user-mock` provider. CI never calls a real provider.
- **Ops:** the production environment drops `ANTHROPIC_API_KEY` and adds `SONGBIRD_MASTER_KEYS`. Losing the master key makes every stored key unreadable, so users would have to re-enter them.
