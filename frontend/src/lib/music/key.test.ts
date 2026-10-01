import { describe, expect, it } from "vitest";
import { rowPitchClass, scalePitchClasses } from "./key";

describe("scalePitchClasses", () => {
  it("lists the C major scale", () => {
    expect(scalePitchClasses({ tonic: "C", mode: "major" })).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it("lists the A natural minor scale, the same notes as C major", () => {
    const a = scalePitchClasses({ tonic: "A", mode: "minor" });
    expect(a[0]).toBe(9);
    expect([...a].sort((x, y) => x - y)).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it("wraps past the octave for a sharp tonic", () => {
    expect(scalePitchClasses({ tonic: "A#", mode: "major" })).toEqual([10, 0, 2, 3, 5, 7, 9]);
  });
});

describe("rowPitchClass", () => {
  it("reduces a midi note to its pitch class", () => {
    expect(rowPitchClass({ midi_note: 60 })).toBe(0);
    expect(rowPitchClass({ midi_note: 69 })).toBe(9);
  });
});
