import type { KeysSettings } from "@/generated/KeysSettings";
import type { PadSettings } from "@/generated/PadSettings";
import type { Sample } from "@/generated/Sample";
import type { SamplerSettings } from "@/generated/SamplerSettings";
import { MAX_SAMPLES } from "./audioTiming";
import { newClip } from "./clipOps";
import {
  DEFAULT_ROOT_NOTE,
  PAD_COUNT,
  PAD_GAIN_DB_RANGE,
  PAD_PITCH_RANGE,
  SAMPLER_KEYS_ID,
  SAMPLER_PADS_ID,
  padIndex,
  padRowId,
  type SamplerKind,
} from "./sampler";
import { addTrack, normalizeSong } from "./songOps";
import { MAX_TRACKS, type Song, type Track } from "./types";

export type SamplerFailure = "not-found" | "wrong-kind" | "sample-limit" | "track-limit";

export type SamplerResult = { song: Song } | { song: null; reason: SamplerFailure };

type Failure = { song: null; reason: SamplerFailure };
const fail = (reason: SamplerFailure): Failure => ({ song: null, reason });
const ok = (song: Song): SamplerResult => ({ song });

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const DEFAULT_KEYS: KeysSettings = { sample_id: null, root_note: DEFAULT_ROOT_NOTE, one_shot: false };
const isDefaultKeys = (k: KeysSettings) =>
  k.sample_id === null && k.root_note === DEFAULT_ROOT_NOTE && !k.one_shot;

// A track with nothing assigned stores no sampler field at all, so songs that never touch it stay as they were.
function withSettings(track: Track, settings: SamplerSettings): Track {
  const keys = settings.keys && !isDefaultKeys(settings.keys) ? settings.keys : undefined;
  const pads = settings.pads && settings.pads.length > 0 ? settings.pads : undefined;
  const { sampler: _old, ...rest } = track;
  void _old;
  return keys || pads ? { ...rest, sampler: { ...(keys && { keys }), ...(pads && { pads }) } } : rest;
}

const withSample = (song: Song, sample: Sample): Song["samples"] =>
  (song.samples ?? []).some((s) => s.id === sample.id) ? song.samples : [...(song.samples ?? []), sample];

const knows = (song: Song, sample: Sample) => (song.samples ?? []).some((s) => s.id === sample.id);

const replaceTrack = (song: Song, track: Track, next: Track, samples: Song["samples"] = song.samples): Song =>
  next === track && samples === song.samples
    ? song
    : { ...song, ...(samples && { samples }), tracks: song.tracks.map((t) => (t === track ? next : t)) };

function locate(song: Song, trackId: string, kind: SamplerKind): Track | Failure {
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track) return fail("not-found");
  return track.instrument === (kind === "keys" ? SAMPLER_KEYS_ID : SAMPLER_PADS_ID) ? track : fail("wrong-kind");
}
const isResult = (v: Track | Failure): v is Failure => "song" in v;

// The track, its starting loop and the clip are one song change, so a single undo takes all three back.
export function addSamplerTrack(
  song: Song,
  kind: SamplerKind,
): { song: Song; trackId: string; clipId: string } | null {
  if (song.tracks.length >= MAX_TRACKS) return null;
  const added = addTrack(
    song,
    kind === "keys"
      ? { id: SAMPLER_KEYS_ID, name: "Sampler" }
      : { id: SAMPLER_PADS_ID, name: "Pads" },
  );
  const track = added.tracks[added.tracks.length - 1];
  const clipped = newClip(added, track.id, 1);
  if (clipped.song === null || clipped.clipId === null) return null;
  return { song: normalizeSong(clipped.song), trackId: track.id, clipId: clipped.clipId };
}

export function chooseKeysSample(song: Song, trackId: string, sample: Sample): SamplerResult {
  const track = locate(song, trackId, "keys");
  if (isResult(track)) return track;
  if (!knows(song, sample) && (song.samples ?? []).length >= MAX_SAMPLES) return fail("sample-limit");
  const keys = track.sampler?.keys ?? DEFAULT_KEYS;
  if (keys.sample_id === sample.id) return ok(song);
  const next = withSettings(track, { keys: { ...keys, sample_id: sample.id } });
  return ok(replaceTrack(song, track, next, withSample(song, sample)));
}

export function clearKeysSample(song: Song, trackId: string): SamplerResult {
  const track = locate(song, trackId, "keys");
  if (isResult(track)) return track;
  const keys = track.sampler?.keys;
  if (!keys || keys.sample_id === null) return ok(song);
  return ok(replaceTrack(song, track, withSettings(track, { keys: { ...keys, sample_id: null } })));
}

export function setRootNote(song: Song, trackId: string, note: number): SamplerResult {
  const track = locate(song, trackId, "keys");
  if (isResult(track)) return track;
  const keys = track.sampler?.keys ?? DEFAULT_KEYS;
  const root = clamp(Math.round(note), 0, 127);
  if (keys.root_note === root) return ok(song);
  return ok(replaceTrack(song, track, withSettings(track, { keys: { ...keys, root_note: root } })));
}

export function setOneShot(song: Song, trackId: string, oneShot: boolean): SamplerResult {
  const track = locate(song, trackId, "keys");
  if (isResult(track)) return track;
  const keys = track.sampler?.keys ?? DEFAULT_KEYS;
  if (keys.one_shot === oneShot) return ok(song);
  return ok(replaceTrack(song, track, withSettings(track, { keys: { ...keys, one_shot: oneShot } })));
}

export interface PadAssignment {
  rowId: string;
  sample: Sample;
}

export type PadsResult =
  | { song: Song; assigned: PadAssignment[]; stopped?: "sample-limit" }
  | { song: null; reason: SamplerFailure };

// Files fill the pads from `startRowId` downward and stop at pad-16, so a folder of one-shots builds a kit in one
// drop. A replaced pad keeps its gain and pitch: they tune the pad's slot in the kit, not the sound in it.
export function assignPads(song: Song, trackId: string, startRowId: string, samples: Sample[]): PadsResult {
  const track = locate(song, trackId, "pads");
  if (isResult(track)) return track;
  const first = padIndex(startRowId);
  if (first < 0) return { song: null, reason: "not-found" };
  const pads = new Map((track.sampler?.pads ?? []).map((p) => [p.row_id, p]));
  const assigned: PadAssignment[] = [];
  let known = song.samples ?? [];
  let grew = false;
  let stopped: "sample-limit" | undefined;
  for (const [offset, sample] of samples.entries()) {
    const index = first + offset;
    if (index >= PAD_COUNT) break;
    if (!known.some((s) => s.id === sample.id)) {
      if (known.length >= MAX_SAMPLES) {
        stopped = "sample-limit";
        break;
      }
      known = [...known, sample];
      grew = true;
    }
    const rowId = padRowId(index);
    const before = pads.get(rowId);
    pads.set(rowId, { gain_db: 0, pitch_semitones: 0, ...before, row_id: rowId, sample_id: sample.id });
    assigned.push({ rowId, sample });
  }
  if (assigned.length === 0) return stopped ? { song: null, reason: stopped } : { song, assigned };
  const sorted = [...pads.values()].sort((a, b) => padIndex(a.row_id) - padIndex(b.row_id));
  const next = withSettings(track, { pads: sorted });
  const result = replaceTrack(song, track, next, grew ? known : song.samples);
  return { song: result, assigned, ...(stopped && { stopped }) };
}

export function assignPad(song: Song, trackId: string, rowId: string, sample: Sample): SamplerResult {
  const result = assignPads(song, trackId, rowId, [sample]);
  return result.song ? ok(result.song) : fail(result.reason);
}

function editPad(song: Song, trackId: string, rowId: string, edit: (pad: PadSettings) => PadSettings): SamplerResult {
  const track = locate(song, trackId, "pads");
  if (isResult(track)) return track;
  const pads = track.sampler?.pads ?? [];
  const pad = pads.find((p) => p.row_id === rowId);
  if (!pad) return ok(song);
  const changed = edit(pad);
  if (changed === pad) return ok(song);
  return ok(replaceTrack(song, track, withSettings(track, { pads: pads.map((p) => (p === pad ? changed : p)) })));
}

export function clearPad(song: Song, trackId: string, rowId: string): SamplerResult {
  const track = locate(song, trackId, "pads");
  if (isResult(track)) return track;
  const pads = track.sampler?.pads ?? [];
  if (!pads.some((p) => p.row_id === rowId)) return ok(song);
  return ok(replaceTrack(song, track, withSettings(track, { pads: pads.filter((p) => p.row_id !== rowId) })));
}

export function setPadGain(song: Song, trackId: string, rowId: string, gainDb: number): SamplerResult {
  const gain = clamp(gainDb, PAD_GAIN_DB_RANGE.min, PAD_GAIN_DB_RANGE.max);
  return editPad(song, trackId, rowId, (p) => (p.gain_db === gain ? p : { ...p, gain_db: gain }));
}

export function setPadPitch(song: Song, trackId: string, rowId: string, semitones: number): SamplerResult {
  const pitch = clamp(Math.round(semitones), PAD_PITCH_RANGE.min, PAD_PITCH_RANGE.max);
  return editPad(song, trackId, rowId, (p) => (p.pitch_semitones === pitch ? p : { ...p, pitch_semitones: pitch }));
}
