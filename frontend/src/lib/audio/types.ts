import type { Row } from "@/generated/Row";

export type LoopRange = { start: number; end: number };

export type PlaybackStatus = "idle" | "loading" | "ready" | "error";

export interface Playback {
  isPlaying: boolean;
  status: PlaybackStatus;
  error: string | null;
  toggle(): void;
  stop(): void;
  // Imports Tone and fetches the kit ahead of Play so the first Play stays
  // inside the user gesture and later plays work offline.
  preload(rows?: Row[]): Promise<void>;
  // Kept out of React state: per-frame updates would re-render every measure.
  subscribePosition(cb: (absoluteStep: number | null) => void): () => void;
}

// Sustained instruments release at endSeconds; one-shot instruments ignore it.
// Times are AudioContext seconds.
export interface SoundSource {
  load(rows: Row[]): Promise<void>;
  trigger(
    row: Row,
    startSeconds: number,
    endSeconds: number,
    velocity: number,
  ): void;
  stopAll(): void;
}
