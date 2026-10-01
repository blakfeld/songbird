import type { Clip } from "@/generated/Clip";
import type { KeyMode } from "@/generated/KeyMode";
import type { Loop } from "@/generated/Loop";
import type { LoopRegion } from "@/generated/LoopRegion";
import type { Song } from "@/generated/Song";
import type { SongKey } from "@/generated/SongKey";
import type { Tonic } from "@/generated/Tonic";
import type { TimeSignature } from "@/generated/TimeSignature";
import type { Track } from "@/generated/Track";
import { STEPS_PER_MEASURE } from "../patternOps";

export type { Clip, KeyMode, Loop, LoopRegion, Song, SongKey, Tonic, Track };

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
