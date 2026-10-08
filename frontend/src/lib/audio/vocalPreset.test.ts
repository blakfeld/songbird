import { describe, expect, it, vi } from "vitest";
import { presets } from "./presets";
import { createSynthSource } from "./synthSource";

vi.mock("tone", () => ({}));

describe("vocal preset", () => {
  const vocal = presets.vocal;

  it("attacks slowly enough to avoid a plucked onset", () => {
    expect(vocal.defaults.envelope.attack).toBeGreaterThanOrEqual(0.04);
    expect(vocal.options.envelope).toMatchObject(vocal.defaults.envelope);
  });

  it("has a vibrato near 5 Hz that starts after the note settles", () => {
    expect(vocal.vibrato?.frequencyHz).toBeCloseTo(5, 0);
    expect(vocal.vibrato?.delaySeconds).toBeGreaterThan(0);
  });

  it("builds an LFO per voice and delays its depth on each note", () => {
    const lfos: { options?: unknown }[] = [];
    const depthCalls: [string, number, number?][] = [];
    class Node {
      gain = {
        cancelScheduledValues: (t: number) => depthCalls.push(["cancel", t]),
        setValueAtTime: (v: number, t: number) => depthCalls.push(["set", v, t]),
        linearRampToValueAtTime: (v: number, t: number) => depthCalls.push(["ramp", v, t]),
        rampTo() {},
      };
      constructor(public options?: unknown) {}
      connect() {
        return this;
      }
      chain() {}
      dispose() {}
    }
    class LFO extends Node {
      constructor(options: unknown) {
        super(options);
        lfos.push(this);
      }
      start() {
        return this;
      }
    }
    class Synth extends Node {
      detune = {};
      envelope = { release: 0.2 };
      toSeconds = (v: number) => v;
      triggerAttack() {}
      triggerRelease() {}
      set() {}
    }
    const tone = { Gain: Node, LFO, Filter: Node, Synth, getDestination: () => ({}) } as never;
    const source = createSynthSource(vocal)(tone);
    source.trigger({ midi_note: 60 } as never, 1, 2, 100);
    expect(lfos).toHaveLength(1);
    expect((lfos[0].options as { frequency: number }).frequency).toBe(5);
    const ramp = depthCalls.find((c) => c[0] === "ramp");
    expect(ramp?.[1]).toBe(vocal.vibrato?.depthCents);
    expect(ramp?.[2]).toBeGreaterThan(1 + (vocal.vibrato?.delaySeconds ?? 0));
  });
});
