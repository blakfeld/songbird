# Delegation and context-window hygiene

The main conversation's context window is the scarcest resource in a session. Once it fills with file dumps, test logs, and search noise, quality drops and work gets summarized away. Protect it aggressively by farming work out to subagents in `.claude/agents/`.

## Default to delegating

Before doing any task yourself, ask: "Does this need to live in my context, or only its conclusion?" If only the conclusion, delegate.

| Work | Agent |
|---|---|
| Rust implementation, bug fixes, tests, clippy/compile failures in `backend/` | `rust-developer` |
| Next.js/React/TS implementation, Vitest/Playwright work in `frontend/` | `frontend-developer` |
| Layout, UX flows, visual design, accessibility, styling critique | `ui-designer` |
| Reviewing a diff/branch/files before commit or on request | `code-reviewer` |
| Multi-file investigation, "how does X work", library/docs/web research | `researcher` |

Handle it yourself only when it's genuinely small: a single-fact lookup in a file you already know, a one- or two-line edit, or answering from context you already hold.

## How to delegate well

- **Brief like a colleague who's never seen the conversation.** State the goal, relevant decisions already made, file paths you know, constraints, and what "done" looks like. Agents don't see your context.
- **Ask for distilled output.** Request summaries, `path:line` citations, and decisions — not pasted files or full logs.
- **Parallelize independent work.** Launch independent agents in a single message (e.g. `rust-developer` on the API and `frontend-developer` on the UI once the contract is fixed; `researcher` on two separate questions).
- **Sequence dependent work.** Typical feature flow: `researcher` (if unknowns) → `ui-designer` (if UI) → `rust-developer` / `frontend-developer` → `code-reviewer`.
- **Review after building.** After any non-trivial implementation by an agent, run `code-reviewer` on the result before reporting done.
- **Continue, don't respawn.** Use `SendMessage` to follow up with an agent that already has the relevant context instead of starting a fresh one.
- **Don't duplicate.** Once you've delegated a search or task, don't also do it yourself — wait for the result.

## Protect your own context

- Don't read whole large files when a targeted range or grep will do — or when an agent could read them and summarize.
- Don't run verbose commands (full test suites, builds, `cargo tree`) in the main thread when their output is only needed as pass/fail; have the implementing agent run them and report results.
- Relay agent findings to the user concisely; the user can't see agent reports, but they don't need the raw version either.
