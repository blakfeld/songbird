import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Pattern } from "@/generated/Pattern";
import { SWING_RANGE, TEMPO_RANGE } from "../patternOps";
import { trimClips } from "./clipOps";
import {
  LOOP_NAME_MAX,
  MAX_TRACKS,
  MEASURE_RANGE,
  PAN_RANGE,
  SONG_NAME_MAX,
  TRACK_NAME_MAX,
  VOLUME_DB_RANGE,
  newId,
  newTrack,
  type Loop,
  type Song,
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
  return { ...song, tracks: song.tracks.filter((t) => t.id !== trackId) };
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

export function setSongLength(song: Song, measures: number): Song {
  const next = clamp(
    Math.round(measures),
    MEASURE_RANGE.min,
    MEASURE_RANGE.max,
  );
  if (next === song.measures) return song;
  if (next > song.measures) return { ...song, measures: next };
  return {
    ...song,
    measures: next,
    tracks: song.tracks.map((t) => {
      const clips = trimClips(t.clips, next);
      return clips === t.clips ? t : { ...t, clips };
    }),
  };
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
  const lengthened = setSongLength(
    song,
    Math.max(song.measures, pattern.measures),
  );
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
  return { ...lengthened, tracks: [...lengthened.tracks, track] };
}
