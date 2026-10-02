"use client";

import { useId, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing, hintClass, labelClass } from "@/components/ui/classes";
import { useAiKeys } from "@/components/ai/AiKeysProvider";
import { isKeyErrorCode, PROVIDER_LABEL } from "@/lib/aiKeys/keyError";
import type { AiKeySummary, AiProvider } from "@/lib/aiKeys/types";
import { ApiError, setAiProvider } from "@/lib/api";

const PROVIDERS: AiProvider[] = ["anthropic", "openai"];

export function ProviderRadioGroup({
  active,
  onChanged,
}: {
  active: AiProvider | null;
  onChanged: (summary: AiKeySummary) => void;
}) {
  const id = useId();
  const { refresh } = useAiKeys();
  const [switching, setSwitching] = useState<AiProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shown optimistically so the click feels instant; it falls back to `active` when the call fails.
  const selected = switching ?? active;

  async function choose(provider: AiProvider) {
    if (switching || provider === active) return;
    setError(null);
    setSwitching(provider);
    try {
      onChanged(await setAiProvider(provider));
    } catch (err) {
      // The other key was likely removed elsewhere, so the page must stop offering a choice that no longer exists.
      if (err instanceof ApiError && isKeyErrorCode(err.code)) void refresh();
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSwitching(null);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2 p-4 sm:p-6">
      <legend className={labelClass}>Provider for AI features</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {PROVIDERS.map((provider) => (
          <label key={provider} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-provider`}
              value={provider}
              checked={selected === provider}
              onChange={() => void choose(provider)}
              className={`size-4 ${focusRing}`}
            />
            {PROVIDER_LABEL[provider]}
            {switching === provider && <Spinner />}
          </label>
        ))}
      </div>
      <p className={hintClass}>Only this provider is used. Songbird never switches to the other key on its own.</p>
      {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}
    </fieldset>
  );
}
