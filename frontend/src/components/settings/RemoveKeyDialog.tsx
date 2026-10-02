"use client";

import { useId, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Spinner } from "@/components/ui/Spinner";
import { PROVIDER_LABEL } from "@/lib/aiKeys/keyError";
import type { AiKeySummary, AiProvider } from "@/lib/aiKeys/types";
import { removeAiKey } from "@/lib/api";

export function RemoveKeyDialog({
  provider,
  consequence,
  onRemoved,
  onCancel,
}: {
  provider: AiProvider | null;
  consequence: string;
  onRemoved: (summary: AiKeySummary) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  return (
    <ModalDialog open={provider !== null} onClose={onCancel} role="alertdialog" labelledBy={titleId}>
      {provider && (
        <Body provider={provider} titleId={titleId} consequence={consequence} onRemoved={onRemoved} onCancel={onCancel} />
      )}
    </ModalDialog>
  );
}

function Body({
  provider,
  titleId,
  consequence,
  onRemoved,
  onCancel,
}: {
  provider: AiProvider;
  titleId: string;
  consequence: string;
  onRemoved: (summary: AiKeySummary) => void;
  onCancel: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    setRemoving(true);
    try {
      onRemoved(await removeAiKey(provider));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 id={titleId} className="text-base font-semibold">
        Remove your {PROVIDER_LABEL[provider]} key?
      </h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{consequence}</p>
      {error && <ErrorAlert message={error} />}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={removing} autoFocus>
          Cancel
        </Button>
        <Button
          onClick={() => void confirm()}
          disabled={removing}
          className="!border-red-700 !bg-red-700 !text-white hover:!bg-red-800 dark:!border-red-500 dark:!bg-red-600"
        >
          {removing && <Spinner />}
          {removing ? "Removing…" : "Remove key"}
        </Button>
      </div>
    </div>
  );
}
