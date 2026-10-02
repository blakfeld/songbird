# Songbird

Songbird is a set of tools for songwriters. Each tool turns a plain-language
description into an editable piano-roll pattern that you can play in the
browser and export as a Standard MIDI File:

- **Drum Machine**: grooves on a General MIDI drum kit.
- **Piano**: melodies and chords on a five-octave keyboard (C2 to C7), played
  with a built-in synthesizer. Click a key in the keyboard to hear its pitch.
- **Electric Piano**, **Organ**, **Strings**, and **Synth Pad**: chords and
  pads from C2 to C6.
- **Bass** (E1 to G3) and **Synth Lead** (C3 to C6): generated as single
  lines, one note at a time. You can still add chords by hand.
- **Pluck**: short, decaying notes from C3 to C6.

Every melodic instrument plays with its own built-in synthesizer voice.

## Prerequisites

- [Rust](https://rustup.rs) (the toolchain version is pinned in `backend/rust-toolchain.toml` and installed automatically)
- [Node.js](https://nodejs.org) 22 or newer and [pnpm](https://pnpm.io) 12 (`corepack enable` provides the pinned version)
- [just](https://github.com/casey/just) (`brew install just`)

## Run it

```sh
just setup          # install frontend dependencies and the Playwright browser
cp backend/.env.example backend/.env
just dev            # backend on :8080, frontend on :3000; Ctrl-C stops both
```

Open <http://localhost:3000> and choose an instrument from the landing page.
Each one also has a direct URL: `/drum-machine` for drums and
`/instruments/<id>` for the others (for example `/instruments/piano` or
`/instruments/synth-pad`).
`.env.example` selects the
`ollama` provider, which needs a local model (see below). To try the app with
no setup at all, use the built-in mock provider instead:

```sh
SONGBIRD_AI_PROVIDER=mock just dev
```

## Tests and checks

```sh
just test           # Rust, Vitest, and Playwright; needs no API key
just lint           # rustfmt, clippy, ESLint, and the TypeScript type check
just gen-types      # regenerate frontend/src/generated from the Rust types
```

Live tests against real providers are skipped by `just test` and run on demand:

```sh
just test-live          # Claude; needs ANTHROPIC_API_KEY
just test-live-ollama   # needs Ollama running with the model pulled
just test-live-codex    # needs a signed-in Codex CLI
```

## Choosing an AI provider

Set `SONGBIRD_AI_PROVIDER` in `backend/.env` to `mock`, `ollama`, `codex`, or
`claude`. When to use each, how to install Ollama or the Codex CLI, and the
local-only rule for Codex are in the
[provider guide](backend/README.md#choosing-an-ai-provider).

## Docker

Run everything without installing toolchains:

```sh
docker compose up --build       # app at http://localhost:3000, mock provider
```

With a local model:

```sh
SONGBIRD_AI_PROVIDER=ollama docker compose --profile ollama up --build
docker compose exec ollama ollama pull qwen2.5:7b-instruct
```

The frontend image bakes in the backend address at build time
(`SONGBIRD_API_URL`, set by `docker-compose.yml`).

## User accounts

There is no sign-up: an operator creates accounts with commands built into the
backend binary. They run against the configured database
(`SONGBIRD_DATABASE_URL`, SQLite at `backend/data/songbird.db` by default), so
run them from the same place and with the same environment as the server.
Passwords are never arguments. On a terminal you are prompted (twice, hidden).
When stdin is not a terminal the command reads one line from it, which is how
scripts supply a password. A password must be 12 to 256 characters.

Locally, from `backend/`:

```sh
cargo run -p api -- user create ana@example.com                 # prompts for the password
printf '%s\n' "$PASSWORD" | cargo run -p api -- user create ana@example.com
cargo run -p api -- user set-password ana@example.com           # also ends all of Ana's sessions
cargo run -p api -- user disable ana@example.com                # also ends all of Ana's sessions
cargo run -p api -- user enable ana@example.com
cargo run -p api -- user list                                   # email, active/disabled, created
cargo run -p api -- user delete ana@example.com                 # asks you to retype the email
cargo run -p api -- user delete ana@example.com --yes           # required when not on a terminal
```

With Docker Compose, run the same commands in the running backend container
(the binary there is `songbird-api`):

```sh
docker compose exec backend songbird-api user create ana@example.com
printf '%s\n' "$PASSWORD" | docker compose exec -T backend songbird-api user create ana@example.com
docker compose exec backend songbird-api user list
```

Emails are trimmed and compared without regard to letter case.
`user delete` removes the account together with all of its projects, sessions,
and usage records. Database backups made by your provider keep that data until
they age out of the provider's retention window, so deleting an account does
not erase it from backups.

Login attempts are throttled per client address. Set `SONGBIRD_TRUST_PROXY=true`
only when the outermost proxy in front of the backend **replaces** any incoming
`X-Forwarded-For` header with the real peer address (Caddy does this by
default). Behind a proxy that appends to the header instead, every client could
choose its own address and sidestep the throttle. Left at `false`, the backend
uses the socket address, which behind a proxy is the proxy itself. Everything
runs as a single backend instance: the login throttle and the per-minute AI
limit are in memory and start fresh on restart.

## Environment variables

All backend settings are documented in [`backend/.env.example`](backend/.env.example):
`SONGBIRD_BIND_ADDR`, `SONGBIRD_AI_PROVIDER`, `ANTHROPIC_API_KEY`,
`SONGBIRD_AI_MODEL`, `SONGBIRD_CORS_ORIGINS`, `SONGBIRD_GENERATION_TIMEOUT_SECS`,
`SONGBIRD_MAX_INPUT_TOKENS`, `SONGBIRD_OLLAMA_URL`, `SONGBIRD_OLLAMA_MODEL`,
`SONGBIRD_CODEX_BIN`, `SONGBIRD_CODEX_MODEL`, `SONGBIRD_COOKIE_SECURE`,
`SONGBIRD_SESSION_IDLE_HOURS`, `SONGBIRD_TRUST_PROXY`,
`SONGBIRD_AI_REQUESTS_PER_MINUTE`, and `SONGBIRD_AI_REQUESTS_PER_DAY`. The frontend reads
`SONGBIRD_API_URL` (default `http://localhost:8080`) to know where to proxy
`/api/*`. The dev server accepts `localhost` and this machine's own network
addresses, so you can open it from another device on your LAN. To reach it by
another hostname, such as a tunnel, list it in `SONGBIRD_DEV_ORIGINS`
(comma-separated).

## Importing the MIDI file into Logic Pro

Click **Download MIDI**, then drag the `.mid` file onto the Logic Pro tracks
area, or onto a Software Instrument or Drummer track. Drum notes use General
MIDI note numbers on channel 10, so they land on the matching sounds of a
Drum Kit Designer or Drummer kit. The region is exactly as long as the pattern.

## Layout

- `backend/` Rust workspace: `crates/music` (domain library) and `crates/api` (Axum server). See [`backend/README.md`](backend/README.md) for the API.
- `frontend/` Next.js app.
- `fixtures/` data shared by the Rust and TypeScript tests.
- `openspec/` specifications and the change plan.
