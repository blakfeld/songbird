import type { Note } from "@/generated/Note";
import type { Row } from "@/generated/Row";

export type LoopRange = { start: number; end: number };

export type PlaybackStatus = "idle" | "loading" | "ready" | "error";

export interface Playback {
  isPlaying: boolean;
  status: PlaybackStatus;
  error: string | null;
  toggle(): void;
  stop(): void;
  // Optional because only the song view lets the user pick a starting point.
  seek?(measure: number): void;
  // Loading ahead of Play keeps the first Play inside the user gesture, which browsers require to start audio.
  preload(rows?: Row[]): Promise<void>;
  // A callback rather than React state, since per-frame state updates would re-render every measure.
  subscribePosition(cb: (absoluteStep: number | null) => void): () => void;
}

// Opaque to callers so each source can keep whatever it needs to release the note later.
export type NoteHandle = object;

// Times are AudioContext seconds because the audio clock, unlike wall time, does not drift under load.
export interface SoundSource {
  load(rows: Row[]): Promise<void>;
  trigger(
    row: Row,
    startSeconds: number,
    endSeconds: number,
    velocity: number,
  ): void;
  // For live play, where the end is unknown until the key is released.
  noteOn(row: Row, startSeconds: number, velocity: number): NoteHandle;
  noteOff(handle: NoteHandle, endSeconds: number): void;
  stopAll(): void;
  // Nodes stay connected to the channel until released, so a removed voice would keep running unheard.
  dispose?(): void;
}

export interface PlaybackTiming {
  tempo: number;
  swing: number;
  stepsPerMeasure: number;
  // Optional because only models that know their meter can place clicks on its beats; the rest get quarter-note clicks.
  beatSteps?: number;
  measures: number;
}

export interface Voice {
  // Stable across edits so the engine keeps one source and channel per voice.
  key: string;
  instrument: string;
  rows: Row[];
  notes: Note[];
  volumeDb: number;
  pan: number;
  // Resolved by the model because solo depends on every other track, which a single voice cannot see.
  audible: boolean;
}

export interface PlaybackModel {
  // Null rather than a default so the engine can tell "nothing loaded" from a real song.
  getTiming(): PlaybackTiming | null;
  getVoices(): Voice[];
  // Single-instrument pages have one implicit voice, so their audition needs no voice key.
  instrument?: string;
}
