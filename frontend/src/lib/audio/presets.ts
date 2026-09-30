import type { SynthPreset } from "./synthSource";

export const pianoPreset: SynthPreset = {
  voice: "FMSynth",
  options: {
    harmonicity: 3,
    modulationIndex: 1.5,
    envelope: { attack: 0.005, decay: 1.2, decayCurve: "exponential", sustain: 0.1, release: 0.6 },
    modulationEnvelope: { attack: 0.005, decay: 0.4, sustain: 0.05, release: 0.4 },
  },
  effects: (tone) => [new tone.Reverb({ decay: 1.5, wet: 0.15 })],
};

// Keeps a backend-added sustained instrument audible without a frontend change.
export const fallbackPreset: SynthPreset = {
  voice: "Synth",
  options: {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.3 },
  },
};

export const presets: Record<string, SynthPreset> = {
  piano: pianoPreset,
};
