import { beforeEach, describe, expect, it } from "vitest";
import type { Note } from "@/generated/Note";
import { clearClipboard, copyNotes, getClip } from "./noteClipboard";
import {
  clearLyrics,
  gridOf,
  moveNotes,
  noteKey,
  pasteNotes,
  setLengths,
  setLyrics,
  setVelocities,
  shiftVelocities,
  toggleGridNote,
} from "./patternOps";
import { drums, note, patternWith } from "@/test/fixtures";

const sung = (row: string, step: number, lyric: string, length = 1): Note => ({
  ...note(row, step, length),
  lyric,
});
const keysOf = (...notes: Note[]) => new Set(notes.map(noteKey));

beforeEach(() => clearClipboard());

describe("lyrics survive note edits", () => {
  it("keeps the lyric when a note is moved to another step and row", () => {
    const n = sung("kick", 2, "me");
    const moved = moveNotes([n], keysOf(n), 2, 1, drums.rows, 64);
    expect(moved?.notes[0]).toMatchObject({ step: 4, lyric: "me" });
    expect(moved?.notes[0].row_id).not.toBe("kick");
  });

  it("keeps the lyric when a note is resized", () => {
    const n = sung("kick", 0, "oh");
    expect(setLengths([n], keysOf(n), 3, 64)[0]).toMatchObject({ length_steps: 3, lyric: "oh" });
  });

  it("keeps the lyric through absolute and relative velocity changes", () => {
    const n = sung("kick", 0, "oh");
    expect(setVelocities([n], keysOf(n), 50)[0]).toMatchObject({ velocity: 50, lyric: "oh" });
    expect(shiftVelocities([n], keysOf(n), 10)[0]).toMatchObject({ velocity: 110, lyric: "oh" });
  });

  it("carries lyrics through copy and paste", () => {
    const a = sung("kick", 0, "oh");
    const b = sung("kick", 2, "oh");
    copyNotes([a, b]);
    const pasted = pasteNotes([a, b], getClip()!.notes, 8, drums.rows, 64);
    expect(pasted.notes.filter((n) => n.step >= 8).map((n) => n.lyric)).toEqual(["oh", "oh"]);
  });

  it("gives a note the user adds no lyric", () => {
    const grid = gridOf(patternWith([sung("kick", 0, "oh")]));
    const added = toggleGridNote(grid, "kick", 4).find((n) => n.step === 4)!;
    expect(added).not.toHaveProperty("lyric");
  });
});

describe("setLyrics and clearLyrics", () => {
  it("sets a lyric on selected notes only", () => {
    const a = note("kick", 0);
    const b = note("kick", 4);
    const out = setLyrics([a, b], keysOf(a), "hold");
    expect(out[0].lyric).toBe("hold");
    expect(out[1]).toBe(b);
  });

  it("removes the field for an empty lyric rather than storing an empty string", () => {
    const n = sung("kick", 0, "me");
    expect(setLyrics([n], keysOf(n), "")[0]).not.toHaveProperty("lyric");
  });

  it("returns the same array when nothing changes", () => {
    const withLyric = [sung("kick", 0, "me")];
    const without = [note("kick", 0)];
    expect(setLyrics(withLyric, keysOf(withLyric[0]), "me")).toBe(withLyric);
    expect(clearLyrics(without, keysOf(without[0]))).toBe(without);
  });

  it("clears every selected lyric", () => {
    const a = sung("kick", 0, "a");
    const b = sung("kick", 4, "b");
    expect(clearLyrics([a, b], keysOf(a, b)).some((n) => "lyric" in n)).toBe(false);
  });
});
