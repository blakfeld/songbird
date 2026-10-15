"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { inputClass } from "@/components/ui/classes";
import { ApiError } from "@/lib/api";
import { setUsername, type AuthUser } from "@/lib/auth/client";
import { checkUsername, normalizeUsername } from "@/lib/auth/usernameRules";

const FALLBACK_FAILURE = "Something went wrong. Please try again.";

// Shared by the Profile page and the listen page, so the rules and messages cannot drift between them.
export function UsernameForm({
  initial = "",
  submitLabel = "Save username",
  onSaved,
}: {
  initial?: string;
  submitLabel?: string;
  onSaved: (user: AuthUser) => void;
}) {
  const ids = { input: useId(), hint: useId() };
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const problem = checkUsername(value);
  const empty = normalizeUsername(value) === "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || empty || problem) return;
    setBusy(true);
    setFailure(null);
    setSaved(false);
    try {
      const user = await setUsername(normalizeUsername(value));
      setSaved(true);
      onSaved(user);
    } catch (err) {
      // The typed name stays in the field on every failure, so a taken name is a small edit rather than a retype.
      setFailure(err instanceof ApiError ? err.message : FALLBACK_FAILURE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-busy={busy} className="flex flex-col gap-3">
      <Field
        label="Username"
        htmlFor={ids.input}
        hintId={ids.hint}
        hint={problem ?? "3 to 30 characters: letters, digits, _ and -. Start with a letter."}
      >
        <input
          id={ids.input}
          value={value}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          aria-describedby={ids.hint}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          className={inputClass}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy || empty || problem !== null}>
          {busy && <Spinner />}
          {busy ? "Saving…" : submitLabel}
        </Button>
        {saved && (
          <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
            Username saved.
          </p>
        )}
      </div>
      {failure && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {failure}
        </p>
      )}
    </form>
  );
}
