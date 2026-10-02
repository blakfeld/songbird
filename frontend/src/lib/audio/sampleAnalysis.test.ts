import { describe, expect, it } from "vitest";
import {
  analyzeSample,
  computeOverview,
  downmixToStereo,
  hashSample,
  interleave,
} from "./sampleAnalysis";

const pcm = (values: number[], channels = 1, sampleRate = 48000) => ({
  data: new Float32Array(values),
  channels,
  sampleRate,
});

describe("sampleAnalysis", () => {
  it("hashes to 32 hex characters and is stable", async () => {
    const a = await hashSample(pcm([0.1, 0.2, 0.3]));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await hashSample(pcm([0.1, 0.2, 0.3]))).toBe(a);
  });

  it("separates identical bytes with a different rate or channel count", async () => {
    const base = await hashSample(pcm([0.1, 0.2, 0.3, 0.4]));
    expect(await hashSample(pcm([0.1, 0.2, 0.3, 0.4], 1, 44100))).not.toBe(base);
    expect(await hashSample(pcm([0.1, 0.2, 0.3, 0.4], 2))).not.toBe(base);
  });

  it("keeps min and max per 256 frames across channels", () => {
    const frames = 300;
    const data = new Float32Array(frames * 2);
    data[2] = -0.5;
    data[3] = 0.25;
    data[299 * 2] = 0.9;
    const overview = computeOverview({ data, channels: 2, sampleRate: 48000 });
    expect(Array.from(overview)).toEqual([-0.5, expect.closeTo(0.25), 0, expect.closeTo(0.9)]);
  });

  it("returns the id and overview together", async () => {
    const result = await analyzeSample(pcm([0, 1, -1]));
    expect(result.id).toHaveLength(32);
    expect(result.overview).toHaveLength(2);
  });

  it("interleaves channels frame by frame", () => {
    expect(Array.from(interleave([new Float32Array([1, 2]), new Float32Array([3, 4])]))).toEqual([1, 3, 2, 4]);
  });

  it("sums four channels to stereo with equal power", () => {
    const ones = () => new Float32Array([1]);
    const [l, r] = downmixToStereo([ones(), ones(), ones(), ones()]);
    expect(l[0]).toBeCloseTo(Math.SQRT2);
    expect(r[0]).toBeCloseTo(Math.SQRT2);
  });

  it("leaves mono and stereo alone", () => {
    const mono = [new Float32Array([1])];
    expect(downmixToStereo(mono)).toBe(mono);
  });
});
