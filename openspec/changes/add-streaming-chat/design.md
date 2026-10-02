# Design

## Context

- **Chat handler:** `chat` (`backend/crates/api/src/songs.rs:39`) runs `plan_chat` and then `generate_track`. Each call is wrapped in `with_timeout(generation_timeout)`, and the handler returns `Json<ChatResponse>`. The server can override the planner's reply: `TRACK_LIMIT_REPLY` and `LOOP_RANGE_REPLY` are applied after planning.
- **Planner:** `plan_chat` (`music/src/chat.rs:197`) retries once on unparseable or invalid output. The planner's output is strict JSON (`PlanDraft`, `music/src/ai/plan.rs:37`), and its fields are ordered `action`, `reply`, `instrument`, `track_name`, `prompt`, `measures`. So the reply is a string inside the JSON object, near the start.
- **Transports:** `StructuredProvider::generate(&StructuredRequest) -> Result<Value>` (`music/src/ai/mod.rs:200`). None of them stream:
  - Claude uses forced tool use.
  - OpenAI uses strict `json_schema`.
  - Ollama sends `"stream": false`.
  - Codex reads a final file from a CLI.
  - The mock providers are in-process.
  - Bodies are read through `read_json_capped` (4 MiB).
- **Middleware:** the AI router sits behind `meter`, which counts per-user requests, and `shed_when_busy` (`api/src/limit.rs:22`). `shed_when_busy` holds its semaphore permit only until `next.run` returns, which for a streamed body is when the headers are sent.
- **Frontend:**
  - `sendChat` (`frontend/src/lib/api.ts:158`) goes through `request`, which has no abort support.
  - `useChat` resolves once and guards against stale replies with `requestId` and `loadEpoch`.
  - Next proxies `/api/*` with `experimental.proxyTimeout` of 10 minutes (`frontend/next.config.ts:31`).

## Goals / Non-Goals

**Goals:**
- Show the reply as Claude, OpenAI or Ollama write it, show which step the request is on, and keep the connection alive on hosts with idle timeouts.
- Keep "invalid AI output is never returned": the track and the final reply are delivered once, validated.
- Keep the JSON response byte-for-byte compatible for clients that don't ask for a stream.

**Non-Goals:**
- Streaming track notes, or partial plans other than the reply text.
- Streaming the track-generation dialog or pattern generation.
- Resuming a dropped stream. A dropped stream is a failed request, and the user resends.
- Streaming from Codex. Its CLI only writes a final file.

## Decisions

### D1. Content negotiation on the existing route, with SSE
`POST /api/v1/songs/chat` checks `Accept`. If it includes `text/event-stream`, the route returns `axum::response::sse::Sse`; otherwise it returns today's `Json<ChatResponse>`.
- *Why SSE over WebSockets:* the exchange is one request and one response, it passes through Caddy and the Next rewrite as plain HTTP, and axum has built-in SSE and keepalive support.
- *Why `fetch` rather than `EventSource` on the client:* `EventSource` can't `POST` a body.
- *Why not a new route:* one route keeps one validation, metering and auth path. Existing JSON tests, Playwright mocks and non-browser clients keep working unchanged.
- *Alternative considered:* NDJSON over chunked transfer. It is simpler to parse, but it has no comment line for keepalives and no standard event types, and proxies don't recognise it as a stream to flush.

### D2. Event protocol
The protocol is in the spec ("Streamed song chat responses"). The stream is produced by a spawned task that sends `ChatEvent` values into a bounded `mpsc` channel. The handler wraps the receiver as the SSE stream, and serde types shared with the frontend through `ts-rs` describe each event's payload, as `ChatResponse` already is.
- **Before the stream:** validation, `RequestProviders` extraction (sign-in, missing key), `meter` and `shed_when_busy` all run before the handler returns the `Sse` response. So their errors are still plain HTTP errors.
- **After the stream starts:** every error goes through the existing `api_error_for` mapping and is then written as an `error` event: the code, the message and `retry_after`, and never provider body text. `key_leak.rs` gains a streamed case.

### D3. Provider streaming as an optional trait method
`StructuredProvider` gains:
```rust
async fn generate_streaming(&self, request: &StructuredRequest, text: &TextSink) -> Result<Value, ProviderError>
```
`TextSink` receives raw output-text fragments. The default implementation calls `generate` and emits nothing, so Codex, `mock` and any future transport work unchanged and satisfy the "provider without streaming" scenario.
- **Claude:** `"stream": true`. It accumulates the `input_json_delta.partial_json` events of the forced tool-use block, forwards each fragment to the sink, and parses the whole accumulated JSON at `message_stop`. A mid-stream `event: error` (for example `overloaded_error`) maps to the same `ProviderError` as the matching HTTP status.
- **OpenAI:** `"stream": true` on Chat Completions with strict `json_schema`. It forwards and accumulates `choices[0].delta.content` and checks `finish_reason` (`length` and refusal) as it does today.
- **Ollama:** `"stream": true`. It reads NDJSON lines, forwards and accumulates `message.content`, and finishes on `done: true`.
- **Shared rules:**
  - HTTP status errors arrive before the body, so the existing status→`ProviderError` mapping is reused unchanged.
  - The 4 MiB cap applies to the accumulated text.
  - The reqwest client timeout stays a total-time limit, and `with_timeout` still bounds each call.
  - `reqwest` needs its `stream` feature. Provider SSE is parsed by a small line parser in `music/src/ai/sse.rs`, unit-tested on split chunks, instead of adding a crate.
- **Only the planner streams:** track generation calls the non-streaming `generate`, because its output is notes that are never shown in pieces.
- **`user-mock` streaming:** `user-mock` gains a streaming planner that emits its reply in several fragments with a short delay, so Playwright exercises the streamed UI. Plain `mock` stays non-streaming, which covers the fallback.

### D4. Extracting the reply from streamed JSON
A `ReplyExtractor` (`music/src/ai/reply_stream.rs`) is fed the planner's raw JSON fragments and emits decoded text for the top-level `"reply"` string only. It is a small state machine that tracks:
- nesting depth, so it reads top-level keys only;
- whether it is inside a string, and the current key;
- escape sequences, including `\uXXXX` and surrogate pairs split across fragments.

It never emits text from other fields. Because the reply is only a prefix of the final reply, the final `result` stays authoritative.
- *Why not split the planner into a free-text call plus a structured call:* that adds a third provider call and more latency and cost to every message, and the reply and the plan could disagree.
- *Why not a general partial-JSON parser crate:* we need one string field, and a focused extractor is easier to test exhaustively, including fragments split at every byte.
- *Schema order:* `reply` stays second in `PlanDraft`. A unit test pins that order, because it decides how early the reply can stream. Models usually emit properties in schema order; if one doesn't, the reply simply streams later.

### D5. Retries and server-overridden replies
- **Retries:** `plan_chat` takes an event sink. Before attempt 2 it sends `reply_reset`, and the UI clears the streamed text.
- **Overridden replies:** when the handler replaces the reply (`TRACK_LIMIT_REPLY`, `LOOP_RANGE_REPLY`), the streamed text was the planner's and is now wrong. The `result` reply always replaces the streamed text in the UI, so no extra event is needed.
  - *Alternative considered:* check the track limit before planning to avoid the mismatch. Rejected, because the limit only matters when the planner chooses `add_track`, and the loop-range case can't be known until the planner picks a length.

### D6. Keepalives
`Sse::keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))`. axum sends a `:` comment line whenever the stream has been silent for the interval, which is what the spec requires.
- *Why 15 s:* it is well under the shortest common idle timeouts: Cloudflare's 100 s, Railway's 5 min, and the 30–60 s defaults of many load balancers.
- **Headers:** responses also set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, so intermediaries neither buffer nor gzip the stream.
- **Dead-connection detection:** keepalives also make a lost connection visible to the client. A read that sees no bytes for 45 s (three missed keepalives) is treated as a network error by the frontend.

### D7. Cancellation and the busy limit
- **Cancellation:** the spawned task's `JoinHandle` is held by a guard inside the response stream. When the client disconnects, hyper drops the body, the guard aborts the task, and the in-flight `reqwest` future is dropped, which closes the provider connection. Codex children are already killed on drop.
- **Busy limit:** `shed_when_busy` moves its `OwnedSemaphorePermit` into the response body, as a body wrapper that drops the permit when the body completes or is dropped. This fixes the permit's lifetime for streams without changing JSON routes, whose bodies complete at once.
- **Metering:** `meter` counts the request on entry, as today. A cancelled stream still counts, the same as a JSON request whose client went away.

### D8. Next proxy passthrough
The browser reaches the backend through the `/api/:path*` rewrite.
- Task 3.1 verifies, against `next start` and the standalone image, that events arrive unbuffered and that keepalives arrive every 15 s through the rewrite. It also checks that Next's `compress` setting does not gzip-buffer `text/event-stream`.
- *If the rewrite buffers:* add a Route Handler at `frontend/src/app/api/v1/songs/chat/route.ts` that forwards the request (including cookies and the Origin check headers) with `fetch` and returns `new Response(upstream.body, …)`. It would take precedence over the rewrite for that one path. This is the fallback, not the default, because it duplicates proxy behaviour that the rewrite already gets right.
- The 10-minute `proxyTimeout` remains the total-time ceiling. It already covers two maximum-length provider calls.

### D9. Frontend
- **SSE reader:** `lib/sse.ts` is a pure parser from a `ReadableStream<Uint8Array>` to typed events. It handles chunk boundaries, `\r\n`, multi-line `data:`, and comment lines (ignored). It is unit-tested with Vitest.
- **Client:** `streamChat(body, {signal, onEvent})` in `lib/api.ts` sends `Accept: text/event-stream` through `request`, which gains a `signal` option.
  - Non-2xx responses go through the existing `toApiError`.
  - A 2xx `application/json` response is treated as a single `result`, so a proxy that strips the stream degrades to today's behaviour.
  - An `error` event becomes the same `ApiError` that `describeError` and the AI-key gate `refresh()` already handle.
- **`useChat`:**
  - It owns an `AbortController`, aborted on a new send, on song load (the `loadEpoch` change) and on unmount. An abort is not shown as an error.
  - The pending entry gains `stage`, `trackLabel` and `streamedReply`, and `reply_reset` clears `streamedReply`.
  - Only `result` calls `applyChatResult`, so saving, undo and the 20-message history are unchanged.
  - The existing `requestId` and `loadEpoch` guards still drop late events.
- **`AssistantPanel`:**
  - The pending bubble renders the step ("Planning…", then "Writing Bass (bass)…") and the streamed text.
  - The live region announces step changes and the final reply only. The streamed text sits in an `aria-live="off"` element, so screen readers are not flooded.
  - `ui-designer` reviews the bubble's layout before it is built.

## Risks / Trade-offs

- [The planner streams a reply that is later replaced (track limit, loop range) or followed by a failure] → The final `result` replaces it, and a failure removes it (spec). This is rare, and the user sees the correction at once.
- [A model emits `reply` late or last despite the schema order] → Streaming degrades to "reply arrives with the result". It is still correct, and the progress steps and keepalives still help.
- [Streaming transports drift from the non-streaming ones (different error mapping or caps)] → Shared helpers for status mapping and capping. The provider contract tests run each transport through both `generate` and `generate_streaming` against the same wiremock fixtures.
- [Buffering intermediaries (Next compression, a CDN) hold the stream] → `no-transform` and `X-Accel-Buffering` headers. Task 3.1 verifies, with the Route Handler fallback (D8). The client's JSON fallback keeps the chat working even if a proxy rewrites the response.
- [Cancellation misses a path and a provider call keeps running after disconnect] → A backend test drops the client mid-plan and asserts, with wiremock, that no generation request is made.
- [Holding busy permits for the stream's life lowers effective concurrency] → This is the correct accounting, because the provider calls really are running. `SONGBIRD_MAX_CONCURRENT_GENERATIONS` (default 4) is unchanged and can be raised.

## Migration Plan

The change is additive and ships in one release. Rollback is a normal redeploy, because the JSON response never changed and older frontends never ask for a stream. A frontend whose stream fails falls back to showing the error, and the user resends.

## Open Questions

- Whether the Next 16 rewrite buffers SSE (D8). Either answer is covered by the fallback, and task 3.1 decides it without changing the spec.
