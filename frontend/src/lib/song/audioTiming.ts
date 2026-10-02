import type { AudioClip } from "@/generated/AudioClip";
import type { Sample } from "@/generated/Sample";

export const TICKS_PER_SIXTEENTH = 240;
// 60 s per minute divided into 4 sixteenths per beat at 240 ticks each gives 16 ticks per second per BPM.
export const TICKS_PER_SECOND_PER_BPM = 16;

export const MAX_SAMPLES = 256;
export const MAX_AUDIO_CLIPS = 256;
export const SAMPLE_NAME_MAX = 80;
export const SAMPLE_RATE_RANGE = { min: 22050, max: 192000 } as const;
export const MAX_SAMPLE_SECONDS = 20 * 60;
export const CLIP_GAIN_DB_RANGE = { min: -24, max: 12 } as const;
export const AUDIO_INSTRUMENT_ID = "audio";
// Counts are u32 in the document, which keeps every product below 2^53 so plain numbers stay exact.
export const U32_MAX = 4294967295;

// Ends are compared as ticks scaled by the sample rate, so no division ever rounds: the server does the
// same in integers, and a clip that ends exactly on a boundary must read the same on both sides.
export const scaledEnd = (
  clip: Pick<AudioClip, "start_ticks" | "length_samples">,
  sampleRate: number,
  tempoBpm: number,
) => clip.start_ticks * sampleRate + clip.length_samples * TICKS_PER_SECOND_PER_BPM * tempoBpm;

export const scaledMeasure = (stepsPerMeasure: number, sampleRate: number) =>
  stepsPerMeasure * TICKS_PER_SIXTEENTH * sampleRate;

// A clip counts up to the measure in which it ends, so an end exactly on a barline stays in the measure before it.
export const clipEndMeasure = (
  clip: Pick<AudioClip, "start_ticks" | "length_samples">,
  sampleRate: number,
  tempoBpm: number,
  stepsPerMeasure: number,
) => Math.ceil(scaledEnd(clip, sampleRate, tempoBpm) / scaledMeasure(stepsPerMeasure, sampleRate));

export const clipEndTicks = (
  clip: Pick<AudioClip, "start_ticks" | "length_samples">,
  sampleRate: number,
  tempoBpm: number,
) => Math.ceil(scaledEnd(clip, sampleRate, tempoBpm) / sampleRate);

// Rounded to whole ticks for display and snapping only; validity always uses `scaledEnd`.
export const samplesToTicks = (samples: number, sampleRate: number, tempoBpm: number) =>
  (samples * TICKS_PER_SECOND_PER_BPM * tempoBpm) / sampleRate;

export const ticksToSamples = (ticks: number, sampleRate: number, tempoBpm: number) =>
  (ticks * sampleRate) / (TICKS_PER_SECOND_PER_BPM * tempoBpm);

// Sorted by start, so only neighbours can collide; touching is allowed.
export function clipsOverlap(
  first: Pick<AudioClip, "start_ticks" | "length_samples">,
  second: Pick<AudioClip, "start_ticks">,
  sampleRate: number,
  tempoBpm: number,
) {
  return scaledEnd(first, sampleRate, tempoBpm) > second.start_ticks * sampleRate;
}

// Names are validated in UTF-16 units on both sides, and a lone surrogate is invalid JSON for the server.
export function cutUtf16(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export const sampleMap = (samples: Sample[] | undefined) => new Map((samples ?? []).map((s) => [s.id, s]));
