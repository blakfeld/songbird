import type { DelayEffect } from "@/generated/DelayEffect";

type Range = { min: number; max: number };

// The single TS copy of the ranges; the Rust table in song.rs is the other, and the shared
// fixture file keeps the two from drifting.
export const SOUND_RANGES = {
  filter_cutoff_hz: { min: 40, max: 20000 },
  filter_resonance: { min: 0, max: 1 },
  attack_s: { min: 0.001, max: 2 },
  decay_s: { min: 0.01, max: 4 },
  sustain: { min: 0, max: 1 },
  release_s: { min: 0.01, max: 8 },
  pitch_semitones: { min: -12, max: 12 },
  eq_db: { min: -12, max: 12 },
  drive: { min: 0, max: 1 },
  mix: { min: 0, max: 1 },
  rate_hz: { min: 0.1, max: 8 },
  depth: { min: 0, max: 1 },
  feedback: { min: 0, max: 0.9 },
  reverb_decay_s: { min: 0.5, max: 10 },
} as const satisfies Record<string, Range>;

export const DELAY_TIMES = ["1/16", "1/8", "1/8d", "1/4", "1/2"] as const satisfies readonly NonNullable<
  DelayEffect["time"]
>[];

const MELODIC_ONLY = ["attack_s", "decay_s", "sustain", "release_s"] as const;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Returns the message tail after the track label, or null when the sound is acceptable. Unknown fields are
// ignored so a newer document's extra settings survive a round trip.
export function soundProblem(sound: unknown, drums: boolean): string | null {
  // Rust deserialises null into an absent option, so a document with null is valid there and must be here.
  if (sound === null) return null;
  if (!isObject(sound)) return "sound must be an object";

  const range = (group: Raw, name: string, r: Range): string | null => {
    const v = group[name];
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) return `${name} must be a number`;
    return v < r.min || v > r.max ? `${name} must be ${r.min}-${r.max}, got ${v}` : null;
  };
  const group = (key: string, parent: Raw): Raw | string | null => {
    const g = parent[key];
    if (g === undefined || g === null) return null;
    return isObject(g) ? g : `${key} must be an object`;
  };
  const check = (g: Raw, fields: [string, Range][]): string | null => {
    for (const [name, r] of fields) {
      const msg = range(g, name, r);
      if (msg) return msg;
    }
    return null;
  };
  const R = SOUND_RANGES;

  const tone = group("tone", sound);
  if (typeof tone === "string") return tone;
  if (tone) {
    for (const f of MELODIC_ONLY)
      if (tone[f] != null && drums) return `${f} applies to melodic tracks only`;
    if (tone.pitch_semitones != null && !drums)
      return "pitch_semitones applies to drums tracks only";
    const msg = check(tone, [
      ["filter_cutoff_hz", R.filter_cutoff_hz],
      ["filter_resonance", R.filter_resonance],
      ["attack_s", R.attack_s],
      ["decay_s", R.decay_s],
      ["sustain", R.sustain],
      ["release_s", R.release_s],
      ["pitch_semitones", R.pitch_semitones],
    ]);
    if (msg) return msg;
    if (tone.pitch_semitones != null && !Number.isInteger(tone.pitch_semitones))
      return "pitch_semitones must be a whole number";
  }

  const effects = group("effects", sound);
  if (typeof effects === "string") return effects;
  if (!effects) return null;

  const specs: [string, [string, Range][]][] = [
    ["eq", [["low_db", R.eq_db], ["mid_db", R.eq_db], ["high_db", R.eq_db]]],
    ["distortion", [["drive", R.drive], ["mix", R.mix]]],
    ["chorus", [["rate_hz", R.rate_hz], ["depth", R.depth], ["mix", R.mix]]],
    ["delay", [["feedback", R.feedback], ["mix", R.mix]]],
    ["reverb", [["decay_s", R.reverb_decay_s], ["mix", R.mix]]],
  ];
  for (const [key, fields] of specs) {
    const g = group(key, effects);
    if (typeof g === "string") return g;
    if (!g) continue;
    if (g.enabled != null && typeof g.enabled !== "boolean")
      return `${key} enabled must be true or false`;
    if (key === "delay" && g.time != null && !(DELAY_TIMES as readonly unknown[]).includes(g.time))
      return `delay time must be one of ${DELAY_TIMES.join(", ")}, got ${JSON.stringify(g.time)}`;
    const msg = check(g, fields);
    if (msg) return msg;
  }
  return null;
}
