import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioClip } from "@/generated/AudioClip";
import { drums } from "@/test/fixtures";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { newTrack, type Song } from "@/lib/song/types";
import { isMixdownCancelled, renderMixdown } from "./mixdown";
import { registerSoundSource } from "./registry";

// jsdom has no Web Audio, so there is no real offline renderer here. The mock below stands in for
// Tone.Offline: it renders what the mixdown scheduled (note triggers and clip starts) as a signal that
// depends only on song time. That proves the mixdown's own work (which tracks, what is scheduled where,
// segment stitching, tail trimming, encoding) but not the DSP of effects or the browser's mixer.
const SR = 8000;

interface Hit {
  start: number;
  end: number;
  level: number;
}
interface Scene {
  channels: { volume: number }[];
  hits: Hit[];
  players: { gainDb: number; buffer: { data: Float32Array }; start: number; offset: number; duration: number; loop: boolean; loopStart: number; loopEnd: number }[];
}

const h = vi.hoisted(() => {
  const state = {
    scene: { channels: [], hits: [], players: [] } as Scene,
    offlineCalls: [] as { duration: number }[],
    // Decay of a note's tail, standing in for a delay or reverb that rings on after the note.
    tailSeconds: 0.4,
    onOffline: (() => {}) as () => void,
    // Stands in for Tone's global context, which a render swaps and must always put back.
    context: { sampleRate: 8000 } as unknown,
    channelOf: (() => null) as (node: unknown) => { volume: number } | null,
  };
  return { state };
});

vi.mock("tone", () => {
  const { state } = h;
  class MockNode {
    targets: unknown[] = [];
    connect(target: unknown) {
      this.targets.push(target);
      return this;
    }
    disconnect() {
      return this;
    }
    dispose() {}
  }
  // Follows connections to the track's channel, since the schedule runs after every channel exists and "the latest
  // channel" would be the wrong track's.
  const channelOf = (node: unknown, seen = new Set<unknown>()): { volume: number } | null => {
    if (seen.has(node)) return null;
    seen.add(node);
    if (node instanceof Channel) return { volume: node.opts.volume };
    for (const next of (node as MockNode).targets ?? []) {
      const found = channelOf(next, seen);
      if (found) return found;
    }
    return null;
  };
  state.channelOf = channelOf;
  const param = () => ({
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
  });
  class Gain extends MockNode {
    gain = param();
  }
  class Channel extends MockNode {
    constructor(public opts: { volume: number; pan: number }) {
      super();
      state.scene.channels.push({ volume: opts.volume });
    }
    toDestination() {
      return this;
    }
  }
  class Player extends MockNode {
    buffer: unknown = null;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    start(time: number, offset: number, duration: number) {
      state.scene.players.push({
        gainDb: channelOf(this)?.volume ?? 0,
        buffer: this.buffer as { data: Float32Array },
        start: time,
        offset,
        duration,
        loop: this.loop,
        loopStart: this.loopStart,
        loopEnd: this.loopEnd,
      });
    }
    stop() {}
  }
  const render = (frames: number) => {
    const out = [new Float32Array(frames), new Float32Array(frames)];
    const { hits, players } = state.scene;
    for (let n = 0; n < frames; n++) {
      const t = n / SR;
      let sum = 0;
      for (const hit of state.scene.hits) {
        if (t < hit.start) continue;
        sum += t < hit.end ? hit.level : hit.level * Math.exp(-(t - hit.end) / state.tailSeconds);
      }
      for (const p of players) {
        const into = t - p.start;
        if (into < 0 || into >= p.duration) continue;
        let frame = Math.floor((p.offset + into) * SR + 1e-6);
        if (p.loop) {
          const a = Math.round(p.loopStart * SR);
          const b = Math.round(p.loopEnd * SR);
          if (frame >= b) frame = a + ((frame - a) % (b - a));
        }
        sum += (p.buffer.data[frame] ?? 0) * 10 ** (p.gainDb / 20);
      }
      out[0][n] = sum;
      out[1][n] = sum;
    }
    void hits;
    return out;
  };
  return {
    getContext: () => state.context,
    setContext: (context: unknown) => {
      state.context = context as typeof state.context;
    },
    Gain,
    Channel,
    Player,
    OfflineContext: class {
      sampleRate = SR;
      constructor(_channels: number, public duration: number) {
        state.scene = { channels: [], hits: [], players: [] };
        state.offlineCalls.push({ duration });
      }
      async render() {
        state.onOffline();
        const data = render(Math.ceil(this.duration * SR));
        return { getChannelData: (c: number) => data[c] };
      }
    },
  };
});

const SYNTH = "mix-synth";
registerSoundSource(SYNTH, (_tone, output) => ({
  load: async () => {},
  trigger: (_row, start, end, velocity) => {
    const volume = h.state.channelOf(output)?.volume ?? 0;
    h.state.scene.hits.push({ start, end, level: (velocity / 127) * 10 ** (volume / 20) * 0.5 });
  },
  noteOn: () => ({}),
  noteOff: () => {},
  stopAll: () => {},
}));
const instruments = [{ ...drums, id: SYNTH }];

const buffers = (data: Float32Array) => ({
  load: async () => {},
  get: () => ({ data }) as never,
  acquire: () => {},
  release: () => {},
});

const loadTone = async () => (await import("tone")) as never;

// A constant sample, so any stretch of the mix that carries it is easy to find.
const SAMPLE_LEVEL = 0.25;
const sampleData = new Float32Array(SR * 4).fill(SAMPLE_LEVEL);

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: "c",
  sample_id: "s1",
  start_ticks: 0,
  offset_samples: 0,
  slice_samples: SR * 4,
  length_samples: SR * 2,
  loop: false,
  gain_db: 0,
  fade_in_samples: 0,
  fade_out_samples: 0,
  ...over,
});

// 4 steps per beat at 120 BPM makes a step 0.125 s and a measure 2 s.
function songWith(opts: { noteStep?: number; noteLength?: number; muteNotes?: boolean; measures?: number; clips?: AudioClip[] }): Song {
  const song = newSongWithTracks();
  song.measures = opts.measures ?? 2;
  song.samples = [{ id: "s1", name: "Loop", sample_rate: SR, channels: 1, length_samples: SR * 4, origin: "import" }];
  const notes = {
    ...newTrack(SYNTH, "Notes"),
    muted: opts.muteNotes ?? false,
    loops: [
      {
        id: "l",
        name: "L",
        measures: song.measures,
        notes: [{ row_id: "kick", step: opts.noteStep ?? 0, length_steps: opts.noteLength ?? 4, velocity: 127 }],
      },
    ],
    clips: [{ id: "k", loop_id: "l", start_measure: 1, measures: song.measures }],
  };
  const audio = { ...newTrack("audio", "Audio"), audio_clips: opts.clips ?? [clip({ start_ticks: 8 * 240 })] };
  song.tracks = [notes, audio];
  return song;
}

function read(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

// Left channel as floats, so a test reads levels rather than 16-bit integers.
async function decode(blob: Blob) {
  const buffer = await read(blob);
  const view = new DataView(buffer);
  const frames = (buffer.byteLength - 44) / 4;
  const left = new Float32Array(frames);
  for (let i = 0; i < frames; i++) left[i] = view.getInt16(44 + i * 4, true) / 32768;
  return { left, sampleRate: view.getUint32(24, true), channels: view.getUint16(22, true), bits: view.getUint16(34, true) };
}

const mean = (a: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) sum += a[i];
  return sum / ((to - from) * SR);
};

async function render(song: Song, options: { segmentSeconds?: number; preRollSeconds?: number } = {}, signal?: AbortSignal, onProgress: (fraction: number) => void = () => {}) {
  return renderMixdown(song, onProgress, signal, { instruments, loadTone, sampleBuffers: buffers(sampleData), ...options });
}

beforeEach(() => {
  h.state.offlineCalls = [];
  h.state.tailSeconds = 0.1;
  h.state.onOffline = () => {};
});

describe("renderMixdown", () => {
  it("Mixdown includes audio tracks: the file holds the notes and the clip", async () => {
    const { wav } = await render(songWith({}));
    const { left, sampleRate, channels, bits } = await decode(wav);
    expect({ sampleRate, channels, bits }).toEqual({ sampleRate: SR, channels: 2, bits: 16 });
    // The note (0 to 0.5 s) is at half scale, and the clip (1 to 3 s) carries the sample's level.
    expect(mean(left, 0.1, 0.4)).toBeCloseTo(0.5, 2);
    expect(mean(left, 1.5, 2.5)).toBeCloseTo(SAMPLE_LEVEL, 2);
    expect(mean(left, 3.2, 3.5)).toBeCloseTo(0, 2);
  });

  it("applies the track's volume to the clip", async () => {
    const song = songWith({});
    song.tracks[1].volume_db = -6;
    const { left } = await decode((await render(song)).wav);
    expect(mean(left, 1.5, 2.5)).toBeCloseTo(SAMPLE_LEVEL * 10 ** (-6 / 20), 2);
  });

  it("Muted track left out: the file has no notes from it", async () => {
    const { wav } = await render(songWith({ muteNotes: true }));
    const { left } = await decode(wav);
    expect(mean(left, 0.1, 0.4)).toBeCloseTo(0, 3);
    expect(mean(left, 1.5, 2.5)).toBeCloseTo(SAMPLE_LEVEL, 2);
  });

  it("leaves out a track that solo silences", async () => {
    const song = songWith({});
    song.tracks[1].soloed = true;
    const { left } = await decode((await render(song)).wav);
    expect(mean(left, 0.1, 0.4)).toBeCloseTo(0, 3);
    expect(mean(left, 1.5, 2.5)).toBeCloseTo(SAMPLE_LEVEL, 2);
  });

  it("Cancel: stops between segments and produces no file", async () => {
    const controller = new AbortController();
    const progress: number[] = [];
    const run = render(
      songWith({ measures: 3 }),
      { segmentSeconds: 2 },
      controller.signal,
      (fraction) => {
        progress.push(fraction);
        if (fraction > 0) controller.abort();
      },
    );
    await expect(run).rejects.toSatisfy(isMixdownCancelled);
    expect(h.state.offlineCalls).toHaveLength(1);
  });

  it("Cancel: renders nothing when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(render(songWith({}), {}, controller.signal)).rejects.toSatisfy(isMixdownCancelled);
    expect(h.state.offlineCalls).toHaveLength(0);
  });

  it("reports progress rising to 1 across segments", async () => {
    const progress: number[] = [];
    await render(songWith({ measures: 3 }), { segmentSeconds: 2 }, undefined, (f) => progress.push(f));
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.length).toBeGreaterThan(3);
  });

  it("renders from a snapshot, so edits after the call starts are not in the file", async () => {
    const song = songWith({});
    h.state.onOffline = () => {
      song.tracks[0].muted = true;
      song.tracks[1].volume_db = -60;
    };
    const { left } = await decode((await render(song, { segmentSeconds: 2 })).wav);
    expect(mean(left, 0.1, 0.4)).toBeCloseTo(0.5, 2);
    expect(mean(left, 1.5, 2.5)).toBeCloseTo(SAMPLE_LEVEL, 2);
  });

  it("trims the tail below -60 dBFS but never cuts into the song", async () => {
    h.state.tailSeconds = 0.4;
    const { seconds } = await render(songWith({ noteStep: 28, noteLength: 4 }));
    // The song is 4 s; a 0.4 s tail from half scale falls below 0.001 after about 2.5 s, well inside the 4 s allowed.
    expect(seconds).toBeGreaterThan(4);
    expect(seconds).toBeLessThan(8);
    const short = await render(songWith({ clips: [], noteStep: 0, noteLength: 1 }));
    expect(short.seconds).toBeGreaterThanOrEqual(4);
  });

  it("warns when the mix reaches full scale, and not otherwise", async () => {
    expect((await render(songWith({}))).clipped).toBe(false);
    const loud = songWith({ clips: [clip({ start_ticks: 0, gain_db: 12 })] });
    // The note's 0.5 and the clip's 0.25 at +12 dB (about 1.0) together exceed full scale.
    loud.tracks[0].volume_db = 6;
    expect((await render(loud)).clipped).toBe(true);
  });

  it("starts a clip that began before a later segment partway through", async () => {
    // A 3 s clip from 1 s runs across the 2 s segment boundary, and the second segment must pick it up mid-sample.
    const song = songWith({ clips: [clip({ start_ticks: 8 * 240, length_samples: SR * 3 })], muteNotes: true, measures: 3 });
    const { left } = await decode((await render(song, { segmentSeconds: 2 })).wav);
    expect(mean(left, 1.1, 1.9)).toBeCloseTo(SAMPLE_LEVEL, 2);
    expect(mean(left, 2.1, 3.9)).toBeCloseTo(SAMPLE_LEVEL, 2);
    expect(mean(left, 4.2, 4.8)).toBeCloseTo(0, 2);
  });

  describe("segmented against whole", () => {
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

    it("differs from a single render by less than -60 dB RMS", async () => {
      // Notes across several segments, one long enough to span a boundary, plus a clip across another.
      const song = songWith({ measures: 6, noteStep: 20, noteLength: 40, clips: [clip({ start_ticks: 30 * 240, length_samples: SR * 4 })] });
      const whole = await decode((await render(song, { segmentSeconds: 1000 })).wav);
      const parts = await decode((await render(song, { segmentSeconds: 2 })).wav);
      const length = Math.min(whole.left.length, parts.left.length);
      const diff = new Float32Array(length);
      for (let i = 0; i < length; i++) diff[i] = whole.left[i] - parts.left[i];
      expect(whole.left.length).toBe(parts.left.length);
      expect(20 * Math.log10(rms(diff) / rms(whole.left.subarray(0, length)) || 1e-9)).toBeLessThan(-60);
    });

    it("would notice a tail cut off, since without pre-roll it is no longer below -60 dB", async () => {
      h.state.tailSeconds = 1.5;
      const song = songWith({ measures: 6, noteStep: 12, noteLength: 2, clips: [] });
      const whole = await decode((await render(song, { segmentSeconds: 1000 })).wav);
      const parts = await decode((await render(song, { segmentSeconds: 2, preRollSeconds: 0 })).wav);
      const length = Math.min(whole.left.length, parts.left.length);
      const diff = new Float32Array(length);
      for (let i = 0; i < length; i++) diff[i] = whole.left[i] - parts.left[i];
      expect(20 * Math.log10(rms(diff) / rms(whole.left.subarray(0, length)))).toBeGreaterThan(-60);
    });
  });
});
