import { STEPS_PER_QUARTER } from "@/lib/timing";
import type { PlaybackClip } from "./types";

// Mirrors the song document: clips sit on a tick grid finer than a step, and swing never moves them.
export const TICKS_PER_STEP = 240;

export const ticksToSeconds = (ticks: number, tempoBpm: number) =>
  (ticks / TICKS_PER_STEP) * (60 / tempoBpm / STEPS_PER_QUARTER);

export const clipLengthSeconds = ({ clip, sampleRate }: PlaybackClip) => clip.length_samples / sampleRate;

export const clipEndSeconds = (pc: PlaybackClip, tempoBpm: number) =>
  ticksToSeconds(pc.clip.start_ticks, tempoBpm) + clipLengthSeconds(pc);

export const dbToGain = (db: number) => 10 ** (db / 20);

export interface ClipPlayback {
  // All in seconds of the sample's own timeline, because that is what the player's offset and loop points use.
  offset: number;
  duration: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
}

// `position` is how far into the clip's own timeline playback begins, in frames, so a start inside a clip or after a
// loop wrap resumes at the audio that belongs at that moment rather than from the top.
export function planClip({ clip, sampleRate }: PlaybackClip, position: number): ClipPlayback | null {
  const remaining = clip.length_samples - position;
  if (position < 0 || remaining <= 0) return null;
  const sliceStart = clip.offset_samples;
  const into = clip.loop ? position % clip.slice_samples : position;
  return {
    offset: (sliceStart + into) / sampleRate,
    duration: remaining / sampleRate,
    loop: clip.loop,
    loopStart: sliceStart / sampleRate,
    loopEnd: (sliceStart + clip.slice_samples) / sampleRate,
  };
}

export interface GainPoint {
  // Relative to the start so the points stay valid whatever the audio clock reads when the clip is scheduled.
  at: number;
  value: number;
}

// The player is cut at the clip's end, so a clip without a fade-out needs no closing point; with the envelope
// piecewise linear, corners are all a ramp schedule has to carry.
export function clipEnvelope({ clip, sampleRate }: PlaybackClip, position: number): GainPoint[] {
  const peak = dbToGain(clip.gain_db);
  const length = clip.length_samples;
  const fadeIn = clip.fade_in_samples;
  const fadeOut = clip.fade_out_samples;
  const level = (p: number) => {
    const rise = fadeIn > 0 ? p / fadeIn : 1;
    const fall = fadeOut > 0 ? (length - p) / fadeOut : 1;
    return peak * Math.min(1, Math.max(0, Math.min(rise, fall)));
  };
  const corners = [position, fadeIn, length - fadeOut, length].filter((p) => p >= position && p <= length);
  const unique = [...new Set(corners)].sort((a, b) => a - b);
  return unique.map((p) => ({ at: (p - position) / sampleRate, value: level(p) }));
}
