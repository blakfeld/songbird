import { describe, expect, it } from "vitest";
import { drums, note, patternWith } from "@/test/fixtures";
import { emptyPattern, toggleNote } from "./patternOps";

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
