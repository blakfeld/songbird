"use client";

import { useState } from "react";
import type { Pattern } from "@/generated/Pattern";
import { Button } from "@/components/ui/Button";
import { exportMidi } from "@/lib/api";
import { saveBlob } from "@/lib/download";

export function DownloadMidiButton({
  pattern,
  onExported,
}: {
  pattern: Pattern;
  onExported?: (filename: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const { blob, filename } = await exportMidi(pattern);
      saveBlob(blob, filename);
      onExported?.(filename);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button onClick={download} disabled={busy} aria-label={busy ? undefined : "Download MIDI"}>
        <span aria-hidden="true">⤓</span>
        {busy ? "Preparing MIDI…" : (
          <>
            <span className="max-[400px]:hidden">Download MIDI</span>
            <span className="min-[400px]:hidden">MIDI</span>
          </>
        )}
      </Button>
      {failed && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          Couldn&apos;t export MIDI. Try again.
        </p>
      )}
    </div>
  );
}
