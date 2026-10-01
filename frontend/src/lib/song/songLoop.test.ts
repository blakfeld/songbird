import { describe, expect, it } from "vitest";
import { activeLoopRange } from "./songLoop";
import { newSong, type Song } from "./types";

const song = (measures: number, loop_region?: Song["loop_region"]): Song => ({
  ...newSong(),
  measures,
  loop_region,
});
const region = (start_measure: number, end_measure: number, enabled = true) => ({
  region: { start_measure, end_measure },
  enabled,
});

describe("activeLoopRange", () => {
  it("is null when looping is off", () => {
    expect(activeLoopRange(song(32, region(9, 16, false)))).toBeNull();
  });

  it("is null when looping is on with no region", () => {
    expect(activeLoopRange(song(32, { region: null, enabled: true }))).toBeNull();
    expect(activeLoopRange(song(32))).toBeNull();
  });

  it("is null for a region covering the whole song", () => {
    expect(activeLoopRange(song(16, region(1, 16)))).toBeNull();
    expect(activeLoopRange(song(16, region(1, 24)))).toBeNull();
  });

  it("is null for a region over 32 measures", () => {
    expect(activeLoopRange(song(64, region(1, 33)))).toBeNull();
  });

  it("returns a 9-16 region", () => {
    expect(activeLoopRange(song(32, region(9, 16)))).toEqual({ start_measure: 9, end_measure: 16 });
  });

  it("allows exactly 32 measures", () => {
    expect(activeLoopRange(song(64, region(5, 36)))).toEqual({ start_measure: 5, end_measure: 36 });
  });
});
