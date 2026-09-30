import type { SoundSource } from "./types";
import { createDrumsSource } from "./drumsSource";
import { fallbackPreset, presets } from "./presets";
import { createSynthSource } from "./synthSource";

type ToneModule = typeof import("tone");

export type SoundSourceFactory = (tone: ToneModule) => SoundSource;

const factories = new Map<string, SoundSourceFactory>([
  ["drums", createDrumsSource],
  ...Object.entries(presets).map(
    ([id, preset]): [string, SoundSourceFactory] => [id, createSynthSource(preset)],
  ),
]);

const fallbackFactory = createSynthSource(fallbackPreset);

export function registerSoundSource(
  instrumentId: string,
  factory: SoundSourceFactory,
) {
  factories.set(instrumentId, factory);
}

export function getSoundSourceFactory(
  instrumentId: string,
): SoundSourceFactory {
  // The engine only has the id, and every non-drum instrument is sustained,
  // so an id without a preset gets the neutral synth rather than silence.
  return factories.get(instrumentId) ?? fallbackFactory;
}
