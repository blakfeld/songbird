import type { SoundSource } from "./types";
import { createDrumsSource } from "./drumsSource";

type ToneModule = typeof import("tone");

export type SoundSourceFactory = (tone: ToneModule) => SoundSource;

const factories = new Map<string, SoundSourceFactory>([
  ["drums", createDrumsSource],
]);

export function registerSoundSource(
  instrumentId: string,
  factory: SoundSourceFactory,
) {
  factories.set(instrumentId, factory);
}

export function getSoundSourceFactory(
  instrumentId: string,
): SoundSourceFactory | undefined {
  return factories.get(instrumentId);
}
