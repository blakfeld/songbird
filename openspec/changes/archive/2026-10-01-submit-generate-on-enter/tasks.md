# Tasks

## 1. Enter submits the generate form

- [x] 1.1 In `frontend/src/components/studio/TrackGenerateDialog.tsx`, add an `onKeyDown` to the prompt textarea. On Enter, when neither Shift nor IME composition (`e.nativeEvent.isComposing`) is active, it calls `preventDefault()` and then `e.currentTarget.form?.requestSubmit()`. This mirrors `AssistantPanel.tsx:131-133`, so the existing `submit` handler's `canSubmit` guard still decides. Add the hint "Enter to generate · Shift+Enter for a new line" and include its id in the textarea's `aria-describedby`, next to `prompt-token-count`. Verify with new `StudioPage.generate.test.tsx` cases for each scenario: Enter generates, Shift+Enter adds a line, Enter on an empty prompt, Enter with an invalid range, and IME composition (simulated with a `keydown` whose `isComposing` is true). Add a case where Enter in the "To measure" field submits.
- [x] 1.2 Treat Enter with `keyCode === 229` as IME composition too (Safari) in both `TrackGenerateDialog` and `AssistantPanel`, with tests for each.
- [x] 1.3 Give `TokenCounter` an `id` prop and pass a `useId`-derived id from every caller, so `aria-describedby` targets are unique.
- [x] 1.4 Run `pnpm lint`, `tsc`, and the Vitest suite in `frontend/`, then run `code-reviewer` on the diff. Verify that everything is green and the review findings are resolved.
