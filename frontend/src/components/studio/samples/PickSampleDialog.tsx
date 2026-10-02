"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { hintClass, inputClass } from "@/components/ui/classes";
import type { SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import { getSamplePreview } from "@/lib/audio/samplePreview";
import { useSampleLibrary } from "@/lib/audio/useSampleLibrary";
import { SampleList } from "./SampleList";
import { usePreviewId } from "./SamplesPanel";

function Body({
  title,
  songSampleIds,
  currentSampleId,
  onPick,
  onImport,
}: {
  title: string;
  songSampleIds: ReadonlySet<string>;
  currentSampleId: string | undefined;
  onPick: (entry: SampleLibraryEntry) => void;
  onImport?: () => void;
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
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{title}</h2>
          {/* Dropping a file is mouse-only, so this is the keyboard path to bringing in new audio. */}
          {onImport && (
            <Button onClick={onImport} className="!px-3 !py-1">
              Import audio…
            </Button>
          )}
        </div>
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

export function PickSampleDialog({
  open,
  title,
  songSampleIds,
  currentSampleId,
  onPick,
  onImport,
  onClose,
}: {
  open: boolean;
  title: string;
  songSampleIds: ReadonlySet<string>;
  currentSampleId: string | undefined;
  onPick: (entry: SampleLibraryEntry) => void;
  onImport?: () => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog open={open} onClose={onClose} label={title} className="m-auto w-full max-w-md rounded-2xl p-0">
      <Body title={title} songSampleIds={songSampleIds} currentSampleId={currentSampleId} onPick={onPick} onImport={onImport} />
    </ModalDialog>
  );
}
