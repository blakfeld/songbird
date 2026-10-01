import { describe, expect, it, vi } from "vitest";
import { createDrumsSource } from "./drumsSource";

const h = vi.hoisted(() => ({
  connected: [] as unknown[],
  toDestinationCalls: 0,
  starts: [] as number[],
  rates: [] as (number | undefined)[],
  filters: [] as MockFilter[],
}));

interface MockFilter {
  options: Record<string, unknown>;
  out: unknown;
  freqRamps: [number, number][];
  qRamps: [number, number][];
}

vi.mock("tone", () => ({}));

class Gain {
  constructor(public value: number) {}
  connect(node: unknown) {
    h.connected.push(node);
    return this;
  }
  toDestination() {
    h.toDestinationCalls += 1;
    return this;
  }
  dispose() {}
}
class Filter implements MockFilter {
  out: unknown = null;
  freqRamps: [number, number][] = [];
  qRamps: [number, number][] = [];
  frequency = { exponentialRampTo: (v: number, t: number) => this.freqRamps.push([v, t]) };
  Q = { rampTo: (v: number, t: number) => this.qRamps.push([v, t]) };
  constructor(public options: Record<string, unknown>) {
    h.filters.push(this);
  }
  connect(node: unknown) {
    this.out = node;
    return this;
  }
  toDestination() {
    return this;
  }
  dispose() {}
}
class ToneBufferSource {
  constructor(options: { playbackRate?: number }) {
    h.rates.push(options.playbackRate);
  }
  connect() {
    return this;
  }
  start(t: number) {
    h.starts.push(t);
  }
  stop() {}
  dispose() {}
}
class ToneAudioBuffers {
  has() {
    return true;
  }
  get() {
    return {};
  }
}

const tone = { Gain, Filter, ToneBufferSource, ToneAudioBuffers, loaded: async () => {} } as never;
const row = { id: "kick", name: "Kick", midi_note: 36 };

describe("drums source routing", () => {
  it("connects hits to the supplied output and never to the destination", async () => {
    h.connected = [];
    h.toDestinationCalls = 0;
    const output = { name: "channel" } as never;
    const source = createDrumsSource(tone, output);
    await source.load([row]);
    source.trigger(row, 1, 2, 100);

    expect(h.connected).toEqual([output]);
    expect(h.toDestinationCalls).toBe(0);
  });

  it("plays to the destination when no output is supplied", async () => {
    h.connected = [];
    h.toDestinationCalls = 0;
    const source = createDrumsSource(tone);
    await source.load([row]);
    source.trigger(row, 1, 2, 100);

    expect(h.toDestinationCalls).toBe(1);
    expect(h.connected).toEqual([]);
  });
});

describe("drums source live notes", () => {
  it("fires the full one-shot on noteOn and ignores noteOff", async () => {
    h.starts = [];
    const source = createDrumsSource(tone);
    await source.load([row]);
    const handle = source.noteOn(row, 5, 100);
    source.noteOff(handle, 6);
    expect(h.starts).toEqual([5]);
  });
});

describe("drums source tone controls", () => {
  const output = { name: "channel" } as never;
  const play = async (source: ReturnType<typeof createDrumsSource>) => {
    await source.load([row]);
    source.trigger(row, 1, 2, 100);
  };

  it("plays at the recorded pitch and builds no filter by default", async () => {
    h.rates = [];
    h.filters = [];
    await play(createDrumsSource(tone, output));
    expect(h.rates).toEqual([1]);
    expect(h.filters).toHaveLength(0);
  });

  it.each([
    [12, 2],
    [-12, 0.5],
    [0, 1],
    [7, 2 ** (7 / 12)],
  ])("maps %d semitones to playback rate %d", async (semitones, rate) => {
    h.rates = [];
    await play(createDrumsSource(tone, output, { pitchSemitones: semitones }));
    expect(h.rates[0]).toBeCloseTo(rate);
  });

  it("applies a pitch change to the next hit only", async () => {
    h.rates = [];
    const source = createDrumsSource(tone, output, {});
    await play(source);
    source.setTone?.({ pitchSemitones: -12 });
    source.trigger(row, 3, 4, 100);
    expect(h.rates).toEqual([1, 0.5]);
  });

  it("builds no filter for empty controls", async () => {
    h.filters = [];
    await play(createDrumsSource(tone, output, {}));
    expect(h.filters).toHaveLength(0);
  });

  it("sends hits through a filter that feeds the output once a cutoff is set", async () => {
    h.connected = [];
    h.filters = [];
    await play(createDrumsSource(tone, output, { filterResonance: 0 }));
    expect(h.filters[0].options).toMatchObject({ type: "lowpass", rolloff: -24, frequency: 20000 });
    expect(h.filters[0].out).toBe(output);
    expect(h.connected).toEqual([h.filters[0]]);
  });

  it("ramps filter changes and reopens the filter when the override is dropped", () => {
    h.filters = [];
    const source = createDrumsSource(tone, output, {});
    source.setTone?.({ filterCutoffHz: 500, filterResonance: 1 });
    source.setTone?.({ filterCutoffHz: 400, filterResonance: 1 });
    source.setTone?.({});
    expect(h.filters).toHaveLength(1);
    expect(h.filters[0].options).toMatchObject({ frequency: 20000, Q: 1 });
    expect(h.filters[0].freqRamps).toEqual([[500, 0.02], [400, 0.02], [20000, 0.02]]);
    expect(h.filters[0].qRamps).toEqual([[6, 0.02], [6, 0.02], [1, 0.02]]);
  });
});
