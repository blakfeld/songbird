"use client";

import { memo, useMemo } from "react";
import type { Note } from "@/generated/Note";
import type { Row } from "@/generated/Row";
import type { RowTint } from "@/lib/music/key";
import { cellLabel, isBlackKey } from "@/lib/pianoRoll";
import { noteKey } from "@/lib/patternOps";
import { NoteBar } from "./NoteBar";
import type { NoteActions } from "./noteActions";

export interface ActiveCell {
  row: number;
  step: number;
}

interface Props {
  actions: NoteActions;
  measureIndex: number;
  rows: Row[];
  stepsPerMeasure: number;
  beatSteps: number;
  notes: Note[];
  carryIn: Note[];
  activeCell: ActiveCell | null;
  shadeBlackRows: boolean;
  rowTints?: RowTint[];
  selection: ReadonlySet<string>;
  // Lets the memo comparison ignore selection changes elsewhere without diffing the whole set per column.
  selectionSignature: string;
  moving: boolean;
}

const sameItems = (a: Note[], b: Note[]) =>
  a === b || (a.length === b.length && a.every((n, i) => n === b[i]));

const TINT_CLASSES = {
  scale: ["bg-emerald-50 dark:bg-emerald-950/50", "bg-emerald-100/60 dark:bg-emerald-900/35"],
  tonic: ["bg-emerald-100 dark:bg-emerald-900/55", "bg-emerald-200/60 dark:bg-emerald-900/70"],
};

function cellClass(
  local: number,
  stepsPerMeasure: number,
  beatSteps: number,
  shaded: boolean,
  tint: RowTint = "none",
) {
  const parts = ["border-r border-b border-zinc-200 dark:border-zinc-800"];
  if (local === stepsPerMeasure - 1) {
    parts.push("border-r-2 border-r-zinc-500 dark:border-r-zinc-500");
  } else if (local % beatSteps === beatSteps - 1) {
    parts.push("border-r-zinc-300 dark:border-r-zinc-700");
  }
  const oddBeat = Math.floor(local / beatSteps) % 2 === 1;
  if (tint !== "none") {
    parts.push(TINT_CLASSES[tint][oddBeat ? 1 : 0]);
  } else if (shaded) {
    parts.push(oddBeat ? "bg-zinc-200/70 dark:bg-zinc-800/60" : "bg-zinc-100 dark:bg-zinc-900");
  } else {
    parts.push(oddBeat ? "bg-zinc-50 dark:bg-zinc-900/50" : "bg-white dark:bg-zinc-950");
  }
  return parts.join(" ");
}

function MeasureColumnImpl({
  actions,
  measureIndex,
  rows,
  stepsPerMeasure,
  beatSteps,
  notes,
  carryIn,
  activeCell,
  shadeBlackRows,
  rowTints,
  selection,
  moving,
}: Props) {
  const start = measureIndex * stepsPerMeasure;
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);

  const coverage = useMemo(() => {
    const map = new Map<string, Note>();
    for (const n of [...carryIn, ...notes]) {
      const from = Math.max(n.step, start);
      const to = Math.min(n.step + n.length_steps, start + stepsPerMeasure);
      for (let s = from; s < to; s++) map.set(`${n.row_id}:${s}`, n);
    }
    return map;
  }, [notes, carryIn, start, stepsPerMeasure]);

  const cells = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const shaded = shadeBlackRows && isBlackKey(row.midi_note);
    for (let local = 0; local < stepsPerMeasure; local++) {
      const abs = start + local;
      const covering = coverage.get(`${row.id}:${abs}`);
      const isActive = activeCell?.row === r && activeCell.step === abs;
      const selected = covering !== undefined && selection.has(noteKey(covering));
      const label = cellLabel(row.name, abs, stepsPerMeasure);
      const description = covering
        ? covering.step === abs
          ? `Note, velocity ${covering.velocity}, ${covering.length_steps} ${covering.length_steps === 1 ? "step" : "steps"}`
          : `Held from step ${(covering.step % stepsPerMeasure) + 1}${selected ? ", selected" : ""}`
        : undefined;
      cells.push(
        // aria-description keeps the accessible name stable while note details stay available.
        // eslint-disable-next-line jsx-a11y/role-supports-aria-props
        <button
          key={`${r}:${local}`}
          type="button"
          data-cell={`${r}:${abs}`}
          aria-label={covering?.step === abs && selected ? `${label}, selected` : label}
          aria-description={description}
          aria-pressed={covering !== undefined}
          tabIndex={isActive ? 0 : -1}
          onClick={(e) => actions.clickCell(row.id, abs, covering, e)}
          className={`${cellClass(local, stepsPerMeasure, beatSteps, shaded, rowTints?.[r])} touch-manipulation ${covering ? "" : "cursor-pointer hover:bg-indigo-600/10 dark:hover:bg-indigo-400/15"} focus-visible:relative focus-visible:z-20 focus-visible:bg-transparent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-black dark:focus-visible:outline-white`}
          style={{ gridColumn: local + 1, gridRow: r + 1 }}
        />,
      );
    }
  }

  return (
    <div
      className="relative grid"
      style={{
        gridTemplateColumns: `repeat(${stepsPerMeasure}, var(--cell-w))`,
        gridTemplateRows: `repeat(${rows.length}, var(--row-h))`,
      }}
    >
      {cells}
      {notes.map((n) => (
        <NoteBar
          key={`${n.row_id}:${n.step}`}
          actions={actions}
          note={n}
          rowIndex={rowIndex.get(n.row_id) ?? 0}
          measureStartStep={start}
          selected={selection.has(noteKey(n))}
          moving={moving && selection.has(noteKey(n))}
        />
      ))}
    </div>
  );
}

// A default shallow compare would re-render every measure on each edit because note arrays are rebuilt per render.
export const MeasureColumn = memo(MeasureColumnImpl, (a, b) =>
  a.actions === b.actions &&
  a.measureIndex === b.measureIndex &&
  a.rows === b.rows &&
  a.stepsPerMeasure === b.stepsPerMeasure &&
  a.beatSteps === b.beatSteps &&
  a.shadeBlackRows === b.shadeBlackRows &&
  a.rowTints === b.rowTints &&
  a.selectionSignature === b.selectionSignature &&
  a.moving === b.moving &&
  a.activeCell?.row === b.activeCell?.row &&
  a.activeCell?.step === b.activeCell?.step &&
  sameItems(a.notes, b.notes) &&
  sameItems(a.carryIn, b.carryIn),
);

