import type { AudioClip } from "@/generated/AudioClip";
import type { Sample } from "@/generated/Sample";
import {
  CLIP_GAIN_DB_RANGE,
  MAX_AUDIO_CLIPS,
  MAX_SAMPLES,
  RECORDING_ORIGIN,
  SAMPLE_NAME_MAX,
  TICKS_PER_SECOND_PER_BPM,
  TICKS_PER_SIXTEENTH,
  AUDIO_INSTRUMENT_ID,
  clipEndTicks,
  cutUtf16,
  sampleMap,
  scaledEnd,
  scaledMeasure,
  ticksToSamples,
} from "./audioTiming";
import { samplerSampleIds } from "./sampler";
import { normalizeSong, uniqueTrackName } from "./songOps";
import { MAX_TRACKS, MEASURE_RANGE, TRACK_NAME_MAX, newId, newTrack, type Song, type Track } from "./types";

export type AudioFailure =
  | "not-found"
  | "no-room"
  | "song-limit"
  | "clip-limit"
  | "sample-limit"
  | "track-limit"
  | "in-use";

// `clipId` names the clip to select afterwards. A success may return the same song reference, which the store
// treats as a no-op, so a drag that ends where it began adds no undo step.
export type AudioOpResult =
  | { song: Song; clipId: string | null }
  | { song: null; reason: AudioFailure };

const fail = (reason: AudioFailure): AudioOpResult => ({ song: null, reason });
const ok = (song: Song, clipId: string | null = null): AudioOpResult => ({ song, clipId });

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const snapTicks = (ticks: number, free = false) =>
  Math.max(0, free ? Math.round(ticks) : Math.round(ticks / TICKS_PER_SIXTEENTH) * TICKS_PER_SIXTEENTH);

const clips = (t: Track) => t.audio_clips ?? [];
const byStart = (a: AudioClip, b: AudioClip) => a.start_ticks - b.start_ticks;

const isAudio = (t: Track) => t.instrument === AUDIO_INSTRUMENT_ID;

// Scaled by the clip's sample rate like every other end comparison, so bounds never depend on rounding.
const songLimit = (song: Song, rate: number) => MEASURE_RANGE.max * scaledMeasure(song.steps_per_measure, rate);

const maxLength = (song: Song, start: number, rate: number, limitScaled: number) =>
  Math.floor((limitScaled - start * rate) / (TICKS_PER_SECOND_PER_BPM * song.tempo_bpm));

interface Context {
  track: Track;
  clip: AudioClip;
  sample: Sample;
  prevEnd: number;
  nextStart: number | null;
}

function locate(song: Song, trackId: string, clipId: string): Context | null {
  const track = song.tracks.find((t) => t.id === trackId);
  const clip = track && clips(track).find((c) => c.id === clipId);
  const sample = clip && sampleMap(song.samples).get(clip.sample_id);
  if (!track || !clip || !sample) return null;
  const rates = sampleMap(song.samples);
  let prevEnd = 0;
  let nextStart: number | null = null;
  for (const other of clips(track)) {
    if (other === clip) continue;
    if (other.start_ticks < clip.start_ticks) {
      const rate = rates.get(other.sample_id)?.sample_rate ?? sample.sample_rate;
      prevEnd = Math.max(prevEnd, clipEndTicks(other, rate, song.tempo_bpm));
    } else if (nextStart === null || other.start_ticks < nextStart) nextStart = other.start_ticks;
  }
  return { track, clip, sample, prevEnd, nextStart };
}

// Fades share the clip's length, so any change to it has to pull them back inside.
function fitFades(c: AudioClip): AudioClip {
  const fadeIn = Math.min(c.fade_in_samples, c.length_samples);
  const fadeOut = Math.min(c.fade_out_samples, c.length_samples - fadeIn);
  return fadeIn === c.fade_in_samples && fadeOut === c.fade_out_samples
    ? c
    : { ...c, fade_in_samples: fadeIn, fade_out_samples: fadeOut };
}

const same = (a: AudioClip, b: AudioClip) =>
  a.start_ticks === b.start_ticks &&
  a.offset_samples === b.offset_samples &&
  a.slice_samples === b.slice_samples &&
  a.length_samples === b.length_samples &&
  a.loop === b.loop &&
  a.gain_db === b.gain_db &&
  a.fade_in_samples === b.fade_in_samples &&
  a.fade_out_samples === b.fade_out_samples &&
  a.sample_id === b.sample_id;

function withClip(song: Song, ctx: Context, next: AudioClip): AudioOpResult {
  if (same(ctx.clip, next)) return ok(song, ctx.clip.id);
  const track = { ...ctx.track, audio_clips: clips(ctx.track).map((c) => (c === ctx.clip ? next : c)).sort(byStart) };
  return ok(
    normalizeSong({ ...song, tracks: song.tracks.map((t) => (t === ctx.track ? track : t)) }),
    next.id,
  );
}

const withSample = (song: Song, sample: Sample): Song["samples"] =>
  (song.samples ?? []).some((s) => s.id === sample.id) ? song.samples : [...(song.samples ?? []), sample];

const fullClip = (sample: Sample, startTicks: number): AudioClip => ({
  id: newId(),
  sample_id: sample.id,
  start_ticks: startTicks,
  offset_samples: 0,
  slice_samples: sample.length_samples,
  length_samples: sample.length_samples,
  loop: false,
  gain_db: 0,
  fade_in_samples: 0,
  fade_out_samples: 0,
});

export function addAudioTrack(song: Song, name = "Audio"): { song: Song; trackId: string } | null {
  if (song.tracks.length >= MAX_TRACKS) return null;
  const track = newTrack(AUDIO_INSTRUMENT_ID, uniqueTrackName(song, cutUtf16(name, TRACK_NAME_MAX) || "Audio"));
  return { song: { ...song, tracks: [...song.tracks, track] }, trackId: track.id };
}

function placeInTrack(song: Song, track: Track, sample: Sample, startTicks: number): AudioOpResult {
  if (!isAudio(track)) return fail("not-found");
  if (clips(track).length >= MAX_AUDIO_CLIPS) return fail("clip-limit");
  const known = (song.samples ?? []).some((s) => s.id === sample.id);
  if (!known && (song.samples ?? []).length >= MAX_SAMPLES) return fail("sample-limit");
  const clip = fullClip(sample, Math.max(0, Math.round(startTicks)));
  const rates = sampleMap(song.samples);
  const room = maxLength(song, clip.start_ticks, sample.sample_rate, songLimit(song, sample.sample_rate));
  if (room < clip.length_samples) return fail("song-limit");
  const taken = clips(track).some((o) => {
    const rate = rates.get(o.sample_id)?.sample_rate ?? sample.sample_rate;
    const before = o.start_ticks < clip.start_ticks;
    return before
      ? clipEndTicks(o, rate, song.tempo_bpm) > clip.start_ticks
      : o.start_ticks * sample.sample_rate < clip.start_ticks * sample.sample_rate + clip.length_samples * TICKS_PER_SECOND_PER_BPM * song.tempo_bpm;
  });
  if (taken) return fail("no-room");
  const next: Track = { ...track, audio_clips: [...clips(track), clip].sort(byStart) };
  return ok(
    normalizeSong({
      ...song,
      samples: withSample(song, sample),
      tracks: song.tracks.map((t) => (t === track ? next : t)),
    }),
    clip.id,
  );
}

export function placeSample(song: Song, trackId: string, sample: Sample, startTicks: number): AudioOpResult {
  const track = song.tracks.find((t) => t.id === trackId);
  return track ? placeInTrack(song, track, sample, startTicks) : fail("not-found");
}

// Track and clip arrive together so one undo step covers both.
export function placeOnNewTrack(song: Song, sample: Sample, startTicks: number): AudioOpResult & { trackId?: string } {
  const added = addAudioTrack(song, sample.name);
  if (!added) return fail("track-limit");
  const result = placeSample(added.song, added.trackId, sample, startTicks);
  return result.song ? { ...result, trackId: added.trackId } : result;
}

// A move that meets a neighbour stops against it rather than hopping over, so the clip order never changes.
export function moveClip(song: Song, trackId: string, clipId: string, startTicks: number, free = false): AudioOpResult {
  const ctx = locate(song, trackId, clipId);
  if (!ctx) return fail("not-found");
  const { clip, sample } = ctx;
  const limit = Math.min(
    songLimit(song, sample.sample_rate),
    ctx.nextStart === null ? Infinity : ctx.nextStart * sample.sample_rate,
  );
  const hi = Math.floor(
    (limit - clip.length_samples * TICKS_PER_SECOND_PER_BPM * song.tempo_bpm) / sample.sample_rate,
  );
  if (hi < ctx.prevEnd) return ok(song, clip.id);
  const start = clamp(snapTicks(startTicks, free), ctx.prevEnd, hi);
  return withClip(song, ctx, { ...clip, start_ticks: start });
}

// The start tick is chosen first and the trimmed samples are rounded up from it, so the end can only move earlier:
// rounding the two independently could push the end into the next clip, which the server then rejects.
export function trimStart(song: Song, trackId: string, clipId: string, startTicks: number, free = false): AudioOpResult {
  const ctx = locate(song, trackId, clipId);
  if (!ctx) return fail("not-found");
  const { clip, sample } = ctx;
  const rate = sample.sample_rate;
  const unit = TICKS_PER_SECOND_PER_BPM * song.tempo_bpm;
  const snapped = snapTicks(startTicks, free);
  const toSamples = (ticks: number) => Math.ceil(((ticks - clip.start_ticks) * rate) / unit);
  const delta = clamp(
    toSamples(snapped),
    Math.max(-clip.offset_samples, toSamples(ctx.prevEnd)),
    Math.min(clip.slice_samples, clip.length_samples) - 1,
  );
  const latest = Math.floor((clip.start_ticks * rate + delta * unit) / rate);
  // `latest` equals the snapped tick unless the sample's start held the trim, and then the clip must stay where its audio is.
  const start = Math.max(ctx.prevEnd, latest);
  if (start === clip.start_ticks && delta === 0) return ok(song, clip.id);
  return withClip(
    song,
    ctx,
    fitFades({
      ...clip,
      start_ticks: start,
      offset_samples: clip.offset_samples + delta,
      slice_samples: clip.slice_samples - delta,
      length_samples: clip.length_samples - delta,
    }),
  );
}

export function setEnd(song: Song, trackId: string, clipId: string, endTicks: number, free = false): AudioOpResult {
  const ctx = locate(song, trackId, clipId);
  if (!ctx) return fail("not-found");
  const { clip, sample } = ctx;
  const wanted = Math.round(
    ticksToSamples(snapTicks(endTicks, free) - clip.start_ticks, sample.sample_rate, song.tempo_bpm),
  );
  const room = maxLength(
    song,
    clip.start_ticks,
    sample.sample_rate,
    Math.min(
      songLimit(song, sample.sample_rate),
      ctx.nextStart === null ? Infinity : ctx.nextStart * sample.sample_rate,
    ),
  );
  const ceiling = clip.loop ? room : Math.min(room, sample.length_samples - clip.offset_samples);
  const length = clamp(wanted, 1, Math.max(1, ceiling));
  if (length === clip.length_samples) return ok(song, clip.id);
  return withClip(
    song,
    ctx,
    fitFades({
      ...clip,
      length_samples: length,
      // A plain clip's slice is what it plays, so turning loop on later repeats the audio the user left in.
      slice_samples: clip.loop ? clip.slice_samples : length,
    }),
  );
}

export function setLoop(song: Song, trackId: string, clipId: string, loop: boolean): AudioOpResult {
  const ctx = locate(song, trackId, clipId);
  if (!ctx) return fail("not-found");
  if (ctx.clip.loop === loop) return ok(song, ctx.clip.id);
  return withClip(
    song,
    ctx,
    fitFades({
      ...ctx.clip,
      loop,
      length_samples: loop ? ctx.clip.length_samples : Math.min(ctx.clip.length_samples, ctx.clip.slice_samples),
    }),
  );
}

export function setGain(song: Song, trackId: string, clipId: string, gainDb: number): AudioOpResult {
  const ctx = locate(song, trackId, clipId);
  if (!ctx) return fail("not-found");
  const gain = clamp(gainDb, CLIP_GAIN_DB_RANGE.min, CLIP_GAIN_DB_RANGE.max);
  return withClip(song, ctx, { ...ctx.clip, gain_db: gain });
}

// Whichever fade is being set wins, and the other gives way, so a drag never snaps back under the pointer.
export function setFades(
  song: Song,
  trackId: string,
  clipId: string,
  fades: { fadeIn?: number; fadeOut?: number },
): AudioOpResult {
  const ctx = locate(song, trackId, clipId);
  if (!ctx) return fail("not-found");
  const { clip } = ctx;
  const whole = (n: number) => clamp(Math.round(n), 0, clip.length_samples);
  let fadeIn = fades.fadeIn === undefined ? clip.fade_in_samples : whole(fades.fadeIn);
  let fadeOut = fades.fadeOut === undefined ? clip.fade_out_samples : whole(fades.fadeOut);
  if (fadeIn + fadeOut > clip.length_samples) {
    if (fades.fadeIn !== undefined) fadeOut = clip.length_samples - fadeIn;
    else fadeIn = clip.length_samples - fadeOut;
  }
  return withClip(song, ctx, { ...clip, fade_in_samples: fadeIn, fade_out_samples: fadeOut });
}

// A copy that would run into the next clip or the song limit is shortened to the gap rather than refused.
export function duplicateClip(song: Song, trackId: string, clipId: string): AudioOpResult {
  const ctx = locate(song, trackId, clipId);
  if (!ctx) return fail("not-found");
  const { clip, sample, track } = ctx;
  if (clips(track).length >= MAX_AUDIO_CLIPS) return fail("clip-limit");
  const start = clipEndTicks(clip, sample.sample_rate, song.tempo_bpm);
  const following = clips(track)
    .filter((o) => o.start_ticks >= start)
    .reduce<number | null>((min, o) => (min === null || o.start_ticks < min ? o.start_ticks : min), null);
  const room = maxLength(
    song,
    start,
    sample.sample_rate,
    Math.min(songLimit(song, sample.sample_rate), following === null ? Infinity : following * sample.sample_rate),
  );
  if (room < 1) return fail(following === null ? "song-limit" : "no-room");
  const copy = fitFades({ ...clip, id: newId(), start_ticks: start, length_samples: Math.min(clip.length_samples, room) });
  const next: Track = { ...track, audio_clips: [...clips(track), copy].sort(byStart) };
  return ok(normalizeSong({ ...song, tracks: song.tracks.map((t) => (t === track ? next : t)) }), copy.id);
}

// A recorded take replaces what was there only for the span it covers, so earlier takes survive on both sides of a
// punch-in. Clips of unknown samples are left alone because their end cannot be measured.
export function replaceSpan(song: Song, trackId: string, startTicks: number, endTicks: number): AudioOpResult {
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track || !isAudio(track)) return fail("not-found");
  if (endTicks <= startTicks) return ok(song);
  const rates = sampleMap(song.samples);
  const unit = TICKS_PER_SECOND_PER_BPM * song.tempo_bpm;
  const pieces: AudioClip[] = [];
  let changed = false;
  for (const clip of clips(track)) {
    const rate = rates.get(clip.sample_id)?.sample_rate;
    if (rate === undefined || scaledEnd(clip, rate, song.tempo_bpm) <= startTicks * rate || clip.start_ticks >= endTicks) {
      pieces.push(clip);
      continue;
    }
    changed = true;
    const splits = clip.start_ticks < startTicks && scaledEnd(clip, rate, song.tempo_bpm) > endTicks * rate;
    if (clip.start_ticks < startTicks) {
      const length = Math.floor(((startTicks - clip.start_ticks) * rate) / unit);
      if (length >= 1) {
        pieces.push(
          fitFades({ ...clip, length_samples: length, slice_samples: clip.loop ? clip.slice_samples : length, fade_out_samples: 0 }),
        );
      }
    }
    if (scaledEnd(clip, rate, song.tempo_bpm) > endTicks * rate) {
      // Rounded up from the span's end, then the start tick rounded down, so the piece can only end earlier and
      // never runs into the clip after it.
      const delta = Math.max(0, Math.ceil(((endTicks - clip.start_ticks) * rate) / unit));
      const length = clip.length_samples - delta;
      if (length >= 1) {
        const start = Math.floor((clip.start_ticks * rate + delta * unit) / rate);
        // A loop's phase cannot be carried into a later start, so it restarts rather than shrinking its region.
        const sliced = clip.loop ? {} : { offset_samples: clip.offset_samples + delta, slice_samples: clip.slice_samples - delta };
        pieces.push(
          fitFades({
            ...clip,
            ...sliced,
            id: splits ? newId() : clip.id,
            start_ticks: start,
            length_samples: length,
            fade_in_samples: 0,
          }),
        );
      }
    }
  }
  if (!changed) return ok(song);
  if (pieces.length > MAX_AUDIO_CLIPS) return fail("clip-limit");
  const next: Track = { ...track, audio_clips: pieces.sort(byStart) };
  return ok(normalizeSong({ ...song, tracks: song.tracks.map((t) => (t === track ? next : t)) }));
}

export interface TakeClip {
  sampleId: string;
  startTicks: number;
  offsetSamples: number;
  lengthSamples: number;
}

// One call for a whole recording session so the samples, the cut and the clip land in a single history entry.
// Every pass becomes a sample, but only the clip's own pass is played; the rest stay reachable as takes.
export function recordTake(song: Song, trackId: string, takes: Sample[], clip: TakeClip): AudioOpResult {
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track || !isAudio(track)) return fail("not-found");
  const known = new Set((song.samples ?? []).map((s) => s.id));
  const fresh = takes.filter((s, i) => !known.has(s.id) && takes.findIndex((o) => o.id === s.id) === i);
  if ((song.samples ?? []).length + fresh.length > MAX_SAMPLES) return fail("sample-limit");
  const sample = takes.find((s) => s.id === clip.sampleId) ?? sampleMap(song.samples).get(clip.sampleId);
  if (!sample) return fail("not-found");
  const withSamples: Song = { ...song, samples: [...(song.samples ?? []), ...fresh] };
  const placed: AudioClip = {
    ...fullClip(sample, Math.max(0, Math.round(clip.startTicks))),
    offset_samples: clip.offsetSamples,
    slice_samples: clip.lengthSamples,
    length_samples: clip.lengthSamples,
  };
  const end = clipEndTicks(placed, sample.sample_rate, song.tempo_bpm);
  if (maxLength(song, placed.start_ticks, sample.sample_rate, songLimit(song, sample.sample_rate)) < placed.length_samples)
    return fail("song-limit");
  const cut = replaceSpan(withSamples, trackId, placed.start_ticks, end);
  if (!cut.song) return cut;
  const cutTrack = cut.song.tracks.find((t) => t.id === trackId)!;
  if (clips(cutTrack).length >= MAX_AUDIO_CLIPS) return fail("clip-limit");
  const next: Track = { ...cutTrack, audio_clips: [...clips(cutTrack), placed].sort(byStart) };
  return ok(normalizeSong({ ...cut.song, tracks: cut.song.tracks.map((t) => (t === cutTrack ? next : t)) }), placed.id);
}

// Newest first, which is the order the Takes list shows; samples are appended as they are recorded.
export const takesOf = (song: Song, trackId: string): Sample[] =>
  (song.samples ?? []).filter((s) => s.origin === RECORDING_ORIGIN && s.track_id === trackId).reverse();

// Counted over every track because a clip or a sampler pad may name any sample in the song, whatever track it was
// recorded on: a take added to the library and put on a pad is the same sample id.
export const usesOf = (song: Song, sampleId: string): { clips: number; pads: number } => ({
  clips: song.tracks.reduce((n, t) => n + clips(t).filter((c) => c.sample_id === sampleId).length, 0),
  pads: song.tracks.reduce((n, t) => n + samplerSampleIds(t).filter((id) => id === sampleId).length, 0),
});
export const isUsed = (song: Song, sampleId: string): boolean => {
  const { clips: c, pads } = usesOf(song, sampleId);
  return c + pads > 0;
};

export function renameSample(song: Song, sampleId: string, name: string): AudioOpResult {
  const next = cutUtf16(name.trim(), SAMPLE_NAME_MAX);
  const sample = (song.samples ?? []).find((s) => s.id === sampleId);
  if (!sample || !next) return fail("not-found");
  if (sample.name === next) return ok(song);
  return ok({ ...song, samples: (song.samples ?? []).map((s) => (s === sample ? { ...s, name: next } : s)) });
}

// A take a clip or pad uses cannot go, so a delete never leaves one pointing at nothing; refusing all of them keeps one
// undo step from meaning "some of what you asked for".
export function deleteTakes(song: Song, trackId: string, sampleIds: string[]): AudioOpResult {
  const takes = new Set(takesOf(song, trackId).map((s) => s.id));
  const doomed = new Set(sampleIds.filter((id) => takes.has(id)));
  if (doomed.size === 0) return fail("not-found");
  if ([...doomed].some((id) => isUsed(song, id))) return fail("in-use");
  return ok({ ...song, samples: (song.samples ?? []).filter((s) => !doomed.has(s.id)) });
}

export function deleteClip(song: Song, trackId: string, clipId: string): AudioOpResult {
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track || !clips(track).some((c) => c.id === clipId)) return fail("not-found");
  const next: Track = { ...track, audio_clips: clips(track).filter((c) => c.id !== clipId) };
  return ok(normalizeSong({ ...song, tracks: song.tracks.map((t) => (t === track ? next : t)) }));
}

export function replaceSample(song: Song, trackId: string, clipId: string, sample: Sample): AudioOpResult {
  const ctx = locate(song, trackId, clipId);
  if (!ctx) return fail("not-found");
  const { clip, track } = ctx;
  if (clip.sample_id === sample.id) return ok(song, clip.id);
  const known = (song.samples ?? []).some((s) => s.id === sample.id);
  if (!known && (song.samples ?? []).length >= MAX_SAMPLES) return fail("sample-limit");
  const room = maxLength(
    song,
    clip.start_ticks,
    sample.sample_rate,
    Math.min(
      songLimit(song, sample.sample_rate),
      ctx.nextStart === null ? Infinity : ctx.nextStart * sample.sample_rate,
    ),
  );
  if (room < 1) return fail("no-room");
  const wanted = clip.loop ? clip.length_samples : Math.min(clip.length_samples, sample.length_samples);
  const next = fitFades({
    ...clip,
    sample_id: sample.id,
    offset_samples: 0,
    slice_samples: sample.length_samples,
    length_samples: Math.min(wanted, room),
  });
  const tracks = song.tracks.map((t) =>
    t === track ? { ...track, audio_clips: clips(track).map((c) => (c === clip ? next : c)) } : t,
  );
  return ok(normalizeSong({ ...song, samples: withSample(song, sample), tracks }), clip.id);
}

// Choosing a take on the same track keeps what the clip played at each song position: the take is entered at the
// point of its own recording that matches where the clip sits, not from its start. Takes recorded without a
// position, or on another track, start from the top as any replaced sample does.
export function switchTake(song: Song, trackId: string, clipId: string, take: Sample): AudioOpResult {
  const replaced = replaceSample(song, trackId, clipId, take);
  const ctx = locate(song, trackId, clipId);
  if (!replaced.song || !ctx || take.track_id !== trackId || take.recorded_at_ticks === undefined) return replaced;
  const { clip } = ctx;
  const into = Math.round(ticksToSamples(clip.start_ticks - take.recorded_at_ticks, take.sample_rate, song.tempo_bpm));
  // Before the take began there is nothing to play, and the end of the take leaves at least one sample for the clip.
  const offset = clamp(into, 0, take.length_samples - 1);
  const placed = replaced.song.tracks.find((t) => t.id === trackId)?.audio_clips?.find((c) => c.id === clipId);
  if (!placed || offset === 0) return replaced;
  const slice = take.length_samples - offset;
  const next = fitFades({
    ...placed,
    offset_samples: offset,
    slice_samples: slice,
    length_samples: placed.loop ? placed.length_samples : Math.min(placed.length_samples, slice),
  });
  const track = replaced.song.tracks.find((t) => t.id === trackId)!;
  const tracks = replaced.song.tracks.map((t) =>
    t === track ? { ...track, audio_clips: clips(track).map((c) => (c.id === clipId ? next : c)) } : t,
  );
  return ok(normalizeSong({ ...replaced.song, tracks }), clipId);
}

export type SequenceResult =
  | {
      song: Song;
      clipId: string;
      trackId: string;
      placed: number;
      // The first sample that did not fit; the ones before it stay placed and the ones after it are not tried.
      stopped?: { sample: Sample; reason: AudioFailure; startTicks: number };
    }
  | { song: null; reason: AudioFailure; sample: Sample; startTicks: number };

// Files dropped together are laid end to end from the drop point as one edit, so one undo step reverts them all.
export function placeSequence(
  song: Song,
  trackId: string | null,
  samples: Sample[],
  startTicks: number,
): SequenceResult {
  let current = song;
  let target = trackId;
  let at = Math.max(0, Math.round(startTicks));
  let clipId = "";
  let placed = 0;
  for (const sample of samples) {
    let result: AudioOpResult;
    if (target === null) {
      const made = placeOnNewTrack(current, sample, at);
      if (made.song) target = made.trackId ?? null;
      result = made;
    } else {
      result = placeSample(current, target, sample, at);
    }
    if (!result.song || target === null) {
      if (placed === 0)
        return { song: null, reason: result.song ? "not-found" : result.reason, sample, startTicks: at };
      return {
        song: current,
        clipId,
        trackId: target!,
        placed,
        stopped: { sample, reason: result.song ? "not-found" : result.reason, startTicks: at },
      };
    }
    current = result.song;
    clipId = result.clipId ?? clipId;
    const track = current.tracks.find((t) => t.id === target);
    const clip = clips(track!).find((c) => c.id === clipId);
    if (clip) at = clipEndTicks(clip, sample.sample_rate, current.tempo_bpm);
    placed++;
  }
  return { song: current, clipId, trackId: target!, placed };
}
