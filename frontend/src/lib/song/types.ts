import type { Clip } from "@/generated/Clip";
import type { KeyMode } from "@/generated/KeyMode";
import type { Loop } from "@/generated/Loop";
import type { LoopRegion } from "@/generated/LoopRegion";
import type { Section } from "@/generated/Section";
import type { SectionKind } from "@/generated/SectionKind";
import type { Song } from "@/generated/Song";
import type { SongKey } from "@/generated/SongKey";
import type { Tonic } from "@/generated/Tonic";
import type { TimeSignature } from "@/generated/TimeSignature";
import type { Track } from "@/generated/Track";
import { STEPS_PER_MEASURE } from "../patternOps";

export type { Clip, KeyMode, Loop, LoopRegion, Section, SectionKind, Song, SongKey, Tonic, Track };

export const TONICS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export const DEFAULT_KEY: SongKey = { tonic: "C", mode: "major" };

export const MAX_TRACKS = 16;
export const MEASURE_RANGE = { min: 1, max: 128 } as const;
export const VOLUME_DB_RANGE = { min: -60, max: 6 } as const;
export const PAN_RANGE = { min: -1, max: 1 } as const;
export const SONG_NAME_MAX = 80;
export const TRACK_NAME_MAX = 40;
export const LOOP_MEASURE_RANGE = { min: 1, max: 128 } as const;
export const LOOP_NAME_MAX = 40;
export const MAX_LOOPS = 64;
export const MAX_CLIPS = 256;
// Unicode code points, matching the server's chars().count(), not UTF-16 units.
export const LYRICS_MAX_CHARS = 20_000;

export const SECTION_NAME_MAX = 40;
export const SECTION_MEASURE_RANGE = { min: 1, max: 32 } as const;
// Code points, like lyrics, because the server counts section notes with chars().
export const SECTION_NOTES_MAX_CHARS = 5_000;
export const SECTION_KINDS: readonly SectionKind[] = [
  "intro",
  "verse",
  "pre-chorus",
  "chorus",
  "bridge",
  "outro",
  "other",
];

export const newId = () => crypto.randomUUID();

export function newTrack(instrument: string, name: string): Track {
  return {
    id: newId(),
    name,
    instrument,
    volume_db: 0,
    pan: 0,
    muted: false,
    soloed: false,
    loops: [],
    clips: [],
  };
}

const UNTITLED = "Untitled song";

// Creating without a dialog means the name can't be left to the user, so it must avoid colliding with existing songs.
export function uniqueUntitledName(existingNames: string[]): string {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  if (!taken.has(UNTITLED.toLowerCase())) return UNTITLED;
  let n = 2;
  while (taken.has(`${UNTITLED} ${n}`.toLowerCase())) n++;
  return `${UNTITLED} ${n}`;
}

export function newSong(
  timeSignature: TimeSignature = "4/4",
  tempoBpm = 120,
): Song {
  return {
    version: 2,
    id: newId(),
    name: "Untitled song",
    tempo_bpm: tempoBpm,
    time_signature: timeSignature,
    steps_per_measure: STEPS_PER_MEASURE[timeSignature],
    swing: 0,
    key: { ...DEFAULT_KEY },
    measures: 1,
    tracks: [],
  };
}
