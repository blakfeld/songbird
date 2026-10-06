import type { SynthPreset } from "./synthSource";

const env = (attack: number, decay: number, sustain: number, release: number) => ({
  attack,
  decay,
  sustain,
  release,
});

const pianoEnvelope = env(0.005, 1.2, 0.1, 0.6);

export const pianoPreset: SynthPreset = {
  voice: "FMSynth",
  defaults: { envelope: pianoEnvelope },
  options: {
    harmonicity: 3,
    modulationIndex: 1.5,
    // The curve is voice character, not a user control, so it lives only here.
    envelope: { ...pianoEnvelope, decayCurve: "exponential" },
    modulationEnvelope: { attack: 0.005, decay: 0.4, sustain: 0.05, release: 0.4 },
  },
  effects: (tone) => [new tone.Reverb({ decay: 1.5, wet: 0.15 })],
};

// Keeps a backend-added sustained instrument audible without a frontend change.
export const fallbackPreset: SynthPreset = {
  voice: "Synth",
  defaults: { envelope: env(0.01, 0.2, 0.6, 0.3) },
  options: {
    oscillator: { type: "triangle" },
    envelope: env(0.01, 0.2, 0.6, 0.3),
  },
};

export const presets: Record<string, SynthPreset> = {
  piano: pianoPreset,
  "electric-piano": {
    voice: "FMSynth",
    defaults: { envelope: env(0.005, 1.2, 0.2, 0.8) },
    options: {
      harmonicity: 3,
      modulationIndex: 0.8,
      envelope: env(0.005, 1.2, 0.2, 0.8),
      modulationEnvelope: env(0.005, 0.5, 0.1, 0.5),
    },
  },
  organ: {
    voice: "Synth",
    defaults: { envelope: env(0.01, 0, 1, 0.05) },
    options: { oscillator: { type: "fatsine", count: 3, spread: 12 }, envelope: env(0.01, 0, 1, 0.05) },
  },
  // Sawtooth harmonics keep E1–G3 audible on small speakers; the default lowpass tames their buzz.
  bass: {
    voice: "Synth",
    defaults: { filterCutoffHz: 900, envelope: env(0.005, 0.2, 0.6, 0.1) },
    options: { oscillator: { type: "sawtooth" }, envelope: env(0.005, 0.2, 0.6, 0.1) },
  },
  "synth-lead": {
    voice: "Synth",
    defaults: { envelope: env(0.01, 0.1, 0.8, 0.15) },
    options: { oscillator: { type: "square" }, envelope: env(0.01, 0.1, 0.8, 0.15) },
  },
  "synth-pad": {
    voice: "Synth",
    defaults: { envelope: env(0.6, 0.5, 0.8, 1.5) },
    options: { oscillator: { type: "fatsawtooth", count: 3, spread: 30 }, envelope: env(0.6, 0.5, 0.8, 1.5) },
    // Chorus LFOs stay silent until started.
    effects: (tone) => [new tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0.5 }).start()],
  },
  strings: {
    voice: "Synth",
    defaults: { filterCutoffHz: 3500, filterRolloff: -12, envelope: env(0.15, 0.3, 0.9, 0.6) },
    options: { oscillator: { type: "fatsawtooth", count: 3, spread: 20 }, envelope: env(0.15, 0.3, 0.9, 0.6) },
  },
  // Odd partials fall off like a triangle under a dominant sine, and the broad band-pass stands in
  // for vocal formants without removing the sung fundamental.
  vocal: {
    voice: "Synth",
    defaults: { envelope: env(0.06, 0.15, 0.85, 0.2) },
    options: {
      oscillator: { type: "custom", partials: [1, 0.08, 0.14, 0.03, 0.05] },
      envelope: env(0.06, 0.15, 0.85, 0.2),
    },
    vibrato: { frequencyHz: 5, depthCents: 18, delaySeconds: 0.25, riseSeconds: 0.3 },
    effects: (tone) => [new tone.Filter({ type: "bandpass", frequency: 1100, Q: 0.35 })],
  },
  pluck: {
    voice: "Synth",
    defaults: { envelope: env(0.002, 0.6, 0, 0.2) },
    options: { oscillator: { type: "triangle" }, envelope: env(0.002, 0.6, 0, 0.2) },
  },
};
