"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { Note } from "@/generated/Note";
import { CELL_W_PX } from "@/lib/pianoRoll";
import type { NoteActions } from "./noteActions";

interface ResizeDrag {
  x: number;
  startLength: number;
  maxLength: number;
  // Authoritative live value: React state lags a flick where pointerup follows pointermove before a render.
  length: number | null;
}

interface Props {
  actions: NoteActions;
  note: Note;
  rowIndex: number;
  measureStartStep: number;
  selected: boolean;
  moving: boolean;
}

const SELECTED =
  "z-10 border-2 border-zinc-950 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.9)] dark:border-white dark:shadow-[inset_0_0_0_1px_rgb(9_9_11/0.9)]";
const UNSELECTED =
  "z-10 border border-indigo-600 hover:ring-2 hover:ring-indigo-600/40 dark:border-indigo-400";

function NoteBarImpl({ actions, note, rowIndex, measureStartStep, selected, moving }: Props) {
  const drag = useRef<ResizeDrag | null>(null);
  const [previewLength, setPreviewLength] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  const length = previewLength ?? note.length_steps;
  const rowName = actions.rows()[rowIndex]?.name ?? "";

  useEffect(() => {
    if (!resizing) return;
    // Escape must abort without committing, so the drag ref is dropped before pointerup fires.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      drag.current = null;
      setPreviewLength(null);
      setResizing(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [resizing]);

  const endResize = (e: React.PointerEvent) => {
    drag.current = null;
    setResizing(false);
    setPreviewLength(null);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onHandleDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = {
      x: e.clientX,
      startLength: note.length_steps,
      maxLength: actions.maxLength(note),
      length: null,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setResizing(true);
  };

  const onHandleMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    const d = drag.current;
    if (!d) return;
    const len = Math.min(
      d.maxLength,
      Math.max(1, d.startLength + Math.round((e.clientX - d.x) / CELL_W_PX)),
    );
    d.length = len;
    setPreviewLength(len);
  };

  const onHandleUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    const d = drag.current;
    if (d && d.length !== null && d.length !== d.startLength) {
      actions.resize(note.row_id, note.step, d.length);
    }
    endResize(e);
  };

  return (
    <div
      aria-hidden="true"
      data-testid="note"
      data-row={note.row_id}
      data-step={note.step}
      data-length={length}
      data-velocity={note.velocity}
      data-selected={selected ? "true" : undefined}
      title={`${rowName} · velocity ${note.velocity} · ${length} ${length === 1 ? "step" : "steps"}\nDrag to move · Shift-drag for velocity\nDouble-click or Delete to remove`}
      onPointerDown={(e) => {
        if (e.button === 0) actions.pressNote(note, e);
      }}
      onDoubleClick={() => actions.removeNote(note)}
      className={`group absolute touch-none select-none rounded-[4px] active:brightness-95 ${selected ? SELECTED : UNSELECTED} ${moving ? "z-20 cursor-grabbing shadow-md" : "cursor-grab"}`}
      style={{
        left: `calc(${note.step - measureStartStep} * var(--cell-w) + 2px)`,
        top: `calc(${rowIndex} * var(--row-h) + 4px)`,
        width: `calc(${length} * var(--cell-w) - 4px)`,
        height: "calc(var(--row-h) - 8px)",
      }}
    >
      <span
        className="absolute inset-0 bg-indigo-600 dark:bg-indigo-400"
        style={{ opacity: 0.2 + 0.8 * (note.velocity / 127) }}
      />
      <span
        aria-hidden="true"
        data-testid="note-resize"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={endResize}
        className="absolute inset-y-0 -right-1 z-10 flex w-2.5 cursor-ew-resize touch-none items-center justify-center pointer-coarse:-right-2 pointer-coarse:w-4"
      >
        <span
          className={`h-3 w-0.5 rounded-full bg-white/90 dark:bg-zinc-950/90 ${resizing ? "" : "invisible group-hover:visible"}`}
        />
      </span>
      {resizing && previewLength !== null && (
        <span className="absolute -top-7 left-0 z-50 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900">
          {previewLength} steps
        </span>
      )}
    </div>
  );
}

export const NoteBar = memo(NoteBarImpl);
