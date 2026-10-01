import { describe, expect, it } from "vitest";
import { drums, note, patternWith } from "@/test/fixtures";
import type { Note } from "@/generated/Note";
import {
  deleteNotes,
  emptyPattern,
  mergeNotes,
  moveNotes,
  noteKey,
  pasteNotes,
  setLengths,
  setVelocities,
  shiftVelocities,
  toggleNote,
} from "./patternOps";

const piano = emptyPattern(
  { ...drums, id: "piano", name: "Piano", kind: "melodic", sustained: true, rows: [{ id: "e4", name: "E4", midi_note: 64 }] },
  4,
);

describe("toggleNote default length", () => {
  it("uses the given default length for a sustained instrument", () => {
    expect(toggleNote(piano, "e4", 0, 4).notes).toEqual([note("e4", 0, 4)]);
  });

  it("clips to the next note in the same row", () => {
    const p = { ...piano, notes: [note("e4", 2, 2)] };
    expect(toggleNote(p, "e4", 0, 4).notes).toContainEqual(note("e4", 0, 2));
  });

  it("clips at the end of the pattern", () => {
    const total = piano.measures * piano.steps_per_measure;
    expect(toggleNote(piano, "e4", total - 2, 4).notes).toEqual([note("e4", total - 2, 2)]);
  });

  it("keeps drums at one step by default", () => {
    expect(toggleNote(patternWith([]), "snare", 4).notes).toEqual([note("snare", 4, 1)]);
  });
});

describe("multi-note ops", () => {
  const rows = ["a", "b", "c", "d"].map((id, i) => ({ id, name: id, midi_note: 60 + i }));
  const n = (row_id: string, step: number, length_steps = 1, velocity = 100): Note => ({
    row_id,
    step,
    length_steps,
    velocity,
  });
  const keys = (...ns: Note[]) => new Set(ns.map(noteKey));

  describe("shiftVelocities", () => {
    it("shifts every selected note by the same amount, clamped to 1-127", () => {
      const a = n("a", 0, 1, 60);
      const b = n("a", 4, 1, 120);
      const c = n("a", 8, 1, 50);
      expect(shiftVelocities([a, b, c], keys(a, b), 20)).toEqual([n("a", 0, 1, 80), n("a", 4, 1, 127), c]);
      expect(shiftVelocities([a], keys(a), -100)[0].velocity).toBe(1);
    });

    it("returns the same array when nothing changes", () => {
      const a = n("a", 0);
      const notes = [a];
      expect(shiftVelocities(notes, keys(a), 0)).toBe(notes);
      expect(shiftVelocities(notes, new Set(), 5)).toBe(notes);
    });
  });

  describe("moveNotes", () => {
    it("moves a selection as a block and returns the new keys", () => {
      const a = n("a", 0, 2, 50);
      const c = n("c", 4);
      const r = moveNotes([a, c], keys(a, c), 2, 1, rows, 16)!;
      expect(r.notes).toEqual([n("b", 2, 2, 50), n("d", 6)]);
      expect(r.keys).toEqual(new Set(["b:2", "d:6"]));
    });

    it("leaves unselected notes untouched", () => {
      const a = n("a", 0);
      const other = n("c", 9);
      expect(moveNotes([a, other], keys(a), 1, 0, rows, 16)!.notes).toEqual([n("a", 1), other]);
    });

    it("returns null before step 0", () => {
      const a = n("a", 1);
      expect(moveNotes([a], keys(a), -2, 0, rows, 16)).toBeNull();
    });

    it("returns null when a note would end past the grid", () => {
      const a = n("a", 13, 3);
      expect(moveNotes([a], keys(a), 1, 0, rows, 16)).toBeNull();
      expect(moveNotes([a], keys(a), 0, 0, rows, 16)).not.toBeNull();
    });

    it("returns null when any note leaves the rows", () => {
      const a = n("a", 0);
      const d = n("d", 4);
      expect(moveNotes([a, d], keys(a, d), 0, 1, rows, 16)).toBeNull();
      expect(moveNotes([a, d], keys(a, d), 0, -1, rows, 16)).toBeNull();
    });

    it("returns null when overlapping an unmoved note", () => {
      const a = n("a", 0, 2);
      const blocker = n("b", 1, 2);
      expect(moveNotes([a, blocker], keys(a), 0, 1, rows, 16)).toBeNull();
    });

    it("allows landing where the selection itself used to be", () => {
      const a = n("a", 0, 2);
      const b = n("a", 2, 2);
      expect(moveNotes([a, b], keys(a, b), 2, 0, rows, 16)!.notes).toEqual([n("a", 2, 2), n("a", 4, 2)]);
    });

    it("allows touching an unmoved note without overlap", () => {
      const a = n("a", 0, 2);
      expect(moveNotes([a, n("a", 4)], keys(a), 2, 0, rows, 16)).not.toBeNull();
    });
  });

  describe("setVelocities", () => {
    it("sets every selected note and only those", () => {
      const a = n("a", 0, 1, 60);
      const b = n("b", 0, 1, 120);
      const c = n("c", 0, 1, 10);
      expect(setVelocities([a, b, c], keys(a, b), 90)).toEqual([n("a", 0, 1, 90), n("b", 0, 1, 90), c]);
    });

    it("clamps to 1-127", () => {
      const a = n("a", 0);
      expect(setVelocities([a], keys(a), 500)[0].velocity).toBe(127);
      expect(setVelocities([a], keys(a), -3)[0].velocity).toBe(1);
    });

    it("returns the same array when nothing changes", () => {
      const notes = [n("a", 0)];
      expect(setVelocities(notes, keys(notes[0]), 100)).toBe(notes);
    });
  });

  describe("setLengths", () => {
    it("sets the length of selected notes", () => {
      const a = n("a", 0);
      expect(setLengths([a], keys(a), 3, 16)).toEqual([n("a", 0, 3)]);
    });

    it("shortens to the next note in the row", () => {
      const a = n("a", 0);
      const next = n("a", 2);
      expect(setLengths([a, next], keys(a), 8, 16)[0].length_steps).toBe(2);
    });

    it("ignores notes in other rows when clamping", () => {
      const a = n("a", 0);
      expect(setLengths([a, n("b", 2)], keys(a), 4, 16)[0].length_steps).toBe(4);
    });

    it("shortens to the end of the grid", () => {
      const a = n("a", 14);
      expect(setLengths([a], keys(a), 8, 16)[0].length_steps).toBe(2);
    });

    it("keeps a minimum length of 1", () => {
      const a = n("a", 0, 3);
      expect(setLengths([a], keys(a), 0, 16)[0].length_steps).toBe(1);
    });

    it("returns the same array when nothing changes", () => {
      const notes = [n("a", 0, 2)];
      expect(setLengths(notes, keys(notes[0]), 2, 16)).toBe(notes);
    });
  });

  describe("deleteNotes", () => {
    it("removes the selected notes", () => {
      const a = n("a", 0);
      const b = n("b", 1);
      const c = n("c", 2);
      expect(deleteNotes([a, b, c], keys(a, c))).toEqual([b]);
    });

    it("returns the same array for an empty selection", () => {
      const notes = [n("a", 0)];
      expect(deleteNotes(notes, new Set())).toBe(notes);
    });
  });

  describe("mergeNotes", () => {
    it("replaces a note on the same row and step", () => {
      expect(mergeNotes([n("a", 4, 2, 50)], [n("a", 4, 1, 90)])).toEqual([n("a", 4, 1, 90)]);
    });

    it("shortens an earlier note the incoming one overlaps", () => {
      expect(mergeNotes([n("a", 0, 4)], [n("a", 2, 4)])).toEqual([n("a", 0, 2), n("a", 2, 4)]);
    });

    it("removes an existing note that starts inside the incoming one", () => {
      expect(mergeNotes([n("a", 3, 2)], [n("a", 2, 4)])).toEqual([n("a", 2, 4)]);
    });

    it("leaves notes in other rows and non-overlapping notes alone", () => {
      const keep = [n("b", 0, 8), n("a", 0, 2)];
      expect(mergeNotes(keep, [n("a", 2, 2)])).toEqual([...keep, n("a", 2, 2)]);
    });
  });

  describe("pasteNotes", () => {
    it("offsets the clip to the paste position and reports keys", () => {
      const r = pasteNotes([], [n("a", 0, 2), n("b", 4)], 8, rows, 16);
      expect(r.notes).toEqual([n("a", 8, 2), n("b", 12)]);
      expect(r.keys).toEqual(new Set(["a:8", "b:12"]));
      expect(r.dropped).toBe(0);
    });

    it("drops rows the instrument lacks", () => {
      const r = pasteNotes([], [n("a", 0), n("zzz", 1)], 0, rows, 16);
      expect(r.notes).toEqual([n("a", 0)]);
      expect(r.keys).toEqual(new Set(["a:0"]));
      expect(r.dropped).toBe(1);
    });

    it("drops notes starting at or past the end", () => {
      const r = pasteNotes([], [n("a", 0), n("a", 8)], 8, rows, 16);
      expect(r.notes).toEqual([n("a", 8)]);
      expect(r.dropped).toBe(1);
    });

    it("trims notes that extend past the end without dropping them", () => {
      const r = pasteNotes([], [n("a", 0, 6)], 12, rows, 16);
      expect(r.notes).toEqual([n("a", 12, 4)]);
      expect(r.dropped).toBe(0);
    });

    it("merges with existing notes by the shared rule", () => {
      const r = pasteNotes([n("a", 0, 6), n("a", 8, 2)], [n("a", 0, 2)], 4, rows, 16);
      expect(r.notes).toEqual([n("a", 0, 4), n("a", 8, 2), n("a", 4, 2)]);
    });

    it("returns the same notes array when everything is dropped", () => {
      const existing = [n("a", 0)];
      const r = pasteNotes(existing, [n("zzz", 0)], 0, rows, 16);
      expect(r.notes).toBe(existing);
      expect(r.dropped).toBe(1);
      expect(r.keys.size).toBe(0);
    });
  });
});
