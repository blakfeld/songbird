import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pattern } from "@/generated/Pattern";
import type { PlaybackModel, Voice } from "./types";
import { createPatternStore } from "@/lib/patternStore";
import { createSongStore } from "@/lib/song/songStore";
import { newSong, newTrack } from "@/lib/song/types";
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
    getSecondsAtTime() {
      return state.seconds;
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
  return {
    start: async () => {
      state.startCalls += 1;
    },
    loaded: async () => {},
    getContext: () => ({ currentTime: 0 }),
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
    registerSoundSource("audition-test", () => ({ load, trigger, stopAll: () => {} }));
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
    stopAll: () => {},
  }));

  function setupClips() {
    const song = newSong();
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
    engine.seek?.(5);
    await start(engine);
    advanceTo(4.1);
    // Measure 5 plays first, then 6 and 7, so the next kick lands two measures later.
    expect(times).toEqual([0, 4]);
  });

  it("plays 16 tracks across 128 measures on the grid without drift or piling up events", async () => {
    const song = newSong();
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
