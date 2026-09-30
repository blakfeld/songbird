# Design

## Context

The proposal (see proposal.md, Why) adds a lyric notepad and an AI chat assistant to the song page. The requirements are in `specs/songwriting/lyrics/spec.md`. The existing code constrains the approach in the following ways.

**Providers produce a single structured output from one system and user prompt.**
- `StructuredProvider::generate(&StructuredRequest{system, user, schema, tool_name, tool_description}) -> Value` (`backend/crates/music/src/ai/mod.rs:46-55`) has no notion of multi-turn messages.
- Claude forces a tool call to get schema-shaped JSON, Ollama sends the schema as `format`, and Codex uses strict structured output.
- Every transport is generic over the schema, so a lyrics schema can reuse all three unchanged.

**Pattern generation hard-wires the provider seam to patterns.**
- `PatternProvider` (`ai/mod.rs:59-71`) is implemented by `SchemaProvider<T>` for the three real transports and directly by `MockProvider` (`ai/mock.rs:29`).
- In today's code, `build_provider` returns `Arc<dyn PatternProvider>` (`api/src/provider.rs:12`), and `AppState` holds exactly that one provider (`api/src/state.rs`).
- #8 (`add-section-chord-generation`, archived before this change) replaces that with `build_providers(&Config) -> Providers { patterns, chords }` in `AppState.providers`. Every adapter shares one `Arc` transport, and `check()` runs once per transport. #6 adds no provider trait.

**Other conventions to follow.**
- The retry policy is to retry only unusable output, twice in total (`music/src/generate.rs:7-45`). The timeout is applied in the handler (`api/src/patterns.rs:26-45`). Validation runs before the provider.
- User text is fenced and HTML-escaped (`ai/prompt.rs:12-58`). Token estimation is shared with the browser through `fixtures/token_estimate.json` (`music/src/tokens.rs`).
- Errors use the `{"error":{code,message}}` shape via `ApiError` (`api/src/error.rs`). The body limit is 64 KiB globally. #5 `add-song-export` raises it to 1 MiB for routes under `/api/v1/lyrics/`.
- On the frontend, `isTextEntryTarget` (`frontend/src/lib/pianoRoll.ts:25-32`) already treats `contenteditable` as text entry. Global shortcuts (`components/editor/useEditorShortcuts.ts:25`) therefore stay out of a CodeMirror editor.
- There is no editor library in `frontend/package.json`. UI is hand-rolled Tailwind in `components/ui/`.
- The song document, song store, and `/studio` page come from #4. Sections and section notes come from #7, and key and chords from #8. This design names those pieces generically (the "song store") because their exact file names are set by those changes.

## Goals / Non-Goals

**Goals:**
- Reuse the three real transports and the mock without changing their `generate` signatures.
- Keep the lyrics request bounded by fixed limits so no new configuration setting is needed.
- Put CodeMirror 6 in place now so #10 is only an extension toggle.

**Non-Goals:**
- Streaming, tool use beyond the single structured reply, and server-side conversation memory.
- Song-level undo covering lyric text. The notepad keeps its own history (see D6).

## Decisions

### D1. The conversation is serialized into one fenced user prompt, not native multi-turn messages
The transcript goes into `StructuredRequest.user` as a sequence of `<message role="user|assistant">…</message>` blocks. Each block's content is escaped with the existing `escape_for_fence`, and the blocks are followed by `<lyrics>`, `<selection>`, and `<song>` blocks.

- **Why:** the transport signature stays unchanged, and Codex (a CLI) and Ollama structured mode work without per-provider message mapping.
- **Why escaping matters here:** assistant turns come back from the client, so they are as untrusted as user turns. Escaping them the same way means a forged "assistant" turn cannot break out of the fence.
- **Alternative considered:** add `messages: Vec<Message>` to `StructuredRequest` and map it per provider. That is more faithful for Claude, but it forks three transports and all their tests, and the model can still be steered by forged history. Rejected for this PR.

### D2. Reply schema: `{reply, suggestions[]}` with a closed `action` enum and a per-request `section_id` enum
The schema is built per request, the same way `draft_schema` injects the instrument's row ids (`ai/prompt.rs:62-73`). `section_id` is an enum of the request's section ids, and `action` is an enum of the three actions. It goes through the existing `strictify` so strict Codex mode accepts it.

- **Why:** a constrained decoder then cannot invent section ids.
- **Normalization still applies:** the lenient normalizer in `music::lyrics::normalize` still enforces the spec's rules for Ollama and any model that ignores the enum. That means truncation, dropping invalid suggestions, and assigning ids `s1..s5`.

### D3. A `LyricsProvider` seam added to #8's `Providers` bundle
Add `trait LyricsProvider { async fn assist(&self, &LyricsRequest) -> Result<LyricsDraft, ProviderError>; }` in `music::ai`.

- `SchemaProvider<T>` implements it by building a `StructuredRequest` from `music::lyrics::prompt`. `MockProvider` implements it deterministically (D5).
- `SchemaProvider` already holds `Arc<T>` (from #8), so the lyrics adapter shares the same transport as patterns and chords.
- `Providers` gains `lyrics: Arc<dyn LyricsProvider>`, filled in `build_providers` for every provider choice. No other wiring changes.
- **Alternative considered:** one trait with an enum of tasks. Rejected because it makes each task's input and output types opaque.
- **Ordering:** #8 introduces `Providers`. If this change is implemented before #8 lands, it introduces the bundle with the same shape (`build_providers`, `AppState.providers`, a shared `Arc` transport), and #8 then only adds its `chords` field.

### D4. Fixed limits instead of configuration
The limits are: 20 messages, user messages at most `max_input_tokens` each (existing setting), assistant messages at most 4,000 characters, lyrics at most 20,000 characters, at most 64 sections, notes at most 5,000 characters each, and at most 64 chords per section.

- **Why no new setting:** these limits bound the prompt to roughly 20k characters of lyrics, 20 × 4k characters of history, and 64 × 5k characters of notes. Worst case is about 110k characters, or about 28k estimated tokens, well under the 1 MiB body limit. The common case is under 10k tokens, so a separate context budget setting has nothing to protect.
- **Where the bounds live:** they are constants in `music::lyrics::request` and are mirrored by the frontend in `lib/lyrics/limits.ts`. That is the same shared-rule approach as `estimateTokens`.
- **Consequence:** there is no change to the `platform/service-operations` "Environment-based configuration" requirement. That avoids a MODIFIED collision with #5 and #6.
- **Reply length:** the Claude transport's `DEFAULT_MAX_TOKENS = 4096` (`ai/claude.rs:12`) already covers a 4k-character reply plus five 2k-character suggestions.

### D5. Mock assistant
The mock uses the existing FNV `stable_hash` idea (`ai/mock.rs:14-27`) over the serialized request.

- It picks one of a few canned replies and quotes the last user message's first 60 characters.
- It emits an `insert` suggestion, a `replace_selection` suggestion when the selection is non-empty, and a `replace_section` suggestion for the first section.
- This covers every application path in Vitest and Playwright without a model.

### D6. Frontend: CodeMirror 6 with a thin React wrapper, lyrics outside song-level undo
The pieces are:
- `components/lyrics/LyricsEditor.tsx` creates an `EditorView` in `useEffect`, as a client component loaded with `next/dynamic` and `ssr: false`.
- It keeps the song store in sync through an update listener, debounced about 300 ms, and pushes external replacements, such as a project import, with a full-document transaction.
- Extensions: `history()`, the default keymap, line wrapping, a `ViewPlugin` decoration that styles heading lines and marks unlinked ones, and a `changeFilter` that enforces the 20,000-character cap.
- There is no `@uiw/react-codemirror`: its React peer range lags React 19 releases, and the wrapper is about 60 lines.

How undo is split:
- Lyric text is excluded from the song store's undo/redo history (#4). The editor's own `history()` handles Cmd/Ctrl+Z inside the notepad, because `isTextEditingTarget` already stops the song-level shortcut there.
- Applying a suggestion is one CodeMirror transaction with `userEvent: "input.suggestion"`, so one undo reverts it.

Alternatives considered:
- **Plain `<textarea>`:** simplest, but #10 would have to replace it to get vim bindings.
- **Monaco:** heavy (MBs), and its vim plugin is less maintained.

### D7. Section headings and application logic are pure functions
`lib/lyrics/sections.ts` parses the text into a list of lyric sections of the form `{name, headingLine, bodyFrom, bodyTo}`, matching `^\s*\[([^\]\n]+)\]\s*$`. It also links them to song sections, matching names case-insensitively after trimming.

`lib/lyrics/applySuggestion.ts` turns a suggestion plus the current document, cursor, and request-time selection into a CodeMirror `ChangeSpec` plus an optional notice.
- For `replace_selection`, the chat message stores `{from, to, text}` from send time. The action applies only if `doc.sliceString(from, to) === text`, and otherwise falls back to an insert.
- Mapping the offsets through the edits made since then was considered and rejected. It is more precise, but surprising when the user rewrote the selected text itself.

Both modules are unit-tested without a DOM.

### D8. Chat state lives on the song
The song document gains `lyrics: string` (default `""`) and `lyric_chat: {role, content, selection?, suggestions?}[]` (default `[]`, trimmed to the latest 20 on append).
- Suggestions are stored with the assistant message so they remain applicable after a reload.
- Both fields are declared on the Rust `Song` in `music/src/song.rs` with `#[serde(default, skip_serializing_if = ...)]` and generated to TypeScript. They are also covered by the browser project-file validator and `fixtures/song_validation.json`, under #5's versioning policy (optional fields, song `version` stays 2). Existing browser songs and project files load unchanged. No endpoint receives the whole song with these fields, but declaring them keeps the generated type the single source of truth.

The request's `song_context` is derived from the song store at send time (`lib/lyrics/songContext.ts`). It is not stored.

## Risks / Trade-offs

- **[Risk] Forged assistant turns steer the model.** → Mitigation: all turns are fenced and escaped (D1), output is schema-constrained and normalized (D2), and suggestions never auto-apply. The worst outcome is bad advice in the user's own session.
- **[Risk] Implementation order differs from archive order (#9 before #8).** → Mitigation: D3 specifies the bundle shape both changes use, so whichever lands second adds only its field.
- **[Risk] Small local models (Ollama) produce weak lyrics or ignore section ids.** → Mitigation: the normalizer drops invalid suggestions. The reply prose is still useful, and quality depends on the provider rather than on the contract.
- **[Trade-off] Editor undo is separate from song undo.** Undoing a track edit never touches lyrics, and the reverse also holds. This matches how text fields already behave on the pattern page.
- **[Trade-off] About 150 KB (min) of CodeMirror** is loaded only when the Lyrics panel is opened, using dynamic import.

## Migration Plan

This change is purely additive. Songs saved before it load with empty lyrics and an empty chat. Rollback means reverting the PR: stored songs keep the extra fields, which older code ignores.
