import { describe, expect, it } from "vitest";
import { defaultNoteLength, isBlackKey } from "./pianoRoll";

describe("isBlackKey", () => {
  it("treats C#4 as black and C4 as white", () => {
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(60)).toBe(false);
  });

  it("marks exactly five pitch classes per octave", () => {
    expect(Array.from({ length: 12 }, (_, i) => 48 + i).filter(isBlackKey)).toHaveLength(5);
  });
});

describe("defaultNoteLength", () => {
  it("is one beat for sustained instruments", () => {
    expect(defaultNoteLength(true, "4/4")).toBe(4);
    expect(defaultNoteLength(true, "3/4")).toBe(4);
    expect(defaultNoteLength(true, "6/8")).toBe(6);
  });

  it("is one step for one-shot instruments", () => {
    expect(defaultNoteLength(false, "4/4")).toBe(1);
    expect(defaultNoteLength(false, "6/8")).toBe(1);
  });
});
