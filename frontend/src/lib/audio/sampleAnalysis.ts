export const OVERVIEW_FRAMES_PER_BUCKET = 256;

export interface PcmSample {
  sampleRate: number;
  channels: number;
  // Interleaved so one contiguous buffer is both the stored blob and the hash input.
  data: Float32Array;
}

export interface SampleAnalysis {
  id: string;
  // [min, max] pairs across all channels, one pair per bucket, so a lane can draw without decoding.
  overview: Float32Array;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// Rate and channel count are part of the hash because identical bytes at another rate or layout are a different sound.
export async function hashSample({ data, sampleRate, channels }: PcmSample): Promise<string> {
  const pcm = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const input = new Uint8Array(pcm.byteLength + 8);
  input.set(pcm);
  const view = new DataView(input.buffer);
  view.setUint32(pcm.byteLength, sampleRate, true);
  view.setUint32(pcm.byteLength + 4, channels, true);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return toHex(new Uint8Array(digest)).slice(0, 32);
}

export function computeOverview({ data, channels }: PcmSample): Float32Array {
  const frames = Math.floor(data.length / channels);
  const buckets = Math.ceil(frames / OVERVIEW_FRAMES_PER_BUCKET);
  const out = new Float32Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    const start = b * OVERVIEW_FRAMES_PER_BUCKET;
    const end = Math.min(frames, start + OVERVIEW_FRAMES_PER_BUCKET);
    let min = Infinity;
    let max = -Infinity;
    for (let i = start * channels; i < end * channels; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

export async function analyzeSample(pcm: PcmSample): Promise<SampleAnalysis> {
  return { id: await hashSample(pcm), overview: computeOverview(pcm) };
}

export function interleave(channels: Float32Array[]): Float32Array {
  const count = channels.length;
  if (count === 1) return channels[0].slice();
  const frames = channels[0]?.length ?? 0;
  const out = new Float32Array(frames * count);
  for (let c = 0; c < count; c++) {
    const source = channels[c];
    for (let i = 0; i < frames; i++) out[i * count + c] = source[i];
  }
  return out;
}

// Alternating channels go left and right, each side scaled by 1/sqrt(n), so uncorrelated sources keep
// their loudness instead of growing with the channel count.
export function downmixToStereo(channels: Float32Array[]): Float32Array[] {
  if (channels.length <= 2) return channels;
  const frames = channels[0].length;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const leftSources = channels.filter((_, i) => i % 2 === 0);
  const rightSources = channels.filter((_, i) => i % 2 === 1);
  const leftGain = 1 / Math.sqrt(leftSources.length);
  const rightGain = 1 / Math.sqrt(rightSources.length);
  for (let i = 0; i < frames; i++) {
    let l = 0;
    for (const c of leftSources) l += c[i];
    let r = 0;
    for (const c of rightSources) r += c[i];
    left[i] = l * leftGain;
    right[i] = r * rightGain;
  }
  return [left, right];
}
