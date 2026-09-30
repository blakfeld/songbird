import type { MixerPatch } from "@/lib/song/songOps";

export interface TrackActions {
  select(trackId: string): void;
  rename(trackId: string, name: string): void;
  remove(trackId: string): void;
  mixer(trackId: string, patch: MixerPatch, options?: { transient?: boolean }): void;
  beginGesture(): void;
  endGesture(): void;
}
