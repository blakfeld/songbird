import type { MixerPatch, SoundPatch } from "@/lib/song/songOps";

export interface TrackActions {
  select(trackId: string): void;
  rename(trackId: string, name: string): void;
  remove(trackId: string): void;
  mixer(trackId: string, patch: MixerPatch, options?: { transient?: boolean }): void;
  sound(trackId: string, patch: SoundPatch, options?: { transient?: boolean }): void;
  resetSound(trackId: string): void;
  generate(trackId: string): void;
  beginGesture(): void;
  endGesture(): void;
}
