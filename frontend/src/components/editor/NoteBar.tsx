"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { Note } from "@/generated/Note";
import { CELL_W_PX, nextVelocityPreset } from "@/lib/pianoRoll";
import { getPatternStore } from "@/lib/patternStore";
import { totalSteps } from "@/lib/patternOps";

// Below this a press is a click, not a drag, so a shaky click still removes the note.
const DRAG_THRESHOLD_PX = 4;

interface Drag {
  x: number;
  y: number;
  moved: boolean;
  startVelocity: number;
  startLength: number;
  maxLength: number;
  // Authoritative live value: React state lags a flick where pointerup follows pointermove before a render.
  velocity: number | null;
  length: number | null;
}

interface Props {
  instrumentId: string;
  note: Note;
  rowIndex: number;
  measureStartStep: number;
}

function maxLengthFor(instrumentId: string, note: Note): number {
  const pattern = getPatternStore(instrumentId).getState().pattern;
  if (!pattern) return note.length_steps;
  const nextStart = pattern.notes
    .filter((n) => n.row_id === note.row_id && n.step > note.step)
    .reduce((min, n) => Math.min(min, n.step), totalSteps(pattern));
  return nextStart - note.step;
}

function NoteBarImpl({ instrumentId, note, rowIndex, measureStartStep }: Props) {
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ velocity?: number; length?: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const velocity = preview?.velocity ?? note.velocity;
  const length = preview?.length ?? note.length_steps;
  const actions = () => getPatternStore(instrumentId).getState();

  useEffect(() => {
    if (!dragging) return;
    // Escape must abort without committing, so the drag ref is dropped before pointerup fires.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      drag.current = null;
      setPreview(null);
      setDragging(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dragging]);

  useEffect(() => {
    if (!dragging || preview?.velocity === undefined) return;
    document.body.style.cursor = "ns-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragging, preview?.velocity]);

  const begin = (e: React.PointerEvent, withMax: boolean) => {
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
      startVelocity: note.velocity,
      startLength: note.length_steps,
      maxLength: withMax ? maxLengthFor(instrumentId, note) : note.length_steps,
      velocity: null,
      length: null,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const end = (e: React.PointerEvent) => {
    drag.current = null;
    setDragging(false);
    setPreview(null);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onBodyDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    begin(e, false);
  };

  const onBodyMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX || Math.abs(dy) <= Math.abs(dx)) return;
      d.moved = true;
      setDragging(true);
    }
    const perPx = e.shiftKey ? 0.25 : 1;
    const v = Math.min(127, Math.max(1, Math.round(d.startVelocity - dy * perPx)));
    d.velocity = v;
    setPreview({ velocity: v });
  };

  const onBodyUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.moved) {
      if (d.velocity !== null && d.velocity !== d.startVelocity) {
        actions().setVelocity(note.row_id, note.step, d.velocity);
      }
    } else if (e.altKey) {
      actions().setVelocity(note.row_id, note.step, nextVelocityPreset(note.velocity));
    } else if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD_PX) {
      actions().toggleNote(note.row_id, note.step);
    }
    end(e);
  };

  const onHandleDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    begin(e, true);
    setDragging(true);
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
    setPreview({ length: len });
  };

  const onHandleUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    const d = drag.current;
    if (d && d.length !== null && d.length !== d.startLength) {
      actions().resizeNote(note.row_id, note.step, d.length);
    }
    end(e);
  };

  const showTooltip = dragging && preview;

  return (
    <div
      aria-hidden="true"
      data-testid="note"
      data-row={note.row_id}
      data-step={note.step}
      data-length={length}
      data-velocity={velocity}
      title={`Velocity ${velocity}`}
      onPointerDown={onBodyDown}
      onPointerMove={onBodyMove}
      onPointerUp={onBodyUp}
      onPointerCancel={end}
      className="group absolute z-10 cursor-pointer touch-none select-none rounded-[4px] border border-indigo-600 hover:ring-2 hover:ring-indigo-600/40 active:brightness-95 dark:border-indigo-400"
      style={{
        left: `calc(${note.step - measureStartStep} * var(--cell-w) + 2px)`,
        top: `calc(${rowIndex} * var(--row-h) + 4px)`,
        width: `calc(${length} * var(--cell-w) - 4px)`,
        height: "calc(var(--row-h) - 8px)",
      }}
    >
      <span
        className="absolute inset-0 bg-indigo-600 dark:bg-indigo-400"
        style={{ opacity: 0.2 + 0.8 * (velocity / 127) }}
      />
      <span
        aria-hidden="true"
        data-testid="note-resize"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={end}
        className="absolute inset-y-0 -right-1 z-10 flex w-2.5 cursor-ew-resize touch-none items-center justify-center pointer-coarse:-right-2 pointer-coarse:w-4"
      >
        <span
          className={`h-3 w-0.5 rounded-full bg-white/90 dark:bg-zinc-950/90 ${dragging ? "" : "invisible group-hover:visible"}`}
        />
      </span>
      {showTooltip && (
        <span className="absolute -top-7 left-0 z-50 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900">
          {preview.velocity !== undefined ? `Vel ${preview.velocity}` : `${preview.length} steps`}
        </span>
      )}
    </div>
  );
}

export const NoteBar = memo(NoteBarImpl);
