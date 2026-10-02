import {
  AUDIO_INSTRUMENT_ID,
  CLIP_GAIN_DB_RANGE,
  MAX_AUDIO_CLIPS,
  MAX_SAMPLES,
  MAX_SAMPLE_SECONDS,
  SAMPLE_NAME_MAX,
  SAMPLE_RATE_RANGE,
  MAX_TAKES_PER_TRACK,
  RECORDING_ORIGIN,
  U32_MAX,
  clipsOverlap,
  scaledEnd,
  scaledMeasure,
} from "./audioTiming";
import { soundProblem } from "./trackSound";
import { MEASURE_RANGE } from "./types";

export type AudioErrorKind =
  | "malformed"
  | "sound"
  | "sample_count"
  | "duplicate_sample_id"
  | "sample_name"
  | "sample_rate"
  | "sample_channels"
  | "sample_length"
  | "sample_origin"
  | "sample_recorded_at"
  | "sample_track"
  | "sample_take_count"
  | "audio_track_content"
  | "audio_clip_count"
  | "audio_clip_sample"
  | "audio_clip_range"
  | "audio_clip_gain"
  | "audio_clip_fade"
  | "duplicate_clip_id"
  | "clip_overlap"
  | "clip_outside_song";

export interface AudioProblem {
  kind: AudioErrorKind;
  message: string;
}
const problem = (kind: AudioErrorKind, message: string): AudioProblem => ({ kind, message });

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isU32 = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= U32_MAX;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;

interface RawSample {
  rate: number;
  length: number;
}

// Mirrors `validate_sample_track` in song.rs: a take must name an audio track, and only a take may name one.
function trackProblem(s: Raw, label: string, tracks: unknown[], takes: Map<string, number>): AudioProblem | null {
  const recording = s.origin === RECORDING_ORIGIN;
  const trackId = s.track_id;
  if (trackId !== undefined && trackId !== null && typeof trackId !== "string")
    return problem("malformed", `${label} has an invalid track_id`);
  const named = typeof trackId === "string";
  const at = s.recorded_at_ticks;
  if (at !== undefined && at !== null && !isU32(at)) return problem("malformed", `${label} has an invalid recorded_at_ticks`);
  const timed = at !== undefined && at !== null;
  if (!recording) {
    if (named) return problem("sample_origin", `${label}: track_id is only allowed on recordings`);
    return timed ? problem("sample_origin", `${label}: recorded_at_ticks is only allowed on recordings`) : null;
  }
  if (!named) return problem("sample_track", `${label}: a recording needs a track_id`);
  const track = tracks.find((t) => isObject(t) && t.id === trackId);
  if (!track) return problem("sample_track", `${label}: track_id \`${trackId}\` names no track`);
  if ((track as Raw).instrument !== AUDIO_INSTRUMENT_ID)
    return problem("sample_track", `${label}: track_id \`${trackId}\` is not an audio track`);
  if (!timed) return problem("sample_recorded_at", `${label}: a recording needs recorded_at_ticks`);
  const count = (takes.get(trackId) ?? 0) + 1;
  takes.set(trackId, count);
  if (count > MAX_TAKES_PER_TRACK)
    return problem("sample_take_count", `${label}: at most ${MAX_TAKES_PER_TRACK} recorded samples per track`);
  return null;
}

// Order and kinds follow `validate_samples` in song.rs, so a document with several faults reports the same one on both sides.
function checkSamples(raw: Raw): { samples: Map<string, RawSample> } | AudioProblem {
  const list = raw.samples ?? [];
  if (!Array.isArray(list)) return problem("malformed", "samples must be a list");
  if (list.length > MAX_SAMPLES)
    return problem("sample_count", `samples: at most ${MAX_SAMPLES} samples, got ${list.length}`);
  const samples = new Map<string, RawSample>();
  const takes = new Map<string, number>();
  const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  for (const s of list) {
    if (!isObject(s) || typeof s.id !== "string" || typeof s.name !== "string")
      return problem("malformed", "a sample is missing its id or name");
    const label = `samples: sample \`${s.id}\``;
    if (samples.has(s.id)) return problem("duplicate_sample_id", `${label} is used more than once`);
    if (!isU32(s.sample_rate) || !isU32(s.channels) || !isU32(s.length_samples))
      return problem("malformed", `${label} has a missing or invalid number`);
    if (s.name.length < 1 || s.name.length > SAMPLE_NAME_MAX)
      return problem("sample_name", `${label}: name must be 1-${SAMPLE_NAME_MAX} characters`);
    if (s.sample_rate < SAMPLE_RATE_RANGE.min || s.sample_rate > SAMPLE_RATE_RANGE.max)
      return problem(
        "sample_rate",
        `${label}: sample_rate must be ${SAMPLE_RATE_RANGE.min}-${SAMPLE_RATE_RANGE.max}, got ${s.sample_rate}`,
      );
    if (s.channels < 1 || s.channels > 2)
      return problem("sample_channels", `${label}: channels must be 1 or 2, got ${s.channels}`);
    if (s.length_samples < 1 || s.length_samples > s.sample_rate * MAX_SAMPLE_SECONDS)
      return problem(
        "sample_length",
        `${label}: length_samples must be 1-${s.sample_rate * MAX_SAMPLE_SECONDS} (20 minutes), got ${s.length_samples}`,
      );
    const bad = trackProblem(s, label, tracks, takes);
    if (bad) return bad;
    samples.set(s.id, { rate: s.sample_rate, length: s.length_samples });
  }
  return { samples };
}

function checkClip(
  label: string,
  clip: Raw,
  sample: RawSample,
): AudioProblem | null {
  const range = (detail: string) => problem("audio_clip_range", `${label}: clip \`${String(clip.id)}\` ${detail}`);
  const { offset_samples: offset, slice_samples: slice, length_samples: length } = clip;
  if (!isU32(clip.start_ticks) || !isU32(offset) || !isU32(slice) || !isU32(length))
    return problem("malformed", `${label}: clip \`${String(clip.id)}\` has a missing or invalid position or length`);
  const looping = clip.loop === undefined ? false : clip.loop;
  const gain = clip.gain_db === undefined ? 0 : clip.gain_db;
  const fadeIn = clip.fade_in_samples === undefined ? 0 : clip.fade_in_samples;
  const fadeOut = clip.fade_out_samples === undefined ? 0 : clip.fade_out_samples;
  if (typeof looping !== "boolean" || !isNum(gain) || !isU32(fadeIn) || !isU32(fadeOut))
    return problem("malformed", `${label}: clip \`${String(clip.id)}\` has an invalid loop, gain, or fade`);
  if (slice < 1) return range("must use at least 1 sample");
  if (offset + slice > sample.length)
    return range(`uses samples ${offset}-${offset + slice}, past the end of its sample (${sample.length} samples)`);
  if (length < 1) return range("must play at least 1 sample");
  if (!looping && length > slice) return range("is longer than its slice, which only a looping clip may be");
  if (gain < CLIP_GAIN_DB_RANGE.min || gain > CLIP_GAIN_DB_RANGE.max)
    return problem(
      "audio_clip_gain",
      `${label}: clip \`${String(clip.id)}\` gain_db must be ${CLIP_GAIN_DB_RANGE.min}-${CLIP_GAIN_DB_RANGE.max}, got ${gain}`,
    );
  if (fadeIn + fadeOut > length)
    return problem("audio_clip_fade", `${label}: clip \`${String(clip.id)}\` fades are longer than the clip`);
  return null;
}

// Covers the sample list and every audio track of an untrusted document. `clipIds` is shared across all
// tracks because an audio clip id may not repeat a note clip id either.
export function audioProblem(raw: Raw): AudioProblem | null {
  const hasAudio =
    raw.samples !== undefined ||
    (Array.isArray(raw.tracks) &&
      raw.tracks.some((t) => isObject(t) && (t.instrument === AUDIO_INSTRUMENT_ID || nonEmpty(t.audio_clips))));
  if (!hasAudio) return null;

  const found = checkSamples(raw);
  if ("kind" in found) return found;
  const { samples } = found;
  const tempo = raw.tempo_bpm;
  const spm = raw.steps_per_measure;
  const measures = raw.measures;
  if (!isNum(tempo) || !isNum(spm) || !isNum(measures)) return problem("malformed", "the song has no tempo or length");
  if (!Array.isArray(raw.tracks)) return null;

  const clipIds = new Set<string>();
  for (const [i, t] of raw.tracks.entries()) {
    if (!isObject(t)) continue;
    const label = `Track ${i + 1} "${String(t.name)}"`;
    const audioClips = t.audio_clips ?? [];
    if (!Array.isArray(audioClips)) return problem("malformed", `${label}: audio_clips must be a list`);
    if (t.instrument !== AUDIO_INSTRUMENT_ID) {
      if (audioClips.length > 0)
        return problem("audio_track_content", `${label}: audio clips belong on audio tracks only`);
      for (const c of Array.isArray(t.clips) ? t.clips : []) {
        if (isObject(c) && typeof c.id === "string") {
          if (clipIds.has(c.id))
            return problem("duplicate_clip_id", `${label}: clip id \`${c.id}\` is used more than once`);
          clipIds.add(c.id);
        }
      }
      continue;
    }
    if (nonEmpty(t.loops) || nonEmpty(t.clips))
      return problem("audio_track_content", `${label}: an audio track holds audio clips, not loops or clips`);
    if (audioClips.length > MAX_AUDIO_CLIPS)
      return problem("audio_clip_count", `${label}: at most ${MAX_AUDIO_CLIPS} audio clips, got ${audioClips.length}`);

    const placed: { id: string; start: number; length: number; rate: number }[] = [];
    for (const c of audioClips) {
      if (!isObject(c) || typeof c.id !== "string" || typeof c.sample_id !== "string")
        return problem("malformed", `${label}: an audio clip is missing its id or sample`);
      if (clipIds.has(c.id))
        return problem("duplicate_clip_id", `${label}: clip id \`${c.id}\` is used more than once`);
      clipIds.add(c.id);
      const sample = samples.get(c.sample_id);
      if (!sample)
        return problem(
          "audio_clip_sample",
          `${label}: clip \`${c.id}\` names sample \`${c.sample_id}\`, which is not in samples`,
        );
      const bad = checkClip(label, c, sample);
      if (bad) return bad;
      const clip = c as { start_ticks: number; length_samples: number };
      const end = scaledEnd(clip, sample.rate, tempo);
      if (end > measures * scaledMeasure(spm, sample.rate))
        return problem(
          "clip_outside_song",
          `${label}: clip \`${c.id}\` ends after the song's ${measures} measures at ${tempo} BPM (the limit is ${MEASURE_RANGE.max})`,
        );
      placed.push({ id: c.id, start: clip.start_ticks, length: clip.length_samples, rate: sample.rate });
    }
    placed.sort((a, b) => a.start - b.start);
    for (let n = 1; n < placed.length; n++) {
      const before = placed[n - 1];
      if (clipsOverlap({ start_ticks: before.start, length_samples: before.length }, { start_ticks: placed[n].start }, before.rate, tempo))
        return problem("clip_overlap", `${label}: clip \`${placed[n].id}\` overlaps the clip before it at ${tempo} BPM`);
    }
    if (isObject(t.sound)) {
      const { tone, ...rest } = t.sound;
      if (tone !== undefined && tone !== null)
        return problem("sound", `${label}: tone settings apply to instrument tracks, not audio tracks`);
      const reason = soundProblem(rest, false);
      if (reason) return problem("sound", `${label}: ${reason}`);
    } else if (t.sound !== undefined && t.sound !== null) {
      return problem("sound", `${label}: sound must be an object`);
    }
  }
  return null;
}
