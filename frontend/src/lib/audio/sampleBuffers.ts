import type { PcmSample } from "./sampleAnalysis";
import { readSamplePcm } from "./sampleStore";

type ToneModule = typeof import("tone");
type ToneBuffer = InstanceType<ToneModule["ToneAudioBuffer"]>;

// Held in memory because turning stored PCM into an AudioBuffer costs a blob read and a deinterleave, which must
// not happen on the scheduler's path.
export interface SampleBufferCache {
  // Samples that are missing or unreadable are skipped rather than failing, so their clips stay silent.
  load(ids: Iterable<string>): Promise<void>;
  get(id: string): ToneBuffer | undefined;
  // Reference counted so two songs, or a song and a preview, can share a buffer without either freeing it.
  acquire(ids: Iterable<string>): void;
  release(ids: Iterable<string>): void;
}

export function createSampleBufferCache(
  tone: ToneModule,
  read: (id: string) => Promise<PcmSample | undefined> = readSamplePcm,
): SampleBufferCache {
  const buffers = new Map<string, ToneBuffer>();
  const loading = new Map<string, Promise<void>>();
  const holds = new Map<string, number>();

  const build = (pcm: PcmSample): ToneBuffer => {
    const frames = Math.floor(pcm.data.length / pcm.channels);
    const audio = tone.getContext().createBuffer(pcm.channels, frames, pcm.sampleRate);
    for (let c = 0; c < pcm.channels; c++) {
      const out = audio.getChannelData(c);
      for (let i = 0; i < frames; i++) out[i] = pcm.data[i * pcm.channels + c];
    }
    return new tone.ToneAudioBuffer(audio);
  };

  const loadOne = (id: string) => {
    if (buffers.has(id)) return Promise.resolve();
    let pending = loading.get(id);
    if (!pending) {
      pending = read(id)
        .then((pcm) => {
          if (pcm) buffers.set(id, build(pcm));
        })
        // Storage can be evicted or unavailable; the clip is then silent instead of the whole play failing.
        .catch(() => {})
        .finally(() => loading.delete(id));
      loading.set(id, pending);
    }
    return pending;
  };

  return {
    async load(ids) {
      await Promise.all([...new Set(ids)].map(loadOne));
    },
    get: (id) => buffers.get(id),
    acquire(ids) {
      for (const id of ids) holds.set(id, (holds.get(id) ?? 0) + 1);
    },
    release(ids) {
      for (const id of ids) {
        const left = (holds.get(id) ?? 0) - 1;
        if (left > 0) {
          holds.set(id, left);
          continue;
        }
        holds.delete(id);
        buffers.get(id)?.dispose();
        buffers.delete(id);
      }
    },
  };
}

let shared: SampleBufferCache | null = null;
let sharedFor: ToneModule | null = null;

// One cache for the page, so the engine and a mixdown do not each hold their own copy of a long sample.
export function sharedSampleBuffers(tone: ToneModule): SampleBufferCache {
  if (!shared || sharedFor !== tone) {
    shared = createSampleBufferCache(tone);
    sharedFor = tone;
  }
  return shared;
}
