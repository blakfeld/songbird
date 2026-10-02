import { describe, expect, it } from "vitest";
import { encodeWav16 } from "./wavEncode";
import { encodeWavInWorker } from "./wavEncodeClient";

const text = (bytes: Uint8Array, at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));

describe("encodeWav16", () => {
  it("writes a 16-bit PCM stereo header and interleaved samples", () => {
    const { bytes } = encodeWav16([new Float32Array([0.5, -0.5]), new Float32Array([0, 0.25])], 48000);
    const view = new DataView(bytes.buffer);
    expect(text(bytes, 0, 4)).toBe("RIFF");
    expect(text(bytes, 8, 8)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(48000 * 4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(bytes.length).toBe(44 + 8);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    // Dither moves a sample by at most one step either way.
    expect(Math.abs(view.getInt16(44, true) - 16384)).toBeLessThanOrEqual(1);
    expect(Math.abs(view.getInt16(46, true))).toBeLessThanOrEqual(1);
    expect(Math.abs(view.getInt16(48, true) + 16384)).toBeLessThanOrEqual(1);
    expect(Math.abs(view.getInt16(50, true) - 8192)).toBeLessThanOrEqual(1);
  });

  it("dithers silence into small noise with no average offset, rather than exact zeros", () => {
    const n = 20000;
    const { bytes } = encodeWav16([new Float32Array(n), new Float32Array(n)], 48000);
    const view = new DataView(bytes.buffer);
    let sum = 0;
    let nonZero = 0;
    for (let i = 0; i < n; i++) {
      const v = view.getInt16(44 + i * 4, true);
      sum += v;
      if (v !== 0) nonZero += 1;
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
    // Triangular noise rounds to a nonzero step a quarter of the time.
    expect(nonZero).toBeGreaterThan(n * 0.2);
    expect(Math.abs(sum / n)).toBeLessThan(0.05);
  });

  it("is deterministic", () => {
    const input = () => [new Float32Array([0.1, 0.2, 0.3]), new Float32Array([0.3, 0.2, 0.1])];
    expect(encodeWav16(input(), 44100).bytes).toEqual(encodeWav16(input(), 44100).bytes);
  });

  it("clamps at full scale and reports clipping", () => {
    const { bytes, clipped } = encodeWav16([new Float32Array([1.5, -2]), new Float32Array([0, 0])], 44100);
    const view = new DataView(bytes.buffer);
    expect(clipped).toBe(true);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it("does not report clipping for a mix that stays below full scale", () => {
    expect(encodeWav16([new Float32Array([0.99, -0.99]), new Float32Array([0, 0])], 44100).clipped).toBe(false);
  });

  it("matches inline encoding when it runs through the worker client without Worker support", async () => {
    const make = () => [new Float32Array([0.1, -0.7]), new Float32Array([0.4, 0.9])];
    const direct = encodeWav16(make(), 22050);
    expect(await encodeWavInWorker(make(), 22050)).toEqual(direct);
  });
});
