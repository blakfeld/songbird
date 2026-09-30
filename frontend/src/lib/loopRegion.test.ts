import { describe, expect, it } from "vitest";
import {
  clampLoop,
  defaultLoop,
  drawRegion,
  moveRegion,
  parseLoop,
  playRange,
  resizeEnd,
  resizeStart,
  type LoopSetting,
} from "./loopRegion";

const r = (start: number, end: number) => ({ start, end });
const setting = (start: number, end: number, enabled = true): LoopSetting => ({
  region: r(start, end),
  enabled,
});

describe("loopRegion", () => {
  it("defaults to no region and looping off", () => {
    expect(defaultLoop()).toEqual({ region: null, enabled: false });
  });

  it("plays the region, or null for the whole length", () => {
    expect(playRange(setting(3, 4))).toEqual(r(3, 4));
    expect(playRange({ region: null, enabled: true })).toBeNull();
  });

  describe("drawRegion", () => {
    it("draws forwards", () => {
      expect(drawRegion(5, 8)).toEqual(r(5, 8));
    });
    it("draws backwards", () => {
      expect(drawRegion(8, 5)).toEqual(r(5, 8));
    });
    it("draws a single measure", () => {
      expect(drawRegion(13, 13)).toEqual(r(13, 13));
    });
    it("keeps the region inside the pattern", () => {
      expect(drawRegion(0, 20, 16)).toEqual(r(1, 16));
    });
  });

  describe("moveRegion", () => {
    it("moves without changing length", () => {
      expect(moveRegion(r(5, 8), 2, 16)).toEqual(r(7, 10));
    });
    it("stops at the end", () => {
      expect(moveRegion(r(13, 16), 3, 16)).toEqual(r(13, 16));
      expect(moveRegion(r(10, 13), 9, 16)).toEqual(r(13, 16));
    });
    it("stops at the start", () => {
      expect(moveRegion(r(2, 4), -5, 16)).toEqual(r(1, 3));
    });
    it("cannot move a full-length region", () => {
      expect(moveRegion(r(1, 16), 3, 16)).toEqual(r(1, 16));
    });
  });

  describe("resize", () => {
    it("moves either edge", () => {
      expect(resizeStart(resizeEnd(r(5, 8), 12, 16), 3, 16)).toEqual(r(3, 12));
    });
    it("keeps one measure when the end is dragged left past the start", () => {
      expect(resizeEnd(r(5, 8), 2, 16)).toEqual(r(5, 5));
    });
    it("keeps one measure when the start is dragged right past the end", () => {
      expect(resizeStart(r(5, 8), 12, 16)).toEqual(r(8, 8));
    });
    it("does not pass the pattern bounds", () => {
      expect(resizeEnd(r(5, 8), 99, 16)).toEqual(r(5, 16));
      expect(resizeStart(r(5, 8), -3, 16)).toEqual(r(1, 8));
    });
  });

  describe("clampLoop", () => {
    it("leaves a null region null", () => {
      const loop: LoopSetting = { region: null, enabled: true };
      expect(clampLoop(loop, 4)).toBe(loop);
    });
    it("clamps a partial region when the pattern shortens", () => {
      expect(clampLoop(setting(13, 16), 8).region).toEqual(r(8, 8));
      expect(clampLoop(setting(5, 12), 8).region).toEqual(r(5, 8));
    });
    it("keeps a drawn region when the pattern lengthens, even a whole-length one", () => {
      expect(clampLoop(setting(1, 8), 16).region).toEqual(r(1, 8));
    });
    it("never changes the on/off setting", () => {
      expect(clampLoop(setting(13, 16, false), 8).enabled).toBe(false);
    });
    it("repairs non-finite bounds", () => {
      expect(clampLoop(setting(NaN, Infinity), 8).region).toEqual(r(1, 8));
    });
  });

  describe("parseLoop", () => {
    it("accepts a valid setting", () => {
      expect(parseLoop({ region: r(2, 3), enabled: true })).toEqual(setting(2, 3));
      expect(parseLoop({ region: null, enabled: true })).toEqual({ region: null, enabled: true });
    });
    it("falls back to the default for missing, flat or malformed values", () => {
      for (const raw of [undefined, null, 3, { start: 1, end: 4, enabled: true }, { region: r(3, 2), enabled: true }, { region: null }, { region: "x", enabled: true }]) {
        expect(parseLoop(raw)).toEqual(defaultLoop());
      }
    });
  });
});
