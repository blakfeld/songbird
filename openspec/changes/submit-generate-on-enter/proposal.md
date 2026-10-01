# Proposal

## Why

In the Studio's "Generate part with AI" dialog, focus starts in the prompt box, which is a multi-line textarea, so pressing Enter adds a new line instead of generating. The user has to reach for the mouse or tab to the Generate button. The song chat already sends on Enter and adds a new line on Shift+Enter, so the two prompt boxes in the same page behave differently.

## What Changes

- **Enter generates.** Pressing Enter in the prompt field submits the dialog, exactly as if Generate were clicked, with the same checks: an empty prompt, an over-limit prompt, generation limits not loaded yet, and an invalid custom range all keep it from submitting, and Enter then does nothing.
- **Shift+Enter adds a new line**, so multi-line prompts are still possible.
- **No early submit while typing with an input method.** Enter that confirms an IME composition, such as Japanese or Chinese input, doesn't submit.
- The measure fields already submit on Enter through the browser's standard form behavior. This change keeps that and covers it with tests.
- A hint under the prompt field reads "Enter to generate · Shift+Enter for a new line".

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `songs/track-generation`: adds keyboard submission rules for the Studio generate form.

## Impact

- `frontend/src/components/studio/TrackGenerateDialog.tsx`: an `onKeyDown` on the prompt textarea that mirrors `AssistantPanel.tsx:131-133`, plus the hint text.
- `frontend/src/components/studio/StudioPage.generate.test.tsx`: new keyboard cases.
- No backend change. The single-instrument editor's `PromptForm` is out of scope.
