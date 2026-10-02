# Songbird backend

A Cargo workspace: `crates/music` is the domain library (pattern model,
instruments, draft normalization and expansion, AI providers) and `crates/api`
is the Axum server. Copy `.env.example` to `.env` to configure it.

```sh
cd backend
SONGBIRD_AI_PROVIDER=mock cargo run -p api      # listens on 127.0.0.1:8080
```

## API

All errors have the shape `{"error": {"code": "...", "message": "..."}}`.
Request bodies are limited to 64 KiB; larger ones get the standard JSON
`413 payload_too_large`, whether or not they declare a `Content-Length`.

### `GET /healthz`

`200 {"status":"ok"}`. Calls no external service or the database, so it only
says the process is alive.

### `GET /readyz`

`200 {"status":"ready"}` when a `SELECT 1` succeeds within 2 seconds, otherwise
`503` with code `not_ready` and no database details. No authentication.

### `GET /api/v1/instruments`

Lists every instrument: `id`, `name`, `kind` (`drums` or `melodic`),
`midi_channel` (1-16), `midi_program` (General MIDI 1-128, `null` for drums),
`range` (`{"low","high"}` MIDI notes, `null` for drums), `sustained`, and `rows`
(`id`, `name`, `midi_note`) in display order. Currently `drums` and `piano`.

### Piano and pitch lanes

`piano` is a melodic instrument: channel 1, General MIDI program 1 (Acoustic
Grand Piano), range C2-C7 (MIDI 36-96), sustained. Its 61 rows run from `C7`
down to `C2`; ids and names are scientific pitch notation with sharps, where
MIDI 60 is `C4` (`C#4`, `A#2`). Every piano pattern carries all 61 rows.

In a draft, a lane is one pitch, and a chord is several lanes with the same
steps. Lanes accept sharps or flats in any case (`C#4`, `Db4`, `db4`) or MIDI
numbers (`60`). A pitch outside the range is moved by whole octaves to the
nearest octave inside it (`E8` becomes `E6`); a name that is not a pitch (such
as `kick`) is dropped. If two lanes land on one row, the louder note is kept.
Holds (`-`) make sustained notes. For a pattern longer than four measures with
no variation, a cadence variant of the first measure is inserted at each phrase
end.

```sh
curl -s localhost:8080/api/v1/patterns/generate \
  -H 'content-type: application/json' \
  -d '{"instrument":"piano","prompt":"gentle ballad","measures":4,"tempo_bpm":72}'
```

### `GET /api/v1/patterns/limits`

`{"max_input_tokens": 256, "measure_options": [4, 8, 12, 16, 32]}`. The token
limit is `SONGBIRD_MAX_INPUT_TOKENS`; the estimate is `ceil(chars / 4)` over the
trimmed prompt.

### `POST /api/v1/patterns/generate`

```sh
curl -s localhost:8080/api/v1/patterns/generate \
  -H 'content-type: application/json' \
  -d '{"instrument":"drums","prompt":"dusty boom bap","measures":4,"tempo_bpm":90}'
```

Body: `instrument` (required), `prompt` (required), `measures` (4, 8, 12, 16 or
32), and optional `tempo_bpm` (40-240), `time_signature` (`4/4`, `3/4`, `6/8`),
`swing` (0-0.75). The response is a pattern document (`version`, `instrument`,
`name`, `tempo_bpm`, `time_signature`, `measures`, `steps_per_measure`,
`swing`, `midi_channel`, `midi_program`, `rows`, `notes`); a note is
`{"row_id":"kick","step":0,"length_steps":1,"velocity":90}` with an absolute,
zero-based sixteenth `step`.

| Status | Code | Cause |
|---|---|---|
| 400 | `invalid_json` | Body is not valid JSON for the endpoint |
| 404 | `not_found` | Unknown path |
| 405 | `method_not_allowed` | Wrong HTTP method |
| 413 | `payload_too_large` | Body over 64 KiB |
| 422 | `invalid_instrument` | Missing or unknown `instrument` |
| 422 | `invalid_prompt` | Prompt empty or whitespace |
| 422 | `prompt_too_long` | Estimated tokens over `max_input_tokens` |
| 422 | `invalid_measures` | Not one of 4, 8, 12, 16, 32 |
| 422 | `invalid_tempo` | Not a whole number 40-240 |
| 422 | `invalid_time_signature` | Not `4/4`, `3/4` or `6/8` |
| 422 | `invalid_swing` | Outside 0-0.75 |
| 502 | `generation_failed` | Provider failed, or its output was unusable after one retry |
| 504 | `generation_timeout` | Exceeded `SONGBIRD_GENERATION_TIMEOUT_SECS` |

Validation happens before any provider call, so `422` responses cost nothing.
A draft that cannot be parsed or normalized is retried once; transport
failures are not retried. Whatever the provider, the draft is clamped,
deduplicated, and made overlap-free by the same code, so responses are
identical in shape.

### `POST /api/v1/patterns/export/midi`

Takes a pattern document (as returned by generate, including any edits) and
returns a Type 1 Standard MIDI File (`audio/midi`, 480 PPQ) with
`Content-Disposition: attachment; filename="songbird-<slug>-<bpm>bpm.mid"`. The
slug is the lowercased ASCII-alphanumeric pattern name with runs of other
characters collapsed to `-` (`pattern` if nothing remains). Swing is baked into
note times. A body that is not a valid pattern is `400 invalid_json`. A pattern
that parses but is not exportable is `422 invalid_pattern`, with the message
naming the field: `tempo_bpm` outside 40-240, `swing` outside 0-0.75,
`steps_per_measure` not matching the time signature, `midi_channel` outside
1-16, or a note with an unknown row, a `step` past the end, `length_steps` of 0,
or `velocity` outside 1-127. Overlapping notes on one row are shortened so the
next begins where the previous ends, as in generation. A pattern with a
`midi_program` gets a Program Change at tick 0 on its channel (wire value
`midi_program - 1`); `midi_program` outside 1-128 is `422 invalid_pattern`. A
pattern that omits it, such as one saved before melodic instruments, is treated
as having its instrument's program (none for drums).

```sh
curl -s localhost:8080/api/v1/patterns/export/midi -H 'content-type: application/json' \
  -d @pattern.json -o groove.mid
```

Manually checked on 2026-09-29: a piano pattern generated with the `ollama`
provider (`qwen2.5:7b-instruct`) and exported with this endpoint imported into
Logic Pro, and its pitches matched the pattern's notes.

### `GET /api/v1/songs/limits`

`{"max_input_tokens": 256, "max_range_measures": 32, "max_song_measures": 128,
"max_tracks": 16, "max_chat_messages": 20}`. Only `max_input_tokens` depends on
configuration.

### `POST /api/v1/songs/tracks/generate`

Generates one track of a song over a range of measures, with the song's other
tracks as context. The server stores nothing; the client applies the result.

```sh
curl -s localhost:8080/api/v1/songs/tracks/generate \
  -H 'content-type: application/json' \
  -d '{"song":{"version":2,"id":"s1","name":"Late Train","tempo_bpm":96,"time_signature":"4/4","steps_per_measure":16,"swing":0,"key":{"tonic":"E","mode":"minor"},"measures":4,"tracks":[{"id":"t1","name":"Drums","instrument":"drums","volume_db":0,"pan":0,"muted":false,"soloed":false,"loops":[{"id":"l1","name":"Beat","measures":1,"notes":[{"row_id":"kick","step":0,"length_steps":1,"velocity":100}]}],"clips":[{"id":"c1","loop_id":"l1","start_measure":1,"measures":4}]},{"id":"t2","name":"Bass","instrument":"bass","volume_db":0,"pan":0,"muted":false,"soloed":false,"loops":[],"clips":[]}]},"track_id":"t2","prompt":"driving eighth-note bass","range":{"start_measure":1,"end_measure":4}}'
```

Body: `song` (a song document, validated as for song export), `track_id`,
`prompt` (the pattern endpoint's prompt rules), and optional `range`
(`{"start_measure", "end_measure"}`, 1-based and inclusive, from measure 1 to
128 and at most 32 measures). A range may extend past the song's current last
measure, because a song's length follows its clips; measures past the end have
no context from other tracks. Without `range` the whole song is generated, which
a song longer than 32 measures does not allow. The response is
`{"track_id", "range", "notes"}`. The notes use the target instrument's rows and
count `step` from the first step of `range`, so a client can store them as a loop
that starts at the range. Tempo, time signature, swing and key come from the
song; the AI cannot change them.

Errors are those of the pattern endpoint, plus `422 invalid_song` (with the
song-export validation message), `422 invalid_track` (`track_id` is not in the
song) and `422 invalid_range` (outside measures 1-128, longer than 32 measures, or
missing for a song longer than 32 measures). The body limit is 2 MiB.

The provider is shown a text summary of the song, rendered by
`music::context::render_context`: tempo, meter, key (C major when the song has
none), the target's own notes in the measures just outside the range, and every
unmuted track's notes from one measure before the range to one after. Only notes
that clips actually play are included. Drums list the struck rows per measure;
melodic tracks list the pitches sounding on each beat and the lowest one. Track
names are escaped inside the block.

`SONGBIRD_MAX_CONTEXT_TOKENS` (default 4000, 0-32000) caps that summary using
the same estimate as the prompt limit. When it would be exceeded, measures far
from the range are dropped first, then the last tracks in song order; a request
is never rejected for context size. `0` sends no context. A dense 16-track,
32-measure song renders to about 4000 estimated tokens at the default budget.

### `POST /api/v1/songs/chat`

Builds a song one part at a time. The client sends the song and the recent
conversation; the server stores nothing. It makes two provider calls, each under
`SONGBIRD_GENERATION_TIMEOUT_SECS`: a planner call that picks the instrument,
names the track and rewrites the request into a standalone prompt, and then
track generation exactly as above, with every other unmuted track as context.

```sh
curl -s localhost:8080/api/v1/songs/chat \
  -H 'content-type: application/json' \
  -d '{"song":{"version":2,"id":"s1","name":"Late Train","tempo_bpm":96,"time_signature":"4/4","steps_per_measure":16,"swing":0,"measures":4,"tracks":[{"id":"t1","name":"Piano","instrument":"piano","volume_db":0,"pan":0,"muted":false,"soloed":false,"loops":[{"id":"l1","name":"Chords","measures":1,"notes":[{"row_id":"C4","step":0,"length_steps":4,"velocity":100}]}],"clips":[{"id":"c1","loop_id":"l1","start_measure":1,"measures":4}]}]},"messages":[{"role":"user","content":"give me the drums to match"}]}'
```

Body: `song`, `messages` (1-20 `{"role": "user"|"assistant", "content"}` entries,
the last from the user; assistant messages at most 4000 characters) and optional
`range` (`{"start_measure", "end_measure"}`), the song's active loop range. The
last message follows the prompt rules of pattern generation. The response is
`{"reply", "track"}`, where `track` is `null` or
`{"name", "instrument", "range", "notes"}`; `notes` count from the start of
`range`, as for track generation. Ids stay with the client.

The range is chosen in this order. A length the user names ("16 bars", "eight
measures"), which the planner reports as `measures` (1-32), gives measures
1 to that length, extending the song if needed. Otherwise a song in which no
track has a clip gets measures 1-8. Otherwise the whole song is used when it has
at most 32 measures. A longer song uses the supplied `range` if it spans at most
32 measures; otherwise the reply asks the user to turn on looping and draw a
loop region, and no track is added. A planner `measures` outside 1-32 is treated
as not named.
A reply with `track: null` is also returned for questions, and when the song
already has 16 tracks (enforced by the server whatever the planner says).

Every invalid body is rejected with `400` and one of the codes of track
generation (`invalid_song`, `invalid_instrument`, `invalid_prompt`,
`prompt_too_long`, `invalid_range`), or `invalid_request` for a message list that
is empty, over 20 entries, does not end with a user message, or has an assistant
message over 4000 characters. Provider failures are `502 generation_failed` and
`504 generation_timeout`. The planner prompt holds the song's
tracks (and the measures they play in) and the conversation, trimmed oldest
first to `SONGBIRD_MAX_CONTEXT_TOKENS`; the latest message is never trimmed.
With `SONGBIRD_AI_PROVIDER=mock` the planner is keyword based: a number (digits
or words, 1-32) followed by bar(s) or measure(s) is the named length; a question gets a
reply only; `drum` or `beat` gives a Drums track, `piano`, `chord` or `keys` a
Piano track, `bass` a Bass track, and anything else the first melodic
instrument (Piano).

The song document may carry a `chat` array of `{"role", "content", "track_id"?}`
entries (at most 20, each at most 4000 characters), which the Studio saves with
the song; export and generation ignore it.

## Database

The backend is chosen by the scheme of `SONGBIRD_DATABASE_URL`:

| Setting | Meaning |
|---|---|
| unset or blank | SQLite at `./data/songbird.db`, created on first start |
| `sqlite://path/to.db?mode=rwc` | SQLite at that path (`:memory:` is rejected) |
| `postgres://user:password@host:5432/dbname` | Postgres (`postgresql://` also works) |
| `SONGBIRD_DATABASE_MAX_CONNECTIONS` | pool size, 1-100, default 10 |

Any other scheme stops startup with an error naming `SONGBIRD_DATABASE_URL`.
The URL is treated as a secret and never logged; error messages show only the
scheme, host, and database name.

Pending migrations run before the server starts listening. A failed migration,
or a database that has applied a migration this build does not know, stops
startup and names the migration.

SQLite is meant for development and single-user use. It runs in WAL mode with
foreign keys on, and a single writer at a time. If it is used outside
development, `/app/data` (or wherever the file lives) must be on persistent
storage. Production should use Postgres; for a managed server add
`?sslmode=verify-full&sslrootcert=/path/to/ca.pem` to the URL.

To try Postgres locally:

```sh
just dev-pg       # starts Postgres in Docker and prints the URL
export SONGBIRD_DATABASE_URL=postgres://songbird:songbird@localhost:5432/songbird
just dev
```

With `docker compose`, SQLite on the `songbird-data` volume is the default. To
use the bundled Postgres instead, run
`SONGBIRD_COMPOSE_DATABASE_URL=postgres://songbird:songbird@postgres:5432/songbird docker compose --profile postgres up`.
Compose reads that variable rather than `SONGBIRD_DATABASE_URL` because the
`localhost` URL above would point the container at itself.

The SQL conventions that keep one set of queries working on both backends are in
`crates/api/src/db/README.md`.

## Choosing an AI provider

Set `SONGBIRD_AI_PROVIDER`. The service checks the provider at startup and
refuses to start with a message saying how to fix it.

| Provider | Use it for | Needs |
|---|---|---|
| `mock` | Tests, CI, trying the API. Deterministic: picks a built-in groove by genre keyword, else by a stable hash of the request. | Nothing |
| `ollama` | Everyday development, free and local. | A running Ollama with the model pulled |
| `codex` | Judging quality with a stronger model, using your ChatGPT plan. Local only. | Codex CLI, signed in |
| `claude` | Production. | `ANTHROPIC_API_KEY` |

### Ollama

```sh
brew install ollama            # or see https://ollama.com/download
ollama serve                   # leave running
ollama pull qwen2.5:7b-instruct
SONGBIRD_AI_PROVIDER=ollama cargo run -p api
```

Variables: `SONGBIRD_OLLAMA_URL` (default `http://localhost:11434`) and
`SONGBIRD_OLLAMA_MODEL` (default `qwen2.5:7b-instruct`, a 7B instruct model that
fits in 16 GB of RAM). Only the configured URL is contacted.

`qwen2.5:7b-instruct` is the verified tag: `just test-live-ollama` passes with
it and it returns valid 8-measure drums patterns through `POST
/api/v1/patterns/generate`. Expect a slow first request: with the model not yet
loaded, the first generation exceeded the default 60 second limit (504
`generation_timeout`), while later requests took about 15 seconds. Set
`SONGBIRD_GENERATION_TIMEOUT_SECS=180` for local models, or warm the model first
with `ollama run qwen2.5:7b-instruct ""`.

### Codex CLI (ChatGPT plan)

```sh
npm i -g @openai/codex         # or: brew install codex
codex login                    # choose "Sign in with ChatGPT"
SONGBIRD_AI_PROVIDER=codex cargo run -p api
```

Variables: `SONGBIRD_CODEX_BIN` (default `codex`) and optional
`SONGBIRD_CODEX_MODEL`. This provider spends your personal plan quota, so the
service refuses to start unless `SONGBIRD_BIND_ADDR` is a loopback address and
logs a warning even then. Runs are serialized (one `codex` process at a time)
and the child's whole process group is killed if the generation timeout fires
(the npm launcher spawns a native child that would otherwise keep running).
The startup `codex login status` check times out after 10 seconds. It is slower than an
API call because the CLI starts an agent; raise the timeout if needed.

**Flags used** (verified against `codex-cli 0.159.0`; minimum supported
version is 0.159.0, since `--output-schema`, `--output-last-message`,
`--ephemeral` and `--skip-git-repo-check` must exist on `codex exec`):

```
codex exec --skip-git-repo-check --sandbox read-only --ephemeral --color never \
  --output-schema <schema.json> --output-last-message <file> -C <empty temp dir> \
  [-m <model>] -
```

The prompt (system prompt plus description) is written to stdin (`-`). The
final message is read from `--output-last-message`. A manual run with a small
schema returned schema-valid JSON, and the ignored live test
`live_codex_generates_a_valid_pattern` passes end to end. `codex login status`
exits 0 when signed in (`Logged in using ChatGPT`) and non-zero otherwise.

Strict output-schema mode rejects optional properties and unknown keywords, so
the draft schema marks every property required and spells out nullable fields.

### Claude

Set `ANTHROPIC_API_KEY` (required) and optionally `SONGBIRD_AI_MODEL`. The
service forces a tool call whose input schema is the draft schema.

Song track generation and chat, checked manually on 2026-10-01 with the `ollama`
provider (`qwen2.5:7b-instruct`, Ollama's default 4096-token context window,
`SONGBIRD_GENERATION_TIMEOUT_SECS=240`, driven by a script that
timed each `curl`-style request end to end):

- `POST /api/v1/songs/tracks/generate` on a 3-track, 8-measure song (drums and
  piano with notes, an empty bass target, key A minor): `200` in 19.8 s with 48
  bass notes on E1 and A1. The context was 407 estimated tokens (1626
  characters), measured with `render_context`.
- A three-message chat on an 8-measure song, feeding each reply back with a
  client-assigned track, loop and clip: "give me a piano that plays slow jazzy
  chords" 28 s and 49 s in two runs, "give me the drums to match" 183 s, "now
  the bass" 70 s. The planner and generation calls are not timed separately by
  the API; a planner-only request (a question) took 4.6 s with the model
  loaded, so nearly all of each total is generation. The longer runs follow
  from the model writing many lanes: the drums part had 768 notes across ten
  rows, and one earlier run of that same message hit the 240 s limit and
  returned `504 generation_timeout`. Expect to raise
  `SONGBIRD_GENERATION_TIMEOUT_SECS` well above 60 for chat with a 7B model.
- Planner choices were sensible: Piano for the piano request, Drums for "the
  drums to match" and Bass for "now the bass". Track names were "Drums" and
  "Bass", but the piano track was named "Track 2", which is not descriptive;
  the planner prompt could ask for a name that describes the part. The replies were
  accurate but wordy (the bass reply was a full paragraph).
- No planner or draft retries were logged; the only warning was the one timeout.
- Quality: the bass followed the piano's roots (A, F) only loosely, and the
  first bass used a 3-step grid. This is a model limit, not a validity problem,
  because normalization kept every note valid. `just test-live-ollama` also
  passes, but it covers pattern generation only.

## Tests

`just test-backend` needs no key, server or model: Claude and Ollama are tested
against `wiremock`, and Codex against `crates/music/tests/fixtures/fake_codex.sh`.

Each integration test gets its own migrated database: a temporary SQLite file
by default. To run them on Postgres instead, start it with `just dev-pg` and run

```sh
just test-backend-pg
```

which sets `SONGBIRD_TEST_POSTGRES_URL` and creates (then drops) one
`songbird_test_*` database per test. Leftovers older than an hour from a
crashed run are removed on the next run.

Live tests are `#[ignore]`d and never run by `just test`:

```sh
just test-live          # Claude; needs ANTHROPIC_API_KEY
just test-live-ollama   # needs Ollama running with the model pulled
just test-live-codex    # needs a signed-in Codex CLI
```

The draft JSON Schemas are snapshotted in
`crates/music/tests/snapshots/drums_draft_schema.json` and
`piano_draft_schema.json`; regenerate it with
`UPDATE_SNAPSHOTS=1 cargo test -p music --test schema_snapshot` after an
intentional change.

## Adding an instrument

1. Add `crates/music/src/instruments/<name>.rs` with a `pub static` `Instrument`:
   id, display name, MIDI channel, `sustained`, rows (id, name, MIDI note), the
   instrument's system prompt, row aliases, example drafts for the mock
   provider, and an optional fallback-variation hook.
   A melodic instrument instead sets `kind: Melodic`, a `midi_program` and a
   `range`, builds its rows with `pitch_rows(low, high)`, and uses
   `melodic_phrase_end` as its fallback hook (see `instruments/piano.rs`).
2. Register it in `BUILTIN` (`instruments/mod.rs`).
3. Add unit tests mirroring `instruments/drums.rs` (rows and channel, aliases,
   examples normalize, the hook differs from its input).

The pattern format, API, providers, and generated TypeScript types do not change.
After changing any type that derives `ts_rs::TS`, run `just gen-types`.
