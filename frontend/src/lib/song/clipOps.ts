import type { Note } from "@/generated/Note";
import type { Row } from "@/generated/Row";
import { type NoteGrid, normalizeNotes } from "../patternOps";
import {
  LOOP_MEASURE_RANGE,
  LOOP_NAME_MAX,
  MAX_CLIPS,
  MAX_LOOPS,
  newId,
  type Clip,
  type Loop,
  type Song,
  type Track,
} from "./types";

// A new clip is deliberately short so an empty loop is quick to fill and easy to stretch.
export const NEW_CLIP_MEASURES = 4;

export type ClipFailure =
  | "not-found"
  | "no-room"
  | "clip-limit"
  | "loop-limit"
  | "not-shared";

// `clipId` names the clip the caller should select afterwards; null when no clip results from the op.
// A success may return the same song reference, which the store treats as a no-op.
export type ClipOpResult =
  | { song: Song; clipId: string | null }
  | { song: null; reason: ClipFailure };

const fail = (reason: ClipFailure): ClipOpResult => ({ song: null, reason });
const ok = (song: Song, clipId: string | null = null): ClipOpResult => ({
  song,
  clipId,
});

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// Exclusive end, so adjacent clips compare with plain <= and never off by one.
const clipEnd = (c: Clip) => c.start_measure + c.measures;

const byStart = (a: Clip, b: Clip) => a.start_measure - b.start_measure;

const withTrack = (
  song: Song,
  trackId: string,
  fn: (track: Track) => ClipOpResult | Track,
): ClipOpResult => {
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track) return fail("not-found");
  const result = fn(track);
  if ("song" in result) return result;
  if (result === track) return ok(song);
  return ok({
    ...song,
    tracks: song.tracks.map((t) => (t === track ? result : t)),
  });
};

// Ops that produce a track need the new clip id too, so they return a pair through this wrapper.
const editTrack = (
  song: Song,
  trackId: string,
  clipId: string | null,
  fn: (track: Track) => Track | ClipFailure,
): ClipOpResult => {
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track) return fail("not-found");
  const next = fn(track);
  if (typeof next === "string") return fail(next);
  if (next === track) return ok(song, clipId);
  return ok(
    { ...song, tracks: song.tracks.map((t) => (t === track ? next : t)) },
    clipId,
  );
};

const insertClip = (clips: Clip[], clip: Clip) =>
  [...clips, clip].sort(byStart);

export const loopUseCount = (track: Track, loopId: string) =>
  track.clips.filter((c) => c.loop_id === loopId).length;

// Returns a length rather than a yes/no so a placement can be shortened to fit instead of refused.
export function freeSpanAt(track: Track, measure: number, song: Song): number {
  if (measure < 1 || measure > song.measures) return 0;
  let limit = song.measures + 1;
  for (const c of track.clips) {
    if (measure >= c.start_measure && measure < clipEnd(c)) return 0;
    if (c.start_measure > measure) limit = Math.min(limit, c.start_measure);
  }
  return limit - measure;
}

// Lets the UI offer "the next place a clip fits" without duplicating the occupancy rules.
export function nextFreeMeasure(track: Track, song: Song, from = 1): number | null {
  for (let m = Math.max(1, from); m <= song.measures; m++) {
    const free = freeSpanAt(track, m, song);
    if (free > 0) return m;
    const covering = track.clips.find((c) => m >= c.start_measure && m < clipEnd(c));
    if (covering) m = clipEnd(covering) - 1;
  }
  return null;
}

// Snapping rather than refusing keeps a copy dropped onto a neighbour from feeling like a failed drag.
export function nearestFreeMeasure(track: Track, song: Song, desired: number): number | null {
  const at = clamp(Math.round(desired), 1, song.measures);
  for (let d = 0; d < song.measures; d++) {
    for (const m of d === 0 ? [at] : [at - d, at + d]) {
      if (freeSpanAt(track, m, song) > 0) return m;
    }
  }
  return null;
}

// Clamping to the neighbours here (not in callers) means pointer drags and keyboard nudges share one rule.
function neighbours(track: Track, clip: Clip, song: Song) {
  let prevEnd = 1;
  let nextStart = song.measures + 1;
  for (const c of track.clips) {
    if (c === clip) continue;
    if (clipEnd(c) <= clip.start_measure) prevEnd = Math.max(prevEnd, clipEnd(c));
    else if (c.start_measure >= clipEnd(clip))
      nextStart = Math.min(nextStart, c.start_measure);
  }
  return { prevEnd, nextStart };
}

// Suffixes are appended after truncating the base so the result always fits LOOP_NAME_MAX.
const fitName = (base: string, suffix: string) =>
  `${base.slice(0, LOOP_NAME_MAX - suffix.length)}${suffix}`;

function newLoopName(track: Track): string {
  const taken = new Set(track.loops.map((l) => l.name));
  for (let n = 1; ; n++) {
    const candidate = fitName(track.name, ` ${n}`);
    if (!taken.has(candidate)) return candidate;
  }
}

export function newClip(
  song: Song,
  trackId: string,
  measure: number,
): ClipOpResult {
  const clipId = newId();
  return editTrack(song, trackId, clipId, (track) => {
    if (track.clips.length >= MAX_CLIPS) return "clip-limit";
    if (track.loops.length >= MAX_LOOPS) return "loop-limit";
    const free = freeSpanAt(track, measure, song);
    if (free === 0) return "no-room";
    const measures = Math.min(NEW_CLIP_MEASURES, free);
    const loop: Loop = {
      id: newId(),
      name: newLoopName(track),
      measures,
      notes: [],
    };
    const clip: Clip = {
      id: clipId,
      loop_id: loop.id,
      start_measure: measure,
      measures,
    };
    return {
      ...track,
      loops: [...track.loops, loop],
      clips: insertClip(track.clips, clip),
    };
  });
}

// `measures` lets an Alt-drag copy keep the dragged clip's length rather than the loop's.
export function placeLoop(
  song: Song,
  trackId: string,
  loopId: string,
  measure: number,
  measures?: number,
): ClipOpResult {
  const clipId = newId();
  return editTrack(song, trackId, clipId, (track) => {
    const loop = track.loops.find((l) => l.id === loopId);
    if (!loop) return "not-found";
    if (track.clips.length >= MAX_CLIPS) return "clip-limit";
    const free = freeSpanAt(track, measure, song);
    if (free === 0) return "no-room";
    const clip: Clip = {
      id: clipId,
      loop_id: loop.id,
      start_measure: measure,
      measures: Math.max(1, Math.min(measures ?? loop.measures, free)),
    };
    return { ...track, clips: insertClip(track.clips, clip) };
  });
}

export function duplicateClip(
  song: Song,
  trackId: string,
  clipId: string,
): ClipOpResult {
  const copyId = newId();
  return editTrack(song, trackId, copyId, (track) => {
    const source = track.clips.find((c) => c.id === clipId);
    if (!source) return "not-found";
    if (track.clips.length >= MAX_CLIPS) return "clip-limit";
    const start = clipEnd(source);
    if (freeSpanAt(track, start, song) < source.measures) return "no-room";
    const copy: Clip = { ...source, id: copyId, start_measure: start };
    return { ...track, clips: insertClip(track.clips, copy) };
  });
}

export function moveClip(
  song: Song,
  trackId: string,
  clipId: string,
  toStart: number,
): ClipOpResult {
  return editTrack(song, trackId, clipId, (track) => {
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) return "not-found";
    const { prevEnd, nextStart } = neighbours(track, clip, song);
    const start = clamp(
      Math.round(toStart),
      prevEnd,
      Math.max(prevEnd, nextStart - clip.measures),
    );
    if (start === clip.start_measure) return track;
    return {
      ...track,
      clips: track.clips.map((c) =>
        c === clip ? { ...c, start_measure: start } : c,
      ),
    };
  });
}

export function resizeClip(
  song: Song,
  trackId: string,
  clipId: string,
  measures: number,
): ClipOpResult {
  return editTrack(song, trackId, clipId, (track) => {
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) return "not-found";
    const { nextStart } = neighbours(track, clip, song);
    const next = clamp(
      Math.round(measures),
      1,
      Math.max(1, nextStart - clip.start_measure),
    );
    if (next === clip.measures) return track;
    return {
      ...track,
      clips: track.clips.map((c) => (c === clip ? { ...c, measures: next } : c)),
    };
  });
}

export function deleteClip(
  song: Song,
  trackId: string,
  clipId: string,
): ClipOpResult {
  return editTrack(song, trackId, null, (track) =>
    track.clips.some((c) => c.id === clipId)
      ? { ...track, clips: track.clips.filter((c) => c.id !== clipId) }
      : "not-found",
  );
}

export function makeUnique(
  song: Song,
  trackId: string,
  clipId: string,
): ClipOpResult {
  return editTrack(song, trackId, clipId, (track) => {
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) return "not-found";
    const loop = track.loops.find((l) => l.id === clip.loop_id);
    if (!loop) return "not-found";
    if (loopUseCount(track, loop.id) < 2) return "not-shared";
    if (track.loops.length >= MAX_LOOPS) return "loop-limit";
    const copy: Loop = {
      ...loop,
      id: newId(),
      name: fitName(loop.name, " (copy)"),
      notes: loop.notes.map((n) => ({ ...n })),
    };
    return {
      ...track,
      loops: [...track.loops, copy],
      clips: track.clips.map((c) =>
        c === clip ? { ...c, loop_id: copy.id } : c,
      ),
    };
  });
}

const mapLoop = (
  song: Song,
  trackId: string,
  loopId: string,
  fn: (loop: Loop) => Loop,
): ClipOpResult =>
  withTrack(song, trackId, (track) => {
    const loop = track.loops.find((l) => l.id === loopId);
    if (!loop) return fail("not-found");
    const next = fn(loop);
    if (next === loop) return track;
    return {
      ...track,
      loops: track.loops.map((l) => (l === loop ? next : l)),
    };
  });

export function renameLoop(
  song: Song,
  trackId: string,
  loopId: string,
  name: string,
): ClipOpResult {
  const next = name.trim().slice(0, LOOP_NAME_MAX);
  return mapLoop(song, trackId, loopId, (l) =>
    !next || next === l.name ? l : { ...l, name: next },
  );
}

export function deleteLoop(
  song: Song,
  trackId: string,
  loopId: string,
): ClipOpResult {
  return editTrack(song, trackId, null, (track) =>
    track.loops.some((l) => l.id === loopId)
      ? {
          ...track,
          loops: track.loops.filter((l) => l.id !== loopId),
          clips: track.clips.filter((c) => c.loop_id !== loopId),
        }
      : "not-found",
  );
}

// Clips are untouched on purpose: a clip longer than its loop simply repeats it, a shorter one cuts it.
export function setLoopLength(
  song: Song,
  trackId: string,
  loopId: string,
  measures: number,
): ClipOpResult {
  const next = clamp(
    Math.round(measures),
    LOOP_MEASURE_RANGE.min,
    LOOP_MEASURE_RANGE.max,
  );
  return mapLoop(song, trackId, loopId, (l) =>
    next === l.measures
      ? l
      : {
          ...l,
          measures: next,
          notes:
            next < l.measures
              ? normalizeNotes(l.notes, next * song.steps_per_measure)
              : l.notes,
        },
  );
}

export function editLoopNotes(
  song: Song,
  trackId: string,
  loopId: string,
  notes: Note[],
): Song {
  const result = mapLoop(song, trackId, loopId, (l) =>
    notes === l.notes ? l : { ...l, notes },
  );
  return result.song ?? song;
}

// Rows are passed in because tracks store only an instrument id, never a copy of its rows.
export const loopGrid = (
  loop: Loop,
  rows: Row[],
  stepsPerMeasure: number,
): NoteGrid => ({
  notes: loop.notes,
  rows,
  totalSteps: loop.measures * stepsPerMeasure,
});

// Shortening the song must never leave a clip past the end; loops are deliberately kept whole.
export function trimClips(clips: Clip[], songMeasures: number): Clip[] {
  if (clips.every((c) => clipEnd(c) <= songMeasures + 1)) return clips;
  return clips
    .filter((c) => c.start_measure <= songMeasures)
    .map((c) =>
      clipEnd(c) > songMeasures + 1
        ? { ...c, measures: songMeasures + 1 - c.start_measure }
        : c,
    );
}

const resolved = new WeakMap<
  Loop[],
  WeakMap<Clip[], { stepsPerMeasure: number; notes: Note[] }>
>();

// The engine asks for every voice on every lookahead step, so the flattening is cached per (loops, clips)
// reference; immutable song updates then leave other tracks' caches valid.
export function resolveTrackNotes(song: Song, track: Track): Note[] {
  const spm = song.steps_per_measure;
  let byClips = resolved.get(track.loops);
  const hit = byClips?.get(track.clips);
  if (hit && hit.stepsPerMeasure === spm) return hit.notes;

  const out: Note[] = [];
  for (const clip of track.clips) {
    const loop = track.loops.find((l) => l.id === clip.loop_id);
    if (!loop) continue;
    const loopSteps = loop.measures * spm;
    const clipSteps = clip.measures * spm;
    const base = (clip.start_measure - 1) * spm;
    for (let offset = 0; offset < clipSteps; offset += loopSteps) {
      for (const n of loop.notes) {
        const local = offset + n.step;
        if (local >= clipSteps) continue;
        out.push({
          ...n,
          step: base + local,
          length_steps: Math.min(n.length_steps, clipSteps - local),
        });
      }
    }
  }
  out.sort((a, b) => a.step - b.step);
  if (!byClips) {
    byClips = new WeakMap();
    resolved.set(track.loops, byClips);
  }
  byClips.set(track.clips, { stepsPerMeasure: spm, notes: out });
  return out;
}
