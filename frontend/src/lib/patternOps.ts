import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { MeasureCount } from "@/generated/MeasureCount";
import type { Note } from "@/generated/Note";
import type { Pattern } from "@/generated/Pattern";
import type { TimeSignature } from "@/generated/TimeSignature";

export const DEFAULT_VELOCITY = 100;
export const TEMPO_RANGE = { min: 40, max: 240 } as const;
export const SWING_RANGE = { min: 0, max: 0.75 } as const;

const STEPS_PER_MEASURE: Record<TimeSignature, number> = {
  "4/4": 16,
  "3/4": 12,
  "6/8": 12,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const totalSteps = (p: Pattern) => p.measures * p.steps_per_measure;

const covers = (n: Note, step: number) =>
  step >= n.step && step < n.step + n.length_steps;

function findCovering(p: Pattern, rowId: string, step: number) {
  return p.notes.find((n) => n.row_id === rowId && covers(n, step));
}

// Returning the same reference on no-ops lets the store skip pointless undo entries.
export function toggleNote(
  p: Pattern,
  rowId: string,
  step: number,
  defaultLength = 1,
): Pattern {
  if (!p.rows.some((r) => r.id === rowId)) return p;
  if (!Number.isInteger(step) || step < 0 || step >= totalSteps(p)) return p;
  const existing = findCovering(p, rowId, step);
  if (existing) return { ...p, notes: p.notes.filter((n) => n !== existing) };
  const nextStart = p.notes
    .filter((n) => n.row_id === rowId && n.step > step)
    .reduce((min, n) => Math.min(min, n.step), totalSteps(p));
  const added: Note = {
    row_id: rowId,
    step,
    length_steps: Math.max(1, Math.min(defaultLength, nextStart - step)),
    velocity: DEFAULT_VELOCITY,
  };
  return { ...p, notes: [...p.notes, added] };
}

export function setVelocity(
  p: Pattern,
  rowId: string,
  step: number,
  velocity: number,
): Pattern {
  const target = findCovering(p, rowId, step);
  if (!target) return p;
  const next = clamp(Math.round(velocity), 1, 127);
  if (next === target.velocity) return p;
  return {
    ...p,
    notes: p.notes.map((n) => (n === target ? { ...n, velocity: next } : n)),
  };
}

export function resizeNote(
  p: Pattern,
  rowId: string,
  step: number,
  lengthSteps: number,
): Pattern {
  const target = p.notes.find((n) => n.row_id === rowId && n.step === step);
  if (!target) return p;
  const nextStart = p.notes
    .filter((n) => n.row_id === rowId && n.step > step)
    .reduce((min, n) => Math.min(min, n.step), totalSteps(p));
  const next = clamp(Math.round(lengthSteps), 1, nextStart - step);
  if (next === target.length_steps) return p;
  return {
    ...p,
    notes: p.notes.map((n) => (n === target ? { ...n, length_steps: next } : n)),
  };
}

// Repeating measures can push a crossing note over the next note or the end, so lengths are re-clamped.
function normalizeNotes(notes: Note[], total: number): Note[] {
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
