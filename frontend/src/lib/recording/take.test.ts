import { describe, expect, it } from "vitest";
import { note } from "@/test/fixtures";
import { createTake, quantizeNote, type QuantizeInput } from "./take";

const base: QuantizeInput = {
  row_id: "c4",
  velocity: 90,
  on: { step: 4 },
  off: { step: 6 },
  range: { start: 0, end: 16 },
  looping: false,
  oneShot: false,
};
const q = (over: Partial<QuantizeInput>) => quantizeNote({ ...base, ...over });

describe("quantizeNote", () => {
  it("uses the mapped steps for start and length", () => {
    expect(q({})).toEqual({ row_id: "c4", step: 4, length_steps: 2, velocity: 90 });
  });

  it("gives a one-shot a length of 1", () => {
    expect(q({ oneShot: true, off: { step: 12 } })?.length_steps).toBe(1);
  });

  it("never records a length below 1", () => {
    expect(q({ off: { step: 4 } })?.length_steps).toBe(1);
  });

  it("clamps the length to the end of the range", () => {
    expect(q({ on: { step: 14 }, off: null })?.length_steps).toBe(2);
    expect(q({ on: { step: 14 }, off: { step: 20 } })?.length_steps).toBe(2);
  });

  it("counts a note held across a loop wrap along playback order", () => {
    const wrapped = q({ looping: true, on: { step: 12 }, off: { step: 2 } });
    expect(wrapped?.length_steps).toBe(4);
    const inner = q({ looping: true, range: { start: 8, end: 24 }, on: { step: 22 }, off: { step: 9 } });
    expect(inner?.length_steps).toBe(2);
  });

  it("discards a note-on at the end of the range even when looping, since the engine already wraps it", () => {
    expect(q({ looping: true, range: { start: 16, end: 32 }, on: { step: 32 } })).toBeNull();
  });

  describe("a note released on the step it was pressed", () => {
    const region = { looping: true, range: { start: 0, end: 16 } };
    // 0.125 s per sixteenth makes one pass of 16 steps last 2 s.
    const at = (step: number, seconds: number) => ({ step, seconds, stepSeconds: 0.125 });

    it("lasts the whole region when a full pass of time went by", () => {
      expect(q({ ...region, on: at(4, 1), off: at(4, 3.02) })?.length_steps).toBe(12);
    });

    it("stays a single step for a brief tap", () => {
      expect(q({ ...region, on: at(4, 1), off: at(4, 1.05) })?.length_steps).toBe(1);
    });

    it("stays a single step without timing information", () => {
      expect(q({ ...region, on: { step: 4 }, off: { step: 4 } })?.length_steps).toBe(1);
    });
  });

  it("discards a note-on past the end when not looping", () => {
    expect(q({ on: { step: 16 } })).toBeNull();
  });

  it("discards a note outside the range", () => {
    expect(q({ range: { start: 8, end: 16 }, on: { step: 3 } })).toBeNull();
  });

  it("clamps velocity to 1-127", () => {
    expect(q({ velocity: 0 })?.velocity).toBe(1);
    expect(q({ velocity: 200 })?.velocity).toBe(127);
  });
});

describe("createTake", () => {
  it("replaces a note on the same row and step", () => {
    const take = createTake([note("c4", 0, 1, 100)]);
    const merged = take.add(note("c4", 0, 1, 60));
    expect(merged).toEqual([note("c4", 0, 1, 60)]);
  });

  it("shortens an overlapped note", () => {
    const take = createTake([note("c4", 0, 8)]);
    const merged = take.add(note("c4", 4, 1));
    expect(merged).toEqual([note("c4", 0, 4), note("c4", 4, 1)]);
  });

  it("merges in start order even when notes arrive out of order", () => {
    const take = createTake([]);
    take.add(note("c4", 4, 1));
    const merged = take.add(note("c4", 0, 8));
    expect(merged).toEqual([note("c4", 0, 4), note("c4", 4, 1)]);
  });
});
