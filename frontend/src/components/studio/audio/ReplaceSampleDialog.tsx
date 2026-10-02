"use client";

import { useState } from "react";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { hintClass, inputClass } from "@/components/ui/classes";
import type { SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import { getSamplePreview } from "@/lib/audio/samplePreview";
import { useSampleLibrary } from "@/lib/audio/useSampleLibrary";
import { SampleList } from "../samples/SampleList";
import { usePreviewId } from "../samples/SamplesPanel";

function Body({
  songSampleIds,
  currentSampleId,
  onPick,
}: {
  songSampleIds: ReadonlySet<string>;
  currentSampleId: string | undefined;
  onPick: (entry: SampleLibraryEntry) => void;
}) {
  const library = useSampleLibrary();
  const previewId = usePreviewId();
  const [query, setQuery] = useState("");
  const all = library.state.status === "ready" ? library.state.entries : [];
  const q = query.trim().toLowerCase();
  const entries = q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
  return (
    <div className="flex max-h-[70dvh] flex-col">
      <header className="flex flex-col gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
        <h2 className="text-base font-semibold">Replace sample</h2>
        <label htmlFor="replace-search" className="sr-only">
          Search samples
        </label>
        <input
          id="replace-search"
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputClass} w-full`}
        />
      </header>
      {entries.length === 0 ? (
        <p className={`${hintClass} p-3`}>{all.length === 0 ? "The library has no samples yet." : `No samples match “${query}”.`}</p>
      ) : (
        <SampleList
          entries={entries}
          mode="pick"
          songSampleIds={songSampleIds}
          currentSampleId={currentSampleId}
          previewId={previewId}
          onPreview={(entry) => void getSamplePreview().toggle(entry.id)}
          onActivate={onPick}
        />
      )}
    </div>
  );
}

export function ReplaceSampleDialog({
  open,
  songSampleIds,
  currentSampleId,
  onPick,
  onClose,
}: {
  open: boolean;
  songSampleIds: ReadonlySet<string>;
  currentSampleId: string | undefined;
  onPick: (entry: SampleLibraryEntry) => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog open={open} onClose={onClose} label="Replace sample" className="m-auto w-full max-w-md rounded-2xl p-0">
      <Body songSampleIds={songSampleIds} currentSampleId={currentSampleId} onPick={onPick} />
    </ModalDialog>
  );
}
