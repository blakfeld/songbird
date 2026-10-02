"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { focusRing, hintClass, inputClass } from "@/components/ui/classes";
import type { SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import { getSamplePreview } from "@/lib/audio/samplePreview";
import { useSampleLibrary } from "@/lib/audio/useSampleLibrary";
import { InstrumentIcon } from "../InstrumentIcon";
import { RemoveSampleDialog } from "./RemoveSampleDialog";
import { SampleList } from "./SampleList";
import { dragKind } from "./useSampleDrop";
import type { SampleImport } from "./useSampleImport";

export const SAMPLES_PANEL_ID = "samples-panel";

export function usePreviewId() {
  const preview = getSamplePreview();
  const [id, setId] = useState<string | null>(preview.current());
  useEffect(() => preview.subscribe(setId), [preview]);
  return id;
}

export function SamplesPanel({
  songSampleIds,
  targetLabel,
  onImportRequest,
  onDropFiles,
  onPlace,
  countSongs,
  onClose,
  searchRef,
}: {
  songSampleIds: ReadonlySet<string>;
  // Null when no audio track is selected, so Enter has nowhere to place a sample.
  targetLabel: string | null;
  onImportRequest: () => void;
  onDropFiles: (files: File[]) => void;
  onPlace: (entry: SampleLibraryEntry) => void;
  countSongs: (sampleId: string) => Promise<number>;
  onClose: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const library = useSampleLibrary();
  const previewId = usePreviewId();
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<SampleLibraryEntry | null>(null);
  const [dropping, setDropping] = useState(false);
  const panel = useRef<HTMLElement>(null);

  const entries = useMemo(() => {
    if (library.state.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    return q ? library.state.entries.filter((e) => e.name.toLowerCase().includes(q)) : library.state.entries;
  }, [library.state, query]);
  const total = library.state.status === "ready" ? library.state.entries.length : 0;

  const preview = useCallback((entry: SampleLibraryEntry) => void getSamplePreview().toggle(entry.id), []);

  return (
    <section
      ref={panel}
      id={SAMPLES_PANEL_ID}
      role="dialog"
      aria-modal="false"
      aria-label="Samples"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !removing) {
          e.stopPropagation();
          onClose();
        }
      }}
      onDragOver={(e) => {
        if (dragKind(e.dataTransfer) !== "files") return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (dragKind(e.dataTransfer) !== "files") return;
        e.preventDefault();
        setDropping(false);
        onDropFiles(Array.from(e.dataTransfer.files));
      }}
      className={`fixed z-40 flex flex-col overflow-hidden border-zinc-200 bg-white shadow-lg max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[60dvh] max-md:rounded-t-2xl max-md:border-t md:top-0 md:right-0 md:h-dvh md:w-80 md:border-l dark:border-zinc-800 dark:bg-zinc-950 ${
        dropping ? "ring-2 ring-indigo-600 ring-inset bg-indigo-50/60 dark:bg-indigo-950/40 dark:ring-indigo-400" : ""
      }`}
    >
      {dropping && (
        <p className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-sm font-semibold">
          Drop to import
        </p>
      )}
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <InstrumentIcon instrumentId="audio" kind={null} className="size-6" />
        <h2 className="text-sm font-semibold">Samples</h2>
        <span className={hintClass}>({total})</span>
        <Button onClick={onImportRequest} className="ml-auto !px-3 !py-1.5">
          Import audio…
        </Button>
        <button
          type="button"
          aria-label="Close samples"
          onClick={onClose}
          className={`inline-flex size-7 items-center justify-center rounded-md hover:bg-zinc-100 pointer-coarse:size-9 dark:hover:bg-zinc-800 ${focusRing}`}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="flex flex-col gap-1 px-3 py-2">
        <label htmlFor="samples-search" className="sr-only">
          Search samples
        </label>
        <input
          ref={searchRef}
          id="samples-search"
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputClass} w-full`}
        />
        <p aria-live="polite" className={hintClass}>
          {targetLabel ?? "Select an audio track to place samples"}
        </p>
        <p role="status" className="sr-only">
          {library.state.status === "ready" ? `${entries.length} ${entries.length === 1 ? "sample" : "samples"}` : ""}
        </p>
      </div>
      {library.state.status === "loading" && (
        <div aria-hidden="true" className="flex flex-col gap-2 p-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-14 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-900" />
          ))}
        </div>
      )}
      {library.state.status === "error" && (
        <div className="p-3">
          <ErrorAlert message="Couldn't open the sample library." onRetry={library.retry} />
        </div>
      )}
      {library.state.status === "ready" && total === 0 && (
        <div className="flex flex-col items-center gap-2 p-6 text-center">
          <h3 className="text-sm font-semibold">No samples yet</h3>
          <p className={hintClass}>Import audio files, or drop them here.</p>
          <Button onClick={onImportRequest}>Import audio…</Button>
        </div>
      )}
      {library.state.status === "ready" && total > 0 && entries.length === 0 && (
        <p className={`${hintClass} p-3`}>
          No samples match “{query}”.{" "}
          <button type="button" className={`underline ${focusRing}`} onClick={() => setQuery("")}>
            Clear search
          </button>
        </p>
      )}
      {entries.length > 0 && (
        <SampleList
          entries={entries}
          mode="library"
          songSampleIds={songSampleIds}
          previewId={previewId}
          canPlace={targetLabel !== null}
          onPreview={preview}
          onActivate={onPlace}
          onRename={(entry, name) => void library.rename(entry.id, name)}
          onRemove={setRemoving}
        />
      )}
      <RemoveSampleDialog
        entry={removing}
        countSongs={countSongs}
        onCancel={() => setRemoving(null)}
        onConfirm={(entry) => {
          setRemoving(null);
          void library.remove(entry.id).then(() => {
            if (previewId === entry.id) getSamplePreview().stop();
          });
          const next = entries[entries.findIndex((e) => e.id === entry.id) + 1] ?? entries[0];
          requestAnimationFrame(() =>
            (next && next.id !== entry.id
              ? panel.current?.querySelector<HTMLElement>(`[data-sample-row="${CSS.escape(next.id)}"] [data-sample-main]`)
              : searchRef.current
            )?.focus(),
          );
        }}
      />
    </section>
  );
}

// Lives with the panel's import state, but the dialog also serves lane drops, so it is exported for the page.
export function LowStorageDialog({ importer }: { importer: SampleImport }) {
  const { low } = importer;
  return (
    <ModalDialog open={low !== null} onClose={() => importer.confirmLow(false)} role="alertdialog" label="Browser storage is almost full">
      {low && (
        <div className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Browser storage is almost full</h2>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            About {Math.max(0, Math.round(low.freeBytes / (1024 * 1024)))} MB is left. Importing{" "}
            {low.files.length === 1 ? low.files[0].name : `${low.files.length} files`} may not fit.
          </p>
          <div className="flex justify-end gap-2">
            <Button autoFocus onClick={() => importer.confirmLow(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => importer.confirmLow(true)}>
              Import anyway
            </Button>
          </div>
        </div>
      )}
    </ModalDialog>
  );
}
