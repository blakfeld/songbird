import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { MeasureCount } from "@/generated/MeasureCount";
import type { Note } from "@/generated/Note";
import type { Pattern } from "@/generated/Pattern";
import type { Row } from "@/generated/Row";
import type { TimeSignature } from "@/generated/TimeSignature";

export const DEFAULT_VELOCITY = 100;
export const TEMPO_RANGE = { min: 40, max: 240 } as const;
export const SWING_RANGE = { min: 0, max: 0.75 } as const;

export const STEPS_PER_MEASURE: Record<TimeSignature, number> = {
  "4/4": 16,
  "3/4": 12,
  "6/8": 12,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const totalSteps = (p: Pattern) => p.measures * p.steps_per_measure;

// Shared by patterns and song tracks so both edit notes with identical rules.
export interface NoteGrid {
  notes: Note[];
  rows: Row[];
  totalSteps: number;
}

export const gridOf = (p: Pattern): NoteGrid => ({
  notes: p.notes,
  rows: p.rows,
  totalSteps: totalSteps(p),
});

const covers = (n: Note, step: number) =>
  step >= n.step && step < n.step + n.length_steps;

function findCovering(notes: Note[], rowId: string, step: number) {
  return notes.find((n) => n.row_id === rowId && covers(n, step));
}

const nextStartAfter = (g: NoteGrid, rowId: string, step: number) =>
  g.notes
    .filter((n) => n.row_id === rowId && n.step > step)
    .reduce((min, n) => Math.min(min, n.step), g.totalSteps);

// Grid ops return the same notes array on no-ops so the store can skip pointless undo entries.
export function toggleGridNote(
  g: NoteGrid,
  rowId: string,
  step: number,
  defaultLength = 1,
): Note[] {
  if (!g.rows.some((r) => r.id === rowId)) return g.notes;
  if (!Number.isInteger(step) || step < 0 || step >= g.totalSteps) return g.notes;
  const existing = findCovering(g.notes, rowId, step);
  if (existing) return g.notes.filter((n) => n !== existing);
  const added: Note = {
    row_id: rowId,
    step,
    length_steps: Math.max(
      1,
      Math.min(defaultLength, nextStartAfter(g, rowId, step) - step),
    ),
    velocity: DEFAULT_VELOCITY,
  };
  return [...g.notes, added];
}

export function setGridVelocity(
  g: NoteGrid,
  rowId: string,
  step: number,
  velocity: number,
): Note[] {
  const target = findCovering(g.notes, rowId, step);
  if (!target) return g.notes;
  const next = clamp(Math.round(velocity), 1, 127);
  if (next === target.velocity) return g.notes;
  return g.notes.map((n) => (n === target ? { ...n, velocity: next } : n));
}

export function resizeGridNote(
  g: NoteGrid,
  rowId: string,
  step: number,
  lengthSteps: number,
): Note[] {
  const target = g.notes.find((n) => n.row_id === rowId && n.step === step);
  if (!target) return g.notes;
  const next = clamp(
    Math.round(lengthSteps),
    1,
    nextStartAfter(g, rowId, step) - step,
  );
  if (next === target.length_steps) return g.notes;
  return g.notes.map((n) =>
    n === target ? { ...n, length_steps: next } : n,
  );
}

// A row never holds two notes at one step, so row and step alone identify a note, which lets selection and clipboard share one key.
export const noteKey = (n: Pick<Note, "row_id" | "step">) => `${n.row_id}:${n.step}`;

const overlaps = (a: Note, b: Note) =>
  a.row_id === b.row_id &&
  a.step < b.step + b.length_steps &&
  b.step < a.step + a.length_steps;

export interface NotesResult {
  notes: Note[];
  keys: Set<string>;
}

// dRow indexes into `rows`, so callers decide which screen direction is positive.
// Null (not a clamped result) lets a drag keep its last valid position instead of sliding along a wall.
export function moveNotes(
  notes: Note[],
  keys: ReadonlySet<string>,
  dStep: number,
  dRow: number,
  rows: Row[],
  totalSteps: number,
): NotesResult | null {
  const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
  const moved: Note[] = [];
  const unmoved: Note[] = [];
  const next: Note[] = [];
  for (const n of notes) {
    if (!keys.has(noteKey(n))) {
      unmoved.push(n);
      next.push(n);
      continue;
    }
    const from = rowIndex.get(n.row_id);
    const target = from === undefined ? undefined : rows[from + dRow];
    const step = n.step + dStep;
    if (!target || step < 0 || step + n.length_steps > totalSteps) return null;
    const m = { ...n, row_id: target.id, step };
    moved.push(m);
    next.push(m);
  }
  if (moved.some((m) => unmoved.some((u) => overlaps(m, u)))) return null;
  return { notes: next, keys: new Set(moved.map(noteKey)) };
}

// Returns the same array on a no-op so the store skips an undo entry.
export function setVelocities(
  notes: Note[],
  keys: ReadonlySet<string>,
  velocity: number,
): Note[] {
  const v = clamp(Math.round(velocity), 1, 127);
  if (!notes.some((n) => keys.has(noteKey(n)) && n.velocity !== v)) return notes;
  return notes.map((n) => (keys.has(noteKey(n)) ? { ...n, velocity: v } : n));
}

// Limits come from the original neighbours, so a selected run can't grow over notes that were moved nowhere.
export function setLengths(
  notes: Note[],
  keys: ReadonlySet<string>,
  length: number,
  totalSteps: number,
): Note[] {
  const want = Math.max(1, Math.round(length));
  let changed = false;
  const out = notes.map((n) => {
    if (!keys.has(noteKey(n))) return n;
    const limit = notes
      .filter((o) => o.row_id === n.row_id && o.step > n.step)
      .reduce((min, o) => Math.min(min, o.step), totalSteps);
    const next = clamp(want, 1, Math.max(1, limit - n.step));
    if (next === n.length_steps) return n;
    changed = true;
    return { ...n, length_steps: next };
  });
  return changed ? out : notes;
}

// An empty or null lyric removes the field so a note without one serializes exactly as it did before lyrics existed.
export function setLyrics(notes: Note[], keys: ReadonlySet<string>, lyric: string | null): Note[] {
  const next = lyric === "" ? null : lyric;
  let changed = false;
  const out = notes.map((n) => {
    if (!keys.has(noteKey(n)) || (n.lyric ?? null) === next) return n;
    changed = true;
    const { lyric: _previous, ...rest } = n;
    void _previous;
    return next === null ? rest : { ...rest, lyric: next };
  });
  return changed ? out : notes;
}

export const clearLyrics = (notes: Note[], keys: ReadonlySet<string>): Note[] => setLyrics(notes, keys, null);

// A relative change keeps spread between notes during a Shift-drag, which absolute `setVelocities` would flatten.
export function shiftVelocities(
  notes: Note[],
  keys: ReadonlySet<string>,
  delta: number,
): Note[] {
  if (delta === 0 || !notes.some((n) => keys.has(noteKey(n)))) return notes;
  return notes.map((n) =>
    keys.has(noteKey(n)) ? { ...n, velocity: clamp(n.velocity + delta, 1, 127) } : n,
  );
}

export function deleteNotes(notes: Note[], keys: ReadonlySet<string>): Note[] {
  return keys.size === 0 || !notes.some((n) => keys.has(noteKey(n)))
    ? notes
    : notes.filter((n) => !keys.has(noteKey(n)));
}

// Incoming notes win collisions so a bulk add never leaves overlapping notes on a row.
// They are applied in start order so an incoming note also shortens an earlier incoming one.
export function mergeNotes(existing: Note[], incoming: Note[]): Note[] {
  let out = existing;
  for (const inc of [...incoming].sort((a, b) => a.step - b.step)) {
    out = out.flatMap((n) => {
      if (n.row_id !== inc.row_id || !overlaps(n, inc)) return [n];
      const length = inc.step - n.step;
      return length > 0 ? [{ ...n, length_steps: length }] : [];
    });
    out = [...out, inc];
  }
  return out;
}

export interface PasteResult extends NotesResult {
  dropped: number;
}

// Clip steps are relative to its earliest note so a paste can anchor the block at any step.
export function pasteNotes(
  existing: Note[],
  clip: Note[],
  at: number,
  rows: Row[],
  totalSteps: number,
): PasteResult {
  const rowIds = new Set(rows.map((r) => r.id));
  const placed: Note[] = [];
  for (const n of clip) {
    const step = n.step + at;
    if (!rowIds.has(n.row_id) || step < 0 || step >= totalSteps) continue;
    placed.push({ ...n, step, length_steps: Math.min(n.length_steps, totalSteps - step) });
  }
  return {
    notes: placed.length === 0 ? existing : mergeNotes(existing, placed),
    keys: new Set(placed.map(noteKey)),
    dropped: clip.length - placed.length,
  };
}

const withNotes = (p: Pattern, notes: Note[]): Pattern =>
  notes === p.notes ? p : { ...p, notes };

export const toggleNote = (
  p: Pattern,
  rowId: string,
  step: number,
  defaultLength = 1,
): Pattern => withNotes(p, toggleGridNote(gridOf(p), rowId, step, defaultLength));

export const setVelocity = (
  p: Pattern,
  rowId: string,
  step: number,
  velocity: number,
): Pattern => withNotes(p, setGridVelocity(gridOf(p), rowId, step, velocity));

export const resizeNote = (
  p: Pattern,
  rowId: string,
  step: number,
  lengthSteps: number,
): Pattern => withNotes(p, resizeGridNote(gridOf(p), rowId, step, lengthSteps));

// Repeating measures can push a crossing note over the next note or the end, so lengths are re-clamped.
export function normalizeNotes(notes: Note[], total: number): Note[] {
  const byRow = new Map<string, Note[]>();
  for (const n of notes) {
    if (n.step >= total) continue;
    byRow.set(n.row_id, [...(byRow.get(n.row_id) ?? []), n]);
  }
  const out: Note[] = [];
  for (const rowNotes of byRow.values()) {
    rowNotes.sort((a, b) => a.step - b.step);
    rowNotes.forEach((n, i) => {
      const limit = rowNotes[i + 1]?.step ?? total;
      out.push({ ...n, length_steps: Math.min(n.length_steps, limit - n.step) });
    });
  }
  return out.sort((a, b) => a.step - b.step || a.row_id.localeCompare(b.row_id));
}

export function setMeasures(p: Pattern, measures: MeasureCount): Pattern {
  if (measures === p.measures) return p;
  const spm = p.steps_per_measure;
  const total = measures * spm;
  let notes = p.notes;
  if (measures > p.measures) {
    const repeated: Note[] = [...p.notes];
    for (let m = p.measures; m < measures; m++) {
      const source = m % p.measures;
      const shift = (m - source) * spm;
      for (const n of p.notes) {
        if (Math.floor(n.step / spm) === source) {
          repeated.push({ ...n, step: n.step + shift });
        }
      }
    }
    notes = repeated;
  }
  return { ...p, measures, notes: normalizeNotes(notes, total) };
}

export function setTempo(p: Pattern, tempo: number): Pattern {
  const next = clamp(Math.round(tempo), TEMPO_RANGE.min, TEMPO_RANGE.max);
  return next === p.tempo_bpm ? p : { ...p, tempo_bpm: next };
}

export function setSwing(p: Pattern, swing: number): Pattern {
  const next = clamp(swing, SWING_RANGE.min, SWING_RANGE.max);
  return next === p.swing ? p : { ...p, swing: next };
}

export function clearNotes(p: Pattern): Pattern {
  return p.notes.length === 0 ? p : { ...p, notes: [] };
}

export function emptyPattern(
  instrument: InstrumentInfo,
  measures: MeasureCount,
  timeSignature: TimeSignature = "4/4",
  tempoBpm = 120,
): Pattern {
  return {
    version: 1,
    instrument: instrument.id,
    name: `New ${instrument.name} pattern`,
    tempo_bpm: tempoBpm,
    time_signature: timeSignature,
    measures,
    steps_per_measure: STEPS_PER_MEASURE[timeSignature],
    swing: 0,
    midi_channel: instrument.midi_channel,
    midi_program: instrument.midi_program,
    rows: instrument.rows,
    notes: [],
  };
}
