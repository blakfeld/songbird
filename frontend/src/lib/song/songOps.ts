import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Pattern } from "@/generated/Pattern";
import { clampLoop } from "../loopRegion";
import type { Note } from "@/generated/Note";
import type { TimeSignature } from "@/generated/TimeSignature";
import { STEPS_PER_MEASURE, SWING_RANGE, TEMPO_RANGE } from "../patternOps";
import { songLoop, withSongLoop } from "./songLoop";
import {
  LOOP_NAME_MAX,
  MAX_TRACKS,
  DEFAULT_KEY,
  MEASURE_RANGE,
  PAN_RANGE,
  SONG_NAME_MAX,
  TRACK_NAME_MAX,
  VOLUME_DB_RANGE,
  newId,
  newTrack,
  type Loop,
  type Song,
  type SongKey,
  type Track,
} from "./types";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// Every op returns the same song reference on no-ops so the store can skip pointless undo entries.
const mapTrack = (
  song: Song,
  trackId: string,
  fn: (t: Track) => Track,
): Song => {
  const target = song.tracks.find((t) => t.id === trackId);
  if (!target) return song;
  const next = fn(target);
  if (next === target) return song;
  return {
    ...song,
    tracks: song.tracks.map((t) => (t === target ? next : t)),
  };
};

export const totalSteps = (song: Song) => song.measures * song.steps_per_measure;

export const songKey = (song: Pick<Song, "tracks"> & { key?: SongKey }): SongKey => song.key ?? DEFAULT_KEY;

// Exported separately so migration can correct a stored length before the song is otherwise trusted.
export function derivedMeasures(song: Pick<Song, "tracks">): number {
  let end = 1;
  for (const t of song.tracks)
    for (const c of t.clips) end = Math.max(end, c.start_measure + c.measures);
  return clamp(end - 1, MEASURE_RANGE.min, MEASURE_RANGE.max);
}

// Every clip-changing op funnels through this so the stored length can never drift from the clips.
export function normalizeSong(song: Song): Song {
  const measures = derivedMeasures(song);
  const sized = measures === song.measures ? song : { ...song, measures };
  // The region may cover the silent measures past the song's end, so only the visible timeline bounds it.
  return sized.loop_region
    ? withSongLoop(sized, clampLoop(songLoop(sized), timelineMeasures(sized)))
    : sized;
}

// The spare room lets a clip be created past the end, which is how the song grows.
export const TIMELINE_TAIL_MEASURES = 8;
export const MIN_TIMELINE_MEASURES = 16;
export const timelineMeasures = (song: Pick<Song, "measures">) =>
  Math.min(
    MEASURE_RANGE.max,
    Math.max(MIN_TIMELINE_MEASURES, song.measures + TIMELINE_TAIL_MEASURES),
  );

// The smallest free suffix keeps names distinguishable in the lane list without renumbering existing tracks.
function uniqueTrackName(song: Song, base: string): string {
  const taken = new Set(song.tracks.map((t) => t.name));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    if (candidate.length <= TRACK_NAME_MAX && !taken.has(candidate)) return candidate;
    if (n > song.tracks.length + 1) return base.slice(0, TRACK_NAME_MAX);
  }
}

export function addTrack(
  song: Song,
  instrument: Pick<InstrumentInfo, "id" | "name">,
  name?: string,
): Song {
  if (song.tracks.length >= MAX_TRACKS) return song;
  const track = newTrack(
    instrument.id,
    name !== undefined
      ? name.slice(0, TRACK_NAME_MAX) || instrument.name
      : uniqueTrackName(song, instrument.name),
  );
  return { ...song, tracks: [...song.tracks, track] };
}

export function deleteTrack(song: Song, trackId: string): Song {
  if (song.tracks.length <= 1) return song;
  if (!song.tracks.some((t) => t.id === trackId)) return song;
  return normalizeSong({ ...song, tracks: song.tracks.filter((t) => t.id !== trackId) });
}

export function renameTrack(song: Song, trackId: string, name: string): Song {
  const next = name.trim().slice(0, TRACK_NAME_MAX);
  if (!next) return song;
  return mapTrack(song, trackId, (t) =>
    t.name === next ? t : { ...t, name: next },
  );
}

export type MixerPatch = Partial<
  Pick<Track, "volume_db" | "pan" | "muted" | "soloed">
>;

export function setMixer(song: Song, trackId: string, patch: MixerPatch): Song {
  return mapTrack(song, trackId, (t) => {
    const next: Track = { ...t };
    if (patch.volume_db !== undefined)
      next.volume_db = clamp(
        patch.volume_db,
        VOLUME_DB_RANGE.min,
        VOLUME_DB_RANGE.max,
      );
    if (patch.pan !== undefined)
      next.pan = clamp(patch.pan, PAN_RANGE.min, PAN_RANGE.max);
    if (patch.muted !== undefined) next.muted = patch.muted;
    if (patch.soloed !== undefined) next.soloed = patch.soloed;
    const same =
      next.volume_db === t.volume_db &&
      next.pan === t.pan &&
      next.muted === t.muted &&
      next.soloed === t.soloed;
    return same ? t : next;
  });
}

export function setTempo(song: Song, tempo: number): Song {
  const next = clamp(Math.round(tempo), TEMPO_RANGE.min, TEMPO_RANGE.max);
  return next === song.tempo_bpm ? song : { ...song, tempo_bpm: next };
}

export function setSwing(song: Song, swing: number): Song {
  const next = clamp(swing, SWING_RANGE.min, SWING_RANGE.max);
  return next === song.swing ? song : { ...song, swing: next };
}

export function renameSong(song: Song, name: string): Song {
  const next = name.trim().slice(0, SONG_NAME_MAX);
  return !next || next === song.name ? song : { ...song, name: next };
}

export function audibleTracks(song: Song): Track[] {
  const anySolo = song.tracks.some((t) => t.soloed);
  return song.tracks.filter((t) => !t.muted && (!anySolo || t.soloed));
}

// A pattern with a different steps-per-measure would misalign against the song grid, so it is refused.
export function addTrackFromPattern(song: Song, pattern: Pattern): Song {
  if (song.tracks.length >= MAX_TRACKS) return song;
  if (pattern.steps_per_measure !== song.steps_per_measure) return song;
  const name =
    pattern.name.trim().slice(0, TRACK_NAME_MAX) || pattern.instrument;
  const loop: Loop = {
    id: newId(),
    name: name.slice(0, LOOP_NAME_MAX),
    measures: pattern.measures,
    notes: pattern.notes.map((n) => ({ ...n })),
  };
  const track: Track = {
    ...newTrack(pattern.instrument, name),
    loops: [loop],
    clips: [
      {
        id: newId(),
        loop_id: loop.id,
        start_measure: 1,
        measures: pattern.measures,
      },
    ],
  };
  return normalizeSong({ ...song, tracks: [...song.tracks, track] });
}

const splitStep = (step: number, stepsPerMeasure: number) => ({
  measure: Math.floor(step / stepsPerMeasure),
  offset: step % stepsPerMeasure,
});

// Only a shorter measure can lose notes; callers use the count to decide whether to ask first.
export function countTimeSignatureLosses(song: Song, ts: TimeSignature): number {
  const next = STEPS_PER_MEASURE[ts];
  if (next >= song.steps_per_measure) return 0;
  let lost = 0;
  for (const t of song.tracks)
    for (const l of t.loops)
      for (const n of l.notes)
        if (splitStep(n.step, song.steps_per_measure).offset >= next) lost++;
  return lost;
}

// Notes keep their measure and offset within it (not absolute step) so beats stay in their bars.
// Lengths are bounded only by the next note in the row and the loop's end, so a sustain that crosses a barline
// survives a meter change and 3/4 <-> 6/8 or lengthening stays lossless.
export function setTimeSignature(song: Song, ts: TimeSignature): Song {
  if (ts === song.time_signature) return song;
  const oldSpm = song.steps_per_measure;
  const newSpm = STEPS_PER_MEASURE[ts];
  const convert = (n: Note): Note | null => {
    const { measure, offset } = splitStep(n.step, oldSpm);
    if (offset >= newSpm) return null;
    return { ...n, step: measure * newSpm + offset };
  };
  const fit = (notes: Note[], loopSteps: number): Note[] => {
    const moved = notes.flatMap((n) => convert(n) ?? []);
    return moved.map((n) => {
      let limit = loopSteps;
      for (const o of moved)
        if (o.row_id === n.row_id && o.step > n.step) limit = Math.min(limit, o.step);
      return n.length_steps <= limit - n.step ? n : { ...n, length_steps: Math.max(1, limit - n.step) };
    });
  };
  return {
    ...song,
    time_signature: ts,
    steps_per_measure: newSpm,
    tracks: song.tracks.map((t) => ({
      ...t,
      loops: t.loops.map((l) => ({ ...l, notes: fit(l.notes, l.measures * newSpm) })),
    })),
  };
}

export function setKey(song: Song, key: SongKey): Song {
  const current = songKey(song);
  return current.tonic === key.tonic && current.mode === key.mode && song.key
    ? song
    : { ...song, key: { tonic: key.tonic, mode: key.mode } };
}
