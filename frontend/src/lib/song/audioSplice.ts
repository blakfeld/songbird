import type { AudioClip } from "@/generated/AudioClip";
import {
  AUDIO_INSTRUMENT_ID,
  MAX_AUDIO_CLIPS,
  TICKS_PER_SECOND_PER_BPM,
  TICKS_PER_SIXTEENTH,
  sampleMap,
  scaledEnd,
  scaledMeasure,
} from "./audioTiming";
import { MEASURE_RANGE, newId, type Song, type Track } from "./types";

export type AudioSpliceFailure = {
  reason: "clip-limit" | "loop-split" | "song-limit";
  track: string;
};

const byStart = (a: AudioClip, b: AudioClip) => a.start_ticks - b.start_ticks;
export const isAudioFailure = (r: Track[] | AudioSpliceFailure): r is AudioSpliceFailure => "reason" in r;

interface Grid {
  // Per sample id, because a clip's end is only exact against its own sample rate.
  rates: Map<string, number>;
  tempo: number;
  spm: number;
}

const gridOf = (song: Song): Grid => ({
  rates: new Map([...sampleMap(song.samples)].map(([id, s]) => [id, s.sample_rate])),
  tempo: song.tempo_bpm,
  spm: song.steps_per_measure,
});

const barTick = (g: Grid, measure: number) => (measure - 1) * g.spm * TICKS_PER_SIXTEENTH;

// Compared scaled by the sample rate so a clip ending exactly on the barline is not read as crossing it.
const crosses = (g: Grid, c: AudioClip, rate: number, tick: number) =>
  c.start_ticks < tick && scaledEnd(c, rate, g.tempo) > tick * rate;

// Floored in integers: the head must end at or before the barline, because a head that ends a fraction of a sample
// after it would overlap the tail, and overlap is invalid. The tail starts on the barline tick and plays the samples
// the head did not, so none is dropped or repeated; its audio is therefore under one sample early, which is the
// least that a sample-addressed clip on a tick grid can do.
function headSamples(g: Grid, c: AudioClip, rate: number, tick: number): number {
  const numerator = (tick - c.start_ticks) * rate;
  const unit = TICKS_PER_SECOND_PER_BPM * g.tempo;
  return (numerator - (numerator % unit)) / unit;
}

const headOf = (c: AudioClip, h: number): AudioClip => ({
  ...c,
  length_samples: h,
  fade_in_samples: Math.min(c.fade_in_samples, h),
  // A fade at the cut would change what is heard, so the head never gets the clip's fade-out. A fade longer than its
  // piece is clamped to that piece rather than carried across the cut: the accepted exception in the sections spec
  // ("Measure edits move clips"), since a clip's fades must fit inside it.
  fade_out_samples: 0,
});

// A looping clip can only continue at the same loop position when the cut lands on a repeat, because
// offset_samples is also where the loop wraps to and there is no separate phase.
function tailOf(c: AudioClip, tick: number, h: number): AudioClip | null {
  if (c.loop && h % c.slice_samples !== 0) return null;
  const length = c.length_samples - h;
  return {
    ...c,
    id: newId(),
    start_ticks: tick,
    length_samples: length,
    fade_in_samples: 0,
    fade_out_samples: Math.min(c.fade_out_samples, length),
    ...(c.loop ? {} : { offset_samples: c.offset_samples + h, slice_samples: c.slice_samples - h }),
  };
}

type Pieces = { clips: AudioClip[] } | "loop-split";

// A clip starting less than a sample before the barline has no whole sample to leave behind, so it moves wholesale.
function splitAt(g: Grid, c: AudioClip, rate: number, tick: number): Pieces {
  if (!crosses(g, c, rate, tick)) return { clips: [c] };
  const h = headSamples(g, c, rate, tick);
  if (h < 1) return { clips: [{ ...c, start_ticks: tick }] };
  const tail = tailOf(c, tick, h);
  return tail ? { clips: [headOf(c, h), tail] } : "loop-split";
}

const audioTracks = (song: Song) => song.tracks.filter((t) => t.instrument === AUDIO_INSTRUMENT_ID);

function mapAudio(
  song: Song,
  fn: (track: Track, clips: AudioClip[], g: Grid) => AudioClip[] | AudioSpliceFailure,
): Track[] | AudioSpliceFailure {
  const g = gridOf(song);
  const next = new Map<Track, Track>();
  for (const t of audioTracks(song)) {
    const result = fn(t, t.audio_clips ?? [], g);
    if (!Array.isArray(result)) return result;
    if (result.length > MAX_AUDIO_CLIPS) return { reason: "clip-limit", track: t.name };
    next.set(t, { ...t, audio_clips: result.sort(byStart) });
  }
  return song.tracks.map((t) => next.get(t) ?? t);
}

// Audio sits on the tick grid rather than in measure clips, so a section edit has to move it separately or recordings
// would stay put while the notes around them shifted.
export function insertAudio(
  song: Song,
  atMeasure: number,
  count: number,
  source?: { start: number; end: number },
): Track[] | AudioSpliceFailure {
  const points = [...new Set(source ? [source.start, source.end + 1, atMeasure] : [atMeasure])];
  return mapAudio(song, (track, clips, g) => {
    let current = clips;
    for (const m of points) {
      const tick = barTick(g, m);
      const split: AudioClip[] = [];
      for (const c of current) {
        const rate = g.rates.get(c.sample_id);
        const pieces = rate === undefined ? { clips: [c] } : splitAt(g, c, rate, tick);
        if (pieces === "loop-split") return { reason: "loop-split", track: track.name };
        split.push(...pieces.clips);
      }
      current = split;
    }
    const at = barTick(g, atMeasure);
    const shift = count * g.spm * TICKS_PER_SIXTEENTH;
    const limit = MEASURE_RANGE.max;
    const copies: AudioClip[] = [];
    const shifted: AudioClip[] = [];
    for (const c of current) {
      const rate = g.rates.get(c.sample_id);
      if (rate === undefined) {
        shifted.push(c);
        continue;
      }
      if (source && c.start_ticks >= barTick(g, source.start) && scaledEnd(c, rate, g.tempo) <= barTick(g, source.end + 1) * rate)
        copies.push({ ...c, id: newId(), start_ticks: c.start_ticks + (at - barTick(g, source.start)) });
      if (c.start_ticks < at) {
        shifted.push(c);
        continue;
      }
      const moved = { ...c, start_ticks: c.start_ticks + shift };
      if (scaledEnd(moved, rate, g.tempo) > limit * scaledMeasure(g.spm, rate))
        return { reason: "song-limit", track: track.name };
      shifted.push(moved);
    }
    return [...shifted, ...copies];
  });
}

// A clip crossing an edge keeps only its outside parts, because the cut audio inside the span is being removed with its section.
export function removeAudio(song: Song, fromMeasure: number, count: number): Track[] | AudioSpliceFailure {
  return mapAudio(song, (track, clips, g) => {
    const a = barTick(g, fromMeasure);
    const b = barTick(g, fromMeasure + count);
    const shift = b - a;
    const out: AudioClip[] = [];
    for (const original of clips) {
      const rate = g.rates.get(original.sample_id);
      if (rate === undefined) {
        out.push(original);
        continue;
      }
      let c = original;
      if (crosses(g, c, rate, a)) {
        const h = headSamples(g, c, rate, a);
        if (h < 1) c = { ...c, start_ticks: a };
        else out.push(headOf(c, h));
      }
      if (scaledEnd(c, rate, g.tempo) <= a * rate) {
        out.push(c);
        continue;
      }
      if (c.start_ticks >= b) {
        out.push({ ...c, start_ticks: c.start_ticks - shift });
        continue;
      }
      if (scaledEnd(c, rate, g.tempo) <= b * rate) continue;
      // Audio after the span belongs to later material that must keep playing, so it closes up instead of being cut.
      const h = headSamples(g, c, rate, b);
      if (h < 1) {
        out.push({ ...c, start_ticks: a });
        continue;
      }
      const tail = tailOf(c, b, h);
      if (!tail) return { reason: "loop-split", track: track.name };
      out.push({ ...tail, start_ticks: a });
    }
    return out;
  });
}
