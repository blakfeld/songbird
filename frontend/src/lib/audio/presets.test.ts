import { describe, expect, it, vi } from "vitest";
import { fallbackPreset, pianoPreset, presets } from "./presets";
import { createSynthSource, type SynthPreset } from "./synthSource";

vi.mock("tone", () => ({}));

// Constructor options are what distinguish a refactored graph from the original, so the mock keeps them.
function builtChain(preset: SynthPreset) {
  const chain: unknown[] = [];
  const recorder = (type: string) =>
    class {
      type = type;
      constructor(public options?: unknown) {}
      start() {
        return this;
      }
      connect() {
        return this;
      }
      chain(...nodes: unknown[]) {
        chain.push(...nodes);
      }
    };
  const output = { type: "output" };
  const tone = {
    Gain: recorder("Gain"),
    Reverb: recorder("Reverb"),
    Chorus: recorder("Chorus"),
    Filter: recorder("Filter"),
    getDestination: () => output,
  } as never;
  createSynthSource(preset)(tone, output as never);
  return chain
    .slice(0, -1)
    .map((n) => ({ type: (n as { type: string }).type, options: (n as { options: unknown }).options }));
}

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

  it.each(Object.keys(presets))("keeps %s's default envelope in step with its voice options", (id) => {
    const preset = presets[id];
    expect(preset.options.envelope).toMatchObject(preset.defaults.envelope);
  });
});

// Captured from the presets before their filters moved into `defaults`, so a refactor cannot
// silently change how an untouched track sounds.
describe("preset graph equivalence with an empty sound", () => {
  const filter = (frequency: number, rolloff: number) => ({
    type: "Filter",
    options: { type: "lowpass", frequency, rolloff },
  });
  // Tone's own Q default is 1, which is what the old filters ran at.
  const withQ = (node: { type: string; options: object }) => ({
    ...node,
    options: { ...node.options, Q: 1 },
  });

  const expected: Record<string, unknown[]> = {
    piano: [{ type: "Reverb", options: { decay: 1.5, wet: 0.15 } }],
    "electric-piano": [],
    organ: [],
    bass: [withQ(filter(900, -24))],
    "synth-lead": [],
    "synth-pad": [{ type: "Chorus", options: { frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0.5 } }],
    strings: [withQ(filter(3500, -12))],
    pluck: [],
  };

  it.each(Object.keys(expected))("builds the same nodes for %s", (id) => {
    expect(builtChain(presets[id])).toEqual(expected[id]);
  });

  it("adds nothing to the fallback voice", () => {
    expect(builtChain(fallbackPreset)).toEqual([]);
  });
});
