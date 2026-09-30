"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { Note } from "@/generated/Note";
import { CELL_W_PX, nextVelocityPreset } from "@/lib/pianoRoll";
import type { NoteActions } from "./noteActions";

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
  // Vertical drags are ambiguous, so Shift at press picks velocity and a plain press moves the note between rows.
  mode: "row" | "velocity";
  rowH: number;
  row: number;
}

interface Props {
  actions: NoteActions;
  note: Note;
  rowIndex: number;
  measureStartStep: number;
}

function NoteBarImpl({ actions, note, rowIndex, measureStartStep }: Props) {
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ velocity?: number; length?: number; row?: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const velocity = preview?.velocity ?? note.velocity;
  const length = preview?.length ?? note.length_steps;
  const shownRow = preview?.row ?? rowIndex;

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
    if (!dragging || (preview?.velocity === undefined && preview?.row === undefined)) return;
    document.body.style.cursor = "ns-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragging, preview?.velocity, preview?.row]);

  const begin = (e: React.PointerEvent, withMax: boolean) => {
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
      startVelocity: note.velocity,
      startLength: note.length_steps,
      maxLength: withMax ? actions.maxLength(note) : note.length_steps,
      velocity: null,
      length: null,
      mode: e.shiftKey ? "velocity" : "row",
      // The bar is one row tall minus its 8px of inset, which avoids reading --row-h from CSS.
      rowH: (e.currentTarget as HTMLElement).offsetHeight + 8,
      row: rowIndex,
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
    if (d.mode === "row") {
      const rows = actions.rows();
      const want = Math.min(rows.length - 1, Math.max(0, rowIndex + Math.round(dy / d.rowH)));
      // Walking row by row, rather than jumping, is what lets occupied rows be skipped and each entered row be heard.
      const dir = Math.sign(want - d.row);
      for (let i = d.row + dir; dir !== 0 && (dir > 0 ? i <= want : i >= want); i += dir) {
        if (!actions.canMove(note, rows[i].id)) continue;
        d.row = i;
        if (i !== rowIndex) actions.placed(rows[i], note.velocity);
      }
      setPreview({ row: d.row });
      return;
    }
    const perPx = e.altKey ? 0.25 : 1;
    const v = Math.min(127, Math.max(1, Math.round(d.startVelocity - dy * perPx)));
    d.velocity = v;
    setPreview({ velocity: v });
  };

  const onBodyUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.moved) {
      if (d.mode === "row") {
        if (d.row !== rowIndex) actions.move(note.row_id, note.step, actions.rows()[d.row].id);
      } else if (d.velocity !== null && d.velocity !== d.startVelocity) {
        actions.setVelocity(note.row_id, note.step, d.velocity);
      }
    } else if (e.altKey) {
      actions.setVelocity(note.row_id, note.step, nextVelocityPreset(note.velocity));
    } else if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD_PX) {
      actions.toggle(note.row_id, note.step);
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
      actions.resize(note.row_id, note.step, d.length);
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
      title={`Velocity ${velocity} · Shift-drag to change`}
      onPointerDown={onBodyDown}
      onPointerMove={onBodyMove}
      onPointerUp={onBodyUp}
      onPointerCancel={end}
      className="group absolute z-10 cursor-pointer touch-none select-none rounded-[4px] border border-indigo-600 hover:ring-2 hover:ring-indigo-600/40 active:brightness-95 dark:border-indigo-400"
      style={{
        left: `calc(${note.step - measureStartStep} * var(--cell-w) + 2px)`,
        top: `calc(${shownRow} * var(--row-h) + 4px)`,
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
          {preview.row !== undefined
            ? actions.rows()[preview.row].name
            : preview.velocity !== undefined
              ? `Vel ${preview.velocity}`
              : `${preview.length} steps`}
        </span>
      )}
    </div>
  );
}

export const NoteBar = memo(NoteBarImpl);
