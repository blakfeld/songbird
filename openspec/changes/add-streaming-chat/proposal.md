# Proposal

## Why

A Studio chat message makes two provider calls in a row: a planner, then a track generator. The chat shows only a spinner until both finish, which can take minutes. The user can't tell whether anything is happening, and the reply only appears at the very end. One silent, buffered response is also fragile in production: proxies and hosting platforms close HTTP connections that send no data for a while (Railway closes them after 5 minutes, and others sooner), and a long chat request sends nothing until it finishes.

## What Changes

- **Streamed song chat.** `POST /api/v1/songs/chat` can answer as a server-sent event stream when the client asks for `text/event-stream`. The stream carries:
  - progress steps: planning, then writing a named track;
  - the assistant's reply text as it is written;
  - the final `{reply, track}` result, as one validated event;
  - errors that happen after the stream has started, with the same codes and fields as today's HTTP errors.
- **Keepalives.** While a stream is open, the server sends a keepalive at least every 15 seconds whenever no other event has gone out. This keeps proxies and hosting platforms from closing the connection during long, silent provider calls.
- **The JSON response is unchanged.** A request without `Accept: text/event-stream` gets today's single `{reply, track}` JSON. Errors found before the stream starts (validation, sign-in, missing AI key, server busy) are still plain HTTP errors.
- **Provider streaming.** The Claude, OpenAI and Ollama transports stream the planner's output, so its reply can be shown before the plan is complete. Codex and the mock providers still answer in one piece; their reply arrives with the final result. A streaming `user-mock` mode lets e2e tests exercise the streamed path without a network.
- **Chat UI.** The pending assistant bubble shows the current step and fills in with the reply as it arrives. The track is added only when the final result arrives, as one undo step, as today. Leaving the song or reloading cancels the in-flight request, and the server stops its provider calls.
- **Scope.** Only the Studio chat streams. Track generation (`/api/v1/songs/tracks/generate`) and pattern generation (`/api/v1/patterns/generate`) keep their single JSON responses.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `songs/track-generation`:
  - The "Song chat endpoint" requirement gains a streamed response mode, keepalives, in-stream errors and cancellation.
  - The "Global song chat builds the arrangement" requirement shows progress and the reply as they stream.

## Impact

- **Backend:**
  - `music/src/ai/`: a streaming method on the structured-provider trait, with a non-streaming default. Streaming implementations for `claude.rs`, `openai.rs` and `ollama.rs`. Incremental extraction of the planner's `reply` field.
  - `music/src/chat.rs`: planner progress and reply events, including a reset when the planner retries.
  - `api/src/songs.rs`: an SSE response for the chat route, with keepalives and cancellation when the client disconnects.
  - `api/src/limit.rs`: the busy-shedding permit must last for the whole streamed body.
- **Frontend:**
  - `lib/api.ts`: a streaming chat client with `AbortSignal` support, and an SSE parser.
  - `components/studio/useChat.ts` and `AssistantPanel.tsx`: the streamed bubble and progress steps.
  - The Next rewrite proxy must pass the stream through unbuffered.
- **API:** additive. Existing JSON clients and tests keep working.
- **Deployment:** none required. Caddy flushes `text/event-stream` immediately. Keepalives make the chat work on hosts with idle-connection timeouts.
- **Dependencies:** possibly `eventsource-stream`, or a small hand-written parser, for reading provider SSE in Rust. No new frontend dependencies.
