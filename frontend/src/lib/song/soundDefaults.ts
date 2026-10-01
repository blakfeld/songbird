import type { Track } from "@/generated/Track";
import { fallbackPreset, presets } from "../audio/presets";
import { SOUND_RANGES as R } from "./trackSound";

// A preset with no filter is "open", which is inaudible, so the knob rests at its top.
const OPEN_CUTOFF_HZ = 20000;

// Mirrors the spec's default column; kept apart from the audio engine so the panel can show
// defaults without loading Tone.
export const EFFECT_DEFAULTS = {
  eq: { low_db: 0, mid_db: 0, high_db: 0 },
  distortion: { drive: 0.4, mix: 0.5 },
  chorus: { rate_hz: 1.5, depth: 0.5, mix: 0.5 },
  delay: { time: "1/8d", feedback: 0.35, mix: 0.3 },
  reverb: { decay_s: 2.5, mix: 0.3 },
} as const;

const within = (v: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, v));

// Clamped because a preset may sit outside what a document may store (the organ's zero decay); a knob
// showing a value beyond its own range could not be dragged back to where it started.
export function toneDefaults(instrumentId: string) {
  const preset = presets[instrumentId] ?? fallbackPreset;
  const { envelope } = preset.defaults;
  return {
    filter_cutoff_hz: within(preset.defaults.filterCutoffHz ?? OPEN_CUTOFF_HZ, R.filter_cutoff_hz),
    filter_resonance: 0,
    attack_s: within(envelope.attack, R.attack_s),
    decay_s: within(envelope.decay, R.decay_s),
    sustain: within(envelope.sustain, R.sustain),
    release_s: within(envelope.release, R.release_s),
    pitch_semitones: 0,
  };
}

// setSound prunes emptied objects, so any remaining sound is a deviation from "Reset sound".
export const isSoundCustomized = (track: Pick<Track, "sound">) => track.sound != null;
