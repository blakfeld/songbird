# Tasks

## 1. Provider streaming (backend `music`)

- [x] 1.1 Add `reqwest`'s `stream` feature and `music/src/ai/sse.rs`, a provider SSE line parser that handles events split across chunks, `\r\n`, multi-line `data:`, and comments (D3). Verify that unit tests feeding every fixture split at every byte offset give the same events.
- [x] 1.2 Add `TextSink` and `StructuredProvider::generate_streaming`, with a default that calls `generate` and emits nothing (D3). Wire it through the per-kind adapters and `AiAccess::PerUser` so the planner can reach it. Verify that existing transport tests pass unchanged and that a default-impl test shows no text emitted.
- [x] 1.3 Implement streaming for `claude.rs` (`input_json_delta`, mid-stream `error` events), `openai.rs` (`delta.content`, `finish_reason` checks) and `ollama.rs` (NDJSON, `done`). Share status→`ProviderError` mapping and the 4 MiB cap with the non-streaming path (D3). Verify with wiremock tests per transport: fragments reach the sink in order; the final `Value` equals the non-streaming result for the same fixture; HTTP 401/429 (with `Retry-After`)/5xx map as before; a mid-stream error maps correctly; the cap is enforced; no provider body text appears in errors. Extend the `provider_contract` cases to run both methods.
- [x] 1.4 Add `ReplyExtractor` in `music/src/ai/reply_stream.rs` (D4). Verify with unit tests: top-level `reply` only (a nested or other-field `"reply"` key is ignored); escapes including `\uXXXX` and surrogate pairs; every fixture split at every byte offset yields the same text; text emitted is always a prefix of the parsed reply. Add a test pinning `reply` as the second property of `plan_schema`.
- [x] 1.5 Give `plan_chat` an event sink: stream reply deltas through `ReplyExtractor` and send `reply_reset` before a retry (D5). Make the `user-mock` planner stream its reply in several delayed fragments, and leave plain `mock` non-streaming (D3). Verify with `music` unit tests: a first attempt that fails validation after streaming produces `reply_reset` then the second attempt's deltas; the non-streaming mock produces no deltas.

Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/` and confirm both pass.

## 2. Streamed chat endpoint (backend `api`)

- [x] 2.1 Define the `ChatEvent` payload types with `ts-rs` exports (D2). Verify that `frontend/src/generated/` gains the event types and that the export test passes.
- [x] 2.2 In `songs.rs`, negotiate on `Accept`. For `text/event-stream`, run the chat in a spawned task that sends `progress`, `reply_delta`, `reply_reset` and one terminal `result` or `error` into a coalescing, capped queue (the planner callback is synchronous; see D2), and return `Sse` with a 15 s `KeepAlive` and `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no` (D1, D2, D6). Errors after the start go through `api_error_for` into `error` events. Verify with `api/tests/chat.rs` cases for every scenario in "Streamed song chat responses": the event order for add-track and reply-only, a timeout and a rate limit (with `retry_after`) as `error` events, a 400 that is not streamed, a planner retry with `reply_reset`, a non-streaming provider, and the plain JSON response unchanged without the header. Extend `key_leak.rs` with a streamed case.
- [x] 2.3 Keepalives. Verify with a `tokio::time::pause` test that a provider stalled for 3 minutes yields a keepalive comment at least every 15 s and then the `result`, and that the parsed events match a run without the stall.
- [x] 2.4 Cancellation and the busy limit (D7): abort the spawned task when the body is dropped, and move `shed_when_busy`'s permit into a body wrapper. Verify with tests:
  - dropping the client during planning means wiremock sees no track-generation request;
  - with `SONGBIRD_MAX_CONCURRENT_GENERATIONS` streams open and already sending events, another AI request gets the busy error;
  - after those streams end, a request succeeds;
  - JSON routes still release permits at once (the existing `ai_limits.rs` tests pass).

Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/` and confirm both pass.

## 3. Frontend client

- [x] 3.1 Verify the Next rewrite passes SSE through unbuffered (D8). Run `next build && next start`, then the standalone Docker image from `docker compose up --build`, against a backend using `SONGBIRD_ENV=development` and `SONGBIRD_AI_PROVIDER=user-mock`. With `curl -N -H 'Accept: text/event-stream'`, check that reply deltas arrive spaced out rather than all at the end, that keepalives arrive every 15 s during a long mock delay, and that the response is not gzip-encoded. If it buffers, add the Route Handler fallback at `frontend/src/app/api/v1/songs/chat/route.ts` and repeat the check. Record the outcome in the PR.
- [x] 3.2 Add `lib/sse.ts`, a typed SSE parser over `ReadableStream<Uint8Array>` that ignores comment lines (D9). Verify with Vitest: chunks split at every offset, `\r\n`, multi-line `data:`, keepalive comments producing no events, and a stream ending mid-event.
- [x] 3.3 Add a `signal` option to `request`, and add `streamChat(body, {signal, onEvent})` to `lib/api.ts`. It uses `toApiError` for non-2xx responses, treats a 2xx JSON response as a single `result`, turns `error` events into `ApiError` with `retry_after`, signs the user out on `unauthenticated` as today, and treats 45 s with no bytes as `network_error` (D6, D9). Verify with `lib/api.test.ts` cases for each.

## 4. Chat UI

- [x] 4.1 Have `ui-designer` review the pending bubble's design (step line, streamed text, the final reply replacing it) against `AssistantPanel.tsx`. Verify that the review's decisions are recorded in this change's design.md D9 before 4.2 starts.
- [x] 4.2 Update `useChat.ts` and `AssistantPanel.tsx` (D9):
  - abort the request on a new send, on song load and on unmount, without showing an error;
  - show the `stage`, `trackLabel` and `streamedReply` state in the pending bubble, and clear it on `reply_reset`;
  - call `applyChatResult` only on `result`;
  - on failure, remove the pending message and the streamed text and restore the input as today;
  - announce step changes and the final reply in the live region, and keep the streamed text out of it.

  Verify with `StudioPage.chat.test.tsx` cases for every new scenario in "Global song chat builds the arrangement": progress steps, text growing, removal on failure, the final reply replacing streamed text, and leaving the song cancelling. Existing chat tests must pass with `streamChat` mocked.
- [x] 4.3 Playwright: switch the existing chat flows in `frontend/e2e/studio.spec.ts` to the streaming `user-mock`. Add a spec that sees the reply text grow and the step change before the track appears, and one that opens another song mid-request and sees no track or error in either song. Keep the held-reply test at about line 504 working with a held stream. Verify that `npx playwright test` passes. If port 8181 is taken by another worktree session, wait for it rather than killing it.

## 5. Integration

- [x] 5.1 Run `just lint` and the full backend and frontend test suites. Verify that all pass.
- [ ] 5.2 Manual check with a real Anthropic key and a real OpenAI key in development mode. Send a part request and a question, and check that the reply streams and the track lands. Then put a proxy with a 60 s idle timeout in front (for example `toxiproxy` with a 60 s idle `timeout` toxic) with a long generation timeout, and check that a 3-minute request completes. Record the results in the PR.
- [x] 5.3 Run `code-reviewer`, and `security-researcher` for error-event leakage, cancellation and the busy limit, on the branch. Verify that the findings are resolved.
