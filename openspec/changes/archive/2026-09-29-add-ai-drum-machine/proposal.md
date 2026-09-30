# Proposal

## Why

Songbird is an online suite of songwriting tools, and nothing exists yet. The Drum Machine is the first tool: songwriters often know the *feel* they want ("laid-back boom-bap at 90 BPM with ghosted snares") but not how to program it. Letting them describe a groove in words, get an editable MIDI pattern back, and drop it straight into Logic Pro removes that friction and establishes the foundation (backend, frontend, AI integration, dev tooling) every later Songbird tool will build on.

## What Changes

- **New monorepo** with a Rust backend (Axum) and a Next.js (React, TypeScript) frontend, plus a single documented way to run both locally and run all tests.
- **Instrument-agnostic core**: patterns are notes on a piano roll (rows × sixteenth steps, each note with a length and velocity) played by an *instrument*. An instrument defines its rows, MIDI channel, sound, and AI prompt. **Drums is the first and only instrument shipped**; later Songbird tools (bass, keys, ...) add instruments without changing the pattern format, API, editor, playback, or export.
- **AI pattern generation**: a backend endpoint accepts an instrument, a free-text description, tempo, time signature, and a length of 4, 8, 12, 16, or 32 measures, and returns a structured pattern. The description is capped by a configurable input token limit (default 256 estimated tokens) to bound AI cost and abuse. The AI provider sits behind a pluggable interface with four implementations: Claude (Anthropic API, the default), Ollama (a locally run open model, so everyday development burns no paid tokens), Codex CLI (uses the developer's existing ChatGPT Plus subscription for local testing against a stronger model; local-only), and a deterministic mock for automated tests and CI.
- **Piano-roll editor**: the web UI renders the pattern as a piano roll (one row per instrument row, columns per step) where the user can add, remove, resize, and change the velocity of notes, and change length, tempo, and swing. The Drum Machine page is this editor with the Drums instrument.
- **Playback**: in-browser playback of the pattern with the instrument's sounds (a bundled drum kit for Drums), play/stop, loop, a moving playhead, and tempo control.
- **MIDI export**: download the pattern as a Standard MIDI File (`.mid`) on the instrument's MIDI channel (General MIDI drum map on channel 10 for Drums), which Logic Pro imports directly.
- **Stateless v1**: no accounts or database. The current pattern lives in the browser (persisted to localStorage so a refresh doesn't lose work).

## Capabilities

### New Capabilities
- `patterns/generation`: Turning an instrument choice, a text prompt, and musical parameters (tempo, time signature, measure count) into a validated note pattern via a pluggable AI provider; includes instrument discovery, the pattern document format, the HTTP API contract, and error behavior.
- `patterns/piano-roll-editor`: The piano-roll UI for viewing and editing a pattern: instrument rows, grid resolution, adding/removing/resizing notes, velocity, changing length/tempo, undo/redo, and preserving work across reloads.
- `patterns/playback`: In-browser audio playback of the current pattern with the instrument's sounds, transport controls, and playhead.
- `patterns/midi-export`: Producing a Standard MIDI File from the current pattern that imports correctly into Logic Pro and other DAWs.
- `instruments/drums`: The Drums instrument: its General MIDI rows and channel, one-shot sound and bundled kit, and drum-specific generation behavior.
- `platform/service-operations`: Backend service behavior shared by all Songbird tools: health check, configuration via environment, CORS for the frontend, and structured error responses.

### Modified Capabilities
<!-- None: this is the first change in the project. -->

## Impact

- **New code**: `backend/` (Rust crate, Axum), `frontend/` (Next.js app), root-level dev tooling (`justfile` / `docker-compose.yml`, CI config).
- **New API**: `POST /api/v1/patterns/generate`, `GET /api/v1/patterns/limits`, `POST /api/v1/patterns/export/midi`, `GET /api/v1/instruments`, `GET /healthz`.
- **External dependency**: Anthropic Messages API (requires `ANTHROPIC_API_KEY` at runtime when the Claude provider is selected). Cost scales with generation requests.
- **Optional local dependencies** (development only): Ollama with a pulled model for the `ollama` provider; OpenAI's Codex CLI signed in with a ChatGPT account for the `codex` provider. Neither is needed for tests or CI.
- **Non-goals for this change**: user accounts, saved pattern libraries, sharing links, audio (WAV) export, custom drum kits/sample upload, instruments other than Drums (the core supports them; none ship), and the other future Songbird tools.
