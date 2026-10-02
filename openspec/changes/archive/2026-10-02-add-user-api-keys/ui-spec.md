# UI spec: AI keys settings, AI key gate, key error actions

Task 8.1 of `add-user-api-keys`. Implements D10 and the spec requirements "AI keys settings page" and "AI actions need a key in the UI". Everything here reuses existing primitives: `Button`, `Field`, `Spinner`, `ModalDialog`, `ErrorAlert`, `Menu`/`menuItemClass`, and `focusRing`/`inputClass`/`labelClass`/`hintClass` from `components/ui/classes.ts`. It adds no new colour tokens. Amber is already used for warnings (`SongFileActions.tsx:177`), and emerald for success badges.

Provider display names: `anthropic` is "Anthropic" and `openai` is "OpenAI". Put them in one `PROVIDER_LABEL` map and use it everywhere below as `{Provider}`.

---

## 1. `/settings/ai-keys` page

Files: `app/settings/ai-keys/page.tsx` (server component that exports `metadata = { title: "AI keys" }`) and `components/settings/AiKeysPage.tsx` (client component).

### Layout

The page shell copies `PatternEditorPage.tsx:96-110`: the same `<main>` classes, but the width is capped at `max-w-2xl` because this is a form page and long lines are hard to read. It has the same breadcrumb, `h1`, and `AccountMenu` at the top right.

```
Songbird ›                                         [B user@x ▾]
AI keys
Songbird uses your own Anthropic or OpenAI key for AI features.
Keys are stored encrypted and never shown again in full.

[ notice: shared dev provider ]          (only when keys_required = false)
[ ← Back to Drum Machine ]               (only when ?next= is valid)

┌ Card ───────────────────────────────────────────────────────┐
│ Anthropic                         ● Set ••••abcd   [Active] │
│ Updated 3 days ago                                          │
│                                   [Replace]  [Remove]       │
│ ─ (expanded on Set/Replace) ─────────────────────────────── │
│ Anthropic API key                                           │
│ [••••••••••••••••••••••••••••••••]                          │
│ Starts with sk-ant-. We check it with Anthropic before      │
│ saving.                                                     │
│ [ErrorAlert, if any]                                        │
│                                     [Cancel] [Save key]     │
├─────────────────────────────────────────────────────────────┤
│ OpenAI                                          ○ Not set   │
│                                                 [Set key]   │
└─────────────────────────────────────────────────────────────┘

┌ Card (only when both keys exist) ───────────────────────────┐
│ Provider for AI features                                    │
│ (•) Anthropic   ( ) OpenAI                                  │
│ Only this provider is used. Songbird never switches to the  │
│ other key on its own.                                       │
└─────────────────────────────────────────────────────────────┘

[ role=status live region, visually hidden or under the card ]
```

- **Card:** `rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950`, the same as `PromptForm`. Render it as a `<ul aria-label="AI providers">` with `divide-y divide-zinc-200 dark:divide-zinc-800`, and give each `<li>` the classes `p-4 sm:p-6`.
- **Row header:** `flex flex-wrap items-start justify-between gap-x-4 gap-y-2`. On the left is the provider name, an `h2` with `text-base font-semibold` and `id` set to the row's labelling id. Under it, when a key is set, is `Updated {formatRelativeTime(updated_at)}` in `hintClass`. On the right is the status, followed by the actions.
- **Status:** use text, not just a dot, so colour never carries the meaning on its own.
  - Not set: `<p className="text-sm text-zinc-600 dark:text-zinc-400">Not set</p>`
  - Set: `<p className="text-sm">Set <span className="font-mono tabular-nums">••••{last4}</span></p>`. Add `<span className="sr-only">, ending in {last4 spaced out}</span>`, because screen readers read "••••" as "bullet bullet…". Hide the bullets with `aria-hidden` and spell the characters with spaces (for example "a b c d").
  - Active badge, shown only when both keys exist: `rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-950 dark:bg-emerald-900/50 dark:text-emerald-200`, with the text "Active". The word itself carries the meaning, so the colour is extra.
- **Actions:** `flex gap-2`, using `Button` (secondary) with `className="!py-1"`, the compact size `ErrorAlert` uses.
  - No key: **Set key**
  - Key set: **Replace** and **Remove**
  - Give each button an `aria-describedby` that points at the row's `h2`, or use labels like `aria-label="Replace Anthropic key"`, so a screen reader announces which of the two rows the button belongs to.
- **Mobile:** the row header wraps, so the actions drop under the status. Nothing scrolls horizontally because there are no fixed widths, the input is `w-full`, and long `last4` text is impossible.

### Key entry (Set or Replace)

Pressing Set or Replace expands an inline `<form>` inside the row. Only one form is open at a time, so opening another row's form closes the first and clears its value. Focus moves to the input when the form opens.

```tsx
<form onSubmit={save} aria-busy={saving} aria-labelledby={rowTitleId} className="mt-4 flex flex-col gap-3">
  <Field label={`${Provider} API key`} htmlFor={inputId} hint={hint} hintId={hintId}>
    <input
      id={inputId} type="password" name={`${provider}-api-key`}
      autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
      data-1p-ignore data-lpignore="true"   // password managers would offer to save it as a site login
      required readOnly={saving}
      aria-invalid={error !== null} aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      value={value} onChange={(e) => setValue(e.target.value)}
      className={`${inputClass} w-full font-mono`}
    />
  </Field>
  {error && <div id={errorId}><ErrorAlert message={error} onDismiss={() => setError(null)} /></div>}
  <div className="flex justify-end gap-2">
    <Button onClick={cancel} disabled={saving}>Cancel</Button>
    <Button type="submit" variant="primary" disabled={saving || value.trim() === ""}>
      {saving && <Spinner />}{saving ? "Checking key…" : "Save key"}
    </Button>
  </div>
</form>
```

- `value` lives in `useState` only. Clear it with `setValue("")` in `finally`, so it is cleared after a success and after a failure (task 8.5).
- **Hint text:**
  - Anthropic: "Starts with `sk-ant-`. Songbird checks it with Anthropic before saving."
  - OpenAI: "Starts with `sk-`. Songbird checks it with OpenAI before saving."
  - In Replace mode, append: "Your current key stays in place unless the new one passes the check."
- **Pending:** the live check can take up to 10 seconds, so the button reads "Checking key…" rather than "Saving…". The input is `readOnly`, not `disabled`, so it keeps focus and is still announced.
- **On success:** the form collapses and the row shows its new status. Move focus to the row's Replace button, because the Set button that had focus no longer exists. Announce one of these in the page live region (`<p role="status" className="sr-only">`):
  - Set: "Anthropic key saved, ending in a b c d."
  - Replace: "Anthropic key replaced, ending in a b c d."
  - If this save made the provider active (it was the first key): add "Anthropic is now used for AI features."
- **On error:** the form stays open with an empty input. Focus returns to the input, and the `ErrorAlert` announces the error through `role="alert"`. Clear the error before each submit, so a repeated failure is announced again (the same pattern as `LoginForm.tsx:58`).
- **Cancel or Escape** in the input collapses the form, clears the value, and returns focus to the button that opened it.

### Save error copy (shown in the row's ErrorAlert)

| Code | Copy |
|---|---|
| `invalid_api_key_format` | Anthropic: "That doesn't look like an Anthropic key. Anthropic keys start with sk-ant- and contain only letters, numbers, - and _." OpenAI: "That doesn't look like an OpenAI key. OpenAI keys start with sk-. Anthropic keys (sk-ant-) go in the Anthropic row." |
| `api_key_rejected` | "{Provider} rejected this key. Check that you copied all of it and that it hasn't been revoked." |
| `provider_unreachable` | "Couldn't reach {Provider} to check the key. Nothing was saved. Try again in a moment." |
| `too_many_requests` | "Too many key checks. Try again in {n} minutes." Calculate `n` from `retryAfterMs` and round up. If it is missing, use "Try again later." |
| `api_keys_unavailable` | "Key management is turned off on this server." (In practice this code is shown at the page level; see below.) |
| network or other | Use `ApiError.message` from `lib/api.ts`. |

These are page-local strings keyed by code and provider, because the copy needs the provider name. The `USER_MESSAGES` entries in `lib/api.ts` stay as the generic fallback.

### Remove (confirm step)

Use the app's existing confirm pattern: `ModalDialog role="alertdialog"`, copied from `RemoveSampleDialog.tsx`. Do not use `window.confirm`.

- Title: "Remove your {Provider} key?"
- Body, depending on the user's keys:
  - This is the active provider and the other key exists: "Songbird will switch to {Other} for AI features."
  - This is the only key and `keys_required` is true: "AI features (Generate, track generation, and the assistant) will be turned off until you add a key."
  - Otherwise: "You can add it again at any time."
- Buttons: **Cancel** (`autoFocus`, because it is the safe default) and **Remove key**, which uses the same red classes as `RemoveSampleDialog.tsx:85`.
- Pending: the Remove button shows `<Spinner />` with "Removing…", and both buttons are disabled. On success, close the dialog and return focus to the row's Set key button. The live region announces "{Provider} key removed." and adds " {Other} is now used for AI features." if the provider switched.
- Error: keep the dialog open and show an `ErrorAlert` inside it with `ApiError.message`.

### Active-provider radio group

Show it only when `keys.length === 2`, as a second card below the providers card.

```tsx
<fieldset className="flex flex-col gap-2 p-4 sm:p-6" disabled={switching}>
  <legend className={labelClass}>Provider for AI features</legend>   {/* legend sits inside the padded card */}
  <div className="flex flex-wrap gap-x-6 gap-y-2">
    {/* radio markup as in TrackGenerateDialog.tsx:96-108: label.flex.items-center.gap-2.text-sm > input.size-4.focusRing */}
  </div>
  <p className={hintClass}>Only this provider is used. Songbird never switches to the other key on its own.</p>
</fieldset>
```

- Selecting an option calls `setAiProvider` straight away, with no Save button. Show the change optimistically and roll back if the call fails.
- While switching, a `<Spinner />` appears next to the chosen label. The live region then announces "OpenAI is now used for AI features."
- On error, show an `ErrorAlert` under the group with `ApiError.message`, revert the selection, and keep focus on the radio.
- The "why" in the hint comes from design A2: the user should know that a failing key is never silently swapped for the other one.

### Page-level states

| State | UI |
|---|---|
| Loading the summary | Inside the card: `<p role="status" className="flex items-center gap-2 p-6 text-sm text-zinc-600 dark:text-zinc-400"><Spinner />Loading your keys…</p>` |
| Load failed (network or 5xx) | `<ErrorAlert message="Couldn't load your AI keys." onRetry={refresh} />`. Don't render the card. |
| `keys_required: false` | An amber notice above the card, followed by the normal card, because keys can still be managed (A9). |
| `503 api_keys_unavailable` on load | Show the same amber notice with different text, and no card. |

The amber notice is a plain block. Don't use `role="alert"`, because it isn't an error and shouldn't interrupt:
`rounded-lg border border-amber-600/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200`

- `keys_required: false`: "This server uses a shared development provider, so AI features work without your own key. Keys you save here aren't used on this server."
- `api_keys_unavailable`: "This server uses a shared development provider, and key management is turned off. AI features work without a key."

Check the contrast in both themes. amber-900 on amber-50 and amber-200 on amber-950 both pass AA comfortably.

### Return path (recommended)

Gate notices and error links point to `/settings/ai-keys?next=<current path>`. Read `next` with the existing `safeReturnTarget` (`lib/auth/returnTarget.ts`). When it is valid, show a link under the breadcrumb that says "← Back to {where}". Use "Back" if the path can't be named. After the first successful save, the live region and the link stay where they are, so the user can go straight back to what they were doing. Without this, a user who followed a gate link from the Studio has to find their way back by hand.

---

## 2. `AiKeyGate` and the inline notice

File: `components/ai/AiKeyGate.tsx`. Use a render prop, so each call site keeps control of its layout and its `canSubmit` logic:

```tsx
<AiKeyGate>
  {({ blocked, noticeId, notice }) => /* caller places `notice` and ORs `blocked` into its submit guard */}
</AiKeyGate>
```

- `blocked = keysRequired && activeProvider === null`. It is `false` while the summary is loading, when the load failed, and on `api_keys_unavailable`. Failing open avoids flashing a notice at users who do have keys, and the server's `409 api_key_required` together with the ErrorAlert link (§3) remains the backstop.
- When `blocked` is false, `notice` is `null` and `noticeId` is `undefined`.

### Notice component (`AiKeyNotice`)

```tsx
<p id={noticeId} className="text-sm text-zinc-700 dark:text-zinc-300">
  Add an Anthropic or OpenAI key to use AI features.{" "}
  <Link href={settingsHref} className={`font-medium underline underline-offset-2 ${focusRing} rounded-sm`}>
    Add a key
  </Link>
</p>
```

- Don't use a glyph, because the meaning is in the text. If the team wants an icon later, use an inline SVG with `aria-hidden`.
- The tone is neutral zinc, not red or amber, because this is a setup step and not an error.
- Use the compact copy "Add an Anthropic or OpenAI key to use AI features." in all three places, so the message is learned once.

### Placement per control

| Control | Notice position | Control state |
|---|---|---|
| `PromptForm` Generate (`PromptForm.tsx:174`) | A full-width row directly above the button row, inside the form. On `sm+`, the button stays right-aligned. | The textarea, measures, tempo, and time signature stay enabled, so the user can draft the groove now and generate after adding a key. |
| `TrackGenerateDialog` Generate (`TrackGenerateDialog.tsx:186`) | Directly above the footer `flex justify-end gap-2` row. | The prompt and range stay enabled. Cancel stays enabled. |
| `AssistantPanel` send (`AssistantPanel.tsx:152`) | Above the form, inside its top border: `px-3 pt-3` in the same slot the `chat.error` alert uses, and rendered before it. Also replace the empty-state paragraph's `aria-describedby` target with the notice when blocked. | The textarea stays enabled. Send is disabled. |

### Disabled behaviour and accessibility

- **Submit button:** use native `disabled`, which matches every other submit in the app (`canSubmit`). It also blocks implicit form submission, and the Enter handlers already go through `requestSubmit()` and the `canSubmit`/`blocked` guard. Add `blocked` to those guards: `canSubmit` in `PromptForm` and `GenerateForm`, and `blocked` in `AssistantPanel`. This matters most in `AssistantPanel.submit`, which clears the draft before sending.
- **Discoverability:** a disabled button is skipped in the tab order, so the reason has to be reachable another way.
  1. In DOM order, the notice and its link come before the disabled button, so keyboard users Tab into the link on their way to the button.
  2. Add `noticeId` to the `aria-describedby` of the prompt textarea in each form, after the existing ids. Screen reader users then hear the reason as soon as they enter the field, which is where they start.
  3. Also put `aria-describedby={noticeId}` on the button, for screen readers that expose disabled controls in browse mode.
- Don't use `aria-disabled` here. Most of the app uses native `disabled` for submits. Only menu items use `aria-disabled`, where removing the item from the roving focus would be wrong. Mixing the two would make the guard logic inconsistent.
- **Becoming blocked mid-session** (key removed in another tab, then `refresh()`): the notice appears without a live announcement, because the ErrorAlert from §3 has already announced the cause. If focus was on the button that just became disabled, move it to the notice link, so focus isn't lost to `<body>`.
- **Becoming unblocked** after the user returns with a key: no announcement is needed, because the button is simply enabled.

---

## 3. `ErrorAlert` `action` link

Add a prop:

```ts
action?: { href: string; label: string };
```

It renders as a Next `Link` after the message text and before Retry and dismiss, in the existing flex row:

```tsx
<p className="min-w-0 flex-1">{message}</p>
{action && (
  <Link href={action.href} className={`shrink-0 self-center rounded-sm font-medium underline underline-offset-2 ${focusRing}`}>
    {action.label}
  </Link>
)}
```

- The link inherits the red text colour (red-700 or red-300), which already passes AA on the alert background. The underline marks it as a link without relying on colour.
- `role="alert"` stays on the container, so the message and the link text are announced together.
- On narrow screens the row is `flex items-start`. Add `flex-wrap` to the container and `basis-full sm:basis-auto` to the link, so a long message plus the link wraps instead of overflowing.

Add a helper, `keyErrorAction(code, returnTo?)`, in `lib/api.ts` or next to `AiKeyGate`. It returns an action or `undefined`:

| Code | Message | Action label |
|---|---|---|
| `api_key_required` | `USER_MESSAGES`: "AI features need your own Anthropic or OpenAI key." | "Add a key" |
| `api_key_invalid` | The server message (readable, names the provider) | "Replace key" |
| `api_key_quota_exhausted` | The server message (names the provider, mentions billing) | "Manage keys" |
| `api_key_rate_limited` | The server message. If `retryAfterMs` is present, append " Try again in {n} seconds." | none |

Call sites need the error **code**, not only the message:
- `PromptForm` already catches `ApiError`.
- `useChat` exposes `chat.error` as a string. Expose the code next to it, or pass the `action` down.
- `useTrackGeneration` passes `initialError` to `TrackGenerateDialog` as a string. Widen it to `{ message, action? }`. This is required by the "Revoked key during generation" scenario, which needs the "Replace key" link inside the dialog.

`PromptForm` appends " Your current pattern is unchanged." to errors. Keep doing that for key errors too, because it reassures the user that their pattern is safe.

---

## 4. User menu link

In `AccountMenu.tsx`, add a menu item between the "Signed in as" block and the separator above "Log out":

```
Signed in as
user@example.com
───────────────
AI keys            ← new
───────────────
Log out
```

```tsx
<Link href="/settings/ai-keys" role="menuitem" className={menuItemClass} onClick={close}>
  AI keys
</Link>
```

- Use the `close` argument from `Menu`'s children render prop, so the panel isn't left open while the client navigates.
- `useMenuBehavior` already includes `[role^="menuitem"]` in arrow-key navigation, so the link becomes the first focused item when the menu opens.
- Use the label "AI keys", which matches the page `h1`. Don't add status text to the menu, because it would need the summary loaded everywhere the menu appears.
- When the current path is `/settings/ai-keys`, add `aria-current="page"` to the item.
- **Navigating away from the Studio:** the breadcrumb "Songbird" link already does this, so it is no regression. Still, confirm that the song autosave flushes on route change in the same way.

---

## Test hooks (for 8.4 and 8.5)

- Query the gate notice with `getByRole("link", { name: "Add a key" })`. Check the disabled submit with `toBeDisabled()` and its description with `toHaveAccessibleDescription(/Anthropic or OpenAI key/)`.
- Find the settings input by its label, "Anthropic API key". After a save, `toHaveValue("")`.
- Masked suffix: the row text includes `••••abcd`, and its accessible name includes "ending in a b c d".
