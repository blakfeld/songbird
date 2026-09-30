"use client";

import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import type { InstrumentKind } from "@/generated/InstrumentKind";
import type { Note } from "@/generated/Note";
import type { TimeSignature } from "@/generated/TimeSignature";
import type { Row } from "@/generated/Row";
import type { LoopRange, Playback } from "@/lib/audio/types";
import {
  beatSteps,
  CELL_W_PX,
  defaultNoteLength,
  nextVelocityPreset,
  noteCovers,
} from "@/lib/pianoRoll";
import { moveGridNote, type NoteGrid } from "@/lib/patternOps";
import { LoopShade } from "./LoopShade";
import { MeasureColumn, type ActiveCell } from "./MeasureColumn";
import { MeasureRuler } from "./MeasureRuler";
import type { NoteActions } from "./noteActions";
import { Playhead } from "./Playhead";
import { RowLabels } from "./RowLabels";

const NO_NOTES: Note[] = [];
const MIDDLE_C = 60;
const MELODIC_ROW_H_PX = 18;
const MELODIC_ROW_H_COARSE_PX = 24;

// When the range is taller than the viewport, the top is kept because melodies are read from their highest note.
function initialScrollTop(grid: NoteGrid, rowH: number, viewportH: number) {
  const indexOf = new Map(grid.rows.map((r, i) => [r.id, i]));
  const noteRows = grid.notes.flatMap((n) => indexOf.get(n.row_id) ?? []);
  let first: number;
  let last: number;
  if (noteRows.length) {
    first = Math.min(...noteRows);
    last = Math.max(...noteRows);
  } else {
    first = last = grid.rows.findIndex((r) => r.midi_note === MIDDLE_C);
    if (first < 0) return 0;
  }
  const rangeH = (last - first + 1) * rowH;
  if (rangeH >= viewportH) return first * rowH;
  return Math.max(0, first * rowH - (viewportH - rangeH) / 2);
}

function groupByMeasure(notes: Note[], spm: number, measures: number) {
  const starting: Note[][] = Array.from({ length: measures }, () => []);
  const carry: Note[][] = Array.from({ length: measures }, () => []);
  for (const n of notes) {
    const first = Math.floor(n.step / spm);
    const last = Math.floor((n.step + n.length_steps - 1) / spm);
    starting[first]?.push(n);
    for (let m = first + 1; m <= last && m < measures; m++) carry[m].push(n);
  }
  return { starting, carry };
}

const DEFAULT_FRAME = "max-h-[70vh] rounded-xl border border-zinc-200 dark:border-zinc-800";
const FILLED_FRAME = "min-h-0 flex-1 rounded-t-xl border border-zinc-200 dark:border-zinc-800";

export function PianoRoll({
  instrumentName,
  kind = "drums",
  sustained = false,
  onAudition,
  grid,
  timeSignature,
  stepsPerMeasure: spm,
  resetKey,
  onToggleNote,
  onSetVelocity,
  onResizeNote,
  onMoveNote,
  onPlaceNote,
  loop,
  follow,
  isPlaying,
  onManualScroll,
  subscribePosition,
  className,
  gutterClassName,
  corner: cornerContent,
  beatLabels,
  describedBy,
  scrollerRef,
  fillHeight = false,
}: {
  instrumentName: string;
  kind?: InstrumentKind;
  sustained?: boolean;
  onAudition?: (row: Row) => void;
  grid: NoteGrid;
  timeSignature: TimeSignature;
  stepsPerMeasure: number;
  // Changes when a whole document is loaded, so edits never move the viewport under the user.
  resetKey: number | string;
  onToggleNote: (rowId: string, step: number, defaultLength?: number) => void;
  onSetVelocity: (rowId: string, step: number, velocity: number) => void;
  onResizeNote: (rowId: string, step: number, lengthSteps: number) => void;
  onMoveNote: (rowId: string, step: number, toRowId: string) => void;
  onPlaceNote?: (row: Row, velocity: number) => void;
  loop: LoopRange;
  follow: boolean;
  isPlaying: boolean;
  onManualScroll: () => void;
  subscribePosition: Playback["subscribePosition"];
  // Replaces the default bordered frame so a host can make the roll fill its region.
  className?: string;
  gutterClassName?: string;
  corner?: ReactNode;
  beatLabels?: boolean;
  // Lets a host add context the grid alone doesn't convey, such as that edits reach several clips.
  describedBy?: string;
  // Lets a host scroll the roll, e.g. to jump to a measure picked elsewhere.
  scrollerRef?: Ref<HTMLDivElement>;
  // Lets a host that sizes the roll (a resize handle) replace the fixed height cap.
  fillHeight?: boolean;
}) {
  const helpId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  useImperativeHandle(scrollerRef, () => scroller.current!);
  const labels = useRef<HTMLDivElement>(null);
  const corner = useRef<HTMLDivElement>(null);
  const latest = useRef({ grid, onToggleNote, onSetVelocity, onResizeNote, onMoveNote, onPlaceNote });
  const followRef = useRef(follow);
  const labelWidth = useRef(0);
  const [active, setActive] = useState<ActiveCell>({ row: 0, step: 0 });
  const [announcement, setAnnouncement] = useState("");
  const beat = beatSteps(timeSignature);
  const total = grid.totalSteps;
  const measures = total / spm;
  const melodic = kind === "melodic";
  const noteLength = defaultNoteLength(sustained, timeSignature);
  const { starting, carry } = useMemo(
    () => groupByMeasure(grid.notes, spm, measures),
    [grid.notes, spm, measures],
  );

  // Handlers read through a ref so the actions object, and with it every memoized column, stays stable.
  const actions = useMemo<NoteActions>(
    () => ({
      toggle: (rowId, step, len) => latest.current.onToggleNote(rowId, step, len),
      setVelocity: (rowId, step, v) => latest.current.onSetVelocity(rowId, step, v),
      resize: (rowId, step, len) => latest.current.onResizeNote(rowId, step, len),
      move: (rowId, step, toRowId) => latest.current.onMoveNote(rowId, step, toRowId),
      rows: () => latest.current.grid.rows,
      canMove: (note, toRowId) => {
        const g = latest.current.grid;
        return note.row_id === toRowId || moveGridNote(g, note.row_id, note.step, toRowId) !== g.notes;
      },
      placed: (row, velocity) => latest.current.onPlaceNote?.(row, velocity),
      maxLength: (note) => {
        const g = latest.current.grid;
        const nextStart = g.notes
          .filter((n) => n.row_id === note.row_id && n.step > note.step)
          .reduce((min, n) => Math.min(min, n.step), g.totalSteps);
        return nextStart - note.step;
      },
    }),
    [],
  );

  // A resize or undo can shrink the grid below the remembered cell; fall back so the roll always has a tab stop.
  const safeActive =
    active.row < grid.rows.length && active.step < total ? active : { row: 0, step: 0 };

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  // Layout effects run before passive ones, so the scroll effect below must see the grid from this same commit.
  useLayoutEffect(() => {
    latest.current = { grid, onToggleNote, onSetVelocity, onResizeNote, onMoveNote, onPlaceNote };
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !melodic) return;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    const rowH = coarse ? MELODIC_ROW_H_COARSE_PX : MELODIC_ROW_H_PX;
    const rulerH = corner.current?.offsetHeight ?? 0;
    el.scrollTop = initialScrollTop(latest.current.grid, rowH, el.clientHeight - rulerH);
  }, [resetKey, melodic]);

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
    const r = Math.min(grid.rows.length - 1, Math.max(0, row));
    const s = Math.min(total - 1, Math.max(0, step));
    setActive({ row: r, step: s });
    const el = root.querySelector<HTMLElement>(`[data-cell="${r}:${s}"]`);
    el?.focus();
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Browser and OS shortcuts such as Cmd+V must not be read as editor keys.
    if (e.metaKey || e.ctrlKey) return;
    const target = e.target as HTMLElement;
    const raw = target.getAttribute?.("data-cell");
    if (!raw) return;
    const [row, step] = raw.split(":").map(Number);
    const rowId = grid.rows[row].id;
    const covering = grid.notes.find((n) => n.row_id === rowId && noteCovers(n, step));
    const root = e.currentTarget;
    const stop = () => e.preventDefault();

    if (e.altKey) {
      if (!covering || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      stop();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      // The keyboard path must land where a drag would, so it applies the same skip-occupied-rows rule.
      for (let i = row + dir; i >= 0 && i < grid.rows.length; i += dir) {
        if (moveGridNote(grid, rowId, covering.step, grid.rows[i].id) === grid.notes) continue;
        onMoveNote(rowId, covering.step, grid.rows[i].id);
        onPlaceNote?.(grid.rows[i], covering.velocity);
        focusCell(i, step, root);
        setAnnouncement(`Moved to ${grid.rows[i].name}`);
        break;
      }
      return;
    }

    if (e.shiftKey && covering) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        stop();
        onSetVelocity(rowId, covering.step, covering.velocity + (e.key === "ArrowUp" ? 10 : -10));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        stop();
        onResizeNote(rowId, covering.step, covering.length_steps + (e.key === "ArrowRight" ? 1 : -1));
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
        if (covering) onToggleNote(rowId, step);
        break;
      case "v":
      case "V":
        if (covering) {
          stop();
          onSetVelocity(rowId, covering.step, nextVelocityPreset(covering.velocity));
        }
        break;
    }
  }

  return (
    <>
      <p id={helpId} className="sr-only">
        Arrow keys move between steps. Enter adds or removes a note. Shift plus Up or Down changes
        velocity. Shift plus Left or Right changes length. Alt plus Up or Down moves the note to
        another row. Space plays or stops.
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div
        role="group"
        aria-roledescription="piano roll"
        aria-label={`${instrumentName} piano roll`}
        aria-describedby={describedBy ? `${helpId} ${describedBy}` : helpId}
        ref={scroller}
        onKeyDown={onKeyDown}
        onWheel={(e) => Math.abs(e.deltaX) > Math.abs(e.deltaY) && userScrolled()}
        onTouchStart={userScrolled}
        onPointerDown={(e) => e.target === e.currentTarget && userScrolled()}
        className={`relative ${className ?? `${fillHeight ? FILLED_FRAME : DEFAULT_FRAME} ${melodic ? "scroll-pl-16 max-sm:scroll-pl-14" : "scroll-pl-28 max-sm:scroll-pl-20"}`} overflow-auto overscroll-x-contain [--cell-w:28px] ${melodic ? "[--row-h:18px] pointer-coarse:[--row-h:24px]" : "[--row-h:32px] pointer-coarse:[--row-h:40px]"}`}
      >
        <div className="relative grid w-max grid-cols-[auto_1fr]">
          <div ref={corner} className="sticky top-0 left-0 z-40 border-r border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950">
            {cornerContent}
          </div>
          <MeasureRuler measures={measures} stepsPerMeasure={spm} beatSteps={beat} loop={loop} beatLabels={beatLabels} />
          <RowLabels
            ref={labels}
            rows={grid.rows}
            kind={kind}
            onAudition={onAudition}
            gutterClassName={gutterClassName}
          />
          <div className="relative flex">
            {starting.map((notes, m) => (
              <MeasureColumn
                key={m}
                actions={actions}
                measureIndex={m}
                rows={grid.rows}
                stepsPerMeasure={spm}
                beatSteps={beat}
                notes={notes.length ? notes : NO_NOTES}
                carryIn={carry[m].length ? carry[m] : NO_NOTES}
                activeCell={Math.floor(safeActive.step / spm) === m ? safeActive : null}
                shadeBlackRows={melodic}
                noteLength={noteLength}
              />
            ))}
            <LoopShade loop={loop} measures={measures} stepsPerMeasure={spm} />
            <Playhead subscribePosition={subscribePosition} />
          </div>
        </div>
      </div>
    </>
  );
}
