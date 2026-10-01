import type { TrackSound } from "@/generated/TrackSound";
import { EFFECT_DEFAULTS as SONG_EFFECT_DEFAULTS } from "@/lib/song/soundDefaults";
import { DELAY_TIMES, SOUND_RANGES } from "@/lib/song/trackSound";
import type { ToneControls, ToneEnvelope } from "./types";

export type DelayTime = (typeof DELAY_TIMES)[number];

export interface ResolvedEffects {
  eq: { enabled: boolean; lowDb: number; midDb: number; highDb: number };
  distortion: { enabled: boolean; drive: number; mix: number };
  chorus: { enabled: boolean; rateHz: number; depth: number; mix: number };
  delay: { enabled: boolean; time: DelayTime; feedback: number; mix: number };
  reverb: { enabled: boolean; decayS: number; mix: number };
}

// Effects are resolved against defaults here, but tone stays as overrides, because a tone default
// belongs to the instrument and only the source knows it.
export interface VoiceSound {
  tone: ToneControls;
  effects: ResolvedEffects;
}

// Derived from the document-shaped table so the panel and the engine can never disagree on what "default" is.
const D = SONG_EFFECT_DEFAULTS;
export const EFFECT_DEFAULTS: ResolvedEffects = {
  eq: { enabled: false, lowDb: D.eq.low_db, midDb: D.eq.mid_db, highDb: D.eq.high_db },
  distortion: { enabled: false, drive: D.distortion.drive, mix: D.distortion.mix },
  chorus: { enabled: false, rateHz: D.chorus.rate_hz, depth: D.chorus.depth, mix: D.chorus.mix },
  delay: { enabled: false, time: D.delay.time, feedback: D.delay.feedback, mix: D.delay.mix },
  reverb: { enabled: false, decayS: D.reverb.decay_s, mix: D.reverb.mix },
};

export const DEFAULT_VOICE_SOUND: VoiceSound = { tone: {}, effects: EFFECT_DEFAULTS };

// Clamped so a document that slipped past validation cannot drive a node out of its safe range.
const clamp = (v: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, v));

export function resolveSound(sound: TrackSound | undefined): VoiceSound {
  if (!sound) return DEFAULT_VOICE_SOUND;
  const R = SOUND_RANGES;
  const d = EFFECT_DEFAULTS;
  const t = sound.tone;
  const e = sound.effects;
  // Validation accepts null as an absent leaf, and clamp(null) would silently become the range minimum.
  const num = (v: number | null | undefined, fallback: number, r: { min: number; max: number }) =>
    v == null ? fallback : clamp(v, r);

  const tone: ToneControls = {};
  if (t?.filter_cutoff_hz != null) tone.filterCutoffHz = clamp(t.filter_cutoff_hz, R.filter_cutoff_hz);
  if (t?.filter_resonance != null) tone.filterResonance = clamp(t.filter_resonance, R.filter_resonance);
  if (t?.pitch_semitones != null) tone.pitchSemitones = Math.round(clamp(t.pitch_semitones, R.pitch_semitones));
  const envelope: Partial<ToneEnvelope> = {};
  if (t?.attack_s != null) envelope.attack = clamp(t.attack_s, R.attack_s);
  if (t?.decay_s != null) envelope.decay = clamp(t.decay_s, R.decay_s);
  if (t?.sustain != null) envelope.sustain = clamp(t.sustain, R.sustain);
  if (t?.release_s != null) envelope.release = clamp(t.release_s, R.release_s);
  // Partial because the preset supplies the rest; only the source knows the preset.
  if (Object.keys(envelope).length > 0) tone.envelope = envelope;

  return {
    tone,
    effects: {
      eq: {
        enabled: e?.eq?.enabled ?? false,
        lowDb: num(e?.eq?.low_db, d.eq.lowDb, R.eq_db),
        midDb: num(e?.eq?.mid_db, d.eq.midDb, R.eq_db),
        highDb: num(e?.eq?.high_db, d.eq.highDb, R.eq_db),
      },
      distortion: {
        enabled: e?.distortion?.enabled ?? false,
        drive: num(e?.distortion?.drive, d.distortion.drive, R.drive),
        mix: num(e?.distortion?.mix, d.distortion.mix, R.mix),
      },
      chorus: {
        enabled: e?.chorus?.enabled ?? false,
        rateHz: num(e?.chorus?.rate_hz, d.chorus.rateHz, R.rate_hz),
        depth: num(e?.chorus?.depth, d.chorus.depth, R.depth),
        mix: num(e?.chorus?.mix, d.chorus.mix, R.mix),
      },
      delay: {
        enabled: e?.delay?.enabled ?? false,
        time: e?.delay?.time && DELAY_TIMES.includes(e.delay.time) ? e.delay.time : d.delay.time,
        feedback: num(e?.delay?.feedback, d.delay.feedback, R.feedback),
        mix: num(e?.delay?.mix, d.delay.mix, R.mix),
      },
      reverb: {
        enabled: e?.reverb?.enabled ?? false,
        decayS: num(e?.reverb?.decay_s, d.reverb.decayS, R.reverb_decay_s),
        mix: num(e?.reverb?.mix, d.reverb.mix, R.mix),
      },
    },
  };
}
