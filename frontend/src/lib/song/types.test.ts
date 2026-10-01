import { describe, expect, it } from "vitest";
import { newSong } from "./types";

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
