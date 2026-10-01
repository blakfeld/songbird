import type { MouseEvent, PointerEvent } from "react";
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
  rows(): Row[];
  // Drags outlive the bar that started them (a move re-keys it), so the roll owns the whole gesture.
  pressNote(note: Note, e: PointerEvent): void;
  removeNote(note: Note): void;
  // Keyboard activation arrives here too, which is why a covered cell selects instead of toggling.
  clickCell(rowId: string, step: number, covering: Note | undefined, e: MouseEvent): void;
}
