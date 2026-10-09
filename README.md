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

For local development, `just dev` runs `just seed` first, which creates
`dev@example.com` with the password `songbird-dev-password`. It is safe to
re-run, and it refuses any database URL
that isn't SQLite or a Postgres on localhost, because the password is public.

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

Login attempts are throttled per client address, taken from the source named
by `SONGBIRD_TRUST_PROXY`:

- `false` (default): the socket address, which behind a proxy is the proxy
  itself.
- `x-forwarded-for`: the first `X-Forwarded-For` entry. Safe only when the
  outermost proxy in front of the backend **replaces** any incoming header with
  the real peer address (Caddy does this by default). Behind a proxy that
  appends instead, every client could choose its own address and sidestep the
  throttle. `true` is a legacy alias.
- `fly-client-ip`: the `Fly-Client-IP` header. Safe only when the backend is
  reachable solely through Fly.io's proxy, which sets that header itself.

Values are case-insensitive, and anything else stops startup. If the chosen
header is missing or not a valid IP address, the socket address is used.
Everything runs as a single backend instance: the login throttle and the
per-minute AI limit are in memory and start fresh on restart.

On SIGTERM or SIGINT the backend stops accepting connections and lets open
requests, including chat streams, finish for up to 190 seconds before exiting.
A chat stream's deadline is twice `SONGBIRD_GENERATION_TIMEOUT_SECS` plus 30
seconds, so raising that setting above about 80 seconds means a deploy may cut
streams off.

## Per-user AI keys

In production every user pays for their own AI calls: each adds an Anthropic or
OpenAI key on the AI keys settings page, and the backend stores it encrypted.
The operator holds no provider key. Until a user saves one, their AI actions
are disabled; songs and editing still work.

**`SONGBIRD_ENV`** is `production` or `development` and defaults to
`production` when unset. It is a separate setting from the provider so that
spending the operator's money takes two mistakes (unsetting it and choosing an
operator provider), not one. Production refuses to start when
`SONGBIRD_AI_PROVIDER` is anything but `user` (the production default), when
`ANTHROPIC_API_KEY` is set (a leftover operator key is a startup failure, not a
dormant liability), or when `SONGBIRD_MASTER_KEYS` is missing or malformed. Any
other `SONGBIRD_ENV` value, such as `prod`, also fails startup. Development
allows every provider and logs a warning.

**Master keys.** `SONGBIRD_MASTER_KEYS` is a comma-separated keyring of
`<version>:<base64 32-byte key>` entries. The first entry encrypts new keys;
the rest only decrypt, so old keys stay readable during rotation. Generate an
entry instead of inventing key material:

```sh
cargo run -p api -- keys generate-master-key    # prints e.g. v1:<base64>
```

With Compose, use `docker compose exec backend songbird-api keys ...`. The
printed version is one higher than the highest `vN` in the current
`SONGBIRD_MASTER_KEYS`, so you can prepend it without a clash. Only
`generate-master-key` works without a database. `rotate` and `purge` run
against `SONGBIRD_DATABASE_URL`, like the `user` commands, and both need
`SONGBIRD_MASTER_KEYS`.

Keep the keyring in the server's secret environment, **not** in the repo and
**not** anywhere your database backups go. Backups hold only ciphertext, so a
stolen backup alone exposes no user keys; storing the key beside it would undo
that.

**Rotating.** Rotate when a key may have leaked, or on a schedule:

1. Generate a new entry and prepend it: `SONGBIRD_MASTER_KEYS=v2:<new>,v1:<old>`.
   Restart the server so new saves use `v2`.
2. Run `keys rotate`. It re-encrypts every key still on an older version under
   the first entry and prints counts: re-encrypted, already on the current
   version, and could not be decrypted (left unchanged), followed by a line
   saying how many keys remain on older versions. It is safe to run while the
   server is live; a key a user saves mid-run is never overwritten.
3. Remove `v1` from the keyring only once rotate says no keys remain on older
   versions. Startup refuses to run when any
   stored key uses a version missing from the keyring. This is deliberate:
   without it, a removed key would appear later as every affected user's AI
   failing. A key rotate cannot decrypt is left unchanged, so a wrong keyring
   never destroys data.

**If a master key is lost** the keys sealed under it are unrecoverable.
Prepend a new key as above (restart so the server uses it) and make sure the
lost version is no longer in `SONGBIRD_MASTER_KEYS`, then delete the orphaned
rows so the startup check passes:

```sh
cargo run -p api -- keys purge --version v1       # asks you to retype the version
cargo run -p api -- keys purge --version v1 --yes # required when not on a terminal
```

Purge needs `SONGBIRD_MASTER_KEYS` set and **refuses a version that is still in
it**, because those keys are readable: rotate them instead, or remove the
version from the keyring if its key is really lost. There is no override. If no
stored key uses the version it says so and deletes nothing, so a typo does not
look like success. Otherwise it cannot be undone and prints how many keys it
deleted. Affected users see their AI actions disabled and re-enter their keys;
songs are untouched.

**Backups keep ciphertext.** A managed database backup retains the encrypted
key of a user whose account or key was deleted until the backup expires. That
is acceptable because it is useless without the master key, which is why the
key must never be stored with the backups.

**Local and e2e use.** `SONGBIRD_AI_PROVIDER=user-mock` runs the full per-user
flow (saving, encrypting, and gating on keys) with fake providers, so no real
key is needed or spent. It still requires `SONGBIRD_MASTER_KEYS` and is
what the Playwright suite uses. Plain `mock`, `ollama`, `codex`, and `claude`
need `SONGBIRD_ENV=development`.

## Environment variables

All backend settings are documented in [`backend/.env.example`](backend/.env.example):
`SONGBIRD_ENV`, `SONGBIRD_MASTER_KEYS`, `SONGBIRD_BIND_ADDR`, `SONGBIRD_AI_PROVIDER`,
`ANTHROPIC_API_KEY`, `SONGBIRD_AI_MODEL`, `SONGBIRD_OPENAI_MODEL`, `SONGBIRD_CORS_ORIGINS`, `SONGBIRD_GENERATION_TIMEOUT_SECS`,
`SONGBIRD_MAX_INPUT_TOKENS`, `SONGBIRD_OLLAMA_URL`, `SONGBIRD_OLLAMA_MODEL`,
`SONGBIRD_CODEX_BIN`, `SONGBIRD_CODEX_MODEL`, `SONGBIRD_COOKIE_SECURE`,
`SONGBIRD_SESSION_IDLE_HOURS`, `SONGBIRD_TRUST_PROXY`,
`SONGBIRD_AI_REQUESTS_PER_MINUTE`, and `SONGBIRD_AI_REQUESTS_PER_DAY`. `SONGBIRD_ENV`
is `production` when unset, and production refuses to start with any provider other than
`user` (each user's own key) or with an `ANTHROPIC_API_KEY` set; local development
needs `SONGBIRD_ENV=development`, which `just dev`, `docker-compose.yml`, and `.env.example`
already set. The frontend reads
`SONGBIRD_API_URL` (default `http://localhost:8080`) to know where to proxy
`/api/*`. The dev server accepts `localhost` and this machine's own network
addresses, so you can open it from another device on your LAN. To reach it by
another hostname, such as a tunnel, list it in `SONGBIRD_DEV_ORIGINS`
(comma-separated).

## Recording audio in the Studio

An audio track can record a microphone or an audio interface as well as play
imported samples. Add one from **Add track**, then select it and press
**Record**: Songbird counts in one bar (if Count-in is on), records until you
press Record again, and puts the take on the track as a clip. Recording needs
HTTPS or `localhost`, and a current Chrome, Edge, Firefox, or Safari. Undo
removes a whole take in one step.

**Choosing an input.** The third row of an audio track's header starts with the
input button, named `Input for <track>`. Before the browser has been asked, it
reads **Allow mic**; opening it (or pressing Record) shows the browser's
permission prompt. Once allowed, it lists your devices:

- **Device**: the system default, or a specific microphone or interface. The
  choice is remembered for that track in this browser only, never in the song.
  If a remembered device is unplugged, the track uses the default input and
  says so, and goes back to the device when you plug it in.
- **Channels**: **Mono** records input 1; **Stereo** records inputs 1 and 2.
  Stereo is unavailable on a one-channel input.
- The level meter beside the button shows the input while the track is
  selected. If the input ever reaches full scale, the small indicator beside
  it stays lit until you click it. Turn down the gain on your microphone or
  interface when it lights.

If the browser says **Blocked**, microphone access was refused for this site.
In Chrome, click the site settings icon at the left of the address bar, set
**Microphone** to **Allow**, then choose **Try again** in the input popover. In
Safari, open **Safari > Settings > Websites > Microphone** (or **Settings for
This Website** in the same menu), set this site to **Allow**, then choose
**Try again**. Everything except recording keeps working while it is blocked.

**Monitoring.** The headphones button (**Monitor**) plays your input back
through the track's effects, volume, and pan, even while stopped; Mute silences
it. The first time you turn it on, Songbird asks you to wear headphones:
through speakers, the microphone hears itself and feeds back loudly. The take
you record is always the dry input, without the track's effects.

**Recording offset.** Browsers report how late audio arrives, and Songbird
compensates for it, but a particular setup can still land a little early or
late. The input popover has a **Recording offset** setting, from -200 to +200
ms, that applies to every track. To set it:

1. Wearing headphones, turn on the Metronome and record a few claps exactly on
   the beat.
2. Zoom in on the clip's waveform and see how far each clap sits from the beat
   line. If the claps are late, raise the offset by that many milliseconds; if
   they are early, lower it.
3. Record again to check, and repeat until the claps sit on the beat.

Changing the offset only affects new takes. Takes you have already recorded do
not move.

**Takes.** Each recording is kept as a take. With looping on, every pass of the
loop is its own take, and the clip plays the last one. Select a clip to see the
track's takes in its panel: switch the clip to another take, rename a take,
delete takes no clip uses, or add a take to the Samples library to use it in
other songs.

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
