import type { Note } from "@/generated/Note";
import { normalizeNotes } from "../patternOps";
import { normalizeLoopRegion } from "./songLoop";
import {
  LOOP_MEASURE_RANGE,
  LOOP_NAME_MAX,
  MAX_CLIPS,
  MAX_LOOPS,
  newId,
  type Clip,
  type Song,
} from "./types";

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);

function validateLoopNotes(notes: unknown, totalSteps: number): boolean {
  if (!Array.isArray(notes)) return false;
  const byRow = new Map<string, [number, number][]>();
  for (const n of notes) {
    if (!isObject(n) || typeof n.row_id !== "string") return false;
    if (!isInt(n.step) || !isInt(n.length_steps)) return false;
    if (n.step < 0 || n.length_steps < 1 || n.step + n.length_steps > totalSteps)
      return false;
    byRow.set(n.row_id, [...(byRow.get(n.row_id) ?? []), [n.step, n.step + n.length_steps]]);
  }
  for (const spans of byRow.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) return false;
  }
  return true;
}

// Stored documents are untrusted, so every level is shape-checked before it is read; a throw here
// would surface as a storage failure and could lock the Studio on startup.
// Ids are unique song-wide so a clip can never be resolved against another track's loop by an id collision.
export function validateClips(song: unknown): string | null {
  if (!isObject(song)) return "song";
  const { measures, steps_per_measure: spm, tracks } = song;
  if (!isInt(measures) || measures < 1) return "song length";
  if (!isInt(spm) || spm < 1) return "steps per measure";
  if (!Array.isArray(tracks)) return "tracks";
  const loopIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const track of tracks) {
    if (!isObject(track)) return "track";
    const { loops, clips } = track;
    if (!Array.isArray(loops) || !Array.isArray(clips))
      return `track ${String(track.id)} has no loops or clips`;
    if (loops.length > MAX_LOOPS) return "too many loops";
    if (clips.length > MAX_CLIPS) return "too many clips";
    const ownLoops = new Set<string>();
    for (const loop of loops) {
      if (!isObject(loop)) return "loop";
      if (typeof loop.id !== "string" || loopIds.has(loop.id)) return "duplicate loop id";
      loopIds.add(loop.id);
      if (
        typeof loop.name !== "string" ||
        loop.name.length < 1 ||
        loop.name.length > LOOP_NAME_MAX
      )
        return "loop name";
      if (
        !isInt(loop.measures) ||
        loop.measures < LOOP_MEASURE_RANGE.min ||
        loop.measures > LOOP_MEASURE_RANGE.max
      )
        return "loop length";
      if (!validateLoopNotes(loop.notes, loop.measures * spm)) return `notes of loop ${loop.id}`;
      ownLoops.add(loop.id);
    }
    const shaped: Raw[] = [];
    for (const clip of clips) {
      if (!isObject(clip)) return "clip";
      if (typeof clip.id !== "string" || clipIds.has(clip.id)) return "duplicate clip id";
      clipIds.add(clip.id);
      if (typeof clip.loop_id !== "string" || !ownLoops.has(clip.loop_id))
        return `clip ${clip.id} references a loop of another track`;
      if (!isInt(clip.start_measure) || !isInt(clip.measures)) return "clip position";
      if (clip.start_measure < 1) return "clip position";
      if (clip.measures < 1) return "clip length";
      shaped.push(clip);
    }
    let previousEnd = 1;
    for (const clip of shaped.sort((a, b) => (a.start_measure as number) - (b.start_measure as number))) {
      const start = clip.start_measure as number;
      if (start < previousEnd) return "overlapping clips";
      previousEnd = start + (clip.measures as number);
      if (previousEnd > measures + 1) return "clip beyond song end";
    }
  }
  return null;
}

const sortedByStart = (clips: Clip[]) =>
  clips.every((c, i) => i === 0 || clips[i - 1].start_measure <= c.start_measure)
    ? clips
    : [...clips].sort((a, b) => a.start_measure - b.start_measure);

// Version 1 notes were only normalised by the editor, so anything a hand-edited or older document
// holds is coerced to what a loop allows; otherwise it would autosave into a v2 that refuses to open.
function cleanNotes(notes: unknown, totalSteps: number) {
  if (!Array.isArray(notes)) return [];
  const usable = notes.filter(
    (n) => isObject(n) && typeof n.row_id === "string" && isInt(n.step) && n.step >= 0 && isInt(n.length_steps),
  ) as Note[];
  return normalizeNotes(usable, totalSteps).filter((n) => n.length_steps >= 1);
}

function fromV1(raw: Raw): Song | null {
  const { tracks, measures, steps_per_measure: spm } = raw;
  if (!Array.isArray(tracks) || !isInt(measures) || !isInt(spm)) return null;
  const total = measures * spm;
  const converted = tracks.map((t: unknown) => {
    if (!isObject(t)) return null;
    // Spreading the rest keeps fields this version doesn't know about instead of stripping them.
    const { notes, ...rest } = t;
    const kept = cleanNotes(notes, total);
    if (kept.length === 0) return { ...rest, loops: [], clips: [] };
    const loopId = newId();
    return {
      ...rest,
      loops: [
        {
          id: loopId,
          name: String(t.name ?? "Loop").slice(0, LOOP_NAME_MAX) || "Loop",
          measures,
          notes: kept,
        },
      ],
      clips: [{ id: newId(), loop_id: loopId, start_measure: 1, measures }],
    };
  });
  if (converted.some((t) => t === null)) return null;
  const song = { ...raw, version: 2, tracks: converted } as unknown as Song;
  return validateClips(song) === null ? normalizeLoopRegion(song) : null;
}

function migrate(raw: unknown): Song | null {
  if (!isObject(raw)) return null;
  if (raw.version === 1) return fromV1(raw);
  if (raw.version !== 2 || validateClips(raw) !== null) return null;
  const song = raw as unknown as Song;
  const tracks = song.tracks.map((t) => {
    const clips = sortedByStart(t.clips);
    return clips === t.clips ? t : { ...t, clips };
  });
  return normalizeLoopRegion(
    tracks.every((t, i) => t === song.tracks[i]) ? song : { ...song, tracks },
  );
}

// Null means the stored document is unusable; the library reports that as "could not be opened".
export function migrateSong(raw: unknown): Song | null {
  try {
    return migrate(raw);
  } catch {
    return null;
  }
}
