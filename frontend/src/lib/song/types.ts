import type { Note } from "@/generated/Note";
import type { TimeSignature } from "@/generated/TimeSignature";
import { STEPS_PER_MEASURE } from "../patternOps";

// Snake_case and flat so change #5 can mirror these types in Rust without a translation layer.
export interface Track {
  id: string;
  name: string;
  instrument: string;
  volume_db: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  notes: Note[];
}

export interface Song {
  version: 1;
  id: string;
  name: string;
  tempo_bpm: number;
  time_signature: TimeSignature;
  steps_per_measure: number;
  swing: number;
  measures: number;
  tracks: Track[];
}

export const MAX_TRACKS = 16;
export const MEASURE_RANGE = { min: 1, max: 128 } as const;
export const VOLUME_DB_RANGE = { min: -60, max: 6 } as const;
export const PAN_RANGE = { min: -1, max: 1 } as const;
export const SONG_NAME_MAX = 80;
export const TRACK_NAME_MAX = 40;

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
    notes: [],
  };
}

export function newSong(
  timeSignature: TimeSignature = "4/4",
  tempoBpm = 120,
): Song {
  return {
    version: 1,
    id: newId(),
    name: "Untitled song",
    tempo_bpm: tempoBpm,
    time_signature: timeSignature,
    steps_per_measure: STEPS_PER_MEASURE[timeSignature],
    swing: 0,
    measures: 8,
    tracks: [newTrack("drums", "Drums"), newTrack("piano", "Piano")],
  };
}
