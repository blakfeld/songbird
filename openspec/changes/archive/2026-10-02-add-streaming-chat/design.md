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
The protocol is in the spec ("Streamed song chat responses"). The stream is produced by a spawned task that sends `ChatEvent` values into a coalescing queue that the response body drains (see the deviation below). The handler wraps the receiver as the SSE stream, and serde types shared with the frontend through `ts-rs` describe each event's payload, as `ChatResponse` already is.
- **Before the stream:** validation, `RequestProviders` extraction (sign-in, missing key), `meter` and `shed_when_busy` all run before the handler returns the `Sse` response. So their errors are still plain HTTP errors.
- **Coalescing queue instead of a bounded channel (deviation):** the planner's event callback is synchronous and cannot await a send, and dropping a delta would break the prefix guarantee, so the task hands events to the response body through a small queue (`api/src/chat_queue.rs`). Pending reply text is merged into one string, which the stream drains as a single `reply_delta` per poll, and is capped at 64 KiB per attempt: text past the cap is dropped for the rest of the attempt (a truncated prefix is still a prefix, and the `result` carries the full reply). A `reply_reset` clears the pending text. Other events (progress, reset, the terminal one) are few. Memory per stalled stream is therefore bounded by the cap plus one result. A supervisor task turns a panic in the chat task into the one terminal `error` event.
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
  - The 4 MiB cap applies to the raw bytes read from the stream, the same limit as a buffered body; the accumulated text is a subset of those bytes.
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
- **Headers:** responses also set `Cache-Control: no-store, no-transform` (`no-store` like every API response) and `X-Accel-Buffering: no`, so intermediaries neither buffer nor gzip the stream.
- **Dead-connection detection:** keepalives also make a lost connection visible to the client. A read that sees no bytes for 45 s (three missed keepalives) is treated as a network error by the frontend.

### D7. Cancellation and the busy limit
- **Cancellation:** the spawned task's `JoinHandle` is held by a guard inside the response stream. When the client disconnects, hyper drops the body, the guard aborts the task, and the in-flight `reqwest` future is dropped, which closes the provider connection. Codex children are already killed on drop.
- **Busy limit:** `shed_when_busy` puts its `OwnedSemaphorePermit` in a request extension (`BusyPermit`). Most routes leave it there and it is released when the handler returns. `stream_chat` takes it and moves it into the chat task, so it covers the stream's provider work: it is released at the terminal event, on a panic, or when the task is aborted on disconnect. *Why not tie it to the response body:* a client that never reads the body can stall hyper's body polling indefinitely, and a permit tied to the body would then be held forever; with N such connections every AI route would be shed. The response stream also ends at a wall-clock deadline of 2 x the generation timeout plus 30 s, but only when the server is still polling it: hyper stops polling a body whose socket is full, so the deadline does not free a fully stalled stream. What bounds such a stream is the queue cap in D2, and in production the reverse proxy's send timeout (nginx, Caddy) is what eventually closes the connection.
- **Metering:** `meter` counts the request on entry, as today. A cancelled stream still counts, the same as a JSON request whose client went away.

### D8. Next proxy passthrough
The browser reaches the backend through the `/api/:path*` rewrite.
- Task 3.1 verifies, against `next start` and the standalone image, that events arrive unbuffered and that keepalives arrive every 15 s through the rewrite. It also checks that Next's `compress` setting does not gzip-buffer `text/event-stream`.
- *If the rewrite buffers:* add a Route Handler at `frontend/src/app/api/v1/songs/chat/route.ts` that forwards the request (including cookies and the Origin check headers) with `fetch` and returns `new Response(upstream.body, …)`. It would take precedence over the rewrite for that one path. This is the fallback, not the default, because it duplicates proxy behaviour that the rewrite already gets right.
- The 10-minute `proxyTimeout` remains the total-time ceiling. It already covers two maximum-length provider calls.

#### 3.1 outcome
The rewrite passes the stream through unbuffered and uncompressed, so the Route Handler fallback is **not needed** and was not added. Checked with `curl -sN -H 'Accept: text/event-stream' -H 'Accept-Encoding: gzip'` through the frontend's `/api` rewrite, each output line timestamped:
- **`next build && next start`, real backend** (`SONGBIRD_ENV=development`, `SONGBIRD_AI_PROVIDER=user-mock`, a key saved for the user): the response is `200`, `content-type: text/event-stream`, `cache-control: no-cache, no-transform` (measured before the backend changed it to `no-store, no-transform`; the compose run below shows the current value), `x-accel-buffering: no`, `transfer-encoding: chunked`, with no `content-encoding`. The three `reply_delta` events arrived at 0.07 s, 0.12 s and 0.17 s (the mock's 50 ms spacing), followed by `progress` (writing) and `result`, not all at the end.
- **Keepalives, `next start`:** no backend knob makes the mock slow, so a stand-in upstream was used (one `progress`, then only `:` comments every 15 s, then `result` at 50 s). Through the rewrite the comments arrived at 15.03 s, 30.04 s and 45.04 s and the result at 50.04 s, with no `content-encoding` despite `Accept-Encoding: gzip`.
- **Standalone Docker image** (`frontend/Dockerfile`, built with `SONGBIRD_API_URL` pointing at the stand-in upstream, run as a container): deltas at 0.53 s, 1.02 s, 1.53 s and 2.03 s, keepalives at 15.03 s and 30.03 s, result at 35.04 s, same headers, no `content-encoding`.
- **`docker compose up --build`, full stack** (`SONGBIRD_ENV=development`, `SONGBIRD_AI_PROVIDER=user-mock`, project name `sse31`, plus a `SONGBIRD_MASTER_KEYS` override; a user and a key were created inside the stack): through the frontend container on :3000 the response is `200`, `content-type: text/event-stream`, `cache-control: no-store, no-transform`, `x-accel-buffering: no`, chunked, with no `content-encoding` despite `Accept-Encoding: gzip`. The reply deltas arrived at 0.08 s, 0.12 s and 0.17 s (the mock's 50 ms spacing, plus about 15 ms of timestamping overhead per line), `progress` (writing) at 0.22 s and `result` at 0.53 s, after the mock's 300 ms track delay.

The real backend's own 15 s keepalive was not observed through the proxy, because no knob slows the mock; the stand-in evidence above covers the proxy, and the backend's paused-time test covers the keepalive interval.

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

#### UI review (task 4.1)
The pending assistant bubble replaces today's "Thinking…" status line (`AssistantPanel.tsx:122-127`) in the same spot: directly after the `<ol role="log">`, with `mt-3`, so its spacing matches the list's `gap-3`.

```
            ┌──────────────────────────┐
            │ give me a bass line      │   pending user bubble (unchanged)
            └──────────────────────────┘
┌──────────────────────────────┐
│ Here's a walking bass line   │   streamed text, grows in place
│ ◌ Writing Bass…              │   step line (spinner + text-xs)
└──────────────────────────────┘
```

- **Outside the log, on purpose:** `role="log"` is implicitly `aria-live="polite"`. Support for a nested `aria-live="off"` that overrides an ancestor is uneven, so the pending bubble is a sibling of the `<ol>`, not an `<li>` in it. It still carries `aria-live="off"` on the streamed text, as D9 requires.
- **Bubble structure.** It is shown while `chat.sending`. Its classes mirror the assistant `<li>` exactly, so the final message lands with the same box:
  ```tsx
  <div className="mt-3 flex max-w-[90%] flex-col gap-1 self-start rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
    <span className="sr-only">Assistant:</span>
    {streamedReply && (
      <p aria-live="off" className="whitespace-pre-wrap break-words">{streamedReply}</p>
    )}
    <p aria-hidden="true" className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
      <Spinner />{stepText}
    </p>
  </div>
  ```
  - The streamed `<p>` is not rendered while the text is empty, so the bubble starts as just the step line, with no empty padding.
  - The step line goes at the **bottom** of the bubble. That is where the final message shows "Added track: …", so "Writing Bass…" turns into "Added track: Bass" in the same place.
  - The step line is `aria-hidden` because the announcement comes from the status region below. Without that, screen-reader browsing would read the step twice.
- **Step copy (visible):**
  - `planning`: "Planning…". It is set client-side the moment Send is pressed, without waiting for the first event, so the bubble never appears empty.
  - After `reply_reset`: "Planning again…". Without it, the streamed text vanishing looks like a glitch. `useChat` therefore needs one extra stage value (`replanning`, or a `retried` flag), which `writing` clears.
  - `writing`: "Writing {label}…". `{label}` comes from the same rule as `addedLabel`: the instrument id is resolved to its display name through `instruments`, and the instrument is dropped when it equals the track name. So it shows "Writing Bass…" or "Writing Walking Bass (Electric Bass)…". The raw id (`bass`) is an implementation detail and appears only as a fallback when `instruments` is still `null`. Extract one helper, `trackLabel(name, instrumentId, instruments)`, and use it for both strings so they cannot drift.
- **Status region (announcements):**
  - One `<p role="status" className="sr-only">` is **always mounted** in the scroller, outside both the log and the bubble. A live region inserted together with its text is often not announced; changing the text of a region that already exists is.
  - Its text is `""` when idle, "Assistant is planning." / "Assistant is planning again." / "Assistant is writing {label}." while sending, and back to `""` on settle. Clearing it is silent.
  - These strings have no "…", because some screen readers read it aloud as "dot dot dot".
  - The final reply is announced only by the existing paths: the new assistant `<li>` appended to the log, and `announce()` ("Added a Bass track. Undo to remove it." / "The assistant replied."). Do not also put the reply in the status region.
  - Deltas are never announced.
- **Growing text:** no typewriter effect, fade or blinking caret. Each delta is rendered as it arrives. This keeps reduced-motion users safe without a separate code path, and it avoids implying a pace the model doesn't have.
  - The only animation is the spinner, which is already `motion-safe:animate-spin`. Under reduced motion it shows as a static ring next to the step text, and the text alone still conveys the state.
- **Scrolling:**
  - The auto-scroll effect also depends on `streamedReply` and the stage, so the growing bubble stays in view.
  - It only sticks to the bottom when the scroller was already within ~32 px of it. A user who scrolled up to reread is not pulled down on every delta.
  - Scrolling stays instant (no `behavior: "smooth"`), so it respects reduced motion.
- **Final swap without a jump:**
  - `applyChatResult` and clearing `pending`/`stage`/`streamedReply` must happen in the same tick, as `send` does today with `finally`, so no frame shows both the pending bubble and the final `<li>`.
  - Because the box, padding, type and `whitespace-pre-wrap break-words` are identical, a final reply that matches the streamed text changes nothing visually except that the step line becomes the "Added track" line, or disappears for a text-only reply.
  - A server-overridden reply (D5) simply replaces the text. No transition is applied.
- **`reply_reset`:** the streamed `<p>` unmounts, so the bubble shrinks back to the step line, and the step reads "Planning again…". The text is cleared, not struck through or faded, because the discarded text was never the answer.
- **Failure or cancel:** the pending user bubble and the assistant bubble unmount together. The error shows in the existing `ErrorAlert` above the form, and the step status clears silently.
- **Tests (for 4.2):** the existing tests query `"Thinking…"` (`StudioPage.chat.test.tsx:144,148,280,289`). Switch them to "Planning…".

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
