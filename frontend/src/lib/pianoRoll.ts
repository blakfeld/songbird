import type { Note } from "@/generated/Note";
import type { TimeSignature } from "@/generated/TimeSignature";

export const CELL_W_PX = 28;
export const VELOCITY_PRESETS = [127, 100, 70, 40] as const;

// Musicians count 1-16 inside a bar, so labels use measure-relative steps rather than absolute indices.
export function cellLabel(rowName: string, absStep: number, stepsPerMeasure: number) {
  const measure = Math.floor(absStep / stepsPerMeasure) + 1;
  const step = (absStep % stepsPerMeasure) + 1;
  return `${rowName}, measure ${measure}, step ${step}`;
}

// 6/8 is felt as two dotted-quarter beats, so grouping by 6 matches how it is counted.
export const beatSteps = (ts: TimeSignature) => (ts === "6/8" ? 6 : 4);

const BLACK_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

export const isBlackKey = (midiNote: number) => BLACK_KEY_PITCH_CLASSES.has(midiNote % 12);

// A sustained note defaults to one beat so it is audible as a note; one-shots have no duration to choose.
export const defaultNoteLength = (sustained: boolean, ts: TimeSignature) =>
  sustained ? beatSteps(ts) : 1;

export function nextVelocityPreset(current: number): number {
  const lower = VELOCITY_PRESETS.find((v) => v < current);
  return lower ?? VELOCITY_PRESETS[0];
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit"]);

// Global shortcuts must not steal keys that the browser uses for text editing.
export function isTextEntryTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.hasAttribute("contenteditable")) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return false;
}

export const noteCovers = (n: Note, step: number) =>
  step >= n.step && step < n.step + n.length_steps;

// SELECT is excluded: it has no text undo, so Cmd+Z after changing one must still undo the pattern.
export function isTextEditingTarget(el: EventTarget | null): boolean {
  return isTextEntryTarget(el) && !(el instanceof HTMLSelectElement);
}
