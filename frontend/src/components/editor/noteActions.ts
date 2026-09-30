import type { Note } from "@/generated/Note";
import type { Row } from "@/generated/Row";

// Kept stable across renders so memoized measure columns are not re-rendered by edits elsewhere.
export interface NoteActions {
  toggle(rowId: string, step: number, defaultLength?: number): void;
  setVelocity(rowId: string, step: number, velocity: number): void;
  resize(rowId: string, step: number, lengthSteps: number): void;
  // Fires whenever a note lands in a new row (added or moved), which is why remove, resize and velocity edits stay silent.
  placed(row: Row, velocity: number): void;
  maxLength(note: Note): number;
  move(rowId: string, step: number, toRowId: string): void;
  rows(): Row[];
  canMove(note: Note, toRowId: string): boolean;
}
