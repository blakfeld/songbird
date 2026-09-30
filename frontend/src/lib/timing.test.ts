import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TimeSignature } from "@/generated/TimeSignature";
import { stepToSeconds } from "./timing";

interface NoteCase {
  step: number;
  length_steps: number;
  start_seconds: number;
  end_seconds: number;
}

interface Case {
  name: string;
  tempo_bpm: number;
  time_signature: TimeSignature;
  measures: number;
  swing: number;
  notes: NoteCase[];
  total_seconds: number;
}

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(resolve(__dirname, "../../../fixtures/timing.json"), "utf8"),
);

const STEPS_PER_MEASURE: Record<TimeSignature, number> = {
  "4/4": 16,
  "3/4": 12,
  "6/8": 12,
};

const TOLERANCE = 6;

describe("stepToSeconds", () => {
  it.each(fixture.cases)("matches fixture: $name", (c) => {
    for (const n of c.notes) {
      expect(stepToSeconds(n.step, c.tempo_bpm, c.swing)).toBeCloseTo(
        n.start_seconds,
        TOLERANCE,
      );
      expect(
        stepToSeconds(n.step + n.length_steps, c.tempo_bpm, c.swing),
      ).toBeCloseTo(n.end_seconds, TOLERANCE);
    }
    const totalSteps = c.measures * STEPS_PER_MEASURE[c.time_signature];
    expect(stepToSeconds(totalSteps, c.tempo_bpm, c.swing)).toBeCloseTo(
      c.total_seconds,
      TOLERANCE,
    );
  });

  it("places the final measure of 32 @ 120 BPM at 62 seconds", () => {
    const c = fixture.cases.find((x) => x.measures === 32 && x.tempo_bpm === 120);
    expect(c).toBeDefined();
    const note = c!.notes.find((n) => n.step === 496);
    expect(note?.start_seconds).toBeCloseTo(62, TOLERANCE);
    expect(stepToSeconds(496, 120, 0)).toBeCloseTo(62, TOLERANCE);
  });

  it("delays only odd steps by swing", () => {
    expect(stepToSeconds(4, 120, 0.5)).toBeCloseTo(0.5, TOLERANCE);
    expect(stepToSeconds(5, 120, 0.5)).toBeCloseTo(0.6875, TOLERANCE);
  });
});
