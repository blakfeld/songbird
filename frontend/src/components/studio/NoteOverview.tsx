"use client";

import { useMemo } from "react";
import type { Note } from "@/generated/Note";
import type { Row } from "@/generated/Row";

interface Layout {
  path: string;
  span: number;
}

// Notes are drawn in step units so the path never needs rebuilding when the lane is resized.
export function overviewLayout(notes: Note[], rows: Row[], melodic: boolean): Layout {
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const placed = notes.flatMap((n) => {
    const i = index.get(n.row_id);
    return i === undefined ? [] : [{ n, i }];
  });
  if (placed.length === 0) return { path: "", span: Math.max(rows.length, 1) };

  let low = 0;
  let span = rows.length;
  if (melodic) {
    // Fitting to the track's own range keeps a bass line from becoming a flat strip across 61 rows.
    const used = placed.map((p) => p.i);
    low = Math.min(...used) - 1;
    span = Math.max(...used) - low + 2;
  }
  const path = placed
    .map(({ n, i }) => `M${n.step} ${i - low}h${n.length_steps}v1h-${n.length_steps}z`)
    .join("");
  return { path, span };
}

export function NoteOverview({
  name,
  notes,
  rows,
  melodic,
  totalSteps,
  stepsPerMeasure,
  audible,
  onSeek,
}: {
  name: string;
  notes: Note[];
  rows: Row[] | null;
  melodic: boolean;
  totalSteps: number;
  stepsPerMeasure: number;
  audible: boolean;
  onSeek: (measureIndex: number) => void;
}) {
  const layout = useMemo(
    () => (rows ? overviewLayout(notes, rows, melodic) : null),
    [notes, rows, melodic],
  );

  const measuresUsed = notes.map((n) => Math.floor(n.step / stepsPerMeasure) + 1);
  const label =
    notes.length === 0
      ? `${name}: no notes`
      : `${name}: ${notes.length} ${notes.length === 1 ? "note" : "notes"}, measures ${Math.min(...measuresUsed)}–${Math.max(...measuresUsed)}`;

  return (
    // Pointer-only on purpose: the track name button is the keyboard path, so lanes add no tab stops.
    <div
      className={`relative min-w-0 cursor-pointer ${audible ? "" : "opacity-40"}`}
      data-testid="note-overview"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const measures = totalSteps / stepsPerMeasure;
        const at = rect.width > 0 ? Math.floor(((e.clientX - rect.left) / rect.width) * measures) : 0;
        onSeek(Math.min(measures - 1, Math.max(0, at)));
      }}
    >
      <div
        role="img"
        aria-label={label}
        className="absolute inset-x-0 inset-y-1 overflow-hidden rounded-md border border-indigo-600/30 bg-indigo-600/10 dark:border-indigo-400/30 dark:bg-indigo-400/10"
      >
        {layout && layout.path && (
          <svg
            viewBox={`0 0 ${totalSteps} ${layout.span}`}
            preserveAspectRatio="none"
            className="h-full w-full"
            aria-hidden="true"
          >
            <path
              d={layout.path}
              className="fill-indigo-600 stroke-indigo-600 dark:fill-indigo-400 dark:stroke-indigo-400"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        {notes.length === 0 && (
          <span className="absolute top-1/2 left-2 -translate-y-1/2 text-xs text-zinc-500">
            No notes yet. Select the track to add some.
          </span>
        )}
      </div>
    </div>
  );
}
