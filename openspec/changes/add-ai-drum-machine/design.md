# Design

## Context

The repository is empty apart from OpenSpec scaffolding (and is not yet a git repo), so this change establishes the project layout, toolchain, and conventions for all future Songbird tools. See proposal.md for motivation and specs/ for required behavior. Fixed constraints from the product owner: Rust + Axum backend, React frontend on Next.js, pluggable AI provider with Claude as default, stateless v1 (no DB, no auth), measure counts 4/8/12/16/32, and a token cap on the user's description.

## Goals / Non-Goals

**Goals:**
- A monorepo layout that future tools (e.g. chord progressions, lyric helper) can slot into without restructuring.
- One command to run everything locally and one command to run all tests, with no API key needed for either (mock provider).
- A single, versioned pattern document shared by backend and frontend, with types that cannot drift.
- Bounded AI cost and latency regardless of measure count.

**Non-Goals:**
- Production deployment/hosting, rate limiting per user, observability stack beyond structured logs.
- Server-side rendering of the editor (it is a client-side interactive page).
- Supporting triplet grids or resolutions finer than sixteenth notes.

## Decisions

### D1. Repository layout
```
songbird/
  backend/            Rust workspace
    crates/api/       Axum binary: routes, config, error mapping
    crates/music/     Domain library (no Axum): meter/timing, Pattern/Note model, request validation,
                      draft grammar + normalization + expansion, SMF writer, AI providers,
                      instruments/ (registry + one module per instrument: drums.rs)
  frontend/           Next.js app (App Router, TypeScript)
  justfile            Task runner entry point
  docker-compose.yml  Run both services in containers
  .github/workflows/ci.yml
```
Domain logic lives in one library crate, `music`, with no Axum dependency so it is unit-testable in isolation. Everything in it is instrument-agnostic except `music::instruments`, where each instrument is an `Instrument` definition registered in a static registry: id, display name, MIDI channel, `sustained` flag, rows (id, name, MIDI note), the instrument's system prompt, row aliases the model may use, example drafts for the mock provider, and an optional fallback-variation hook. Drums (`instruments/drums.rs`) is the only instrument in this change. Adding an instrument means adding one module and registering it; the pattern format, API, editor, playback engine, and export do not change. *Alternatives*: one crate per instrument on top of a core crate (more crates and boundaries than the small amount of instrument-specific code justifies); a separate `drums` crate owning a drum-only document (rejected: it would bake drums into the API and document and force a migration when the second instrument arrives).

### D2. Task runner: `just`
`just dev` starts backend (`cargo watch`/`cargo run`) and frontend (`pnpm dev`) together; `just test` runs `cargo test`, `pnpm test` (Vitest), and `pnpm test:e2e` (Playwright); `just lint` runs `cargo fmt --check`, `cargo clippy -D warnings`, `pnpm lint`, `pnpm typecheck`. `docker compose up` is the alternative "run it without installing toolchains" path. *Alternatives*: Makefile (worse ergonomics, tab pitfalls), npm scripts at root (awkward for Rust). `just` is a single small binary; document install in README.

### D3. Frontend stack
Next.js (App Router) + TypeScript + Tailwind CSS, pnpm as package manager. The piano-roll editor is a generic client component parameterized by an instrument (its rows and metadata come from `GET /api/v1/instruments`; its sound source comes from a frontend instrument registry keyed by id). The Drum Machine lives at `/drum-machine` and renders the editor with the `drums` instrument; `/` is a Songbird landing page linking to it. Next.js `rewrites` proxy `/api/*` and `/healthz` to the backend in development, so the browser talks to one origin; CORS (spec'd in `platform/service-operations`) still exists for deployments where frontend and API are on different origins.

State: **Zustand** store holding the pattern document plus an undo/redo history stack (snapshots of the immutable pattern; patterns are small — a 32-measure pattern is at most ~5k notes). Persistence via Zustand's `persist` middleware to `localStorage`, one key per instrument (`songbird.patterns.<instrument>.v1`). *Alternative*: React `useReducer` + context — workable, but persistence, selectors, and access from the audio engine outside React are clumsier.

### D4. Piano-roll rendering
DOM/CSS-grid rendering, one memoized component per measure, row labels in a sticky left column, horizontal scroll container. 32 measures × 16 steps × ~12 rows ≈ 6k cells; memoizing per measure keeps edits to a single-measure re-render. Notes are absolutely positioned bars over the cell grid spanning `length_steps` columns (a note crossing a measure boundary is drawn by its starting measure with overflow visible), so empty cells stay cheap click targets. Velocity is shown via bar opacity; velocity editing via vertical drag on a note (and Alt-click cycling presets for accessibility). Each note has a right-edge resize handle: horizontal drag snaps to whole steps, clamped to the next note on the row and the pattern end, committed as one undoable edit on pointer-up. Clicking the note body (not the handle) removes it. *Alternative*: `<canvas>` — faster for huge grids but requires hand-rolled hit testing and accessibility; revisit only if profiling shows DOM is too slow (see Risks).

### D5. Audio playback: Tone.js
Use **Tone.js** `Transport` for sample-accurate lookahead scheduling (avoids `setTimeout` drift required by the timing spec) and a per-instrument sound source from a frontend registry. For drums that is a `Tone.Players` loaded from a bundled kit of CC0 one-shot samples in `frontend/public/kits/drums/` (one file per row; source e.g. a CC0 kit from freesound/99sounds with license recorded in `LICENSE-samples.md`). Swing is applied in our own scheduling math (not `Transport.swing`) so the same function (`stepToSeconds`) can be unit-tested and mirrored exactly by the MIDI exporter. Playhead position is read from `Transport.seconds` in a `requestAnimationFrame` loop. Edits during playback: the scheduler reads notes from the store at schedule time each bar, satisfying "audible on next pass". The engine calls the sound source with `(row, startSeconds, endSeconds, velocity)`; one-shot sources (drums) ignore `endSeconds`, sustained sources (future instruments) release at it. *Alternative*: raw Web Audio API — no dependency, but reimplements the lookahead scheduler.

### D6. Pattern document and shared types
The pattern document (spec: patterns/generation → "Pattern document format") and the instrument listing are defined once as Rust structs (`Pattern`, `Row`, `Note`, `InstrumentInfo`, plus request/limits types) with `serde` and exported to TypeScript via **`ts-rs`** into `frontend/src/generated/`. A test in CI regenerates and fails on diff. `step` is an absolute, zero-based sixteenth index; `steps_per_measure` is derived from time signature (4/4→16, 3/4→12, 6/8→12). The pattern copies its instrument's rows and MIDI channel so export and playback need nothing but the document. Drums rows (GM notes, channel 10): kick 36, snare 38, side stick 37, clap 39, closed hat 42, pedal hat 44, open hat 46, low tom 45, mid tom 47, high tom 50, crash 49, ride 51.

### D7. AI generation: compact "sections + arrangement" format
Asking an LLM to enumerate every note for up to 32 measures is slow, expensive, and error-prone. Instead the provider returns a compact, instrument-agnostic intermediate form:
```json
{
  "name": "Dusty Boom Bap",
  "tempo_bpm": 90, "swing": 0.2,
  "sections": [
    {"id": "A", "lanes": [
      {"lane": "kick", "steps": "x......x..x....."},
      {"lane": "snare", "steps": "....X.......X..."},
      {"lane": "hat_closed", "steps": "x.x.x.x.x.x.x.x."}]},
    {"id": "fill", "lanes": [
      {"lane": "snare", "steps": "....X.....xxXXXX"},
      {"lane": "crash", "steps": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}]}
  ],
  "arrangement": ["A","A","A","fill"]
}
```
Sections and lanes are arrays rather than objects keyed by id because strict structured-output modes (OpenAI/Codex, Ollama) reject free-form object keys. A `lane` is a row id of the requested instrument (the schema enumerates them; the instrument's aliases are also accepted). One string per lane per section, one char per step: `.` rest, `g` ghost (≈35), `x` normal (≈90), `X` accent (≈120), `-` hold (extends the previous note by one step; a rest after a rest). A lane may instead be an array of per-step velocities (`[110,0,0,35,…]`, `0` = rest) when the model wants finer dynamics; array notes always have length 1 (use a string for held notes) and values are clamped to 1–127, which is how an out-of-range model velocity (e.g. 200) becomes 127. The `arrangement` lists a section per measure; the backend repeats it cyclically to reach the requested measure count, and for >4 measures guarantees a variation at phrase ends (inserting the last non-primary section, or the instrument's fallback-variation hook — a snare roll for drums — if the model gave none). A hold cannot run past its section's measure because each string is one measure long; expansion then removes overlaps on each row (an earlier note is shortened to end where the next begins) and truncates notes at the pattern end. All of this lives in `music` — providers only produce this form, and every validation rule in the spec is enforced in one place regardless of provider or instrument.

**Provider trait** (`music::ai::PatternProvider`, async): `generate(&GenerateRequest, &Instrument) -> Result<PatternDraft, ProviderError>` and `check()`. The real providers share a helper that builds the instrument's system prompt, the user message, and the instrument-specific `PatternDraft` JSON Schema (lane enum = the instrument's row ids), then parses the JSON they return. Implementations:
- `ClaudeProvider`: calls the Anthropic Messages API over `reqwest` (no official Rust SDK), using a forced tool call (`tool_choice: {type: "tool", name: "emit_pattern"}`) whose `input_schema` is the intermediate format, so output is structured JSON. The system prompt is a shared part (step-string grammar, arrangement, that the user's text is a musical description only) plus the instrument's part (for drums: GM drum vocabulary and genre conventions). Model configurable via `SONGBIRD_AI_MODEL` (default `claude-sonnet-5-5`), key via `ANTHROPIC_API_KEY`.
- `OllamaProvider`: see D7b.
- `CodexCliProvider`: see D7c.
- `MockProvider`: deterministic — picks one of the instrument's example drafts by genre keyword in the prompt, else by a stable hash of the request; no network. Drums ships four (rock, house, boom-bap, trap).

All providers share the same prompts and the same `PatternDraft` JSON Schema (generated from the Rust type with `schemars`, with the lane enum filled in per instrument), so switching providers changes quality and cost, never the contract. Selected by `SONGBIRD_AI_PROVIDER=claude|ollama|codex|mock`; each provider implements an async `check()` run at startup (spec: fail fast with a fix-it message). Retry once on parse/validation failure (spec); overall timeout via `tokio::time::timeout` using `SONGBIRD_GENERATION_TIMEOUT_SECS` (default 60). *Alternatives*: free-form JSON in text (less reliable than forced tool use); returning MIDI directly from the model (unvalidatable).

| Provider | Cost | Runs where | Intended use |
|---|---|---|---|
| `mock` | free | anywhere | automated tests, CI |
| `ollama` | free | local / self-hosted | everyday development (`.env.example` default) |
| `codex` | ChatGPT Plus plan | developer's machine only | quality checks against a stronger model |
| `claude` | API tokens | anywhere | production default |

### D7b. Ollama provider
`POST {SONGBIRD_OLLAMA_URL}/api/chat` (default `http://localhost:11434`) with `stream: false`, the shared system prompt as the system message, the user's description as the user message, and `format: <PatternDraft JSON Schema>` — Ollama's structured-output mode constrains decoding to the schema, which keeps small models on-format. Model from `SONGBIRD_OLLAMA_MODEL`; the README recommends a 7–14B instruct model that fits in 16–24 GB of RAM (exact tag chosen and verified during implementation). `check()` calls `GET /api/tags` and confirms the model is listed. `docker-compose.yml` gets an optional `ollama` profile.

*Alternatives*: Ollama's OpenAI-compatible `/v1/chat/completions` endpoint, which would also cover LM Studio, llama.cpp server and vLLM — rejected for now because JSON-schema-constrained output is inconsistently supported across those servers; it is a straightforward follow-up provider if wanted. Running models in-process (e.g. `llama.cpp` bindings) — heavier build, and worse developer experience than a separate server.

### D7c. Codex CLI provider (ChatGPT subscription)
A ChatGPT Plus subscription does not include OpenAI API access; the supported way to use it programmatically is OpenAI's Codex CLI, which signs in with a ChatGPT account and offers a non-interactive `codex exec` mode. `CodexCliProvider` spawns `SONGBIRD_CODEX_BIN` (default `codex`) with `tokio::process::Command`: prompt (shared system prompt + user description) on stdin, the `PatternDraft` JSON Schema passed as the output schema, the final message written to a temp file that is then parsed, working directory a fresh empty temp dir, read-only sandbox, git-repo check skipped, optional `SONGBIRD_CODEX_MODEL`. Exact flag names are verified against the installed CLI during implementation and a minimum CLI version is pinned in the README. A `tokio::sync::Semaphore(1)` serializes runs so plan usage limits are not burned in parallel; the child is killed if the generation timeout fires. `check()` runs `codex login status`, and startup refuses the provider unless `SONGBIRD_BIND_ADDR` is a loopback address.

*Alternatives*: OpenAI API provider — needs separately billed API credit, which defeats the purpose. Calling ChatGPT's private web endpoints with session tokens — undocumented, brittle, and against OpenAI's terms; explicitly rejected.

### D7a. Input token limit: shared character-based estimate
The description is capped by an *estimated* token count, `ceil(chars / 4)` over Unicode scalar values of the trimmed prompt (spec: patterns/generation → "Prompt token limit"). The limit is `SONGBIRD_MAX_INPUT_TOKENS` (default 256, validated to 16–4096 at startup). The backend enforces it before any provider call (`422 prompt_too_long`); it is the authority. The frontend implements the same one-line function for a live counter and to disable Generate, and reads the configured limit from `GET /api/v1/patterns/limits` (which also returns `measure_options`, so the UI never hard-codes either). A shared fixture file `fixtures/token_estimate.json` of `(prompt, expected estimate)` pairs, including multi-byte and whitespace edge cases, is consumed by both Rust and Vitest tests so the two implementations cannot drift.

*Alternatives*: a real BPE tokenizer such as `tiktoken-rs` (closer to Claude's actual tokenization, but it is a different vendor's vocabulary anyway, and mirroring it in the browser needs a ~1 MB `js-tiktoken` bundle); Anthropic's token-counting endpoint (exact, but adds a network round-trip per request and only works for the Claude provider). The cap exists to bound cost and abuse, not to hit an exact model limit, so a cheap, deterministic, provider-independent estimate is sufficient.

### D8. MIDI export in the backend
`POST /api/v1/patterns/export/midi` takes a pattern document and returns `audio/midi` bytes with `Content-Disposition: attachment`. Written by `music::midi` using the **`midly`** crate: Type 1 SMF, 480 PPQ, track 0 = tempo + time signature + name, track 1 = notes on the pattern's `midi_channel` (drums: 10, index 9), each Note Off at the (swung) start tick of step `step + length_steps` — a length-1 drum note ends one sixteenth (120 ticks) later, which DAWs treat as a normal one-shot — End of Track at pattern end. Swing uses the same formula as playback. The frontend posts the current (edited) pattern and triggers a download from the blob. *Alternative*: generate MIDI in the browser (e.g. `midi-writer-js`) — works offline, but keeps logic out of Rust where future tools (and a potential server-side renderer) will want it, and Rust tests are the easiest place to assert exact ticks. The pattern is small, so the round-trip is negligible. Stateless: nothing is stored.

Why `.mid`: Logic Pro imports Standard MIDI Files natively (drag into the tracks area creates a region; GM drum note numbers map to Drum Kit Designer / Drummer kits, and future melodic instruments map to any Software Instrument). No Logic-specific format is needed.

### D9. Backend service structure
Axum with `tower-http` layers: `CorsLayer` (origins from `SONGBIRD_CORS_ORIGINS`), `RequestBodyLimitLayer` (64 KiB), `TraceLayer` with `tracing` JSON logs. Config via `envy`/`dotenvy` into a typed `Config` (including `max_input_tokens`, generation timeout, and per-provider settings) validated at startup, followed by the selected provider's `check()`; the API key is wrapped in a `secrecy::SecretString` so it cannot be logged by accident. A single `ApiError` enum implements `IntoResponse` producing the standard error shape; a custom JSON extractor rejection maps to `invalid_json`. App state holds `Arc<dyn PatternProvider>` and the instrument registry, making handlers testable with the mock via `tower::ServiceExt::oneshot`.

### D10. Testing strategy
- **Rust unit** (`music`): step-string parsing (including holds), clamping, dedupe, overlap removal, expansion to each measure count, fill insertion, instrument registry, MIDI tick math (golden tests with exact bytes for small patterns), round-trip parse with `midly`.
- **Rust integration** (`api`): every endpoint and error code via `oneshot` with `MockProvider`; a `FailingProvider`/`SlowProvider` test double for `502`/`504` (timeout shortened via config in tests).
- **Provider tests**: Claude and Ollama against `wiremock` HTTP servers; Codex against a fake `codex` script (checked into `backend/tests/fixtures/`) that emits fixture output, bad output, a non-zero exit, or hangs — so CI never needs a subscription, an API key, or a local model.
- **Optional live tests**: `#[ignore]` tests per real provider — `just test-live` (Claude, needs `ANTHROPIC_API_KEY`), `just test-live-ollama` (needs a running Ollama with the model pulled), `just test-live-codex` (needs a signed-in Codex CLI).
- **Frontend unit** (Vitest + React Testing Library): store reducers (toggle, velocity, note resize, measure resize, undo/redo), `stepToSeconds` swing math, token estimator against the shared fixture, form validation, piano-roll rendering.
- **E2E** (Playwright): boots backend with `SONGBIRD_AI_PROVIDER=mock` and Next dev server; covers generate → edit (including a note resize) → reload persistence → download MIDI (parsed with `@tonejs/midi`, an independent parser, satisfying the round-trip scenario). Audio is not asserted beyond "transport state changes".
- **CI**: GitHub Actions running `just lint` and `just test` on push/PR.

## Risks / Trade-offs

- [Generalizing before a second instrument exists could pick the wrong abstraction] → Keep instrument-specific code to one definition module; only add note length (needed by any melodic instrument) and defer anything else (pitch ranges, scales, chords) to the change that adds that instrument.
- [LLM output quality varies; grooves may be musically weak] → Strong system prompt with genre examples; compact format keeps the model focused on musical choices; editor lets users fix results. Iterate on prompt using a small set of saved prompts evaluated by ear.
- [AI cost/abuse on a public endpoint] → Bounded output size via compact format and output `max_tokens`; input capped by `SONGBIRD_MAX_INPUT_TOKENS`; add rate limiting before any public deployment (out of scope here, noted in README).
- [Token estimate differs from Claude's real token count (by roughly ±30% depending on language and content)] → Acceptable because the cap bounds cost rather than enforcing a hard model limit; the default of 256 leaves large headroom under any model's context window. Swap the estimator behind the same function if precision ever matters.
- [Local models write weaker grooves and cold-load slowly] → Schema-constrained output plus shared validation/retry keeps responses valid; raise `SONGBIRD_GENERATION_TIMEOUT_SECS` locally; use `codex` or `claude` when judging musical quality.
- [Codex CLI is slower than a direct API call (agent start-up) and may approach the timeout] → Configurable timeout; single-run semaphore; documented as a testing tool, not a serving path.
- [ChatGPT Plus usage caps] → Serialized runs; `ollama` is the day-to-day default so Codex is used deliberately.
- [Codex CLI flags or output format change between versions] → Pin a minimum version, verify flags in a dedicated task, and keep the fake-CLI tests asserting the exact arguments passed.
- [Personal subscription exposed through a shared server] → Startup refuses the `codex` provider on non-loopback addresses and logs a warning even locally.
- [Prompt injection via user description] → Output is forced through a tool schema and fully validated; nothing from the model is executed or rendered as HTML.
- [DOM piano roll sluggish at 32 measures on low-end devices] → Per-measure memoization; if profiling shows problems, switch the grid body to canvas without changing the store or specs.
- [Browser autoplay policies block audio] → Start `Tone.start()` on the first Play click (a user gesture).
- [Swing implemented twice (TS playback, Rust export) could diverge] → Shared fixture file of `(pattern, expected note times)` consumed by both Rust and Vitest tests.
- [Sample licensing] → Only CC0/public-domain samples; license file committed alongside.
- [ts-rs generated types drift] → CI check that regenerating produces no diff.

## Migration Plan

Greenfield: no migration. Rollout is local development only in this change. Rollback = revert the change.

## Open Questions

- Exact CC0 drum kit to bundle (any kit covering every drums row satisfies the spec).
- Visual design/branding for Songbird beyond a clean default Tailwind theme.
- Hosting target for a first public deployment (containers from `docker-compose.yml` are portable to most options).
