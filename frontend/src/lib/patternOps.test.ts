import { describe, expect, it } from "vitest";
import { drums, note, patternWith } from "@/test/fixtures";
import type { Note } from "@/generated/Note";
import { emptyPattern, moveGridNote, toggleNote, type NoteGrid } from "./patternOps";

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

describe("moveGridNote", () => {
  const rows = [
    { id: "a", name: "A", midi_note: 3 },
    { id: "b", name: "B", midi_note: 2 },
    { id: "c", name: "C", midi_note: 1 },
  ];
  const grid = (notes: Note[]): NoteGrid => ({ notes, rows, totalSteps: 16 });
  const n = (row_id: string, step: number, length_steps = 1, velocity = 100): Note => ({
    row_id,
    step,
    length_steps,
    velocity,
  });

  it("changes only the row, keeping step, length and velocity", () => {
    const g = grid([n("a", 8, 3, 70), n("c", 0)]);
    expect(moveGridNote(g, "a", 8, "b")).toEqual([n("b", 8, 3, 70), n("c", 0)]);
  });

  it("refuses a target row where the note would overlap another", () => {
    const g = grid([n("a", 8, 3), n("b", 10)]);
    expect(moveGridNote(g, "a", 8, "b")).toBe(g.notes);
  });

  it("allows a target row whose notes only touch the edges", () => {
    const g = grid([n("a", 8, 2), n("b", 10), n("b", 7)]);
    expect(moveGridNote(g, "a", 8, "b")).not.toBe(g.notes);
  });

  it("is a no-op for the same row, an unknown row or a missing note", () => {
    const g = grid([n("a", 8)]);
    expect(moveGridNote(g, "a", 8, "a")).toBe(g.notes);
    expect(moveGridNote(g, "a", 8, "zzz")).toBe(g.notes);
    expect(moveGridNote(g, "a", 9, "b")).toBe(g.notes);
  });
});
