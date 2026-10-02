# Design

## Context

The proposal (see proposal.md, Why) adds an AI lyric assistant beside the existing lyric notepad. The requirements are in `specs/songwriting/lyrics/spec.md`. The existing code constrains the approach in these ways.

**Providers produce a single structured output from one system and user prompt.**
- `StructuredProvider::generate(&StructuredRequest{system, user, schema, tool_name, tool_description}) -> Value` (`backend/crates/music/src/ai/mod.rs:30-39`, `:199-208`) has no notion of multi-turn messages.
- Claude forces a tool call, OpenAI and Codex use strict structured output, and Ollama sends the schema as `format`. Every transport is generic over the schema.
- `impl StructuredProvider for Arc<T>` (`ai/mod.rs:210-225`) lets one transport serve several provider kinds.

**Each AI task is its own provider kind over a shared transport.**
- `PatternProvider` with the `SchemaProvider<T>` adapter (`ai/mod.rs:227-275`) and `MockProvider` (`ai/mock.rs`).
- `PlanProvider`, `SchemaPlanProvider<T>` and `MockPlanProvider`, all in `ai/plan.rs:75-82`, `:233-263`, `:265-273`. `PlanRequest` (`ai/plan.rs:63-73`) carries an already-rendered, escaped `user` prompt plus the plain fields the schema and the mock need.
- `Providers { patterns, plans }` (`api/src/provider.rs:13-19`). `Providers::over(transport)` (`provider.rs:43-53`) is "the single place a new provider kind is added". `Providers::mock()` and `Providers::new` (`provider.rs:21-41`) fill test bundles.

**AI access is resolved per request.**
- `AppState.ai: AiAccess` (`api/src/state.rs:16-29`) is either `Shared(Providers)` or `PerUser(Arc<dyn UserProviders>)` (`api/src/ai_access.rs:30-34`). `build_ai_access` picks the mode at startup (`provider.rs:110-117`).
- The `RequestProviders` extractor (`ai_access.rs:220-278`) signs the user in, loads and decrypts their stored key in per-user mode, and returns a `Providers` bundle plus the provider's display name. Handlers take it before the body, so a user without a key gets `api_key_required` rather than a validation error.
- `RealUserProviders::providers` builds a bundle with `Providers::over` around the user's key (`ai_access.rs:103-118`). `MockUserProviders` returns `Providers::mock()`, or bundles of `Failing` providers for keys ending `-revoked`, `-quota` or `-ratelimited` (`ai_access.rs:146-218`). Playwright runs with `SONGBIRD_AI_PROVIDER=user-mock` (`frontend/playwright.config.ts:42`).
- `api_error_for` (`ai_access.rs:280-298`) maps key failures to `api_key_invalid`, `api_key_quota_exhausted` and `api_key_rate_limited`, and everything else to `generation_failed`.

**Every AI route shares one set of layers.**
- `routes.rs:58-64` merges each module's `ai_router()` into one router, wrapped in `ai_limits::meter` (per-minute window and daily count, `api/src/ai_limits.rs:91-132`) and `limit::shed_when_busy` (shared concurrency budget, `api/src/limit.rs:20-32`). Sign-in and the origin check wrap all protected routes (`routes.rs:66-79`).
- `meter` refunds the daily count when the response carries `NeverReachedProvider` (`ai_limits.rs:121-130`, `api/src/error.rs:236-249`).
- The global body limit is 64 KiB (`routes.rs:20-22`, applied at `:126`). Song routes override it with `SONG_MAX_BODY_BYTES` = 2 MiB, whose comment already says "The lyrics endpoints reuse this limit" (`routes.rs:24-28`, `:62`).
- `with_timeout` (`api/src/patterns.rs:46-64`) applies `config.generation_timeout` and maps errors through `api_error_for`. The pattern, track and chat handlers all use it (`patterns.rs:30-44`, `songs.rs:37-134`).

**The song chat is the closest precedent.**
- Wire types: `ChatMessage {role, content}` (`music/src/chat.rs:33-37`) with `ChatRole` (`music/src/song.rs:141-146`). `MAX_CHAT_MESSAGES = 20` (`chat.rs:22`).
- `ChatBody::validate` (`chat.rs:147-173`) requires 1–20 messages ending with a user message, caps assistant messages at `MAX_CHAT_CONTENT_CHARS` = 4,000 (`song.rs:137`), and checks the latest message with `validate_prompt` (`music/src/request.rs:97-110`). Its errors are 400 `ChatRejected` (`error.rs:34-38`, `:222-234`). Every other validation error is 422.
- `plan_chat` (`chat.rs:197-225`) retries only unusable output, using `generate::ATTEMPTS` = 2 (`music/src/generate.rs:9`, `:19-50`). Transport errors are not retried.
- `render_planner_prompt` (`chat.rs:248-276`) fences each message with `escape_for_fence` and drops the oldest messages until the prompt fits `max_context_tokens`, never dropping the latest.
- Persistence: `Song.chat: Vec<ChatEntry>` (`song.rs:87-92`, `:148-156`), validated in `Song::validate` (`song.rs:854-866`) with `SongErrorKind::Chat`, and mirrored in `frontend/src/lib/song/projectFile.ts:145-160`. The store appends replies with `applyChatResult` (`frontend/src/lib/song/songStore.ts:470-492`), clips entries to 4,000 characters (`:176`), keeps `CHAT_LIMIT` = 20 (`:174`), and uses `set` rather than `edit` so the reply is not an undo step. `withLiveFields` (`frontend/src/lib/song/songLoop.ts:104-119`) makes undo and redo keep the live `chat` and `lyrics`.
- `useChat` (`frontend/src/components/studio/useChat.ts:14-87`) guards against double submits, discards replies for a song that was closed (`loadEpoch`), refreshes key state on key errors, and puts the text back on failure. `AssistantPanel` gates Send with `useAiKeyGate` (`AssistantPanel.tsx:56`).

**Other conventions.**
- User text is fenced and HTML-escaped with `escape_for_fence`, and names with `escape_name` (`music/src/ai/prompt.rs:74-95`). Per-request schemas are built from schemars output and passed through `strictify` (`prompt.rs:97-116`).
- Token estimates are shared with the browser (`music/src/tokens.rs:34-38`, `frontend/src/lib/estimateTokens.ts`). `max_input_tokens` and `max_context_tokens` are existing settings (`api/src/config.rs:268-269`). `GET /api/v1/songs/limits` publishes `max_input_tokens` (`music/src/track_generation.rs:48-66`), and `components/editor/TokenCounter.tsx` renders the count.
- The mock is deterministic through an FNV `stable_hash` (`ai/mock.rs:14-16`).

**The notepad already exists.**
- `components/lyrics/LyricsEditor.tsx` is a CodeMirror 6 view loaded with `next/dynamic` (`LyricsPanel.tsx:7-10`). It is keyed by song id, so every song gets a fresh undo history (`LyricsEditor.tsx:208-211`).
- It has `history()`, a heading `ViewPlugin` (`:31-57`), a `changeFilter` that refuses any change past 20,000 characters and shows the limit notice (`:137-143`), and a 300 ms debounced sync to `setLyrics` (`:19`, `:145-153`). Outside changes to `lyrics` are applied as one full-document transaction unless typing is pending (`:172-182`). A `registerFlush` prop lets the page flush pending typing (`:70-71`, `:159`).
- `lib/lyrics/headings.ts` holds the one heading regex, `isHeadingLine` and `headingLines`. Its comment reserves it for "any later section linking".
- `setLyrics` is not an undo step (`songStore.ts:588-595`).

**Sections and the Studio layout.**
- `Song.sections` holds `Section {id, name, kind, measures, notes}` (`song.rs:98-103`, `:124-131`). Notes are capped at `MAX_SECTION_NOTES_CHARS` = 5,000 (`song.rs:110`). A song has at most 128 measures and each section at least 1, so it has at most 128 sections.
- `sectionsOf(song)` (`frontend/src/lib/songSectionOps.ts:79-82`) returns the real sections or the implicit chunks from `implicitSections` (`frontend/src/lib/song/implicitSections.ts`): ids `implicit`, `implicit-2`, …, names "Song", "Song 2", …, at most 32 measures each. The first section edit replaces every implicit chunk with a real section that keeps its name but gets a fresh id. Section names need not be unique (`renameSection`, `songSectionOps.ts:259-262`).
- The right column has three tabs, Assistant, Lyrics and Section, and renders only the selected panel (`components/studio/RightColumnTabs.tsx:6-15`, `:95`). Below `lg`, the assistant and the lyrics each open in their own drawer (`StudioPage.tsx:119`, `:1071-1082`).
- Chords (#8 `add-section-chord-generation`) have not landed. Sections have no chord data yet.

## Goals / Non-Goals

**Goals:**
- Route the lyric assistant through exactly the same access, limit, timeout and error path as the existing AI endpoints, with no special cases.
- Reuse the transports, `ChatRole`/`ChatMessage`, the retry policy, prompt escaping and trimming, and the song chat's persistence pattern.
- Add no configuration setting and no dependency.

**Non-Goals:**
- Native multi-turn messages in `StructuredRequest`, streaming, and server-side conversation memory.
- Merging the lyric assistant with the song chat. They answer different questions and return different shapes (see D7).
- A second heading parser.

## Decisions

### D1. The conversation is serialized into one fenced user prompt, not native multi-turn messages
`music::lyrics::render_prompt` renders a `<song>` block (name, key, tempo, meter, and one line per section with id, name, kind, measures and chords), a `<notes>` block per section, the conversation as `<message role="user|assistant">…</message>` blocks, then `<lyrics>` and `<selection>` blocks.
- Every piece of client text goes through `escape_for_fence`, and names through `escape_name` (`prompt.rs:74-95`). This is the same rendering as `render_planner_prompt` (`chat.rs:248-276`).
- **Why:** the transport signature stays unchanged, and all four transports work without per-provider message mapping.
- **Why escaping assistant turns matters:** they come back from the client, so they are as untrusted as user turns. Escaping them the same way means a forged "assistant" turn cannot break out of the fence.
- **Alternative considered:** add `messages: Vec<Message>` to `StructuredRequest` and map it per provider. That is more faithful for Claude, but it forks four transports and their tests, and the model can still be steered by forged history. Rejected, as it was for the song chat.

### D2. Reply schema: `{reply, suggestions[]}` with a closed `action` enum and a per-request `section_id` enum
`SchemaLyricsProvider` builds the schema per request from schemars output, sets `section_id` to an enum of the request's section ids and `action` to the three actions, and passes it through `strictify`. That is the same approach as `draft_schema` (`prompt.rs:97-110`) and `plan_schema` (`ai/plan.rs:207`).
- **Why:** a constrained decoder cannot invent section ids, and strict OpenAI and Codex modes accept the schema.
- **Normalization still applies:** `music::lyrics::normalize` enforces the spec's rules for Ollama and any model that ignores the enum. It truncates, drops invalid suggestions, and assigns ids `s1..s5`.

### D3. A `LyricsProvider` kind added to `Providers`, resolved through `RequestProviders`
Add `music/src/ai/lyrics.rs`, shaped like `ai/plan.rs`:
- `trait LyricsProvider { async fn assist(&self, &LyricsRequest) -> Result<LyricsDraft, ProviderError>; async fn check(&self) }`.
- `SchemaLyricsProvider<T>` builds the `StructuredRequest` from `LyricsRequest`.
- `MockLyricsProvider` (D5).
- `LyricsRequest` mirrors `PlanRequest`: the rendered, escaped `user` prompt, plus the section ids, whether there is a non-empty selection, and the latest user message, which the schema and the mock need without parsing prose.

Wire it in `api/src/provider.rs` and `ai_access.rs`:
- `Providers` gains `lyrics: Arc<dyn LyricsProvider>`.
- `Providers::over` adds `SchemaLyricsProvider::new(transport)`. Because `RealUserProviders::providers` and `over_transport` both go through `over`, per-user keys and every shared provider (Claude, Ollama, Codex) get the lyrics adapter on the same `Arc` transport. `check()` still runs once per transport.
- `Providers::mock()` and `Providers::new(patterns, plans)` fill `lyrics` with `MockLyricsProvider`, the way `with_patterns` fills `plans`. A new `Providers::with_lyrics(self, lyrics)` lets tests swap in a fake. **Why:** the 39 existing call sites keep compiling unchanged.
- `Failing` (`ai_access.rs:189-218`) also implements `LyricsProvider`, and `MockUserProviders::providers` puts it in the bundle. **Why:** `-revoked`, `-quota` and `-ratelimited` keys then fail the lyric endpoint the same way, so the e2e key-error flows cover it.
- **Alternative considered:** implement `LyricsProvider` on the existing `SchemaProvider<T>`. Rejected because `plans` set the precedent of one adapter type per kind, and one adapter per kind keeps each kind's prompt and schema in its own module.
- **Alternative considered:** one trait with an enum of tasks. Rejected because it makes each task's input and output types opaque.

### D4. The endpoint follows the existing AI handler exactly
`api/src/lyrics.rs`:
```rust
pub fn ai_router() -> Router<AppState> { Router::new().route("/api/v1/lyrics/assist", post(assist)) }

async fn assist(State(state): State<AppState>, ai: RequestProviders, ApiJson(body): ApiJson<LyricsAssistBody>)
    -> Result<Json<LyricsAssistResponse>, ApiError> {
    let request = body.validate(state.config.max_input_tokens, state.config.max_context_tokens)?;
    let response = with_timeout(state.config.generation_timeout, ai.provider_name,
        assist_lyrics(ai.providers.lyrics.as_ref(), &request)).await?;
    Ok(Json(response))
}
```
- In `routes.rs`, merge `crate::lyrics::ai_router().layer(DefaultBodyLimit::max(SONG_MAX_BODY_BYTES))` into the `ai` router next to `songs::ai_router()` (`routes.rs:60-64`). It then gets sign-in, the origin check, metering, the refund on `NeverReachedProvider`, and load shedding with no new code.
- **Body limit:** 2 MiB, the song limit. The body is a projection of the song (sections, notes, lyrics) plus a bounded history, so it is never larger than the song it came from by more than the history (20 × 4,000 characters). The 64 KiB default would reject a song with long section notes.
- `assist_lyrics` (`music::lyrics`) copies `plan_chat`'s loop: `ATTEMPTS` tries, `InvalidOutput` and an unusable draft retried, other provider errors returned at once. An unusable draft (empty reply after normalization) is a new `DraftError::InvalidLyrics` (`music/src/draft.rs:109-118`), so it reaches clients as `generation_failed` through the existing `GenerationError` path.
- **Errors:** `with_timeout` and `api_error_for` give 504 `generation_timeout`, 502 `generation_failed`, and the key errors, as for every AI route. Validation errors use a new `LyricsRequestError` with `code()`, converted to a new `ApiError::LyricsRejected { code, message }` at 422. A blank or over-long latest message reuses `validate_prompt`, so it surfaces as the existing `ApiError::Validation` (`invalid_prompt` / `prompt_too_long`, 422). Shape errors (unknown role, kind or meter) are caught by `ApiJson` as 400 `invalid_json`.
- **Why 422, not the song chat's 400:** `error.rs:34-36` records 400 as the song chat's exception, and `lib/api.ts:64-71` already shows the server's message for any 422. That means the new codes need no client mapping.

### D5. Fixed request limits, and the prompt trimmed to the existing context budget
Validation (in `music::lyrics`, reusing song constants where they exist):
- At most `MAX_CHAT_MESSAGES` (20) messages, ending with a user message.
- Every message but the last at most `MAX_CHAT_CONTENT_CHARS` (4,000).
- The latest message checked by `validate_prompt` against `max_input_tokens`.
- Lyrics at most `MAX_LYRICS_CHARS`.
- 1–128 sections (`MAX_MEASURES`), each with a unique non-empty id of at most 64 characters, a name of 1–`SECTION_NAME_MAX` characters, 1–32 measures, notes at most `MAX_SECTION_NOTES_CHARS`, and at most 64 chords of at most 16 characters each.
- **Why cap id and chord length:** both are rendered into the untrimmed song lines (and ids into the schema enum), so without a cap only the 2 MiB body limit would bound the part of the prompt that is never trimmed.
- A song name at most `SONG_NAME_MAX`, and the tempo in `MIN_TEMPO_BPM..=MAX_TEMPO_BPM`.
- The selection measured in UTF-16 units.

Details:
- **Why check every earlier message, unlike the song chat:** the saved `lyric_chat` caps entries at 4,000 characters (D6), so a longer earlier message can only come from a client that is not ours. Bounding it keeps the prompt bounded before trimming.
- **Why UTF-16 offsets:** CodeMirror positions and JavaScript string indices are UTF-16. The server counts the same way, as `ai/plan.rs:155` does for track names, so no client conversion is needed. The server slices the selected text out of `lyrics` itself, so the model sees exactly the text the offsets point at.
- **Trimming:** `render_prompt` never trims the song and section lines, the lyrics, the selection, or the latest user message. It fits the rest into `max_context_tokens`: it drops the oldest messages first, as `render_planner_prompt` does, and then section notes from the last section backwards, each replaced by `(notes omitted)`. **Why this order:** the notes describe what the song is for now, while old turns are the least relevant part of the conversation. `max_context_tokens = 0` keeps its documented meaning of "no extra context".
- **Why no new setting:** the untrimmed part is bounded by fixed limits (about 5k tokens of lyrics, at most `max_input_tokens` for the message, and a few thousand tokens of section lines). The trimmed part is bounded by the operator's existing `max_context_tokens`.
- **Reply length:** Claude's `DEFAULT_MAX_TOKENS = 4096` (`ai/claude.rs:17`) covers a 4,000-character reply plus five 2,000-character suggestions, about 3.5k tokens.
- **Mirrored on the client:** the client mirrors only what the UI enforces: `max_input_tokens` via `getSongLimits`, the 20-message window, and the 4,000-character clip. The server stays authoritative for the rest.

### D6. `lyric_chat` is a new Song field, following `chat`
Add `Song.lyric_chat: Vec<LyricChatEntry>` with `#[serde(default, skip_serializing_if = "Vec::is_empty")]` and `#[ts(as = "Option<Vec<LyricChatEntry>>", optional)]`, exactly like `chat` (`song.rs:87-92`).
- `LyricChatEntry { role: ChatRole, content, selection?: {from, to, text}, suggestions?: StoredLyricSuggestion[] }`.
- `StoredLyricSuggestion` is the wire suggestion plus `section_name`, the section's name when the reply arrived (see D8).
- `selection` sits on the assistant entry, as the selection its suggestions target. **Why:** trimming to 20 entries can drop a reply's user message but never separates a reply from its own suggestions.

Validation:
- `Song::validate` gains a `SongErrorKind::LyricChat` check: at most `MAX_CHAT_ENTRIES` entries, content at most `MAX_CHAT_CONTENT_CHARS`, at most 5 suggestions of at most 2,000 characters with labels of at most 80, selection text at most `MAX_LYRICS_CHARS`, and section names at most `SECTION_NAME_MAX`.
- `projectFile.ts` and `fixtures/song_validation.json` mirror this, under the existing versioning policy (optional field, song `version` stays 2).

How it reuses the `chat` precedent:
- The store gets `applyLyricReply(userMessage, selection, response, sectionNames)` and `clearLyricChat()`. Both use `set`, not `edit`, like `applyChatResult` (`songStore.ts:470-492`) and `setLyrics` (`:588-595`), so neither is an undo step. They clip content to 4,000 characters and keep the latest 20 entries. Empty `lyric_chat` is omitted, like empty `lyrics`.
- `withLiveFields` (`songLoop.ts:104-119`) adds `"lyric_chat"` to its key list, so song undo and redo keep the live conversation.
- Autosave already sends the whole song, so the conversation is stored server-side with the project and in project files with no new code path.

**Why a separate field rather than more entries in `chat`:**
- The shapes differ: suggestions and selection versus `track_id`.
- Mixing them would send lyric turns to the song planner, and arrangement turns to the lyric assistant, as history neither can act on.
- Each panel clears and trims its own conversation.

### D7. Where the lyric chat differs from the song chat, and why
| | Song chat | Lyric chat | Why |
|---|---|---|---|
| Body | whole `Song` | `song_context` from `sectionsOf` | Implicit sections exist only in TypeScript (`implicitSections.ts`), and the assistant needs no tracks. |
| Provider calls | planner, then generation | one | There is no second artifact to generate. |
| Validation status | 400 `ChatRejected` | 422 | See D4. |
| Earlier messages | assistant length only | all lengths | See D5. |
| Saved entry | `{role, content, track_id?}` | `{role, content, selection?, suggestions?}` | See D6. |
| Clear | none | "Clear conversation" | A lyric conversation is scoped to a writing session and its suggestions go stale. |
| Token counter | none | shown | The spec asks for it, and `TokenCounter` already exists. |

Everything else is the same: `ChatRole`/`ChatMessage`, the 20-message window, the 4,000-character entries, history trimming, `RequestProviders`, the limits, `with_timeout`, and the stale-reply and key-gate behavior of `useChat`.

### D8. Section linking and application are pure functions over the existing heading parser
- Extend `lib/lyrics/headings.ts` rather than adding a parser:
  - Give `HEADING` a capture group.
  - Add `headingName(line)`.
  - Add `lyricSections(text) -> {name, headingFrom, bodyFrom, bodyTo}[]`, with offsets as JavaScript string indices so they equal CodeMirror positions.
  - The decoration keeps using `isHeadingLine`.
- `lib/lyrics/sectionLinks.ts`:
  - `linkKey(name) = name.trim().toLowerCase()`.
  - `linkedSections(text, sections)`.
  - `missingHeadings(text, sections)` for "Add section headings". It skips names already present and dedupes by key.
  - All of them take `sectionsOf(song)`, so implicit chunks link by their names, "Song", "Song 2" and so on. **Why by name:** names are what the user typed in brackets, and materialization keeps names but changes ids, so linking survives it with no extra work. Same-named sections share one heading. That matches how a repeated chorus is written once.
- `lib/lyrics/applySuggestion.ts` turns a stored suggestion plus the document, cursor, focus state, and current `sectionsOf(song)` into a CodeMirror change spec and an optional notice.
  - `replace_section`: look the section up by `section_id` in the current sections and use its current name. If it is gone (deleted, or an implicit chunk that became real), use the stored `section_name`. Then take the first heading with that key, or append `\n[Name]\n<text>`. **Why id first, then name:** a rename after the reply still targets the right section, and an implicit id that no longer exists still resolves through its kept name.
  - `replace_selection`: apply only if `doc.sliceString(from, to) === text` from the stored selection, and otherwise insert at the cursor with a notice. Mapping the offsets through later edits was considered and rejected. It is more precise, but surprising when the user rewrote the selected text itself.
- `lib/lyrics/songContext.ts` builds `song_context` from `sectionsOf(song)`, sending implicit ids as they are, and `chords: []` until #8 provides chord data.
- All four modules are unit-tested without a DOM.

### D9. Frontend placement and the editor handle
- **Placement:** the lyric chat sits in `LyricsPanel`, below the notepad. The notepad keeps `flex-1`, and the chat gets a resizable height stored with `useStoredHeight`, as the Studio dock does (`StudioPage.tsx:133`). The drawer renders the same `LyricsPanel`, so narrow screens get the same stack.
  - **Why not the Assistant tab:** suggestions apply through the live `EditorView`, and `RightColumnTabs` mounts only the selected panel (`RightColumnTabs.tsx:95`). In another tab the editor would not exist when the user clicks Apply. Keeping the chat beside the text it edits also keeps the two chats visibly separate.
  - **Why stacked, not side by side:** the right column is too narrow for two panes.
- **Editor handle:** `LyricsEditor` gains a `registerEditor` prop, shaped like `registerFlush`. It exposes:
  - `snapshot()`, which returns the current document, the main selection, the cursor, and whether the editor has had focus.
  - `apply(spec, notice?)`, which dispatches one transaction with `userEvent: "input.suggestion"` and scrolls it into view.
  - **Why read lyrics from the editor:** the debounced sync (`LyricsEditor.tsx:145-153`) can lag the store by 300 ms, and the selection offsets must match the exact text sent.
  - **Why `apply` needs no limit check of its own:** the existing `changeFilter` (`:137-143`) refuses an application past 20,000 characters and shows the existing limit notice, and the existing update listener syncs an accepted one to the store and autosave.
- **Unlinked marker:** the heading plugin reads the current section keys from a `Compartment`. `LyricsPanel` reconfigures it when `sectionsOf(song)` names change, so renames relink without rebuilding the editor or losing its undo history.
- **"Add section headings":** a button in the `LyricsPanel` header. It applies `missingHeadings` through the same handle as one transaction, so one notepad undo reverts it.
- **Chat logic:** `components/lyrics/useLyricChat.ts` copies `useChat`'s guards: `inFlight`, the `loadEpoch` stale check, `refresh()` on key errors, and the put-back on failure. It calls `assistLyrics` in `lib/api.ts`. `LyricChatPanel` and `SuggestionCard` reuse `useAiKeyGate`, `ErrorAlert`, `TokenCounter` and `isSubmitEnter`.

### D10. Mock assistant
`MockLyricsProvider` hashes the rendered request with the same FNV approach as `ai/mock.rs:14-16`.
- It picks one of a few canned replies and quotes the first 60 characters of the latest user message.
- It always emits an `insert` suggestion, a `replace_selection` suggestion when the selection is non-empty, and a `replace_section` suggestion for the first section id.
- **Why:** this covers every application path in Vitest and Playwright without a model. Because `Providers::mock()` includes it, `user-mock` e2e runs get it with no setup.

## Risks / Trade-offs

- **[Risk] Forged assistant turns steer the model.** → Mitigation: all turns are fenced and escaped (D1), output is schema-constrained and normalized (D2), and suggestions never auto-apply. The worst outcome is bad advice in the user's own session, paid for by the user's own key in per-user mode.
- **[Risk] Saved selections enlarge the song.** Each reply can store its selection text, up to 20,000 characters. → Mitigation: the window holds 20 entries and selections are usually a few lines. In the worst case the existing 2 MiB body limit and the project storage limit refuse the save with `payload_too_large` or `project_limit`, and clearing the conversation fixes it.
- **[Risk] Small local models (Ollama) produce weak lyrics or ignore section ids.** → Mitigation: the normalizer drops invalid suggestions. The reply prose is still useful, and quality depends on the provider rather than on the contract.
- **[Risk] Notes are trimmed on songs with many long notes.** → Mitigation: trimming is deterministic and from the end of the song. Operators can raise `max_context_tokens` (up to 32,000).
- **[Trade-off] Two chats on one page.** Users may ask the lyric assistant for a track. → It answers in prose only. The panels are in different tabs with different titles.
- **[Trade-off] Lyric chat turns count against the same per-minute and daily AI limits as track generation.** This is deliberate: the budgets protect the provider and the user's key, not a feature.

## Migration Plan

This change is purely additive.
- Songs saved before it load with an empty lyric conversation, and songs without one serialize unchanged.
- Rollback means reverting the PR. An older server's `Song` drops the unknown `lyric_chat` field on the next save, as serde ignores unknown fields by default. Only the lyric conversation of songs edited after a rollback is lost. Lyrics and the song chat are unaffected.

## Open Questions

These can be settled during implementation without changing the specs or the task breakdown.
- **Error wording:** `ApiError::GenerationFailed` says "could not produce a valid pattern" (`error.rs:54`), and the client maps `generation_failed` to "The AI could not generate a pattern" (`frontend/src/lib/api.ts:35`). The song chat already shows this wording. Should both become provider-neutral ("could not produce a valid response") for all AI routes? This is a wording change only, so it does not affect the lyric spec.
- **Split height:** the default and minimum heights of the chat under the notepad in the Lyrics tab and drawer. This is left to the `ui-designer` review in task 5.4.
