import type { Note } from "@/generated/Note";
import type { Row } from "@/generated/Row";
import { type NoteGrid, mergeNotes, normalizeNotes } from "../patternOps";
import { normalizeSong, timelineMeasures } from "./songOps";
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

// One measure is the smallest thing worth drawing, and the user stretches the clip (and its loop) from there.
export const NEW_CLIP_MEASURES = 1;

export type ClipFailure =
  | "not-found"
  | "no-room"
  | "clip-limit"
  | "loop-limit"
  | "not-shared"
  | "generating";

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
  return ok(
    normalizeSong({
      ...song,
      tracks: song.tracks.map((t) => (t === track ? result : t)),
    }),
  );
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
    normalizeSong({
      ...song,
      tracks: song.tracks.map((t) => (t === track ? next : t)),
    }),
    clipId,
  );
};

const insertClip = (clips: Clip[], clip: Clip) =>
  [...clips, clip].sort(byStart);

export const loopUseCount = (track: Track, loopId: string) =>
  track.clips.filter((c) => c.loop_id === loopId).length;

// Returns a length rather than a yes/no so a placement can be shortened to fit instead of refused.
export function freeSpanAt(track: Track, measure: number, song: Song): number {
  const bound = timelineMeasures(song);
  if (measure < 1 || measure > bound) return 0;
  let limit = bound + 1;
  for (const c of track.clips) {
    if (measure >= c.start_measure && measure < clipEnd(c)) return 0;
    if (c.start_measure > measure) limit = Math.min(limit, c.start_measure);
  }
  return limit - measure;
}

// Lets the UI offer "the next place a clip fits" without duplicating the occupancy rules.
export function nextFreeMeasure(track: Track, song: Song, from = 1): number | null {
  for (let m = Math.max(1, from); m <= timelineMeasures(song); m++) {
    const free = freeSpanAt(track, m, song);
    if (free > 0) return m;
    const covering = track.clips.find((c) => m >= c.start_measure && m < clipEnd(c));
    if (covering) m = clipEnd(covering) - 1;
  }
  return null;
}

// Snapping rather than refusing keeps a copy dropped onto a neighbour from feeling like a failed drag.
export function nearestFreeMeasure(track: Track, song: Song, desired: number): number | null {
  const bound = timelineMeasures(song);
  const at = clamp(Math.round(desired), 1, bound);
  for (let d = 0; d < bound; d++) {
    for (const m of d === 0 ? [at] : [at - d, at + d]) {
      if (freeSpanAt(track, m, song) > 0) return m;
    }
  }
  return null;
}

// Clamping to the neighbours here (not in callers) means pointer drags and keyboard nudges share one rule.
function neighbours(track: Track, clip: Clip, song: Song) {
  let prevEnd = 1;
  let nextStart = timelineMeasures(song) + 1;
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

// Notes are loop-relative so a take can seed the loop with what it already knows about the clip.
export function newClipWithNotes(
  song: Song,
  trackId: string,
  measure: number,
  measures: number,
  notes: Note[],
): ClipOpResult {
  const clipId = newId();
  return editTrack(song, trackId, clipId, (track) => {
    if (track.clips.length >= MAX_CLIPS) return "clip-limit";
    if (track.loops.length >= MAX_LOOPS) return "loop-limit";
    const free = freeSpanAt(track, measure, song);
    if (free === 0) return "no-room";
    const length = clamp(Math.round(measures), 1, Math.min(free, LOOP_MEASURE_RANGE.max));
    const loop: Loop = {
      id: newId(),
      name: newLoopName(track),
      measures: length,
      notes,
    };
    const clip: Clip = {
      id: clipId,
      loop_id: loop.id,
      start_measure: measure,
      measures: length,
    };
    return {
      ...track,
      loops: [...track.loops, loop],
      clips: insertClip(track.clips, clip),
    };
  });
}

export const newClip = (song: Song, trackId: string, measure: number): ClipOpResult =>
  newClipWithNotes(song, trackId, measure, NEW_CLIP_MEASURES, []);

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
    const loop = track.loops.find((l) => l.id === clip.loop_id);
    // Only a clip that shows its loop exactly has no other length to honour. One that repeats or cuts its loop
    // keeps it, since growing the loop would silence the repeats and following a shorter clip would drop notes.
    const followLoop =
      loop && loopUseCount(track, loop.id) === 1 && loop.measures === clip.measures;
    return {
      ...track,
      loops: followLoop
        ? track.loops.map((l) =>
            l === loop ? withLoopLength(l, next, song.steps_per_measure) : l,
          )
        : track.loops,
      clips: track.clips.map((c) => (c === clip ? { ...c, measures: next } : c)),
    };
  });
}

// A tail that starts on a repeat of its loop can share it; any other start would shift the loop's phase, so the
// tail gets its own loop with the notes baked in. Baking is exact, whereas rotating a loop would cut wrapped notes.
function splitTrackClip(
  song: Song,
  track: Track,
  clip: Clip,
  at: number,
  tailId: string,
): Track | ClipFailure {
  if (at <= clip.start_measure || at >= clipEnd(clip)) return track;
  if (track.clips.length >= MAX_CLIPS) return "clip-limit";
  const head: Clip = { ...clip, measures: at - clip.start_measure };
  const tail: Clip = { ...clip, id: tailId, start_measure: at, measures: clipEnd(clip) - at };
  const loop = track.loops.find((l) => l.id === clip.loop_id);
  let loops = track.loops;
  if (loop && (at - clip.start_measure) % loop.measures !== 0) {
    if (loops.length >= MAX_LOOPS) return "loop-limit";
    const spm = song.steps_per_measure;
    const cut = (at - 1) * spm;
    const played = resolveTrackNotes(song, { ...track, clips: [clip] });
    const baked: Loop = {
      id: newId(),
      name: fitName(loop.name, " (cont.)"),
      measures: tail.measures,
      // A note sounding across the cut belongs to the head, which clips it at its own end.
      notes: played.filter((n) => n.step >= cut).map((n) => ({ ...n, step: n.step - cut })),
    };
    tail.loop_id = baked.id;
    loops = [...loops, baked];
  }
  return {
    ...track,
    loops,
    clips: track.clips.map((c) => (c === clip ? head : c)).concat(tail).sort(byStart),
  };
}

// Returns the new tail's clip id so a caller can select what it just made.
export function splitClip(
  song: Song,
  trackId: string,
  clipId: string,
  atMeasure: number,
): ClipOpResult {
  const tailId = newId();
  return editTrack(song, trackId, tailId, (track) => {
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) return "not-found";
    return splitTrackClip(song, track, clip, Math.round(atMeasure), tailId);
  });
}

// Pieces are cut straight from each original clip rather than by splitting twice and deleting: a split at the
// range start would bake the doomed inside part into a loop nothing plays, and a second split would rename the
// kept tail "(cont.) (cont.)". Limits are checked by callers against the finished track, not intermediate ones.
function clearTrackRange(song: Song, track: Track, start: number, end: number): Track {
  const after = end + 1;
  const loops = [...track.loops];
  const clips: Clip[] = [];
  let changed = false;
  for (const clip of track.clips) {
    if (clipEnd(clip) <= start || clip.start_measure >= after) {
      clips.push(clip);
      continue;
    }
    changed = true;
    if (clip.start_measure < start) clips.push({ ...clip, measures: start - clip.start_measure });
    if (clipEnd(clip) <= after) continue;
    const tail: Clip = { ...clip, id: newId(), start_measure: after, measures: clipEnd(clip) - after };
    const loop = track.loops.find((l) => l.id === clip.loop_id);
    if (loop && (after - clip.start_measure) % loop.measures !== 0) {
      const cut = (after - 1) * song.steps_per_measure;
      const played = resolveTrackNotes(song, { ...track, clips: [clip] });
      const baked: Loop = {
        id: newId(),
        name: fitName(loop.name, " (cont.)"),
        measures: tail.measures,
        // A note sounding across the cut belongs to the inside part, which is being removed.
        notes: played.filter((n) => n.step >= cut).map((n) => ({ ...n, step: n.step - cut })),
      };
      tail.loop_id = baked.id;
      loops.push(baked);
    }
    clips.push(tail);
  }
  return changed ? { ...track, loops, clips: clips.sort(byStart) } : track;
}

const overLimit = (track: Track): ClipFailure | null =>
  track.clips.length > MAX_CLIPS ? "clip-limit" : track.loops.length > MAX_LOOPS ? "loop-limit" : null;

export function clearMeasureRange(
  song: Song,
  trackId: string,
  start: number,
  end: number,
): ClipOpResult {
  return editTrack(song, trackId, null, (track) => {
    const cleared = clearTrackRange(song, track, Math.round(start), Math.round(end));
    return overLimit(cleared) ?? cleared;
  });
}

// Written as one track edit rather than clear-then-newClip: clearing can shorten the song, and the timeline bound
// that newClip honours would then cut the new clip short of the range.
export function applyGeneratedRange(
  song: Song,
  trackId: string,
  range: { start_measure: number; end_measure: number },
  notes: Note[],
): ClipOpResult {
  const clipId = newId();
  return editTrack(song, trackId, clipId, (track) => {
    const cleared = clearTrackRange(song, track, range.start_measure, range.end_measure);
    const measures = range.end_measure - range.start_measure + 1;
    const loop: Loop = { id: newId(), name: newLoopName(cleared), measures, notes };
    const clip: Clip = {
      id: clipId,
      loop_id: loop.id,
      start_measure: range.start_measure,
      measures,
    };
    const result = {
      ...cleared,
      loops: [...cleared.loops, loop],
      clips: insertClip(cleared.clips, clip),
    };
    return overLimit(result) ?? result;
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

// Shortening drops and truncates notes with the same rule a pattern uses; lengthening never touches them.
function withLoopLength(loop: Loop, measures: number, stepsPerMeasure: number): Loop {
  const next = clamp(
    Math.round(measures),
    LOOP_MEASURE_RANGE.min,
    LOOP_MEASURE_RANGE.max,
  );
  if (next === loop.measures) return loop;
  return {
    ...loop,
    measures: next,
    notes:
      next < loop.measures
        ? normalizeNotes(loop.notes, next * stepsPerMeasure)
        : loop.notes,
  };
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

export type DropReason = "clip-limit" | "loop-limit" | "no-room";

// The take owns this across many recordNotes calls, so it is mutated in place rather than threaded through results.
export interface TakeState {
  // Keyed by the first measure of the empty stretch, which stays put however the take's clip grows inside it.
  runs: Map<number, { loopId: string; clipId: string; limit: number }>;
  dropped: Partial<Record<DropReason, number>>;
}

export const createTakeState = (): TakeState => ({ runs: new Map(), dropped: {} });

const lastMeasureOf = (n: Note, stepsPerMeasure: number) =>
  Math.floor((n.step + n.length_steps - 1) / stepsPerMeasure) + 1;

const mapTrack = (song: Song, trackId: string, fn: (t: Track) => Track): Song =>
  normalizeSong({
    ...song,
    tracks: song.tracks.map((t) => (t.id === trackId ? fn(t) : t)),
  });

// Notes are song-absolute steps. Transient: the take's gesture makes the whole thing one undo step.
export function recordNotes(
  song: Song,
  trackId: string,
  notes: Note[],
  takeState: TakeState,
): ClipOpResult {
  if (!song.tracks.some((t) => t.id === trackId)) return fail("not-found");
  const spm = song.steps_per_measure;
  const drop = (reason: DropReason) => {
    takeState.dropped[reason] = (takeState.dropped[reason] ?? 0) + 1;
  };
  const trackOf = (s: Song) => s.tracks.find((t) => t.id === trackId)!;
  const intoLoop = (s: Song, loopId: string, n: Note, local: number): Song =>
    mapTrack(s, trackId, (t) => ({
      ...t,
      loops: t.loops.map((l) => {
        if (l.id !== loopId) return l;
        const room = l.measures * spm - local;
        const placed = { ...n, step: local, length_steps: clamp(n.length_steps, 1, room) };
        return { ...l, notes: mergeNotes(l.notes, [placed]) };
      }),
    }));

  let current = song;
  for (const n of [...notes].sort((a, b) => a.step - b.step)) {
    if (n.step < 0) continue;
    const track = trackOf(current);
    const takeClips = new Set([...takeState.runs.values()].map((r) => r.clipId));
    const foreign = track.clips.filter((c) => !takeClips.has(c.id));
    const m = Math.floor(n.step / spm) + 1;

    const inside = foreign.find((c) => m >= c.start_measure && m < clipEnd(c));
    if (inside) {
      const loop = track.loops.find((l) => l.id === inside.loop_id);
      if (!loop) continue;
      const local = (n.step - (inside.start_measure - 1) * spm) % (loop.measures * spm);
      current = intoLoop(current, loop.id, n, local);
      continue;
    }

    const bound = timelineMeasures(current);
    if (m > bound) {
      drop("no-room");
      continue;
    }
    let lo = 1;
    let hi = bound + 1;
    for (const c of foreign) {
      if (clipEnd(c) <= m) lo = Math.max(lo, clipEnd(c));
      else if (c.start_measure > m) hi = Math.min(hi, c.start_measure);
    }

    const run = takeState.runs.get(lo);
    const clip = run && track.clips.find((c) => c.id === run.clipId);
    const loop = run && track.loops.find((l) => l.id === run.loopId);
    if (run && clip && loop) {
      if (m >= run.limit) {
        drop("no-room");
        continue;
      }
      const start = Math.min(clip.start_measure, m);
      const end = Math.max(clipEnd(clip), Math.min(lastMeasureOf(n, spm), run.limit - 1) + 1);
      const measures = end - start;
      if (measures > LOOP_MEASURE_RANGE.max) {
        drop("no-room");
        continue;
      }
      if (start !== clip.start_measure || measures !== clip.measures) {
        // Growing backwards moves the loop's origin, so existing notes shift to keep their song positions.
        const shift = (clip.start_measure - start) * spm;
        current = mapTrack(current, trackId, (t) => ({
          ...t,
          loops: t.loops.map((l) =>
            l.id === loop.id
              ? { ...l, measures, notes: l.notes.map((x) => ({ ...x, step: x.step + shift })) }
              : l,
          ),
          clips: t.clips.map((c) =>
            c.id === clip.id ? { ...c, start_measure: start, measures } : c,
          ),
        }));
      }
      current = intoLoop(current, loop.id, n, n.step - (start - 1) * spm);
      continue;
    }

    const measures = Math.min(lastMeasureOf(n, spm), hi - 1) - m + 1;
    const local = n.step - (m - 1) * spm;
    const placed = { ...n, step: local, length_steps: clamp(n.length_steps, 1, measures * spm - local) };
    const result = newClipWithNotes(current, trackId, m, measures, [placed]);
    if (result.song === null) {
      drop(result.reason === "not-found" ? "no-room" : (result.reason as DropReason));
      continue;
    }
    const created = trackOf(result.song).clips.find((c) => c.id === result.clipId)!;
    takeState.runs.set(lo, { loopId: created.loop_id, clipId: created.id, limit: hi });
    current = result.song;
  }
  return ok(current);
}
