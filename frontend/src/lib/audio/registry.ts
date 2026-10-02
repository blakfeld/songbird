import { SAMPLER_KEYS_ID, SAMPLER_PADS_ID } from "@/lib/song/sampler";
import type { SoundSource, ToneControls } from "./types";
import { createDrumsSource } from "./drumsSource";
import { fallbackPreset, presets } from "./presets";
import { createSamplerSource } from "./samplerSource";
import { createSynthSource } from "./synthSource";

type ToneModule = typeof import("tone");

// Without an output the source plays straight to the destination, which is
// what single-instrument pages and key audition want.
export type SoundSourceFactory = (
  tone: ToneModule,
  output?: import("tone").InputNode,
  initialTone?: ToneControls,
) => SoundSource;

const factories = new Map<string, SoundSourceFactory>([
  ["drums", createDrumsSource],
  [SAMPLER_KEYS_ID, createSamplerSource("keys")],
  [SAMPLER_PADS_ID, createSamplerSource("pads")],
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
