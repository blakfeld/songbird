import type { Pattern } from "@/generated/Pattern";
import { totalSteps } from "../patternOps";
import type { PatternStore } from "../patternStore";
import { createTake, type Take, type TakeTarget } from "./take";

// The take rides the store's gesture, so the store's own rules decide what an edit made mid-take does to it.
export function createPatternTake(store: PatternStore): TakeTarget {
  let take: Take | null = null;
  let recorded = 0;
  // Compared by identity because another gesture can replace ours, and merging onto a stale base would overwrite it.
  let myBase: Pattern | null = null;

  const rebase = () => {
    const pattern = store.getState().pattern;
    if (!pattern) return false;
    store.getState().beginGesture();
    myBase = store.getState().gestureBase;
    take = createTake(pattern.notes);
    return true;
  };

  return {
    begin: () => {
      recorded = 0;
      rebase();
    },
    add: (note) => {
      const pattern = store.getState().pattern;
      if (!pattern) return;
      const total = totalSteps(pattern);
      if (note.step < 0 || note.step >= total) return;
      // An edit, undo, redo or drag ends or replaces the gesture, and merging onto the old base would overwrite that change.
      if ((!myBase || store.getState().gestureBase !== myBase) && !rebase()) return;
      // The pattern's length never changes, so a note can only be shortened to fit.
      const length_steps = Math.min(note.length_steps, total - note.step);
      const merged = take!.add({ ...note, length_steps });
      recorded++;
      store.getState().editNotes(() => merged, { transient: true });
    },
    end: () => {
      store.getState().commitGesture();
      take = null;
      myBase = null;
      return { recorded, dropped: {} };
    },
    discard: () => {
      store.getState().cancelGesture();
      take = null;
      myBase = null;
    },
  };
}
