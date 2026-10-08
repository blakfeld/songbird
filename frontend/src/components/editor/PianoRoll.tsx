"use client";

import { createPortal } from "react-dom";
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
import type { Playback } from "@/lib/audio/types";
import type { LoopSetting } from "@/lib/loopRegion";
import {
  beatSteps,
  CELL_W_PX,
  defaultNoteLength,
  isTextEntryTarget,
  nextVelocityPreset,
  noteCovers,
} from "@/lib/pianoRoll";
import { copyNotes, getClip, markPasted, nextPasteStep } from "@/lib/noteClipboard";
import { rowTint, type KeyHighlight } from "@/lib/music/key";
import {
  DEFAULT_VELOCITY,
  deleteNotes,
  moveNotes,
  noteKey,
  pasteNotes,
  setLengths,
  setVelocities,
  setLyrics,
  clearLyrics,
  shiftVelocities,
  type NoteGrid,
} from "@/lib/patternOps";
import { LoopRegion } from "./LoopRegion";
import { LoopShade } from "./LoopShade";
import { MeasureColumn, type ActiveCell } from "./MeasureColumn";
import { MeasureRuler } from "./MeasureRuler";
import { NoteInspector } from "./NoteInspector";
import type { NoteActions } from "./noteActions";
import { Playhead } from "./Playhead";
import { RowLabels } from "./RowLabels";

const NO_NOTES: Note[] = [];
const MIDDLE_C = 60;
const MELODIC_ROW_H_PX = 18;
const MELODIC_ROW_H_COARSE_PX = 24;
const DRUM_ROW_H_PX = 32;
const DRUM_ROW_H_COARSE_PX = 40;
// Below this a press is a click, not a drag, so a shaky click still selects the note.
const DRAG_THRESHOLD_PX = 4;
const NO_KEYS: ReadonlySet<string> = new Set();

// Mirrors the --row-h classes below: the drag maths run on pointer deltas, which jsdom and layout-free tests can't measure.
function rowHeightPx(melodic: boolean) {
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  if (melodic) return coarse ? MELODIC_ROW_H_COARSE_PX : MELODIC_ROW_H_PX;
  return coarse ? DRUM_ROW_H_COARSE_PX : DRUM_ROW_H_PX;
}

const plural = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
const clampNumber = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Moved {
  notes: Note[];
  keys: ReadonlySet<string>;
}

interface MarqueeBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// A move preview re-keys the dragged note, so the roll owns the gesture rather than the bar that started it.
type Session =
  | {
      kind: "marquee";
      x: number;
      y: number;
      originX: number;
      originY: number;
      additive: boolean;
      active: boolean;
      baseSelection: ReadonlySet<string>;
    }
  | {
      kind: "note";
      note: Note;
      x: number;
      y: number;
      shift: boolean;
      mod: boolean;
      began: boolean;
      mode: "move" | "velocity";
      rowH: number;
      rowIndex: number;
      base: Note[];
      keys: ReadonlySet<string>;
      baseSelection: ReadonlySet<string>;
      dStep: number;
      dRow: number;
      result: Moved | null;
    };

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
  onEditNotes,
  onBeginGesture,
  onEndGesture,
  onCancelGesture,
  onPlaceNote,
  loop,
  onLoopChange,
  follow,
  isPlaying,
  onManualScroll,
  subscribePosition,
  className,
  gutterClassName,
  renderRowLabels,
  corner: cornerContent,
  beatLabels,
  describedBy,
  scrollerRef,
  fillHeight = false,
  keyHighlight,
  inspectorTarget,
  inspectorCompact = false,
  onAnnounce,
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
  // Multi-note edits go through one generic callback so each page keeps its own undo model.
  onEditNotes: (fn: (grid: NoteGrid) => Note[], options?: { transient?: boolean }) => void;
  // A drag previews through transient edits, so the host brackets it to make it one undo step.
  onBeginGesture: () => void;
  onEndGesture: () => void;
  onCancelGesture: () => void;
  onPlaceNote?: (row: Row, velocity: number) => void;
  // Without both, the ruler is static, as in the Studio dock where the song's region does not apply.
  loop?: LoopSetting;
  onLoopChange?: (loop: LoopSetting) => void;
  follow: boolean;
  isPlaying: boolean;
  onManualScroll: () => void;
  subscribePosition: Playback["subscribePosition"];
  // Replaces the default bordered frame so a host can make the roll fill its region.
  className?: string;
  gutterClassName?: string;
  // Lets a host own the label column, as a sampler does to put a drop target on each pad.
  renderRowLabels?: (props: { rows: Row[]; gutterClassName?: string }) => ReactNode;
  corner?: ReactNode;
  beatLabels?: boolean;
  // Lets a host add context the grid alone doesn't convey, such as that edits reach several clips.
  describedBy?: string;
  // Lets a host scroll the roll, e.g. to jump to a measure picked elsewhere.
  scrollerRef?: Ref<HTMLDivElement>;
  // Lets a host that sizes the roll (a resize handle) replace the fixed height cap.
  fillHeight?: boolean;
  // Studio melodic tracks only; the roll itself stays unaware of where the key comes from.
  keyHighlight?: KeyHighlight;
  // The roll owns the selection, so it renders the inspector into a slot the host places in its own toolbar.
  inspectorTarget?: HTMLElement | null;
  inspectorCompact?: boolean;
  // Outcomes a sighted user must also see, such as how many pasted notes were discarded.
  onAnnounce?: (message: string) => void;
}) {
  const helpId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  useImperativeHandle(scrollerRef, () => scroller.current!);
  const labels = useRef<HTMLDivElement>(null);
  const corner = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ grid, onToggleNote, onSetVelocity, onResizeNote, onPlaceNote });
  const api = useRef<Pick<NoteActions, "pressNote" | "removeNote" | "clickCell">>({
    pressNote: () => {},
    removeNote: () => {},
    clickCell: () => {},
  });
  const pointer = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    cancel: () => void;
  }>({ move: () => {}, up: () => {}, cancel: () => {} });
  const session = useRef<Session | null>(null);
  const selectionRef = useRef<ReadonlySet<string>>(NO_KEYS);
  const suppressClick = useRef(false);
  const hoverStep = useRef<number | null>(null);
  const [selection, setSelectionState] = useState<ReadonlySet<string>>(NO_KEYS);
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  const [seenSpm, setSeenSpm] = useState(spm);
  const [seenNotes, setSeenNotes] = useState(grid.notes);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  const [dragMode, setDragMode] = useState<"move" | "velocity" | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const followRef = useRef(follow);
  const labelWidth = useRef(0);
  const [active, setActive] = useState<ActiveCell>({ row: 0, step: 0 });
  const [announcement, setAnnouncement] = useState("");
  const beat = beatSteps(timeSignature);
  const total = grid.totalSteps;
  const measures = total / spm;
  const melodic = kind === "melodic";
  const rowTints = useMemo(
    () => (keyHighlight ? grid.rows.map((r) => rowTint(keyHighlight, r)) : undefined),
    [keyHighlight, grid.rows],
  );
  const noteLength = defaultNoteLength(sustained, timeSignature);

  // A different pattern or loop must not inherit keys that may now name unrelated notes.
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    setSelectionState(NO_KEYS);
  }
  // Keys are row and step, so a new step width remaps every one of them onto a different note.
  if (seenSpm !== spm) {
    setSeenSpm(spm);
    setSeenNotes(grid.notes);
    setSelectionState(NO_KEYS);
  } else if (seenNotes !== grid.notes) {
    // Undo, redo or the host can change notes behind the roll's back; the roll's own edits update the keys in
    // the same batch, so anything still unmatched here is stale and could later name an unrelated note.
    setSeenNotes(grid.notes);
    const live = new Set(grid.notes.map(noteKey));
    const kept = [...selection].filter((k) => live.has(k));
    if (kept.length !== selection.size) setSelectionState(new Set(kept));
  }
  const selectedNotes = useMemo(
    () => grid.notes.filter((n) => selection.has(noteKey(n))),
    [grid.notes, selection],
  );
  const selectionSignatures = useMemo(() => {
    const sigs = Array.from({ length: measures }, () => "");
    for (const n of selectedNotes) {
      const first = Math.floor(n.step / spm);
      const last = Math.floor((n.step + n.length_steps - 1) / spm);
      for (let m = first; m <= last && m < measures; m++) sigs[m] += `${noteKey(n)}|`;
    }
    return sigs;
  }, [selectedNotes, spm, measures]);
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
      rows: () => latest.current.grid.rows,
      pressNote: (note, e) => api.current.pressNote(note, e),
      removeNote: (note) => api.current.removeNote(note),
      clickCell: (rowId, step, covering, e) => api.current.clickCell(rowId, step, covering, e),
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
    latest.current = { grid, onToggleNote, onSetVelocity, onResizeNote, onPlaceNote };
    selectionRef.current = selection;
  });

  // One document-level listener set outlives re-keyed bars, which pointer capture on a bar would not.
  useEffect(() => {
    const move = (e: PointerEvent) => pointer.current.move(e);
    const up = (e: PointerEvent) => pointer.current.up(e);
    const cancel = () => pointer.current.cancel();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") pointer.current.cancel();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key);
    };
  }, []);

  useEffect(() => {
    if (!dragMode) return;
    document.body.style.cursor = dragMode === "move" ? "grabbing" : "ns-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragMode]);

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
    // The corner shares the label column's grid track, so it has the gutter's width when a host owns the labels.
    const el = labels.current ?? corner.current;
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

  function select(next: ReadonlySet<string>) {
    selectionRef.current = next;
    setSelectionState(next);
  }

  const rowIndexOf = (rowId: string) => latest.current.grid.rows.findIndex((r) => r.id === rowId);
  const currentSelected = () =>
    latest.current.grid.notes.filter((n) => selectionRef.current.has(noteKey(n)));

  // A pointer-driven selection leaves focus on the page body, where Delete and Cmd+C would never reach the roll.
  function focusNote(note: Note) {
    const i = rowIndexOf(note.row_id);
    if (i >= 0 && scroller.current) focusCell(i, note.step, scroller.current);
  }

  function selectNote(note: Note, additive: boolean) {
    const key = noteKey(note);
    if (!additive) {
      select(new Set([key]));
    } else {
      const next = new Set(selectionRef.current);
      if (!next.delete(key)) next.add(key);
      select(next);
      setAnnouncement(`${plural(next.size)} selected`);
    }
    focusNote(note);
  }

  function removeKeys(keys: ReadonlySet<string>, count: number) {
    onEditNotes((g) => deleteNotes(g.notes, keys));
    select(NO_KEYS);
    setAnnouncement(`Removed ${plural(count)}`);
  }

  function removeNoteUnder(note: Note) {
    removeKeys(new Set([noteKey(note)]), 1);
  }

  function cellClick(rowId: string, step: number, covering: Note | undefined, e: React.MouseEvent) {
    // A marquee that ends over the cell it started on still produces a click, which must not add a note.
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (covering) {
      selectNote(covering, e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }
    onToggleNote(rowId, step, noteLength);
    const row = grid.rows.find((r) => r.id === rowId);
    if (row) onPlaceNote?.(row, DEFAULT_VELOCITY);
    select(NO_KEYS);
  }

  function pressNote(note: Note, e: React.PointerEvent) {
    suppressClick.current = false;
    session.current = {
      kind: "note",
      note,
      x: e.clientX,
      y: e.clientY,
      shift: e.shiftKey,
      mod: e.metaKey || e.ctrlKey,
      began: false,
      mode: e.shiftKey ? "velocity" : "move",
      rowH: rowHeightPx(melodic),
      rowIndex: rowIndexOf(note.row_id),
      base: latest.current.grid.notes,
      keys: NO_KEYS,
      baseSelection: selectionRef.current,
      dStep: 0,
      dRow: 0,
      result: null,
    };
  }

  function onGridPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) userScrolled();
    suppressClick.current = false;
    const target = e.target as HTMLElement;
    // A held cell lies under its bar, so only a free cell starts a selection box; touch keeps panning.
    if (e.button !== 0 || e.pointerType === "touch") return;
    if (target.getAttribute?.("data-cell") === null || target.getAttribute("aria-pressed") === "true") return;
    const rect = gridRef.current?.getBoundingClientRect();
    session.current = {
      kind: "marquee",
      x: e.clientX,
      y: e.clientY,
      originX: e.clientX - (rect?.left ?? 0),
      originY: e.clientY - (rect?.top ?? 0),
      additive: e.shiftKey,
      active: false,
      baseSelection: selectionRef.current,
    };
  }

  function onGridPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const cell = (e.target as HTMLElement).closest?.("[data-cell]")?.getAttribute("data-cell");
    if (cell) {
      hoverStep.current = Number(cell.split(":")[1]);
      return;
    }
    const rect = gridRef.current?.getBoundingClientRect();
    const step = rect ? Math.floor((e.clientX - rect.left) / CELL_W_PX) : -1;
    hoverStep.current = step >= 0 && step < total ? step : null;
  }

  function noteMove(s: Extract<Session, { kind: "note" }>, e: PointerEvent) {
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const g = latest.current.grid;
    if (!s.began) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      s.began = true;
      const key = noteKey(s.note);
      // Dragging an unselected note moves only that note, but a selected one carries its whole selection.
      s.keys = selectionRef.current.has(key) ? selectionRef.current : new Set([key]);
      if (s.keys !== selectionRef.current) select(s.keys);
      s.base = g.notes;
      s.result = { notes: s.base, keys: s.keys };
      onBeginGesture();
      setDragMode(s.mode);
      focusNote(s.note);
    }

    if (s.mode === "velocity") {
      const delta = Math.round(-dy * (e.altKey ? 0.25 : 1));
      const next = shiftVelocities(s.base, s.keys, delta);
      onEditNotes(() => next, { transient: true });
      setTip({
        x: s.note.step * CELL_W_PX,
        y: s.rowIndex * s.rowH,
        text: `Vel ${clampNumber(s.note.velocity + delta, 1, 127)}`,
      });
      return;
    }

    const targetStep = Math.round(dx / CELL_W_PX);
    const targetRow = Math.round(dy / s.rowH);
    const attempt = (dStep: number, dRow: number): Moved | null =>
      dStep === 0 && dRow === 0
        ? { notes: s.base, keys: s.keys }
        : moveNotes(s.base, s.keys, dStep, dRow, g.rows, g.totalSteps);
    const jump = () => {
      if (targetStep === s.dStep) return;
      const r = attempt(targetStep, s.dRow);
      if (r) {
        s.dStep = targetStep;
        s.result = r;
      }
    };
    jump();
    // Walking row by row, rather than jumping, is what lets blocked rows be skipped and each entered row be heard.
    const dir = Math.sign(targetRow - s.dRow);
    for (let r = s.dRow + dir; dir !== 0 && (dir > 0 ? r <= targetRow : r >= targetRow); r += dir) {
      const result = attempt(s.dStep, r);
      if (!result) continue;
      s.dRow = r;
      s.result = result;
      const row = g.rows[s.rowIndex + r];
      if (r !== 0 && row) onPlaceNote?.(row, s.note.velocity);
    }
    // Leaving a blocked row can open a horizontal position that was refused while the notes were still in it.
    jump();

    const result = s.result;
    if (!result) return;
    onEditNotes(() => result.notes, { transient: true });
    select(result.keys);
    const row = g.rows[s.rowIndex + s.dRow];
    const step = s.note.step + s.dStep;
    const local = step % spm;
    setTip({
      x: step * CELL_W_PX,
      y: (s.rowIndex + s.dRow) * s.rowH,
      text: `${row?.name ?? ""} \u00b7 ${Math.floor(step / spm) + 1}.${Math.floor(local / beat) + 1}.${(local % beat) + 1}`,
    });
  }

  function onPointerMove(e: PointerEvent) {
    const s = session.current;
    if (!s) return;
    if (s.kind === "note") return noteMove(s, e);
    if (!s.active) {
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD_PX) return;
      s.active = true;
    }
    const rect = gridRef.current?.getBoundingClientRect();
    setMarquee({
      x0: s.originX,
      y0: s.originY,
      x1: e.clientX - (rect?.left ?? 0),
      y1: e.clientY - (rect?.top ?? 0),
    });
  }

  function finishMarquee(s: Extract<Session, { kind: "marquee" }>, box: MarqueeBox) {
    const g = latest.current.grid;
    const rowH = rowHeightPx(melodic);
    const s0 = Math.floor(Math.min(box.x0, box.x1) / CELL_W_PX);
    const s1 = Math.floor(Math.max(box.x0, box.x1) / CELL_W_PX);
    const r0 = Math.floor(Math.min(box.y0, box.y1) / rowH);
    const r1 = Math.floor(Math.max(box.y0, box.y1) / rowH);
    // Cell units rather than pixels, so a note counts as touched whenever the box reaches any cell it covers.
    const next = new Set(s.additive ? s.baseSelection : NO_KEYS);
    for (const n of g.notes) {
      const r = g.rows.findIndex((row) => row.id === n.row_id);
      if (r >= r0 && r <= r1 && n.step <= s1 && n.step + n.length_steps - 1 >= s0) next.add(noteKey(n));
    }
    select(next);
    setAnnouncement(`${plural(next.size)} selected`);
    suppressClick.current = true;
    // Pointer down and up on different cells produce no click, so the flag would otherwise swallow the next
    // keyboard activation.
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    focusRoll();
  }

  function onPointerUp(e: PointerEvent) {
    const s = session.current;
    session.current = null;
    if (!s) return;
    if (s.kind === "marquee") {
      setMarquee(null);
      if (!s.active) return;
      const rect = gridRef.current?.getBoundingClientRect();
      finishMarquee(s, {
        x0: s.originX,
        y0: s.originY,
        x1: e.clientX - (rect?.left ?? 0),
        y1: e.clientY - (rect?.top ?? 0),
      });
      return;
    }
    if (s.began) {
      onEndGesture();
      setDragMode(null);
      setTip(null);
      return;
    }
    if (e.altKey) onSetVelocity(s.note.row_id, s.note.step, nextVelocityPreset(s.note.velocity));
    else selectNote(s.note, s.shift || s.mod);
  }

  function cancelSession() {
    const s = session.current;
    session.current = null;
    if (!s) return;
    if (s.kind === "marquee") {
      setMarquee(null);
      return;
    }
    if (s.began) {
      onCancelGesture();
      select(s.baseSelection);
      setDragMode(null);
      setTip(null);
    }
  }

  function focusRoll() {
    scroller.current?.querySelector<HTMLElement>('[data-cell][tabindex="0"]')?.focus({ preventScroll: true });
  }

  function copySelection(): number {
    return copyNotes(currentSelected());
  }

  function paste() {
    const clip = getClip();
    if (!clip) return false;
    const at = hoverStep.current ?? nextPasteStep();
    const g = latest.current.grid;
    const result = pasteNotes(g.notes, clip.notes, at, g.rows, g.totalSteps);
    const placed = clip.notes.length - result.dropped;
    if (placed > 0) {
      onEditNotes(() => result.notes);
      select(result.keys);
      markPasted(at, clip.span);
    }
    const message =
      `Pasted ${plural(placed)}.` +
      (result.dropped > 0 ? ` ${result.dropped} didn't fit and were left out.` : "");
    setAnnouncement(message);
    onAnnounce?.(message);
    return true;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Text fields keep their native copy, paste and delete.
    if (isTextEntryTarget(e.target)) return;
    // A key the roll consumes must not also fire a host-level shortcut bound to the same key.
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      switch (e.key.toLowerCase()) {
        case "a":
          handled();
          select(new Set(grid.notes.map(noteKey)));
          setAnnouncement(`${plural(grid.notes.length)} selected`);
          break;
        case "c":
          if (selectedNotes.length === 0) break;
          handled();
          setAnnouncement(`Copied ${plural(copySelection())}`);
          break;
        case "x":
          if (selectedNotes.length === 0) break;
          handled();
          copySelection();
          removeKeys(new Set(selectedNotes.map(noteKey)), selectedNotes.length);
          setAnnouncement(`Cut ${plural(selectedNotes.length)}`);
          break;
        case "v":
          if (getClip()) {
            handled();
            paste();
          }
          break;
      }
      return;
    }
    // Browser and OS shortcuts such as Cmd+Z must not be read as editor keys.
    if (e.metaKey || e.ctrlKey) return;

    if (e.key === "Escape") {
      if (session.current || selectionRef.current.size === 0) return;
      handled();
      select(NO_KEYS);
      setAnnouncement("Selection cleared");
      return;
    }

    const target = e.target as HTMLElement;
    const raw = target.getAttribute?.("data-cell");
    if (!raw) return;
    const [row, step] = raw.split(":").map(Number);
    const rowId = grid.rows[row].id;
    const covering = grid.notes.find((n) => n.row_id === rowId && noteCovers(n, step));
    const root = e.currentTarget;
    const stop = () => e.preventDefault();

    if (e.altKey) {
      const arrows: Record<string, [number, number]> = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      };
      const delta = arrows[e.key];
      if (!delta) return;
      const moving = selectedNotes.length > 0 ? new Set(selectedNotes.map(noteKey)) : covering ? new Set([noteKey(covering)]) : null;
      if (!moving) return;
      stop();
      const [dStep, dRow] = delta;
      const result = moveNotes(grid.notes, moving, dStep, dRow, grid.rows, total);
      if (!result) return;
      onEditNotes(() => result.notes);
      if (selectedNotes.length > 0) select(result.keys);
      const primary = covering && moving.has(noteKey(covering)) ? covering : grid.notes.find((n) => moving.has(noteKey(n)))!;
      const toRow = grid.rows[grid.rows.findIndex((r) => r.id === primary.row_id) + dRow];
      const toStep = primary.step + dStep;
      if (dRow !== 0) onPlaceNote?.(toRow, primary.velocity);
      focusCell(grid.rows.indexOf(toRow), covering === primary ? step + dStep : toStep, root);
      setAnnouncement(
        `Moved to ${toRow.name}, measure ${Math.floor(toStep / spm) + 1}, step ${(toStep % spm) + 1}`,
      );
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
        if (selectedNotes.length > 0) {
          handled();
          removeKeys(new Set(selectedNotes.map(noteKey)), selectedNotes.length);
        } else if (covering) {
          handled();
          removeKeys(new Set([noteKey(covering)]), 1);
        }
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

  // The handlers close over this render's props, so the stable listeners and actions must see the latest ones.
  useLayoutEffect(() => {
    api.current = { pressNote, removeNote: removeNoteUnder, clickCell: cellClick };
    pointer.current = { move: onPointerMove, up: onPointerUp, cancel: cancelSession };
  });

  return (
    <>
      <p id={helpId} className="sr-only">
        Arrow keys move between steps. Enter adds a note, or selects the note under the cursor.
        Shift plus Enter adds it to the selection. Command or Control A selects all notes. Escape
        clears the selection. Delete removes the selected notes. Alt plus an arrow key moves them.
        Shift plus Up or Down changes velocity. Shift plus Left or Right changes length. Command or
        Control C, X, and V copy, cut, and paste. Space plays or stops.
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
        onPointerDown={onGridPointerDown}
        className={`relative ${className ?? `${fillHeight ? FILLED_FRAME : DEFAULT_FRAME} ${melodic ? "scroll-pl-16 max-sm:scroll-pl-14" : "scroll-pl-28 max-sm:scroll-pl-20"}`} overflow-auto overscroll-x-contain [--cell-w:28px] ${melodic ? "[--row-h:18px] pointer-coarse:[--row-h:24px]" : "[--row-h:32px] pointer-coarse:[--row-h:40px]"}`}
      >
        <div className="relative grid w-max grid-cols-[auto_1fr]">
          <div ref={corner} className="sticky top-0 left-0 z-40 border-r border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950">
            {cornerContent}
          </div>
          <MeasureRuler measures={measures} stepsPerMeasure={spm} beatSteps={beat} beatLabels={beatLabels}>
            {loop && onLoopChange && (
              <LoopRegion
                loop={loop}
                measures={measures}
                stepsPerMeasure={spm}
                measurePx={spm * CELL_W_PX}
                onChange={onLoopChange}
              />
            )}
          </MeasureRuler>
          {renderRowLabels ? (
            renderRowLabels({ rows: grid.rows, gutterClassName })
          ) : (
            <RowLabels
              ref={labels}
              rows={grid.rows}
              kind={kind}
              onAudition={onAudition}
              gutterClassName={gutterClassName}
              keyHighlight={keyHighlight}
              rowTints={rowTints}
            />
          )}
          <div
            ref={gridRef}
            data-testid="roll-grid"
            // Hover is tracked on the grid alone so a pointer over the ruler or labels doesn't aim a paste.
            onPointerMove={onGridPointerMove}
            onPointerLeave={() => {
              hoverStep.current = null;
            }}
            className="relative flex"
          >
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
                rowTints={rowTints}
                selection={selection}
                selectionSignature={selectionSignatures[m]}
                moving={dragMode === "move"}
              />
            ))}
            {marquee && (
              <div
                aria-hidden="true"
                data-testid="marquee"
                className="pointer-events-none absolute z-20 rounded-[2px] border border-indigo-600 bg-indigo-600/10 dark:border-indigo-400 dark:bg-indigo-400/15"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}
            {tip && (
              <span
                aria-hidden="true"
                data-testid="drag-tip"
                className="pointer-events-none absolute z-50 -translate-y-full rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900"
                style={{ left: tip.x, top: tip.y }}
              >
                {tip.text}
              </span>
            )}
            {loop && <LoopShade loop={loop} measures={measures} stepsPerMeasure={spm} />}
            <Playhead subscribePosition={subscribePosition} />
          </div>
        </div>
      </div>
      {inspectorTarget &&
        createPortal(
          <NoteInspector
            notes={selectedNotes}
            onSetLyric={(lyric) => onEditNotes((g) => setLyrics(g.notes, selectionRef.current, lyric))}
            onClearLyrics={() => onEditNotes((g) => clearLyrics(g.notes, selectionRef.current))}
            oneShot={!sustained}
            compact={inspectorCompact}
            onSetVelocity={(v) => onEditNotes((g) => setVelocities(g.notes, selectionRef.current, v))}
            onSetLength={(l) =>
              onEditNotes((g) => setLengths(g.notes, selectionRef.current, l, g.totalSteps))
            }
          />,
          inspectorTarget,
        )}
    </>
  );
}
