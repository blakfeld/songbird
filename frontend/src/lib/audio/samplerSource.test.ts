import { describe, expect, it, vi } from "vitest";
import type { Row } from "@/generated/Row";
import type { SamplerSettings } from "@/generated/SamplerSettings";
import type { SampleBufferCache } from "./sampleBuffers";
import { createSamplerSource, MAX_SAMPLER_VOICES } from "./samplerSource";

vi.mock("tone", () => ({}));

interface Event {
  kind: "set" | "ramp" | "hold" | "cancel" | "rampTo";
  value?: number;
  time: number;
}

const made = vi.hoisted(() => ({
  players: [] as unknown[],
  gains: [] as unknown[],
}));

class Param {
  events: Event[] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ kind: "set", value, time });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: "ramp", value, time });
  }
  cancelScheduledValues(time: number) {
    this.events.push({ kind: "cancel", time });
  }
  cancelAndHoldAtTime(time: number) {
    this.events.push({ kind: "hold", time });
  }
  rampTo(value: number, _seconds: number, time: number) {
    this.events.push({ kind: "rampTo", value, time });
  }
}

class Gain {
  gain = new Param();
  out: unknown = null;
  constructor(public initial: number) {
    made.gains.push(this);
  }
  connect(node: unknown) {
    this.out = node;
    return this;
  }
  disconnect() {
    return this;
  }
  dispose() {}
}

class Player {
  buffer: unknown = null;
  starts: number[] = [];
  stops: (number | undefined)[] = [];
  onstop: (p: Player) => void = () => {};
  out: unknown = null;
  constructor(public options: { playbackRate: number }) {
    made.players.push(this);
  }
  connect(node: unknown) {
    this.out = node;
    return this;
  }
  offsets: (number | undefined)[] = [];
  start(t: number, offset?: number) {
    this.starts.push(t);
    if (offset !== undefined) this.offsets.push(offset);
  }
  stop(t?: number) {
    this.stops.push(t);
  }
  dispose() {}
}

class Filter {
  constructor(public options: Record<string, unknown>) {}
  frequency = { exponentialRampTo() {} };
  Q = { rampTo() {} };
  connect() {
    return this;
  }
  dispose() {}
}

const tone = { Gain, Player, Filter, getDestination: () => ({ name: "destination" }), now: () => 0 } as never;
const players = () => made.players as Player[];
const gainOf = (p: Player) => p.out as Gain;

const keyRow = (name: string, midi_note: number): Row => ({ id: name, name, midi_note });
const E4 = keyRow("E4", 64);
const C5 = keyRow("C5", 72);
const pad = (n: number): Row => ({ id: `pad-${n}`, name: `Pad ${n}`, midi_note: 35 + n });

// Buffers are plain objects with a duration, which is all the source reads.
const cacheOf = (durations: Record<string, number>): SampleBufferCache => ({
  load: async () => {},
  get: (id) => (id in durations ? ({ duration: durations[id] } as never) : undefined),
  acquire: vi.fn(),
  release: vi.fn(),
});

function build(
  kind: "keys" | "pads",
  settings: SamplerSettings,
  durations: Record<string, number>,
  controls = {},
) {
  made.players = [];
  made.gains = [];
  const output = { name: "output" } as never;
  const source = createSamplerSource(kind)(tone, output, controls);
  const cache = cacheOf(durations);
  source.setSamples!(settings, cache);
  return { source, cache, output };
}

const keys = (over = {}): SamplerSettings => ({ keys: { sample_id: "s1", root_note: 60, one_shot: false, ...over } });
const padSettings = (...pads: { n: number; id?: string; gain?: number; pitch?: number }[]): SamplerSettings => ({
  pads: pads.map((p) => ({
    row_id: `pad-${p.n}`,
    sample_id: p.id ?? "s1",
    gain_db: p.gain ?? 0,
    pitch_semitones: p.pitch ?? 0,
  })),
});

describe("keys sampler", () => {
  it("plays a note an octave above the root at double speed", () => {
    const { source } = build("keys", keys(), { s1: 4 });
    source.trigger(C5, 1, 1.125, 127);
    expect(players()).toHaveLength(1);
    expect(players()[0].options.playbackRate).toBe(2);
    expect(players()[0].starts).toEqual([1]);
  });

  it("pitches E4 against a C4 root by four semitones", () => {
    const { source } = build("keys", keys(), { s1: 4 });
    source.trigger(E4, 0, 0.125, 100);
    expect(players()[0].options.playbackRate).toBeCloseTo(2 ** (4 / 12));
  });

  it("releases a sustained note after its end and not at the end of the sample", () => {
    const { source } = build("keys", keys(), { s1: 4 }, { envelope: { release: 0.2 } });
    source.trigger(E4, 0, 0.125, 127);
    const [player] = players();
    expect(player.stops).toHaveLength(1);
    // The sample runs for 4 s at this pitch, so a stop that early is the release, not the sample ending.
    expect(player.stops[0]).toBeCloseTo(0.325);
    const events = gainOf(player).gain.events;
    expect(events.at(-1)).toMatchObject({ kind: "ramp", value: 0 });
    expect(events.at(-1)!.time).toBeCloseTo(0.325);
  });

  it("stops at the end of a sample shorter than the note", () => {
    const { source } = build("keys", keys(), { s1: 0.1 });
    source.trigger(keyRow("C4", 60), 0, 2, 100);
    expect(players()[0].stops[0]).toBeCloseTo(0.1);
  });

  it("lets a one-shot play to its end whatever the note length", () => {
    const { source } = build("keys", keys({ one_shot: true }), { s1: 4 });
    source.trigger(keyRow("C4", 60), 0, 0.125, 127);
    expect(players()[0].stops).toEqual([]);
    const events = gainOf(players()[0]).gain.events;
    expect(events.some((e) => e.kind === "ramp" && e.value === 0)).toBe(false);
  });

  it("is silent with no sample chosen", () => {
    const { source } = build("keys", { keys: { sample_id: null, root_note: 60, one_shot: false } }, {});
    source.trigger(E4, 0, 1, 100);
    expect(players()).toHaveLength(0);
  });

  it("holds a live note until release, then releases from the key-up time", () => {
    const { source } = build("keys", keys(), { s1: 4 }, { envelope: { release: 0.5 } });
    const handle = source.noteOn(E4, 1, 127);
    expect(players()[0].stops).toEqual([]);
    source.noteOff(handle, 3);
    expect(players()[0].stops[0]).toBeCloseTo(3.5);
    expect(gainOf(players()[0]).gain.events.some((e) => e.kind === "hold" && e.time === 3)).toBe(true);
  });

  it("stays silent when its audio is missing", () => {
    const { source } = build("keys", keys(), {});
    source.trigger(E4, 0, 1, 100);
    expect(players()).toHaveLength(0);
  });
});

describe("pads sampler", () => {
  it("plays the whole sample for a short note", () => {
    const { source } = build("pads", padSettings({ n: 1 }), { s1: 2 });
    source.trigger(pad(1), 0, 0.125, 127);
    expect(players()).toHaveLength(1);
    expect(players()[0].stops).toEqual([]);
    expect(players()[0].options.playbackRate).toBe(1);
  });

  it("applies pad gain with velocity and pad pitch with the track pitch", () => {
    const { source } = build("pads", padSettings({ n: 3, gain: -6, pitch: 3 }), { s1: 1 }, { pitchSemitones: 2 });
    source.trigger(pad(3), 0, 0.125, 127);
    expect(players()[0].options.playbackRate).toBeCloseTo(2 ** (5 / 12));
    const level = gainOf(players()[0]).gain.events.find((e) => e.kind === "set" && e.value! > 0)!.value!;
    expect(level).toBeCloseTo(10 ** (-6 / 20));
  });

  it("scales level by velocity", () => {
    const { source } = build("pads", padSettings({ n: 1 }), { s1: 1 });
    source.trigger(pad(1), 0, 0.125, 64);
    const level = gainOf(players()[0]).gain.events.find((e) => e.kind === "set")!.value!;
    expect(level).toBeCloseTo(64 / 127);
  });

  it("is silent on an empty pad", () => {
    const { source } = build("pads", padSettings({ n: 1 }), { s1: 1 });
    source.trigger(pad(2), 0, 0.125, 100);
    expect(players()).toHaveLength(0);
  });

  it("is silent when a pad's audio is missing", () => {
    const { source } = build("pads", padSettings({ n: 1, id: "gone" }), { s1: 1 });
    source.trigger(pad(1), 0, 0.125, 100);
    expect(players()).toHaveLength(0);
  });

  it("routes every voice through the output it was given", () => {
    const { source, output } = build("pads", padSettings({ n: 1 }), { s1: 1 });
    source.trigger(pad(1), 0, 0.125, 100);
    const bus = gainOf(players()[0]).out as Gain;
    expect(bus.out).toBe(output);
  });
});

describe("joining a sample mid-way", () => {
  it("starts a pad at an offset and skips one that has already finished", () => {
    const { source } = build("pads", padSettings({ n: 1 }), { s1: 2 });
    source.trigger(pad(1), 0, 0.125, 127, 0.5);
    expect(players()[0].starts).toEqual([0]);
    expect(players()[0].offsets).toEqual([0.5]);
    source.trigger(pad(1), 0, 0.125, 127, 2.5);
    expect(players()).toHaveLength(1);
  });

  it("continues a fade-in from where it would be when resumed inside a long attack", () => {
    const { source } = build("keys", keys({ one_shot: true }), { s1: 4 }, { envelope: { attack: 1 } });
    source.trigger(keyRow("C4", 60), 0, 0.125, 127, 0.25);
    const events = gainOf(players()[0]).gain.events;
    expect(events).toEqual([
      { kind: "set", value: 0.25, time: 0 },
      { kind: "ramp", value: 1, time: 0.75 },
    ]);
  });

  it("ranks resumed rings by their own start, so the newest of 33 steals the oldest", () => {
    const { source } = build("pads", padSettings({ n: 1 }), { s1: 20 });
    // Offsets shrink as the notes get newer, as they do when a window opens on a run of rings.
    for (let i = 0; i < MAX_SAMPLER_VOICES + 1; i++) source.trigger(pad(1), 0, 0.1, 100, 10 - i * 0.1);
    const oldest = players()[0];
    expect(oldest.stops).toHaveLength(1);
    expect(players().slice(1).every((p) => p.stops.length === 0)).toBe(true);
  });

  it("does not fade a resumed one-shot key in again", () => {
    const { source } = build("keys", keys({ one_shot: true }), { s1: 4 });
    source.trigger(keyRow("C4", 60), 0, 0.125, 127, 1);
    const events = gainOf(players()[0]).gain.events;
    expect(events).toEqual([{ kind: "set", value: 1, time: 0 }]);
  });
});

describe("voice limit", () => {
  it("steals the oldest voice for the 33rd note and leaves the rest alone", () => {
    const { source } = build("pads", padSettings({ n: 1 }), { s1: 10 });
    for (let i = 0; i < MAX_SAMPLER_VOICES + 1; i++) source.trigger(pad(1), i * 0.01, i * 0.01 + 0.1, 100);
    expect(players()).toHaveLength(33);
    const first = players()[0];
    expect(first.stops).toHaveLength(1);
    expect(first.stops[0]).toBeGreaterThan(32 * 0.01);
    expect(gainOf(first).gain.events.some((e) => e.kind === "rampTo" && e.value === 0)).toBe(true);
    expect(players().slice(1).every((p) => p.stops.length === 0)).toBe(true);
  });

  it("does not steal while 32 voices are free of overlap", () => {
    const { source } = build("pads", padSettings({ n: 1 }), { s1: 0.05 });
    for (let i = 0; i < 40; i++) source.trigger(pad(1), i * 0.1, i * 0.1 + 0.05, 100);
    expect(players().every((p) => p.stops.length === 0)).toBe(true);
  });
});

describe("tone controls", () => {
  it("uses an edited envelope for later notes", () => {
    const { source } = build("keys", keys(), { s1: 4 });
    source.setTone!({ envelope: { release: 1 } });
    source.trigger(E4, 0, 0.5, 100);
    expect(players()[0].stops[0]).toBeCloseTo(1.5);
  });

  it("holds and releases buffer references as assignments change", () => {
    const { source, cache } = build("keys", keys(), { s1: 1, s2: 1 });
    expect(cache.acquire).toHaveBeenCalledWith(["s1"]);
    source.setSamples!(keys({ sample_id: "s2" }), cache);
    expect(cache.release).toHaveBeenCalledWith(["s1"]);
    source.dispose!();
    expect(cache.release).toHaveBeenLastCalledWith(["s2"]);
  });
});
