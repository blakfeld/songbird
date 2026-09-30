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

`200 {"status":"ok"}`. Calls no external service.

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

## Tests

`just test-backend` needs no key, server or model: Claude and Ollama are tested
against `wiremock`, and Codex against `crates/music/tests/fixtures/fake_codex.sh`.

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
