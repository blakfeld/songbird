import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import type { Pattern } from "@/generated/Pattern";
import type { PlaybackModel, Voice } from "./types";
import { createPatternStore } from "@/lib/patternStore";
import { createSongStore } from "@/lib/song/songStore";
import { newTrack } from "@/lib/song/types";
import { drums } from "@/test/fixtures";
import { stepToSeconds } from "@/lib/timing";
import { createPlaybackEngine } from "./engine";
import { createPatternPlaybackModel } from "./patternPlaybackModel";
import { createSongPlaybackModel } from "./songPlaybackModel";
import { registerSoundSource } from "./registry";

type MockParam = { ramps: [number, number][]; rampTo(v: number, t: number): void };
type MockChannel = {
  opts: { volume: number; pan: number };
  volume: MockParam;
  pan: MockParam;
  toDestinationCalls: number;
  disposed: boolean;
};

const h = vi.hoisted(() => {
  type Ev = { time: number; cb: (t: number) => void };
  type GainNode = { value: number };
  const state = {
    events: [] as Ev[],
    seconds: 0,
    started: 0,
    startCalls: 0,
    hits: [] as { note: string; time: number; gain: GainNode }[],
    gains: [] as GainNode[],
    stopped: 0,
    kitLoads: [] as Record<string, string>[],
    channels: [] as MockChannel[],
    now: 0,
    outputLatency: 0,
    baseLatency: 0,
    clicks: [] as { time: number; hz: number }[],
    contextState: "suspended",
  };
  return { state };
});

vi.mock("tone", () => {
  const { state } = h;
  const transport = {
    get seconds() {
      return state.seconds;
    },
    set seconds(v: number) {
      state.seconds = v;
    },
    scheduleOnce(cb: (t: number) => void, time: number) {
      state.events.push({ time, cb });
    },
    // Shifted by the audio time's distance from the clock so stepAt's latency maths is observable.
    getSecondsAtTime(t: number = state.now) {
      return state.seconds + (t - state.now);
    },
    start() {
      state.started += 1;
    },
    stop() {},
    cancel() {
      state.events = [];
    },
  };
  class ToneAudioBuffers {
    private urls: Record<string, string>;
    constructor(opts: { urls: Record<string, string> }) {
      this.urls = opts.urls;
      state.kitLoads.push(opts.urls);
    }
    has(k: string) {
      return k in this.urls;
    }
    get(k: string) {
      return { name: k };
    }
  }
  class Gain {
    node: { value: number };
    constructor(value: number) {
      this.node = { value };
      state.gains.push(this.node);
    }
    toDestination() {
      return this;
    }
    connect() {
      return this;
    }
    dispose() {}
  }
  const param = (): MockParam => {
    const p: MockParam = {
      ramps: [],
      rampTo(v, t) {
        p.ramps.push([v, t]);
      },
    };
    return p;
  };
  class Channel implements MockChannel {
    volume = param();
    pan = param();
      toDestinationCalls = 0;
    disposed = false;
    constructor(public opts: MockChannel["opts"]) {
      state.channels.push(this);
    }
    toDestination() {
      this.toDestinationCalls += 1;
      return this;
    }
    dispose() {
      this.disposed = true;
    }
  }
  class ToneBufferSource {
    private gain: Gain | null = null;
    constructor(private opts: { url: { name: string } }) {}
    connect(g: Gain) {
      this.gain = g;
      return this;
    }
    start(time: number) {
      state.hits.push({
        note: this.opts.url.name,
        time,
        gain: this.gain!.node,
      });
    }
    stop() {
      state.stopped += 1;
    }
    dispose() {}
  }
  class Synth {
    toDestination() {
      return this;
    }
    triggerAttackRelease(hz: number, _d: number, time: number) {
      state.clicks.push({ time, hz });
    }
    dispose() {}
  }
  return {
    Synth,
    start: async () => {
      state.startCalls += 1;
      state.contextState = "running";
    },
    loaded: async () => {},
    getContext: () => ({
      state: state.contextState,
      currentTime: state.now,
      rawContext: {
        outputLatency: state.outputLatency,
        baseLatency: state.baseLatency,
      },
    }),
    getTransport: () => transport,
    ToneAudioBuffers,
    Gain,
    Channel,
    ToneBufferSource,
  };
});

// Audio time is offset from transport time so the tests prove the engine
// forwards the callback's audio time rather than its own transport time.
const AUDIO_OFFSET = 100;

function advanceTo(t: number) {
  for (;;) {
    const due = h.state.events
      .filter((e) => e.time <= t)
      .sort((a, b) => a.time - b.time)[0];
    if (!due) break;
    h.state.events.splice(h.state.events.indexOf(due), 1);
    h.state.seconds = due.time;
    due.cb(due.time + AUDIO_OFFSET);
  }
  h.state.seconds = t;
}

const ROWS = [
  { id: "kick", name: "Kick", midi_note: 36 },
  { id: "snare", name: "Snare", midi_note: 38 },
];

function makePattern(over: Partial<Pattern> = {}): Pattern {
  return {
    version: 1,
    instrument: "drums",
    name: "t",
    tempo_bpm: 120,
    time_signature: "4/4",
    measures: 4,
    steps_per_measure: 16,
    swing: 0,
    midi_channel: 10,
    rows: ROWS,
    notes: [],
    ...over,
  } as Pattern;
}

function setup(pattern: Pattern) {
  const store = createPatternStore("drums-test");
  store.getState().setPattern(pattern);
  const engine = createPlaybackEngine(createPatternPlaybackModel("drums", store), {
    requestFrame: () => 0,
    cancelFrame: () => {},
  });
  return { store, engine };
}

async function start(engine: ReturnType<typeof createPlaybackEngine>) {
  engine.toggle();
  await vi.waitFor(() => expect(engine.isPlaying).toBe(true));
}

beforeEach(() => {
  localStorage.clear();
  Object.assign(h.state, {
    events: [],
    seconds: 0,
    started: 0,
    startCalls: 0,
    hits: [],
    gains: [],
    stopped: 0,
    kitLoads: [],
    channels: [],
    now: 0,
    outputLatency: 0,
    baseLatency: 0,
    clicks: [],
    contextState: "suspended",
  });
});

describe("playback engine", () => {
  it("schedules notes at stepToSeconds including swing", async () => {
    const notes = [1, 2, 3, 7].map((step) => ({
      row_id: "kick",
      step,
      length_steps: 1,
      velocity: 127,
    }));
    const { engine } = setup(makePattern({ swing: 0.5, notes }));
    await start(engine);
    advanceTo(0);
    advanceTo(1.9);

    expect(h.state.hits.map((x) => x.time)).toEqual(
      notes.map((n) => stepToSeconds(n.step, 120, 0.5) + AUDIO_OFFSET),
    );
  });

  it("loads the kit keyed by each row's midi note", async () => {
    const { engine } = setup(makePattern());
    await start(engine);
    expect(h.state.kitLoads[0]).toEqual({ "36": "36.wav", "38": "38.wav" });
  });

  it("scales gain with velocity", async () => {
    const { engine } = setup(
      makePattern({
        notes: [
          { row_id: "kick", step: 0, length_steps: 1, velocity: 127 },
          { row_id: "kick", step: 1, length_steps: 1, velocity: 64 },
        ],
      }),
    );
    await start(engine);
    advanceTo(1);
    const [loud, soft] = h.state.hits;
    // Read after both hits so a gain node shared between hits would fail.
    expect(loud.gain.value).toBeCloseTo(1);
    expect(soft.gain.value).toBeCloseTo(64 / 127);
    expect(loud.gain).not.toBe(soft.gain);
  });

  it("plays a drum note identically regardless of length_steps", async () => {
    const times: number[][] = [];
    for (const length_steps of [1, 4]) {
      h.state.hits = [];
      const { engine } = setup(
        makePattern({
          notes: [{ row_id: "snare", step: 4, length_steps, velocity: 100 }],
        }),
      );
      await start(engine);
      advanceTo(1);
      times.push(h.state.hits.map((x) => x.time));
      engine.stop();
    }
    expect(times[0]).toHaveLength(1);
    expect(times[0]).toEqual(times[1]);
  });

  it("picks up store edits on the next pass", async () => {
    const { engine, store } = setup(makePattern());
    engine.setLoop({ start: 1, end: 1 });
    await start(engine);
    advanceTo(1.5);
    expect(h.state.hits).toHaveLength(0);

    store.getState().toggleNote("kick", 0);
    advanceTo(2.1);
    expect(h.state.hits.map((x) => x.time)).toEqual([2 + AUDIO_OFFSET]);
  });

  it("loops the full pattern back to measure 1", async () => {
    const { engine } = setup(
      makePattern({
        notes: [
          { row_id: "kick", step: 0, length_steps: 1, velocity: 100 },
          { row_id: "snare", step: 16, length_steps: 1, velocity: 100 },
        ],
      }),
    );
    engine.setLoop({ start: 1, end: 2 });
    await start(engine);
    advanceTo(6.1);
    expect(h.state.hits.map((x) => [x.note, x.time - AUDIO_OFFSET])).toEqual([
      ["36", 0],
      ["38", 2],
      ["36", 4],
      ["38", 6],
    ]);
  });

  it("loops only the selected measure range", async () => {
    const notes = [0, 1, 2, 3].map((m) => ({
      row_id: "kick",
      step: m * 16,
      length_steps: 1,
      velocity: 100 + m,
    }));
    const { engine } = setup(makePattern({ measures: 4, notes }));
    engine.setLoop({ start: 2, end: 3 });
    await start(engine);
    advanceTo(7.8);
    // Per-measure velocities identify which measure each hit came from.
    expect(h.state.hits.map((x) => Math.round(x.gain.value * 127))).toEqual([
      101, 102, 101, 102,
    ]);
  });

  it("reports absolute step positions inside the loop range", async () => {
    const seen: (number | null)[] = [];
    let frame: (() => void) | undefined;
    const store = createPatternStore("drums-pos");
    store.getState().setPattern(makePattern({ measures: 4 }));
    const e2 = createPlaybackEngine(createPatternPlaybackModel("drums", store), {
      requestFrame: (cb) => {
        frame = cb;
        return 1;
      },
      cancelFrame: () => {},
    });
    e2.setLoop({ start: 3, end: 4 });
    e2.subscribePosition((s) => seen.push(s));
    await start(e2);
    advanceTo(0);
    advanceTo(1);
    frame?.();
    advanceTo(2.5);
    frame?.();
    e2.stop();
    expect(seen).toEqual([40, 48 + 4, null]);
  });

  it("stop silences and resets state", async () => {
    const stopAll = vi.fn();
    registerSoundSource("spy", () => ({
      load: async () => {},
      trigger: () => {},
      noteOn: () => ({}),
      noteOff: () => {},
      stopAll,
    }));
    const store = createPatternStore("spy-test");
    store.getState().setPattern(makePattern({ instrument: "spy" }));
    const engine = createPlaybackEngine(createPatternPlaybackModel("spy", store), {
      requestFrame: () => 0,
      cancelFrame: () => {},
    });
    await start(engine);
    engine.stop();
    expect(stopAll).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);
    expect(engine.status).toBe("idle");
    expect(h.state.events).toHaveLength(0);
  });

  it("does not refetch the kit on a second play", async () => {
    const { engine } = setup(makePattern());
    await start(engine);
    engine.stop();
    await start(engine);
    expect(h.state.kitLoads).toHaveLength(1);
  });

  it("reuses a preloaded kit and starts audio synchronously in toggle", async () => {
    const { engine } = setup(makePattern());
    await engine.preload();
    expect(h.state.kitLoads).toHaveLength(1);
    expect(h.state.startCalls).toBe(0);
    engine.toggle();
    expect(h.state.startCalls).toBe(1);
    await vi.waitFor(() => expect(engine.isPlaying).toBe(true));
    expect(h.state.kitLoads).toHaveLength(1);
  });

  it("hears a note added later in the bar that is currently playing", async () => {
    const { engine, store } = setup(makePattern());
    engine.setLoop({ start: 1, end: 1 });
    await start(engine);
    advanceTo(0.3);
    store.getState().toggleNote("kick", 4);
    advanceTo(0.6);
    expect(h.state.hits.map((x) => x.time - AUDIO_OFFSET)).toEqual([0.5]);
  });

  it("realigns to the new loop range when it changes mid-play", async () => {
    const notes = [0, 1, 2, 3].map((m) => ({
      row_id: "kick",
      step: m * 16,
      length_steps: 1,
      velocity: 100 + m,
    }));
    const { engine } = setup(makePattern({ notes }));
    await start(engine);
    advanceTo(0.5);
    engine.setLoop({ start: 3, end: 4 });
    advanceTo(5.95);
    const measures = h.state.hits.map((x) => Math.round(x.gain.value * 127) - 100);
    // Measure 1 was already playing; the next bar must jump into 3..4.
    expect(measures).toEqual([0, 2, 3, 2]);
  });

  it("does not accumulate scheduled events over a long run", async () => {
    const { engine } = setup(makePattern());
    await start(engine);
    advanceTo(120);
    expect(h.state.events.length).toBeLessThan(5);
  });
});

describe("audition", () => {
  it("triggers one half-second note at velocity 100 without touching the store", async () => {
    const trigger = vi.fn();
    const load = vi.fn(async () => {});
    registerSoundSource("audition-test", () => ({ load, trigger, noteOn: () => ({}), noteOff: () => {}, stopAll: () => {} }));
    const store = createPatternStore("audition-test");
    const before = store.getState();
    const engine = createPlaybackEngine(
      createPatternPlaybackModel("audition-test", store),
    );

    await engine.audition(ROWS[0]);

    expect(load).toHaveBeenCalledWith([ROWS[0]]);
    expect(trigger).toHaveBeenCalledTimes(1);
    const [row, start, end, velocity] = trigger.mock.calls[0];
    expect(row).toBe(ROWS[0]);
    expect(start).toBeCloseTo(0.01);
    expect(end - start).toBeCloseTo(0.5);
    expect(velocity).toBe(100);
    expect(h.state.startCalls).toBe(1);
    expect(store.getState()).toBe(before);
  });
});

describe("multi-voice playback", () => {
  type Hit = { id: string; time: number; velocity: number };
  const hits: Hit[] = [];
  const outputs: Record<string, unknown> = {};

  for (const id of ["mv-a", "mv-b"]) {
    registerSoundSource(id, (_tone, output) => {
      outputs[id] = output;
      return {
        load: async () => {},
        trigger: (_row, time, _end, velocity) => hits.push({ id, time, velocity }),
        noteOn: () => ({}),
        noteOff: () => {},
        stopAll: () => {},
      };
    });
  }

  const note = (step: number, velocity = 100) => ({
    row_id: "kick",
    step,
    length_steps: 1,
    velocity,
  });

  const voice = (key: string, over: Partial<Voice> = {}): Voice => ({
    key,
    instrument: key,
    rows: ROWS,
    notes: [note(0)],
    volumeDb: 0,
    pan: 0,
    audible: true,
    ...over,
  });

  function setupVoices(initial: Voice[], instrument?: string) {
    let voices = initial;
    const model: PlaybackModel = {
      instrument,
      getTiming: () => ({ tempo: 120, swing: 0, stepsPerMeasure: 16, measures: 1 }),
      getVoices: () => voices,
    };
    const engine = createPlaybackEngine(model, {
      requestFrame: () => 0,
      cancelFrame: () => {},
    });
    return { engine, setVoices: (v: Voice[]) => (voices = v) };
  }

  beforeEach(() => {
    hits.length = 0;
    for (const k of Object.keys(outputs)) delete outputs[k];
  });

  it("triggers two voices that start on the same step, each through its own channel", async () => {
    const { engine } = setupVoices([voice("mv-a"), voice("mv-b")]);
    await start(engine);
    advanceTo(0);

    expect(hits.map((x) => [x.id, x.time])).toEqual([
      ["mv-a", AUDIO_OFFSET],
      ["mv-b", AUDIO_OFFSET],
    ]);
    expect(h.state.channels).toHaveLength(2);
    expect(h.state.channels.every((c) => c.toDestinationCalls === 1)).toBe(true);
    expect(outputs["mv-a"]).toBe(h.state.channels[0]);
    expect(outputs["mv-b"]).toBe(h.state.channels[1]);
  });

  it("silences the other voices when the audible set changes to a solo", async () => {
    const { engine, setVoices } = setupVoices([
      voice("mv-a", { notes: [note(0), note(4)] }),
      voice("mv-b", { notes: [note(0), note(4)] }),
    ]);
    await start(engine);
    advanceTo(0.1);
    expect(hits.map((x) => x.id)).toEqual(["mv-a", "mv-b"]);

    setVoices([
      voice("mv-a", { notes: [note(0), note(4)], audible: false }),
      voice("mv-b", { notes: [note(0), note(4)] }),
    ]);
    advanceTo(0.6);

    expect(hits.map((x) => x.id)).toEqual(["mv-a", "mv-b", "mv-b"]);
    const [a, b] = h.state.channels;
    expect(a.volume.ramps).toEqual([[-100, 0.02]]);
    expect(b.volume.ramps).toEqual([]);

    setVoices([
      voice("mv-a", { notes: [note(0), note(4)] }),
      voice("mv-b", { notes: [note(0), note(4)] }),
    ]);
    advanceTo(0.7);
    expect(a.volume.ramps).toEqual([
      [-100, 0.02],
      [0, 0.02],
    ]);
  });

  it("ramps a voice to pan -1 on its channel", async () => {
    const { engine, setVoices } = setupVoices([voice("mv-a")]);
    await start(engine);
    advanceTo(0.1);
    setVoices([voice("mv-a", { pan: -1 })]);
    advanceTo(0.2);

    expect(h.state.channels[0].pan.ramps).toEqual([[-1, 0.02]]);
  });

  it("applies a volume change without restarting the transport", async () => {
    const { engine, setVoices } = setupVoices([voice("mv-a")]);
    await start(engine);
    advanceTo(0.1);
    const startsBefore = h.state.started;
    setVoices([voice("mv-a", { volumeDb: -12 })]);
    advanceTo(0.2);

    expect(h.state.channels[0].volume.ramps).toEqual([[-12, 0.02]]);
    expect(h.state.started).toBe(startsBefore);
    expect(engine.isPlaying).toBe(true);
    expect(h.state.channels).toHaveLength(1);
  });

  it("creates the channel with the voice's initial mixer values", async () => {
    const { engine } = setupVoices([voice("mv-a", { volumeDb: -6, pan: 0.5 })]);
    await start(engine);
    expect(h.state.channels[0].opts).toEqual({ volume: -6, pan: 0.5 });
  });

  it("fades out and then disposes the channel of a voice that disappears", async () => {
    vi.useFakeTimers();
    try {
      const { engine, setVoices } = setupVoices([voice("mv-a")]);
      await start(engine);
      advanceTo(0.1);
      setVoices([voice("mv-b")]);
      advanceTo(0.2);

      // Fading first avoids a click from cutting a channel that is still sounding.
      expect(h.state.channels[0].volume.ramps.at(-1)?.[0]).toBe(-100);
      expect(h.state.channels[0].disposed).toBe(false);
      vi.advanceTimersByTime(500);
      expect(h.state.channels[0].disposed).toBe(true);
      expect(h.state.channels[1].disposed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("previews a muted voice audibly, through its own volume and pan", async () => {
    const { engine } = setupVoices([voice("mv-a", { audible: false, volumeDb: -6, pan: -1 })]);
    await engine.audition(ROWS[0], { voiceKey: "mv-a", velocity: 90 });

    expect(hits).toEqual([{ id: "mv-a", time: expect.closeTo(0.01), velocity: 90 }]);
    expect(h.state.channels[0].opts).toEqual({ volume: -6, pan: -1 });
  });

  it("keeps a preview at its own volume while the scheduler holds the muted voice silent", async () => {
    const { engine } = setupVoices([voice("mv-a", { audible: false, volumeDb: -6, notes: [] })]);
    await start(engine);
    await engine.audition(ROWS[0], { voiceKey: "mv-a" });
    advanceTo(0.1);

    const [scheduled, preview] = h.state.channels;
    expect(scheduled.opts.volume).toBe(-100);
    expect(preview.opts.volume).toBe(-6);
    expect(preview.volume.ramps).toEqual([]);
  });

  it("auditions a specific voice through its channel at the given velocity", async () => {
    const { engine } = setupVoices([voice("mv-a"), voice("mv-b")]);
    await engine.audition(ROWS[0], { voiceKey: "mv-b", velocity: 42 });

    expect(hits).toEqual([{ id: "mv-b", time: expect.closeTo(0.01), velocity: 42 }]);
    expect(h.state.channels).toHaveLength(1);
    expect(outputs["mv-b"]).toBe(h.state.channels[0]);
    expect(outputs["mv-a"]).toBeUndefined();
  });
});

describe("clip playback", () => {
  const times: number[] = [];
  registerSoundSource("clip-test", () => ({
    load: async () => {},
    trigger: (_row, time) => times.push(time - AUDIO_OFFSET),
    noteOn: () => ({}),
    noteOff: () => {},
    stopAll: () => {},
  }));

  function setupClips() {
    const song = newSongWithTracks();
    song.measures = 8;
    song.tracks = [
      {
        ...song.tracks[0],
        instrument: "clip-test",
        loops: [{ id: "l", name: "L", measures: 2, notes: [{ row_id: "kick", step: 0, length_steps: 1, velocity: 100 }] }],
        clips: [{ id: "c", loop_id: "l", start_measure: 3, measures: 6 }],
      },
    ];
    song.measures = 8;
    const store = createSongStore(song);
    const engine = createPlaybackEngine(createSongPlaybackModel(store, [{ ...drums, id: "clip-test" }]), {
      requestFrame: () => 0,
      cancelFrame: () => {},
    });
    return { store, engine };
  }

  beforeEach(() => {
    times.length = 0;
  });

  it("triggers a repeated loop on the first step of measures 3, 5 and 7 only", async () => {
    const { engine } = setupClips();
    await start(engine);
    advanceTo(15.9);
    // A measure lasts 2 s at 120 BPM in 4/4.
    expect(times).toEqual([4, 8, 12]);
  });

  it("hears a loop edit at the next matching step in every clip", async () => {
    const { engine, store } = setupClips();
    const trackId = store.getState().song!.tracks[0].id;
    store.getState().placeLoop(trackId, "l", 1, 2);
    await start(engine);
    advanceTo(0.1);
    expect(times).toEqual([0]);
    store.getState().editLoopNotes(trackId, "l", drums.rows, (g) => [
      ...g.notes,
      { row_id: "kick", step: 8, length_steps: 1, velocity: 100 },
    ]);
    advanceTo(15.9);
    // The added note is half a measure (1 s) into each repeat of the loop, in the clip at measure 1 and the one at 3-8.
    expect(times).toEqual([0, 1, 4, 5, 8, 9, 12, 13]);
  });

  it("starts at a seeked measure and then follows the loop range", async () => {
    const { engine } = setupClips();
    // A seek only chooses the start while looping is off.
    engine.setLooping(false);
    engine.seek?.(5);
    await start(engine);
    advanceTo(4.1);
    // Measure 5 plays first, then 6 and 7, so the next kick lands two measures later.
    expect(times).toEqual([0, 4]);
  });

  it("plays 16 tracks across 128 measures on the grid without drift or piling up events", async () => {
    const song = newSongWithTracks();
    song.measures = 128;
    song.tracks = Array.from({ length: 16 }, (_, i) => ({
      ...newTrack("clip-test", `T${i}`),
      loops: [{ id: `l${i}`, name: "L", measures: 1, notes: [{ row_id: "kick", step: 0, length_steps: 1, velocity: 100 }] }],
      clips: [{ id: `c${i}`, loop_id: `l${i}`, start_measure: 1, measures: 128 }],
    }));
    const store = createSongStore(song);
    const model = createSongPlaybackModel(store, [{ ...drums, id: "clip-test" }]);
    const first = model.getVoices()[0].notes;
    expect(model.getVoices()[0].notes).toBe(first);
    const engine = createPlaybackEngine(model, { requestFrame: () => 0, cancelFrame: () => {} });
    await start(engine);
    advanceTo(255.9);
    expect(times).toHaveLength(16 * 128);
    expect(times.every((t) => Math.abs(t / 2 - Math.round(t / 2)) < 1e-9)).toBe(true);
    expect(h.state.events.length).toBeLessThan(5);
  });
});

describe("play-once ending", () => {
  const perMeasure = (measures: number) =>
    Array.from({ length: measures }, (_, m) => ({
      row_id: "kick",
      step: m * 16,
      length_steps: 1,
      velocity: 100 + m,
    }));
  const measuresHeard = () =>
    h.state.hits.map((x) => Math.round(x.gain.value * 127) - 100 + 1);

  it("plays every measure once and stops by itself when looping is off", async () => {
    const { engine } = setup(makePattern({ notes: perMeasure(4) }));
    engine.setLooping(false);
    await start(engine);
    advanceTo(7.9);
    expect(engine.isPlaying).toBe(true);
    advanceTo(9);
    await vi.waitFor(() => expect(engine.isPlaying).toBe(false));
    expect(measuresHeard()).toEqual([1, 2, 3, 4]);
    expect(engine.status).toBe("idle");
  });

  it("loops the whole pattern when looping is on with no range", async () => {
    const { engine } = setup(makePattern({ notes: perMeasure(4) }));
    engine.setLoop(null);
    engine.setLooping(true);
    await start(engine);
    advanceTo(9.9);
    expect(measuresHeard()).toEqual([1, 2, 3, 4, 1]);
    expect(engine.isPlaying).toBe(true);
  });

  it("resets the position when it stops by itself", async () => {
    const seen: (number | null)[] = [];
    let frame: (() => void) | undefined;
    const store = createPatternStore("drums-pos-end");
    store.getState().setPattern(makePattern());
    const engine = createPlaybackEngine(createPatternPlaybackModel("drums", store), {
      requestFrame: (cb) => {
        frame = cb;
        return 1;
      },
      cancelFrame: () => {},
    });
    engine.subscribePosition((s) => seen.push(s));
    engine.setLooping(false);
    await start(engine);
    advanceTo(1);
    frame?.();
    advanceTo(9);
    await vi.waitFor(() => expect(engine.isPlaying).toBe(false));
    expect(seen.at(-1)).toBeNull();
    expect(seen.length).toBeGreaterThan(1);
  });

  it("lets the last note sound for its full length before stopping", async () => {
    const stops: number[] = [];
    const ends: number[] = [];
    registerSoundSource("ring", () => ({
      load: async () => {},
      trigger: (_row, _start, end) => ends.push(end),
      noteOn: () => ({}),
      noteOff: () => {},
      stopAll: () => stops.push(h.state.seconds),
    }));
    const store = createPatternStore("ring-test");
    store.getState().setPattern(
      makePattern({
        instrument: "ring",
        notes: [{ row_id: "kick", step: 56, length_steps: 8, velocity: 100 }],
      }),
    );
    const engine = createPlaybackEngine(createPatternPlaybackModel("ring", store), {
      requestFrame: () => 0,
      cancelFrame: () => {},
    });
    engine.setLooping(false);
    await start(engine);
    advanceTo(7.95);
    const stopsBeforeEnd = stops.length;
    expect(engine.isPlaying).toBe(true);
    advanceTo(9);
    await vi.waitFor(() => expect(engine.isPlaying).toBe(false));
    // The note was triggered at 7 s and lasts 1 s, so nothing may be cut before 8 s.
    expect(ends[0] - AUDIO_OFFSET).toBeCloseTo(8);
    expect(stops.slice(stopsBeforeEnd).every((t) => t >= 8)).toBe(true);
  });

  it("continues to the end when looping is turned off mid-play", async () => {
    const { engine } = setup(makePattern({ measures: 16, notes: perMeasure(16) }));
    engine.setLoop({ start: 5, end: 8 });
    await start(engine);
    advanceTo(2.5);
    engine.setLooping(false);
    advanceTo(200);
    await vi.waitFor(() => expect(engine.isPlaying).toBe(false));
    expect(measuresHeard()).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("returns to the region when looping is turned on outside it", async () => {
    const { engine } = setup(makePattern({ measures: 16, notes: perMeasure(16) }));
    engine.setLoop({ start: 5, end: 8 });
    engine.setLooping(false);
    await start(engine);
    advanceTo(22.5);
    engine.setLooping(true);
    advanceTo(33.9);
    expect(measuresHeard()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 5, 6, 7, 8, 5]);
    expect(engine.isPlaying).toBe(true);
  });

  it("starts at a seeked measure when looping is off", async () => {
    const { engine } = setup(makePattern({ notes: perMeasure(4) }));
    engine.setLooping(false);
    engine.seek?.(3);
    await start(engine);
    advanceTo(9);
    await vi.waitFor(() => expect(engine.isPlaying).toBe(false));
    expect(measuresHeard()).toEqual([3, 4]);
  });

  it("starts at the region rather than a seeked measure when looping is on", async () => {
    const { engine } = setup(makePattern({ notes: perMeasure(4) }));
    engine.setLoop({ start: 2, end: 3 });
    engine.seek?.(4);
    await start(engine);
    advanceTo(0.1);
    expect(measuresHeard()).toEqual([2]);
  });

  it("does nothing further when stopped before the finish timer fires", async () => {
    const { engine } = setup(makePattern({ notes: perMeasure(4) }));
    engine.setLooping(false);
    await start(engine);
    advanceTo(8.05);
    engine.stop();
    const heard = measuresHeard().length;
    advanceTo(12);
    expect(engine.isPlaying).toBe(false);
    expect(measuresHeard()).toHaveLength(heard);
    expect(h.state.events).toHaveLength(0);
  });

  it("plays again right after an automatic stop", async () => {
    const { engine } = setup(makePattern({ notes: perMeasure(4) }));
    engine.setLooping(false);
    await start(engine);
    advanceTo(9);
    await vi.waitFor(() => expect(engine.isPlaying).toBe(false));

    h.state.hits = [];
    await start(engine);
    advanceTo(3);
    expect(engine.isPlaying).toBe(true);
    expect(measuresHeard()).toEqual([1, 2]);
  });

  it("does not silence triggered sources on the natural end, but does on a user Stop", async () => {
    const stopAll = vi.fn();
    registerSoundSource("crash", () => ({
      load: async () => {},
      trigger: () => {},
      noteOn: () => ({}),
      noteOff: () => {},
      stopAll,
    }));
    const store = createPatternStore("crash-test");
    store.getState().setPattern(makePattern({ instrument: "crash" }));
    const engine = createPlaybackEngine(createPatternPlaybackModel("crash", store), {
      requestFrame: () => 0,
      cancelFrame: () => {},
    });
    engine.setLooping(false);
    await start(engine);
    advanceTo(9);
    await vi.waitFor(() => expect(engine.isPlaying).toBe(false));
    expect(stopAll).not.toHaveBeenCalled();

    await start(engine);
    engine.stop();
    expect(stopAll).toHaveBeenCalled();
  });

  it("starts at measure 1 when looping is turned off after a seek made with looping on", async () => {
    const { engine } = setup(makePattern({ notes: perMeasure(4) }));
    engine.setLoop({ start: 1, end: 4 });
    engine.seek?.(3);
    engine.setLooping(false);
    await start(engine);
    advanceTo(1);
    expect(measuresHeard()).toEqual([1]);
  });
});

describe("live notes", () => {
  const events: { kind: string; time: number; velocity?: number; handle?: object }[] = [];
  registerSoundSource("live-a", () => ({
    load: async () => {},
    trigger: () => {},
    noteOn: (_row, time, velocity) => {
      const handle = {};
      events.push({ kind: "on", time, velocity, handle });
      return handle;
    },
    noteOff: (handle, time) => events.push({ kind: "off", time, handle }),
    stopAll: () => {},
  }));

  const voice = (over: Partial<Voice> = {}): Voice => ({
    key: "live-a",
    instrument: "live-a",
    rows: ROWS,
    notes: [],
    volumeDb: -6,
    pan: -1,
    audible: false,
    ...over,
  });

  const setupLive = (v: Voice) => {
    const model: PlaybackModel = {
      getTiming: () => ({ tempo: 120, swing: 0, stepsPerMeasure: 16, measures: 1 }),
      getVoices: () => [v],
    };
    return createPlaybackEngine(model, { requestFrame: () => 0, cancelFrame: () => {} });
  };

  beforeEach(() => {
    events.length = 0;
  });

  it("plays on a muted track through the track's volume and pan", async () => {
    const engine = setupLive(voice());
    await engine.prepareLive("live-a");
    h.state.now = 3;

    const note = engine.liveNoteOn(ROWS[0], { voiceKey: "live-a", velocity: 90 });

    expect(note).not.toBeNull();
    expect(events).toEqual([{ kind: "on", time: 3, velocity: 90, handle: expect.any(Object) }]);
    expect(h.state.channels).toHaveLength(1);
    expect(h.state.channels[0].opts).toEqual({ volume: -6, pan: -1 });
  });

  it("releases the same note handle on note-off", async () => {
    const engine = setupLive(voice());
    await engine.prepareLive("live-a");
    const note = engine.liveNoteOn(ROWS[0], { voiceKey: "live-a" })!;
    h.state.now = 4;
    engine.liveNoteOff(note);

    expect(events[1]).toEqual({ kind: "off", time: 4, handle: events[0].handle });
  });

  it("drops the note instead of waiting when audio has not been prepared", () => {
    const engine = setupLive(voice());
    expect(engine.liveNoteOn(ROWS[0], { voiceKey: "live-a" })).toBeNull();
    expect(events).toEqual([]);
  });

  it("returns null while the audio context is suspended, so nothing queues up to burst later", async () => {
    const engine = setupLive(voice());
    await engine.prepareLive("live-a");
    h.state.contextState = "suspended";

    expect(engine.liveBlocked()).toBe(true);
    expect(engine.liveNoteOn(ROWS[0], { voiceKey: "live-a" })).toBeNull();
    expect(events).toEqual([]);

    h.state.contextState = "running";
    expect(engine.liveBlocked()).toBe(false);
    expect(engine.liveNoteOn(ROWS[0], { voiceKey: "live-a" })).not.toBeNull();
  });

  it("does not report blocked before audio has loaded, since a click would not fix that", () => {
    const engine = setupLive(voice());
    expect(engine.liveBlocked()).toBe(false);
  });

  it("does not touch the scheduler's channel for a muted voice", async () => {
    const engine = setupLive(voice());
    await engine.prepareLive("live-a");
    engine.liveNoteOn(ROWS[0], { voiceKey: "live-a" });
    expect(h.state.channels.map((c) => c.opts.volume)).toEqual([-6]);
  });
});

// The type only allows lengths a user can pick, but a one-bar run keeps these timelines short.
const ONE_MEASURE = 1 as Pattern["measures"];

describe("stepAt", () => {
  const NOW_MS = 1000;
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(NOW_MS);
  });
  afterEach(() => vi.restoreAllMocks());

  // The event happens "now"; the engine clock has advanced to the heard time plus any latency.
  const stepAt = (engine: ReturnType<typeof createPlaybackEngine>, ageMs = 0) =>
    engine.stepAt(NOW_MS - ageMs);

  it("quantizes to the nearest step", async () => {
    const { engine } = setup(makePattern());
    await start(engine);
    advanceTo(0.53);
    expect(stepAt(engine)?.step).toBe(4);
    expect(stepAt(engine)?.frac).toBeCloseTo(0.24);

    advanceTo(0.78);
    expect(stepAt(engine)?.step).toBe(6);
  });

  it("uses the time the event happened rather than when it was handled", async () => {
    const { engine } = setup(makePattern());
    await start(engine);
    advanceTo(0.7);
    expect(stepAt(engine, 170)?.step).toBe(4);
  });

  it("subtracts the output latency so the step is the one the player heard", async () => {
    const { engine } = setup(makePattern());
    await start(engine);
    h.state.outputLatency = 0.1;
    advanceTo(0.6);
    expect(stepAt(engine)?.step).toBe(4);
  });

  it("subtracts the base latency alone when the output latency is unknown", async () => {
    const { engine } = setup(makePattern());
    await start(engine);
    h.state.outputLatency = 0;
    h.state.baseLatency = 0.1;
    advanceTo(0.6);
    expect(stepAt(engine)?.step).toBe(4);
  });

  it("subtracts base and output latency together", async () => {
    const { engine } = setup(makePattern());
    await start(engine);
    h.state.outputLatency = 0.06;
    h.state.baseLatency = 0.04;
    advanceTo(0.6);
    // Either latency alone would land on step 5.
    expect(stepAt(engine)?.step).toBe(4);
  });

  it("reports the event's transport time and the step length", async () => {
    const { engine } = setup(makePattern());
    await start(engine);
    advanceTo(0.53);
    expect(stepAt(engine)).toMatchObject({ seconds: 0.53, stepSeconds: 0.125 });
  });

  it("honours a pending seek when the event falls past the last scheduled bar", async () => {
    const { engine } = setup(makePattern({ measures: ONE_MEASURE }));
    engine.setLooping(false);
    await start(engine);
    advanceTo(1.98);
    expect(stepAt(engine)).toBeNull();
    engine.seek?.(1);
    expect(stepAt(engine)?.step).toBe(0);
  });

  it("inverts swing so a swung odd step is found", async () => {
    const { engine } = setup(makePattern({ swing: 0.5 }));
    await start(engine);
    // Step 1 sounds at 0.1875 s; without swing this time would round to step 2.
    advanceTo(0.19);
    expect(stepAt(engine)?.step).toBe(1);
  });

  it("wraps an early downbeat to the loop region's first step", async () => {
    const { engine } = setup(makePattern({ measures: 4 }));
    engine.setLoop({ start: 1, end: 2 });
    await start(engine);
    advanceTo(3.98);
    expect(stepAt(engine)?.step).toBe(0);
  });

  it("maps a note held across a loop wrap to an earlier step than its start", async () => {
    const { engine } = setup(makePattern({ measures: 4 }));
    engine.setLoop({ start: 1, end: 2 });
    await start(engine);
    advanceTo(3.9);
    const on = stepAt(engine)!;
    advanceTo(4.2);
    const off = stepAt(engine)!;

    expect(on.step).toBe(31);
    expect(off.step).toBe(2);
  });

  it("discards a note-on past the end when looping is off", async () => {
    const { engine } = setup(makePattern({ measures: ONE_MEASURE }));
    engine.setLooping(false);
    await start(engine);
    advanceTo(1.5);
    expect(stepAt(engine)?.step).toBe(12);
    advanceTo(1.98);
    expect(stepAt(engine)).toBeNull();
  });

  it("maps an event during the load before a plain Play to the first step instead of dropping it", async () => {
    const { engine } = setup(makePattern({ measures: 4 }));
    await start(engine);
    engine.stop();
    void engine.play();
    expect(engine.getSnapshot().status).toBe("loading");
    expect(stepAt(engine)).toMatchObject({ step: 0, stepSeconds: 0.125 });
  });

  it("maps an event before the first bar sounds to the first step, at the loop region's start when looping", async () => {
    const { engine } = setup(makePattern({ measures: 4 }));
    engine.setLoop({ start: 2, end: 3 });
    await start(engine);
    expect(stepAt(engine, 500)?.step).toBe(16);
  });

  it("still drops events during the load of a count-in run, which are heard over the clicks", async () => {
    const { engine } = setup(makePattern({ measures: 4 }));
    await start(engine);
    engine.stop();
    void engine.play({ countIn: true });
    expect(stepAt(engine)).toBeNull();
    await vi.waitFor(() => expect(engine.isPlaying).toBe(true));
    expect(stepAt(engine, 500)).toBeNull();
  });

  it("returns null before anything is scheduled", () => {
    const { engine } = setup(makePattern());
    expect(stepAt(engine)).toBeNull();
  });
});

describe("metronome and count-in", () => {
  const clickTimes = () => h.state.clicks.map((c) => c.time - AUDIO_OFFSET);
  const kick = (step: number) => ({
    row_id: "kick",
    step,
    length_steps: 1,
    velocity: 100,
  });

  it("clicks on steps 0, 4, 8 and 12 with an accented downbeat", async () => {
    const { engine } = setup(makePattern({ measures: ONE_MEASURE }));
    engine.setLooping(false);
    engine.setMetronome(true);
    await start(engine);
    advanceTo(1.9);

    expect(clickTimes()).toEqual([0, 0.5, 1, 1.5]);
    const [first, ...rest] = h.state.clicks;
    expect(rest.every((c) => c.hz < first.hz)).toBe(true);
  });

  it("clicks twice per measure in 6/8", async () => {
    const { engine } = setup(
      makePattern({ measures: ONE_MEASURE, time_signature: "6/8", steps_per_measure: 12 }),
    );
    engine.setLooping(false);
    engine.setMetronome(true);
    await start(engine);
    advanceTo(1.4);

    expect(clickTimes()).toEqual([0, 0.75]);
    expect(h.state.clicks[0].hz).toBeGreaterThan(h.state.clicks[1].hz);
  });

  it("stays silent with the metronome off and no count-in", async () => {
    const { engine } = setup(makePattern({ measures: ONE_MEASURE, notes: [kick(0)] }));
    engine.setLooping(false);
    await start(engine);
    advanceTo(1.9);
    expect(h.state.clicks).toEqual([]);
  });

  it("plays one bar of clicks before the first bar when counting in, even with the metronome off", async () => {
    const { engine } = setup(makePattern({ measures: ONE_MEASURE, notes: [kick(0)] }));
    engine.setLooping(false);
    engine.setMetronome(false);
    void engine.play({ countIn: true });
    await vi.waitFor(() => expect(engine.isPlaying).toBe(true));
    advanceTo(3.9);

    expect(clickTimes()).toEqual([0, 0.5, 1, 1.5]);
    // The real bar starts the moment the pre-roll ends, and clicks stop after it.
    expect(h.state.hits.map((x) => x.time - AUDIO_OFFSET)).toEqual([2]);
  });

  it("does not play notes during the count-in", async () => {
    const { engine } = setup(makePattern({ measures: ONE_MEASURE, notes: [kick(4), kick(8)] }));
    engine.setLooping(false);
    void engine.play({ countIn: true });
    await vi.waitFor(() => expect(engine.isPlaying).toBe(true));
    advanceTo(1.9);
    expect(h.state.hits).toEqual([]);
  });

  it("starts with no count-in when playing normally", async () => {
    const { engine } = setup(makePattern({ measures: ONE_MEASURE, notes: [kick(0)] }));
    engine.setLooping(false);
    await start(engine);
    advanceTo(0.1);
    expect(h.state.clicks).toEqual([]);
    expect(h.state.hits.map((x) => x.time - AUDIO_OFFSET)).toEqual([0]);
  });

  it("keeps clicks out of the reported position and counts down the beats", async () => {
    const positions: (number | null)[] = [];
    const beats: (number | null)[] = [];
    let frame: (() => void) | undefined;
    const store = createPatternStore("drums-countin");
    store.getState().setPattern(makePattern({ measures: ONE_MEASURE }));
    const engine = createPlaybackEngine(createPatternPlaybackModel("drums", store), {
      requestFrame: (cb) => ((frame = cb), 1),
      cancelFrame: () => {},
    });
    engine.setLooping(false);
    engine.subscribePosition((s) => positions.push(s));
    engine.subscribeCountIn((b) => beats.push(b));
    void engine.play({ countIn: true });
    await vi.waitFor(() => expect(engine.isPlaying).toBe(true));
    for (const t of [0, 0.6, 1.1, 1.6, 2.1]) {
      advanceTo(t);
      frame?.();
    }

    expect(beats).toEqual([4, 3, 2, 1, null]);
    expect(positions).toEqual([0]);
  });

  it("ends the count-in when the first real bar is scheduled, without any frame running", async () => {
    const ended = vi.fn();
    const { engine } = setup(makePattern({ measures: ONE_MEASURE }));
    engine.setLooping(false);
    engine.subscribeCountInEnd(ended);
    void engine.play({ countIn: true });
    await vi.waitFor(() => expect(engine.isPlaying).toBe(true));
    advanceTo(1.9);
    await Promise.resolve();
    expect(ended).not.toHaveBeenCalled();
    advanceTo(2.1);
    await Promise.resolve();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("reports the measure the next play starts on, including a pending seek", () => {
    const { engine } = setup(makePattern({ measures: 4 }));
    engine.setLoop({ start: 2, end: 3 });
    expect(engine.startMeasure()).toBe(2);
    engine.setLooping(false);
    expect(engine.startMeasure()).toBe(1);
    engine.seek?.(3);
    expect(engine.startMeasure()).toBe(3);
  });

  it("discards the rest of the count-in when stopped during it", async () => {
    const { engine } = setup(makePattern({ measures: ONE_MEASURE, notes: [kick(0)] }));
    engine.setLooping(false);
    void engine.play({ countIn: true });
    await vi.waitFor(() => expect(engine.isPlaying).toBe(true));
    advanceTo(0.6);
    engine.stop();
    const clicks = h.state.clicks.length;
    advanceTo(5);

    expect(engine.isPlaying).toBe(false);
    expect(h.state.clicks).toHaveLength(clicks);
    expect(h.state.hits).toEqual([]);
  });

  it("does not map events to steps during the count-in", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { engine } = setup(makePattern({ measures: ONE_MEASURE }));
    engine.setLooping(false);
    void engine.play({ countIn: true });
    await vi.waitFor(() => expect(engine.isPlaying).toBe(true));
    advanceTo(1);
    expect(engine.stepAt(1000)).toBeNull();
    vi.restoreAllMocks();
  });
});
