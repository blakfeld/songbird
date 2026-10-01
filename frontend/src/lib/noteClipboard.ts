import type { Note } from "@/generated/Note";

export interface NoteClip {
  // Steps are relative to the earliest note so a paste only has to add its target step.
  notes: Note[];
  span: number;
}

// Module state, not the system clipboard: that needs permissions and would put note JSON in the user's clipboard.
let clip: NoteClip | null = null;
// Kept beside the clip, not in a roll, because switching tracks remounts the roll but "after the last copy" must survive it.
let nextAt = 0;

export function copyNotes(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const origin = Math.min(...notes.map((n) => n.step));
  const end = Math.max(...notes.map((n) => n.step + n.length_steps));
  clip = {
    notes: notes.map((n) => ({ ...n, step: n.step - origin })),
    span: end - origin,
  };
  nextAt = end;
  return notes.length;
}

export const getClip = (): NoteClip | null => clip;

export const nextPasteStep = () => nextAt;

export function markPasted(at: number, span: number) {
  nextAt = at + span;
}

export function clearClipboard() {
  clip = null;
  nextAt = 0;
}
