import type { ChatTrack } from "@/generated/ChatTrack";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Pattern } from "@/generated/Pattern";
import { clampLoop } from "../loopRegion";
import type { Note } from "@/generated/Note";
import type { TrackSound } from "@/generated/TrackSound";
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

// The server returns names and notes only; ids and mixer defaults are minted here so the store stays their sole source.
export function addChatTrack(
  song: Song,
  part: Pick<ChatTrack, "name" | "instrument" | "range" | "notes">,
): { song: Song; trackId: string } | null {
  if (song.tracks.length >= MAX_TRACKS) return null;
  const name = uniqueTrackName(song, part.name.trim().slice(0, TRACK_NAME_MAX) || part.instrument);
  const measures = part.range.end_measure - part.range.start_measure + 1;
  const loop: Loop = {
    id: newId(),
    name: name.slice(0, LOOP_NAME_MAX),
    measures,
    notes: part.notes.map((n) => ({ ...n })),
  };
  const track: Track = {
    ...newTrack(part.instrument, name),
    loops: [loop],
    clips: [{ id: newId(), loop_id: loop.id, start_measure: part.range.start_measure, measures }],
  };
  return { song: normalizeSong({ ...song, tracks: [...song.tracks, track] }), trackId: track.id };
}

export function deleteTrack(song: Song, trackId: string): Song {
  if (!song.tracks.some((t) => t.id === trackId)) return song;
  return normalizeSong({ ...song, tracks: song.tracks.filter((t) => t.id !== trackId) });
}

export function moveTrack(song: Song, trackId: string, toIndex: number): Song {
  const from = song.tracks.findIndex((t) => t.id === trackId);
  if (from < 0) return song;
  const to = clamp(toIndex, 0, song.tracks.length - 1);
  if (to === from) return song;
  const tracks = song.tracks.slice();
  const [moved] = tracks.splice(from, 1);
  tracks.splice(to, 0, moved);
  return { ...song, tracks };
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

// Null deletes a field so "reset to the instrument default" is expressible in the same shape as an edit.
export type SoundPatch = DeepPatch<TrackSound>;
type DeepPatch<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends object
    ? DeepPatch<NonNullable<T[K]>> | null
    : NonNullable<T[K]> | null;
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

// Returns `current` itself when the patch changes nothing, and undefined when deletes leave nothing behind,
// so a fully reset sound disappears from the document instead of lingering as empty objects.
function mergePatch(current: Plain | undefined, patch: Plain): Plain | undefined {
  const next: Plain = { ...current };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const had = key in next;
    if (value === null) {
      if (had) {
        delete next[key];
        changed = true;
      }
    } else if (isPlain(value)) {
      const before = isPlain(next[key]) ? next[key] : undefined;
      const merged = mergePatch(before, value);
      if (merged === before && (before !== undefined || !had)) continue;
      if (merged === undefined) delete next[key];
      else next[key] = merged;
      changed = true;
    } else if (next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  }
  if (!changed) return current;
  return Object.keys(next).length === 0 ? undefined : next;
}

const MELODIC_ONLY_TONE = ["attack_s", "decay_s", "sustain", "release_s"] as const;

// A wrong-kind field would make the whole song fail validation on reload, so it is refused here whatever the UI did.
function forKind(patch: SoundPatch, drums: boolean): SoundPatch {
  if (!patch.tone) return patch;
  const tone: Record<string, unknown> = { ...patch.tone };
  for (const key of drums ? MELODIC_ONLY_TONE : (["pitch_semitones"] as const)) delete tone[key];
  return { ...patch, tone: tone as SoundPatch["tone"] };
}

export function setSound(song: Song, trackId: string, rawPatch: SoundPatch): Song {
  return mapTrack(song, trackId, (t) => {
    const patch = forKind(rawPatch, t.instrument === "drums");
    const merged = mergePatch((t.sound ?? undefined) as Plain | undefined, patch as Plain) as TrackSound | undefined;
    // A stored null means the same as absent, so an empty result must not replace it or a drag that
    // ends where it began would still count as a change.
    if (merged === t.sound || (merged === undefined && t.sound == null)) return t;
    const { sound: _old, ...rest } = t;
    void _old;
    return merged === undefined ? rest : { ...rest, sound: merged };
  });
}

export function resetSound(song: Song, trackId: string): Song {
  return mapTrack(song, trackId, (t) => {
    if (t.sound === undefined) return t;
    const { sound: _old, ...rest } = t;
    void _old;
    return rest;
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
