"use client";

import { useCallback, useRef, useState } from "react";
import {
  LOW_STORAGE_BYTES,
  importAudioFiles,
  type ImportOptions,
  type ImportOutcome,
  type ImportProgress,
} from "@/lib/audio/sampleImport";
import type { SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import { notifyLibraryChanged } from "@/lib/audio/useSampleLibrary";

export interface ImportRow {
  key: string;
  name: string;
  percent: number;
}

export interface ImportError {
  key: string;
  message: string;
}

export interface LowStorage {
  files: File[];
  freeBytes: number;
}

const PERCENT: Record<ImportProgress["stage"], number> = { reading: 10, decoding: 40, storing: 80, done: 100 };

async function freeBytes(): Promise<number | null> {
  try {
    const space = await navigator.storage?.estimate?.();
    return space?.quota !== undefined && space.usage !== undefined ? space.quota - space.usage : null;
  } catch {
    return null;
  }
}

let nextKey = 0;

// Owns the import pipeline's UI state so the Samples panel, the lane drops and the track menu all report in one place.
export function useSampleImport(options?: ImportOptions) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [low, setLow] = useState<LowStorage | null>(null);
  const pending = useRef<((go: boolean) => void) | null>(null);

  const run = useCallback(
    async (files: File[]): Promise<SampleLibraryEntry[]> => {
      const base = nextKey;
      nextKey += files.length;
      setRows(files.map((f, i) => ({ key: `${base + i}`, name: f.name, percent: 0 })));
      const batch = await importAudioFiles(files, {
        ...options,
        onProgress: (p) => {
          options?.onProgress?.(p);
          setRows((rs) => rs.map((r, i) => (i === p.fileIndex ? { ...r, percent: PERCENT[p.stage] } : r)));
        },
      });
      setRows([]);
      const failed = batch.outcomes.flatMap((o: ImportOutcome, i) =>
        o.ok ? [] : [{ key: `${base + i}`, message: o.message }],
      );
      if (failed.length > 0) setErrors((e) => [...e, ...failed]);
      notifyLibraryChanged();
      return batch.outcomes.flatMap((o) => (o.ok ? [o.entry] : []));
    },
    [options],
  );

  // Resolves with the entries that were stored, in file order, or none when the user backs out of the warning.
  const importFiles = useCallback(
    async (files: File[]): Promise<SampleLibraryEntry[]> => {
      if (files.length === 0) return [];
      const free = await freeBytes();
      if (free !== null && free < LOW_STORAGE_BYTES) {
        const go = await new Promise<boolean>((resolve) => {
          pending.current = resolve;
          setLow({ files, freeBytes: free });
        });
        setLow(null);
        pending.current = null;
        if (!go) return [];
      }
      return run(files);
    },
    [run],
  );

  return {
    rows,
    errors,
    low,
    importFiles,
    confirmLow: (go: boolean) => pending.current?.(go),
    dismissError: (key: string) => setErrors((e) => e.filter((x) => x.key !== key)),
  };
}

export type SampleImport = ReturnType<typeof useSampleImport>;
