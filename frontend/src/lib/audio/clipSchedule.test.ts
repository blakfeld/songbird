import { describe, expect, it } from "vitest";
import type { AudioClip } from "@/generated/AudioClip";
import { clipEnvelope, clipEndSeconds, planClip, ticksToSeconds } from "./clipSchedule";
import type { PlaybackClip } from "./types";

const RATE = 1000;

const pc = (over: Partial<AudioClip> = {}): PlaybackClip => ({
  sampleRate: RATE,
  clip: {
    id: "c",
    sample_id: "s",
    start_ticks: 0,
    offset_samples: 100,
    slice_samples: 400,
    length_samples: 1000,
    loop: true,
    gain_db: 0,
    fade_in_samples: 0,
    fade_out_samples: 0,
    ...over,
  },
});

// Plays a plan the way a looping buffer source does, so a gap or a wrong phase at a repeat shows as a wrong value.
function playPlan(sample: Float32Array, plan: NonNullable<ReturnType<typeof planClip>>): Float32Array {
  const out = new Float32Array(Math.round(plan.duration * RATE));
  const a = Math.round(plan.loopStart * RATE);
  const b = Math.round(plan.loopEnd * RATE);
  let frame = Math.round(plan.offset * RATE);
  for (let n = 0; n < out.length; n++) {
    if (plan.loop && frame >= b) frame = a;
    out[n] = sample[frame];
    frame += 1;
  }
  return out;
}

describe("ticksToSeconds", () => {
  it("is straight time: 240 ticks are a sixteenth, with no swing", () => {
    expect(ticksToSeconds(240, 120)).toBeCloseTo(0.125, 12);
    expect(ticksToSeconds(3840, 120)).toBeCloseTo(2, 12);
    expect(ticksToSeconds(3840, 100)).toBeCloseTo(2.4, 12);
  });

  it("ends a clip where its start plus its length falls", () => {
    expect(clipEndSeconds(pc({ start_ticks: 3840, length_samples: 500 }), 120)).toBeCloseTo(2.5, 12);
  });
});

describe("planClip", () => {
  it("plays a plain clip from its offset for its length", () => {
    expect(planClip(pc({ loop: false, length_samples: 300 }), 0)).toMatchObject({ offset: 0.1, duration: 0.3, loop: false });
  });

  it("resumes inside a plain clip", () => {
    expect(planClip(pc({ loop: false, length_samples: 300 }), 120)).toMatchObject({ offset: 0.22, duration: 0.18 });
  });

  it("resumes a looping clip at its phase in the slice", () => {
    // 1000 frames in, a 400-frame slice has done 2.5 repeats, so playback is 200 frames into the slice.
    const plan = planClip(pc(), 1000 - 300)!;
    expect(plan.offset).toBeCloseTo(0.1 + 0.3, 12);
    expect(plan.loopStart).toBeCloseTo(0.1, 12);
    expect(plan.loopEnd).toBeCloseTo(0.5, 12);
  });

  it("has nothing to play at or past the clip's end", () => {
    expect(planClip(pc(), 1000)).toBeNull();
    expect(planClip(pc(), -1)).toBeNull();
  });

  it("Looping clip repeats seamlessly: every repeat is the slice again, with no gap or jump", () => {
    // A ramp has no repeated values, so a skipped or doubled frame at a repeat changes the output.
    const sample = Float32Array.from({ length: 600 }, (_, i) => i);
    const out = playPlan(sample, planClip(pc(), 0)!);
    expect(out).toHaveLength(1000);
    for (let n = 0; n < out.length; n++) expect(out[n]).toBe(100 + (n % 400));
    // The step across each repeat is the slice's own jump back, and nothing else.
    const jumps = Array.from(out).flatMap((v, n) => (n > 0 && v - out[n - 1] !== 1 ? [n] : []));
    expect(jumps).toEqual([400, 800]);
  });

  it("continues the same waveform when started mid-clip as when played from the top", () => {
    const sample = Float32Array.from({ length: 600 }, (_, i) => i);
    const whole = playPlan(sample, planClip(pc(), 0)!);
    const resumed = playPlan(sample, planClip(pc(), 650)!);
    expect(Array.from(resumed)).toEqual(Array.from(whole.subarray(650)));
  });
});

describe("clipEnvelope", () => {
  it("holds the clip's gain with no fades", () => {
    const points = clipEnvelope(pc({ gain_db: -6, loop: false }), 0);
    expect(points.map((p) => p.at)).toEqual([0, 1]);
    for (const p of points) expect(p.value).toBeCloseTo(10 ** (-6 / 20), 12);
  });

  it("rises over the fade-in and falls over the fade-out", () => {
    const points = clipEnvelope(pc({ fade_in_samples: 100, fade_out_samples: 200 }), 0);
    expect(points).toEqual([
      { at: 0, value: 0 },
      { at: 0.1, value: 1 },
      { at: 0.8, value: 1 },
      { at: 1, value: 0 },
    ]);
  });

  it("starts partway up a fade-in when playback begins inside it", () => {
    const [first, second] = clipEnvelope(pc({ fade_in_samples: 100 }), 40);
    expect(first).toEqual({ at: 0, value: 0.4 });
    expect(second.at).toBeCloseTo(0.06, 12);
    expect(second.value).toBe(1);
  });

  it("starts partway down a fade-out when playback begins inside it", () => {
    const points = clipEnvelope(pc({ fade_out_samples: 200 }), 900);
    expect(points).toEqual([
      { at: 0, value: 0.5 },
      { at: 0.1, value: 0 },
    ]);
  });
});
