import { beforeEach, describe, expect, it } from "vitest";
import { note } from "@/test/fixtures";
import { clearClipboard, copyNotes, getClip, markPasted, nextPasteStep } from "./noteClipboard";

beforeEach(clearClipboard);

describe("noteClipboard", () => {
  it("stores steps relative to the earliest note and remembers the span", () => {
    expect(copyNotes([note("kick", 8, 2), note("snare", 12, 4)])).toBe(2);
    expect(getClip()).toEqual({ notes: [note("kick", 0, 2), note("snare", 4, 4)], span: 8 });
  });

  it("points the next paste at the end of the copied block, then of each pasted block", () => {
    copyNotes([note("kick", 8, 2), note("snare", 12, 4)]);
    expect(nextPasteStep()).toBe(16);
    markPasted(16, 8);
    expect(nextPasteStep()).toBe(24);
  });

  it("keeps the previous clip when nothing is copied", () => {
    copyNotes([note("kick", 0)]);
    expect(copyNotes([])).toBe(0);
    expect(getClip()?.notes).toHaveLength(1);
  });
});
