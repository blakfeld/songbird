import { describe, expect, it } from "vitest";
import { pianoPreset, presets } from "./presets";
import type { SynthPreset } from "./synthSource";

const envelope = (id: string) => (presets[id] as SynthPreset).options.envelope as {
  attack: number;
  decay: number;
  sustain: number;
};

describe("synth presets", () => {
  // Without an explicit entry an instrument silently gets the neutral fallback voice.
  it.each(["piano", "electric-piano", "organ", "bass", "synth-lead", "synth-pad", "strings", "pluck"])(
    "has an explicit preset for %s",
    (id) => {
      expect(Object.hasOwn(presets, id)).toBe(true);
    },
  );

  it("holds the organ at full level while a key is down", () => {
    expect(envelope("organ").sustain).toBe(1);
  });

  it("lets the pluck decay to silence quickly", () => {
    const { sustain, decay } = envelope("pluck");
    expect(sustain).toBe(0);
    expect(decay).toBeLessThan(1);
  });

  it("attacks the pad more slowly than the piano", () => {
    expect(envelope("synth-pad").attack).toBeGreaterThan(
      (pianoPreset.options.envelope as { attack: number }).attack,
    );
  });
});
