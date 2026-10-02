"use client";

import { ErrorAlert } from "@/components/editor/ErrorAlert";
import type { SampleImport } from "./useSampleImport";

export function ImportProgress({ importer }: { importer: SampleImport }) {
  if (importer.rows.length === 0 && importer.errors.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
      {importer.rows.length > 0 && (
        <ul aria-label="Importing" className="flex flex-col gap-2">
          {importer.rows.map((r) => (
            <li key={r.key} className="flex flex-col gap-1 text-xs">
              <span className="flex justify-between gap-2">
                <span className="truncate">{r.name}</span>
                <span className="tabular-nums">{r.percent}%</span>
              </span>
              <progress
                aria-label={`Importing ${r.name}`}
                max={100}
                value={r.percent}
                className="h-1 w-full accent-indigo-600"
              />
            </li>
          ))}
        </ul>
      )}
      {importer.errors.map((e) => (
        <ErrorAlert key={e.key} message={e.message} onDismiss={() => importer.dismissError(e.key)} />
      ))}
    </div>
  );
}
