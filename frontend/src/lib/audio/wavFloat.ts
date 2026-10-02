import type { PcmSample } from "./sampleAnalysis";

const FLOAT_FORMAT = 3;
const BITS = 32;

// fmt and fact chunks precede the data, which is where the first sample sits.
export const FLOAT_HEADER_BYTES = 12 + 24 + 12 + 8;

export const floatWavBytes = (frames: number, channels: number) => FLOAT_HEADER_BYTES + frames * channels * 4;

// 32-bit float rather than 16-bit PCM so a bundle holds the stored audio exactly, and any DAW can open it.
export function encodeWavFloat32({ data, sampleRate, channels }: PcmSample): Uint8Array {
  const frames = Math.floor(data.length / channels);
  const dataBytes = frames * channels * 4;
  const bytes = new Uint8Array(floatWavBytes(frames, channels));
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, FLOAT_FORMAT, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 4, true);
  view.setUint16(32, channels * 4, true);
  view.setUint16(34, BITS, true);
  // Non-PCM formats are required to carry a fact chunk giving the frame count.
  tag(36, "fact");
  view.setUint32(40, 4, true);
  view.setUint32(44, frames, true);
  tag(48, "data");
  view.setUint32(52, dataBytes, true);
  new Uint8Array(bytes.buffer, FLOAT_HEADER_BYTES, dataBytes).set(
    new Uint8Array(data.buffer, data.byteOffset, dataBytes),
  );
  return bytes;
}

export interface WavHeader {
  sampleRate: number;
  channels: number;
  frames: number;
  dataOffset: number;
}

// Reads only what is needed from the front of a file, so a bundle can be checked without holding its audio.
// Returns null for anything but 32-bit float, the one format a bundle is written in.
export function parseFloatWavHeader(bytes: Uint8Array): WavHeader | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let format: { sampleRate: number; channels: number } | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt " && at + 24 <= bytes.length) {
      if (view.getUint16(at + 8, true) !== FLOAT_FORMAT || view.getUint16(at + 22, true) !== BITS) return null;
      format = { channels: view.getUint16(at + 10, true), sampleRate: view.getUint32(at + 12, true) };
    } else if (tag(at) === "data") {
      if (!format || format.channels < 1) return null;
      return { ...format, frames: Math.floor(size / (format.channels * 4)), dataOffset: at + 8 };
    }
    // Chunks are word aligned.
    at += 8 + size + (size % 2);
  }
  return null;
}

export function decodeWavFloat32(bytes: Uint8Array, header: WavHeader): PcmSample {
  const length = header.frames * header.channels;
  // Copied so the view is aligned, which a slice of a larger buffer is not guaranteed to be.
  const data = new Float32Array(bytes.slice(header.dataOffset, header.dataOffset + length * 4).buffer);
  return { sampleRate: header.sampleRate, channels: header.channels, data };
}
