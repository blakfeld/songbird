"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { inputClass } from "@/components/ui/classes";
import { PROVIDER_LABEL } from "@/lib/aiKeys/keyError";
import type { AiKeySummary, AiProvider } from "@/lib/aiKeys/types";
import { saveAiKey } from "@/lib/api";
import { KEY_HINT, saveErrorMessage } from "./aiKeyMessages";

// The key lives only in this component's state, and the form unmounts on success, so no
// storage, URL, or lingering DOM node ever holds it.
export function KeyForm({
  provider,
  replacing,
  labelledBy,
  onSaved,
  onCancel,
}: {
  provider: AiProvider;
  replacing: boolean;
  labelledBy: string;
  onSaved: (summary: AiKeySummary) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = PROVIDER_LABEL[provider];

  useEffect(() => input.current?.focus(), []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || value.trim() === "") return;
    // Cleared first so a repeated identical failure is announced again.
    setError(null);
    setSaving(true);
    try {
      onSaved(await saveAiKey(provider, value.trim()));
    } catch (err) {
      setError(saveErrorMessage(err, provider));
      input.current?.focus();
    } finally {
      setValue("");
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={save}
      aria-busy={saving}
      aria-labelledby={labelledBy}
      className="mt-4 flex flex-col gap-3"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !saving) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <Field
        label={`${name} API key`}
        htmlFor={`${id}-input`}
        hintId={hintId}
        hint={replacing ? `${KEY_HINT[provider]} Your current key stays in place unless the new one passes the check.` : KEY_HINT[provider]}
      >
        <input
          ref={input}
          id={`${id}-input`}
          type="password"
          name={`${provider}-api-key`}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          // Password managers would otherwise offer to save the key as a site login.
          data-1p-ignore
          data-lpignore="true"
          required
          readOnly={saving}
          aria-invalid={error !== null}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`${inputClass} w-full font-mono`}
        />
      </Field>
      {error && (
        <div id={errorId}>
          <ErrorAlert message={error} onDismiss={() => setError(null)} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving || value.trim() === ""}>
          {saving && <Spinner />}
          {saving ? "Checking key…" : "Save key"}
        </Button>
      </div>
    </form>
  );
}
