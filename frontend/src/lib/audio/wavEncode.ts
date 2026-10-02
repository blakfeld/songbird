export interface EncodedWav {
  bytes: Uint8Array;
  // True when any sample reached full scale before quantizing, which is where a mix starts to distort.
  clipped: boolean;
}

const HEADER_BYTES = 44;

// Fixed so the same mix always encodes to the same file, which keeps downloads reproducible and tests exact.
const DITHER_SEED = 0x9e3779b9;

// A small generator, because dither needs two uniform draws per sample and Math.random is slower and unseedable.
function uniform(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

// Triangular noise of one step either side decorrelates the rounding error from the signal, so quiet tails
// fade into hiss rather than into audible quantization distortion.
export function encodeWav16(channels: Float32Array[], sampleRate: number): EncodedWav {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * count * 2;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);

  const random = uniform(DITHER_SEED);
  let clipped = false;
  let offset = HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const x = channels[c][i];
      if (x >= 1 || x <= -1) clipped = true;
      const dither = random() - random();
      const q = Math.round(x * 32767 + dither);
      view.setInt16(offset, Math.max(-32768, Math.min(32767, q)), true);
      offset += 2;
    }
  }
  return { bytes, clipped };
}
