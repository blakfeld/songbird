"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Note } from "@/generated/Note";
import type { Pattern } from "@/generated/Pattern";
import type { LoopRange, Playback } from "@/lib/audio/types";
import { beatSteps, CELL_W_PX, nextVelocityPreset, noteCovers } from "@/lib/pianoRoll";
import { getPatternStore } from "@/lib/patternStore";
import { totalSteps } from "@/lib/patternOps";
import { LoopShade } from "./LoopShade";
import { MeasureColumn, type ActiveCell } from "./MeasureColumn";
import { MeasureRuler } from "./MeasureRuler";
import { Playhead } from "./Playhead";
import { RowLabels } from "./RowLabels";

const NO_NOTES: Note[] = [];

function groupByMeasure(pattern: Pattern) {
  const spm = pattern.steps_per_measure;
  const starting: Note[][] = Array.from({ length: pattern.measures }, () => []);
  const carry: Note[][] = Array.from({ length: pattern.measures }, () => []);
  for (const n of pattern.notes) {
    const first = Math.floor(n.step / spm);
    const last = Math.floor((n.step + n.length_steps - 1) / spm);
    starting[first]?.push(n);
    for (let m = first + 1; m <= last && m < pattern.measures; m++) carry[m].push(n);
  }
  return { starting, carry };
}

export function PianoRoll({
  instrumentId,
  instrumentName,
  pattern,
  loop,
  follow,
  isPlaying,
  onManualScroll,
  subscribePosition,
}: {
  instrumentId: string;
  instrumentName: string;
  pattern: Pattern;
  loop: LoopRange;
  follow: boolean;
  isPlaying: boolean;
  onManualScroll: () => void;
  subscribePosition: Playback["subscribePosition"];
}) {
  const helpId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const followRef = useRef(follow);
  const labelWidth = useRef(0);
  const [active, setActive] = useState<ActiveCell>({ row: 0, step: 0 });
  const spm = pattern.steps_per_measure;
  const beat = beatSteps(pattern.time_signature);
  const total = totalSteps(pattern);
  const { starting, carry } = useMemo(() => groupByMeasure(pattern), [pattern]);

  // A resize or undo can shrink the grid below the remembered cell; fall back so the roll always has a tab stop.
  const safeActive =
    active.row < pattern.rows.length && active.step < total ? active : { row: 0, step: 0 };

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  // Measuring per frame would force layout 60 times a second.
  useEffect(() => {
    const el = labels.current;
    if (!el) return;
    labelWidth.current = el.offsetWidth;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      labelWidth.current = el.offsetWidth;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let lastTarget = -1;
    let lastStep: number | null = null;
    return subscribePosition((position) => {
      const el = scroller.current;
      const step = position === null ? null : Math.floor(position);
      if (step === lastStep) return;
      lastStep = step;
      if (step === null || !el || !followRef.current) {
        lastTarget = -1;
        return;
      }
      const labelW = labelWidth.current;
      const x = step * CELL_W_PX;
      const visibleStart = el.scrollLeft;
      const visibleEnd = el.scrollLeft + el.clientWidth - labelW - 4 * CELL_W_PX;
      if (x >= visibleStart && x <= visibleEnd) return;
      // Page-flip rather than continuous scrolling: easier to read and cheaper.
      const target = Math.max(0, x - CELL_W_PX);
      if (target === lastTarget) return;
      lastTarget = target;
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollTo?.({ left: target, behavior: reduced ? "auto" : "smooth" });
    });
  }, [subscribePosition]);

  // The scroll event also fires for our own programmatic scrolls, so user intent is read from input events.
  const userScrolled = () => {
    if (isPlaying) onManualScroll();
  };

  function focusCell(row: number, step: number, root: HTMLElement) {
    const r = Math.min(pattern.rows.length - 1, Math.max(0, row));
    const s = Math.min(total - 1, Math.max(0, step));
    setActive({ row: r, step: s });
    const el = root.querySelector<HTMLElement>(`[data-cell="${r}:${s}"]`);
    el?.focus();
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Browser and OS shortcuts such as Cmd+V must not be read as editor keys.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const raw = target.getAttribute?.("data-cell");
    if (!raw) return;
    const [row, step] = raw.split(":").map(Number);
    const rowId = pattern.rows[row].id;
    const store = getPatternStore(instrumentId).getState();
    const current = store.pattern;
    const covering = current?.notes.find((n) => n.row_id === rowId && noteCovers(n, step));
    const root = e.currentTarget;
    const stop = () => e.preventDefault();

    if (e.shiftKey && covering) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        stop();
        store.setVelocity(rowId, covering.step, covering.velocity + (e.key === "ArrowUp" ? 10 : -10));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        stop();
        store.resizeNote(rowId, covering.step, covering.length_steps + (e.key === "ArrowRight" ? 1 : -1));
        return;
      }
    }
    if (e.shiftKey && e.key.startsWith("Arrow")) return;

    switch (e.key) {
      case "ArrowLeft": stop(); focusCell(row, step - 1, root); break;
      case "ArrowRight": stop(); focusCell(row, step + 1, root); break;
      case "ArrowUp": stop(); focusCell(row - 1, step, root); break;
      case "ArrowDown": stop(); focusCell(row + 1, step, root); break;
      case "Home": stop(); focusCell(row, 0, root); break;
      case "End": stop(); focusCell(row, total - 1, root); break;
      case "PageUp": stop(); focusCell(row, step - spm, root); break;
      case "PageDown": stop(); focusCell(row, step + spm, root); break;
      case "Delete":
      case "Backspace":
        stop();
        if (covering) store.toggleNote(rowId, step);
        break;
      case "v":
      case "V":
        if (covering) {
          stop();
          store.setVelocity(rowId, covering.step, nextVelocityPreset(covering.velocity));
        }
        break;
    }
  }

  return (
    <>
      <p id={helpId} className="sr-only">
        Arrow keys move between steps. Enter adds or removes a note. Shift plus Up or Down changes
        velocity. Shift plus Left or Right changes length. Space plays or stops.
      </p>
      <div
        role="group"
        aria-roledescription="piano roll"
        aria-label={`${instrumentName} piano roll`}
        aria-describedby={helpId}
        ref={scroller}
        onKeyDown={onKeyDown}
        onWheel={(e) => Math.abs(e.deltaX) > Math.abs(e.deltaY) && userScrolled()}
        onTouchStart={userScrolled}
        onPointerDown={(e) => e.target === e.currentTarget && userScrolled()}
        className="relative max-h-[70vh] scroll-pl-28 overflow-auto overscroll-x-contain rounded-xl border border-zinc-200 [--cell-w:28px] [--row-h:32px] pointer-coarse:[--row-h:40px] max-sm:scroll-pl-20 dark:border-zinc-800"
      >
        <div className="relative grid w-max grid-cols-[auto_1fr]">
          <div className="sticky top-0 left-0 z-40 border-r border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950" />
          <MeasureRuler measures={pattern.measures} stepsPerMeasure={spm} beatSteps={beat} loop={loop} />
          <RowLabels ref={labels} rows={pattern.rows} />
          <div className="relative flex">
            {starting.map((notes, m) => (
              <MeasureColumn
                key={m}
                instrumentId={instrumentId}
                measureIndex={m}
                rows={pattern.rows}
                stepsPerMeasure={spm}
                beatSteps={beat}
                notes={notes.length ? notes : NO_NOTES}
                carryIn={carry[m].length ? carry[m] : NO_NOTES}
                activeCell={Math.floor(safeActive.step / spm) === m ? safeActive : null}
              />
            ))}
            <LoopShade loop={loop} measures={pattern.measures} stepsPerMeasure={spm} />
            <Playhead subscribePosition={subscribePosition} />
          </div>
        </div>
      </div>
    </>
  );
}
