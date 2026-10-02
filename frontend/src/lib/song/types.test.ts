import { describe, expect, it } from "vitest";
import { newSong, uniqueUntitledName } from "./types";

describe("newSong", () => {
  it("has the documented defaults", () => {
    const s = newSong();
    expect(s).toMatchObject({
      version: 2,
      name: "Untitled song",
      measures: 1,
      key: { tonic: "C", mode: "major" },
      time_signature: "4/4",
      steps_per_measure: 16,
      tempo_bpm: 120,
      swing: 0,
    });
    expect(s.tracks).toEqual([]);
  });

  it("uses 12 steps per measure for 3/4", () => {
    expect(newSong("3/4").steps_per_measure).toBe(12);
  });
});

describe("uniqueUntitledName", () => {
  it("uses the plain default for an empty list", () => {
    expect(uniqueUntitledName([])).toBe("Untitled song");
  });

  it("numbers from 2 when the default exists", () => {
    expect(uniqueUntitledName(["Untitled song"])).toBe("Untitled song 2");
  });

  it("reuses the smallest gap", () => {
    expect(uniqueUntitledName(["Untitled song", "Untitled song 3"])).toBe("Untitled song 2");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(uniqueUntitledName(["  UNTITLED SONG "])).toBe("Untitled song 2");
    expect(uniqueUntitledName(["untitled song", " Untitled Song 2  "])).toBe("Untitled song 3");
  });
});
