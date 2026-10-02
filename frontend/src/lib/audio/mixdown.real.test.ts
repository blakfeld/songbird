import { loadRealTone } from "@/test/webAudio";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AudioClip } from "@/generated/AudioClip";
import { drums } from "@/test/fixtures";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { newTrack, type Song } from "@/lib/song/types";
import { renderMixdown } from "./mixdown";
import { registerSoundSource } from "./registry";
import { createSampleBufferCache } from "./sampleBuffers";
import type { PcmSample } from "./sampleAnalysis";

// These render through a real Web Audio implementation (node-web-audio-api) behind Tone.Offline, so what they
// check is what a browser would write: loop seams, onsets, effect tails and segment joins.
const SR = 48000;
type Tone = Awaited<ReturnType<typeof loadRealTone>>;
let tone: Tone;

beforeAll(async () => {
  tone = await loadRealTone(SR);
});

const DC = "real-dc";
const SINE = "real-sine";
const instruments = [DC, SINE].map((id) => ({ ...drums, id }));

// A constant burst: a note is a sharp step, so its onset is easy to locate in the output.
registerSoundSource(DC, (t, output) => {
  const length = Math.round(0.125 * SR);
  const audio = t.getContext().createBuffer(1, length, SR);
  audio.getChannelData(0).fill(0.5);
  const buffer = new t.ToneAudioBuffer(audio);
  return {
    load: async () => {},
    trigger: (_row, start) => {
      new t.ToneBufferSource({ url: buffer }).connect(output as never).start(start);
    },
    noteOn: () => ({}),
    noteOff: () => {},
    stopAll: () => {},
  };
});

// A held sine whose phase depends on where it was started, which is what a restarted note would get wrong.
registerSoundSource(SINE, (t, output) => ({
  load: async () => {},
  trigger: (_row, start, end) => {
    const gain = new t.Gain(0.4).connect(output as never);
    new t.Oscillator(221, "sine").connect(gain).start(start).stop(end);
  },
  noteOn: () => ({}),
  noteOff: () => {},
  stopAll: () => {},
}));

const pcm = new Map<string, PcmSample>();
const buffers = () => createSampleBufferCache(tone, async (id) => pcm.get(id));

function ramp(frames: number): PcmSample {
  const data = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) data[i * 2] = data[i * 2 + 1] = (i / frames) * 0.8;
  return { sampleRate: SR, channels: 2, data };
}

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: "c",
  sample_id: "s1",
  start_ticks: 0,
  offset_samples: 0,
  slice_samples: 24000,
  length_samples: 24000,
  loop: false,
  gain_db: 0,
  fade_in_samples: 0,
  fade_out_samples: 0,
  ...over,
});

interface Spec {
  measures?: number;
  notes?: { instrument?: string; step: number; length: number }[];
  clips?: AudioClip[];
  effects?: Record<string, unknown>;
  swing?: number;
}

// A step is 0.125 s and a measure 2 s at 120 BPM.
function song(spec: Spec): Song {
  const s = newSongWithTracks();
  s.measures = spec.measures ?? 1;
  s.swing = spec.swing ?? 0;
  s.samples = [{ id: "s1", name: "S", sample_rate: SR, channels: 2, length_samples: 48000, origin: "import" }];
  s.tracks = [];
  for (const instrument of new Set((spec.notes ?? []).map((n) => n.instrument ?? DC))) {
    s.tracks.push({
      ...newTrack(instrument, "Notes"),
      sound: spec.effects ? ({ effects: spec.effects } as never) : undefined,
      loops: [
        {
          id: "l",
          name: "L",
          measures: s.measures,
          notes: (spec.notes ?? [])
            .filter((n) => (n.instrument ?? DC) === instrument)
            .map((n) => ({ row_id: "kick", step: n.step, length_steps: n.length, velocity: 127 })),
        },
      ],
      clips: [{ id: "k", loop_id: "l", start_measure: 1, measures: s.measures }],
    });
  }
  if (spec.clips) s.tracks.push({ ...newTrack("audio", "Audio"), audio_clips: spec.clips });
  return s;
}

function read(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function mix(s: Song, options: { segmentSeconds?: number; preRollSeconds?: number } = {}, seed = false) {
  // Tone.Reverb builds its impulse response from Math.random, so each render would hear a different room; reseeding
  // as each segment's context is made gives every segment the same room, leaving only what the segmenting does.
  const seeded = seed
    ? new Proxy(tone, {
        get(target, key) {
          if (key !== "OfflineContext") return Reflect.get(target, key);
          return new Proxy(target.OfflineContext, {
            construct(Ctor, args) {
              let x = 12345;
              vi.spyOn(Math, "random").mockImplementation(() => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32));
              return Reflect.construct(Ctor, args);
            },
          });
        },
      })
    : tone;
  const result = await renderMixdown(s, () => {}, undefined, {
    instruments,
    loadTone: async () => seeded as Tone,
    sampleBuffers: buffers(),
    ...options,
  });
  const view = new DataView(await read(result.wav));
  const frames = (view.byteLength - 44) / 4;
  const left = new Float32Array(frames);
  for (let i = 0; i < frames; i++) left[i] = view.getInt16(44 + i * 4, true) / 32768;
  return { left, clipped: result.clipped };
}

// The track channel's panner sets the level at centre pan (it is -3 dB for some Web Audio implementations), which
// is Tone's mixer rather than the mixdown, so it is measured once and divided out; what the seam tests check is shape.
async function centreGain() {
  pcm.set("s1", { sampleRate: SR, channels: 2, data: new Float32Array(48000 * 2).fill(0.5) });
  const { left } = await mix(song({ clips: [clip()] }));
  const gain = left[12000] / 0.5;
  expect(gain).toBeGreaterThan(0.5);
  expect(gain).toBeLessThanOrEqual(1.001);
  return gain;
}

const onset = (a: Float32Array) => a.findIndex((x) => Math.abs(x) > 0.05);
const rmsDb = (diff: Float32Array, ref: Float32Array) => {
  const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  return 20 * Math.log10(rms(diff) / rms(ref));
};

afterEach(() => vi.restoreAllMocks());

describe("real offline renders", () => {
  it("never leaves Tone's global context on the render while it waits, so live scheduling is not redirected", async () => {
    pcm.set("s1", ramp(24000));
    const live = tone.getContext();
    const seen: unknown[] = [];
    registerSoundSource("real-slow", () => ({
      // Loading yields, as a kit fetch does; a live engine could tick here.
      load: async () => {
        seen.push(tone.getContext());
        await new Promise((resolve) => setTimeout(resolve, 20));
        seen.push(tone.getContext());
      },
      trigger: () => {},
      noteOn: () => ({}),
      noteOff: () => {},
      stopAll: () => {},
    }));
    const s = song({ notes: [{ step: 0, length: 1 }], effects: { reverb: { enabled: true, decay_s: 1, mix: 0.3 } } });
    s.tracks[0].instrument = "real-slow";
    // Polled during the whole render, including the reverb's impulse-response wait.
    const during: unknown[] = [];
    const timer = setInterval(() => during.push(tone.getContext()), 1);
    const render = renderMixdown(s, () => {}, undefined, {
      instruments: [...instruments, { ...drums, id: "real-slow" }],
      loadTone: async () => tone,
      sampleBuffers: buffers(),
    });
    await render;
    clearInterval(timer);
    expect(seen).toHaveLength(2);
    for (const context of [...seen, ...during, tone.getContext()]) expect(context).toBe(live);
  });

  it("Looping clip repeats seamlessly: the rendered ramp has no jump or gap at any repeat", async () => {
    const g = await centreGain();
    pcm.set("s1", ramp(24000));
    const { left } = await mix(song({ measures: 2, clips: [clip({ loop: true, length_samples: 96000 })] }));
    // Each repeat starts the ramp again, so the output is the ramp at every frame, including across the seams.
    for (let n = 0; n < 96000; n++) {
      const expected = ((n % 24000) / 24000) * 0.8 * g;
      if (Math.abs(left[n] - expected) > 3 / 32768) {
        throw new Error(`frame ${n}: heard ${left[n]}, expected ${expected}`);
      }
    }
    expect(Math.abs(left[96000])).toBeLessThan(0.001);
  });

  it("starts a looping clip at the matching phase partway into its slice", async () => {
    const g = await centreGain();
    pcm.set("s1", ramp(24000));
    // Starting 0.1 s after the clip's start would be a seek; a clip whose slice begins mid-sample shows the offset.
    const { left } = await mix(song({ clips: [clip({ loop: true, offset_samples: 6000, slice_samples: 12000, length_samples: 36000 })] }));
    for (let n = 0; n < 36000; n++) {
      const expected = ((6000 + (n % 12000)) / 24000) * 0.8 * g;
      expect(Math.abs(left[n] - expected)).toBeLessThan(3 / 32768);
    }
  });

  it("Alignment: a clip's onset lands within 1 ms of a note at the same song time, measured from the render", async () => {
    pcm.set("s1", { sampleRate: SR, channels: 2, data: new Float32Array(48000 * 2).fill(0.5) });
    for (const tick of [9 * 240, 9 * 240 + 120, 13 * 240]) {
      const step = tick / 240;
      const note = await mix(song({ notes: [{ step: Math.floor(step), length: 1 }] }));
      const audio = await mix(song({ clips: [clip({ start_ticks: tick })] }));
      const expected = Math.round((tick / 240) * 0.125 * SR);
      // Compare against the grid time for tick positions, and against the note itself where a note can sit.
      expect(Math.abs(onset(audio.left) - expected)).toBeLessThan(0.001 * SR);
      if (tick % 240 === 0) expect(Math.abs(onset(audio.left) - onset(note.left))).toBeLessThan(0.001 * SR);
    }
  });

  it("does not swing a clip while a note on the same odd step is delayed", async () => {
    pcm.set("s1", { sampleRate: SR, channels: 2, data: new Float32Array(48000 * 2).fill(0.5) });
    const note = await mix(song({ swing: 0.5, notes: [{ step: 9, length: 1 }] }));
    const audio = await mix(song({ swing: 0.5, clips: [clip({ start_ticks: 9 * 240 })] }));
    expect(onset(audio.left)).toBeCloseTo(9 * 0.125 * SR, -1);
    expect(onset(note.left) - onset(audio.left)).toBeGreaterThan(0.05 * SR);
  });

  const echoes = {
    delay: { enabled: true, time: "1/8", feedback: 0.5, mix: 0.5 },
    reverb: { enabled: true, decay_s: 1.5, mix: 0.4 },
  };

  it("hears the reverb and delay tails, so the impulse response is awaited", async () => {
    const dry = await mix(song({ notes: [{ step: 4, length: 1 }] }));
    const wet = await mix(song({ notes: [{ step: 4, length: 1 }], effects: echoes }), {}, true);
    const energy = (a: Float32Array) => a.slice(Math.round(1.3 * SR), Math.round(2.5 * SR)).reduce((s, x) => s + x * x, 0);
    expect(energy(dry.left)).toBeLessThan(1e-3);
    expect(energy(wet.left)).toBeGreaterThan(0.05);
  });

  it("Segmented render differs from a whole render by less than -60 dB RMS, with delay and reverb tails across the joins", async () => {
    const spec = {
      measures: 4,
      notes: [
        { step: 14, length: 1 },
        { step: 30, length: 1 },
        { step: 33, length: 1 },
        { step: 47, length: 1 },
      ],
      effects: echoes,
    };
    const whole = await mix(song(spec), { segmentSeconds: 1000 }, true);
    // 2 s segments put several joins inside the audible tails.
    const parts = await mix(song(spec), { segmentSeconds: 2 }, true);
    expect(parts.left.length).toBe(whole.left.length);
    const diff = whole.left.map((x, i) => x - parts.left[i]);
    expect(rmsDb(diff, whole.left)).toBeLessThan(-60);
    // The tails are really there: the joins at 2, 4 and 6 s sit inside them.
    expect(Math.max(...whole.left.slice(Math.round(2.05 * SR), Math.round(2.4 * SR)).map(Math.abs))).toBeGreaterThan(0.01);
  });

  it("a render with no pre-roll is measurably different, so the check above can fail", async () => {
    const spec = { measures: 4, notes: [{ step: 14, length: 1 }, { step: 33, length: 1 }], effects: echoes };
    const whole = await mix(song(spec), { segmentSeconds: 1000 }, true);
    const parts = await mix(song(spec), { segmentSeconds: 2, preRollSeconds: 0 }, true);
    const diff = whole.left.map((x, i) => x - parts.left[i]);
    expect(rmsDb(diff, whole.left)).toBeGreaterThan(-60);
  });

  it("a held note spanning segment joins matches the whole render, with no restart at the join", async () => {
    // Notes beyond the 4 s pre-roll: a held sine restarted at a window's edge would be out of phase with the whole.
    const spec = { measures: 5, notes: [{ instrument: SINE, step: 4, length: 64 }] };
    const whole = await mix(song(spec), { segmentSeconds: 1000 });
    const parts = await mix(song(spec), { segmentSeconds: 2 });
    const diff = whole.left.map((x, i) => x - parts.left[i]);
    expect(rmsDb(diff, whole.left)).toBeLessThan(-60);
  });
});
