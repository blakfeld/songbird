import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackPreset, pianoPreset } from "./presets";
import { createSynthSource, MAX_POLYPHONY, type SynthPreset } from "./synthSource";

const RELEASE = 0.5;

const h = vi.hoisted(() => ({
  voices: [] as MockSynth[],
  buses: [] as MockGain[],
  chains: [] as unknown[][],
}));

interface MockGain {
  ramps: number[];
  disposed: boolean;
}
interface MockSynth {
  attacks: [number, number, number][];
  releases: number[];
  disposed: boolean;
  bus: MockGain | null;
}

vi.mock("tone", () => ({}));

class Gain {
  ramps: number[] = [];
  disposed = false;
  gain = { rampTo: (v: number) => this.ramps.push(v) };
  constructor() {
    h.buses.push(this);
  }
  connect() {
    return this;
  }
  chain(...nodes: unknown[]) {
    h.chains.push(nodes);
  }
  dispose() {
    this.disposed = true;
  }
}

class FMSynth {
  attacks: [number, number, number][] = [];
  releases: number[] = [];
  disposed = false;
  bus: MockGain | null = null;
  envelope = { release: RELEASE };
  constructor() {
    h.voices.push(this);
  }
  connect(bus: MockGain) {
    this.bus = bus;
  }
  toSeconds(v: number) {
    return v;
  }
  triggerAttack(f: number, t: number, v: number) {
    this.attacks.push([f, t, v]);
  }
  triggerRelease(t: number) {
    this.releases.push(t);
  }
  dispose() {
    this.disposed = true;
  }
}

const tone = { Gain, FMSynth, getDestination: () => ({}) } as never;
const preset: SynthPreset = { voice: "FMSynth", options: {} };
const row = (midi_note: number) => ({ id: `n${midi_note}`, name: "x", midi_note });

beforeEach(() => {
  h.voices = [];
  h.buses = [];
  h.chains = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("synth source", () => {
  it("attacks at start and releases at end with velocity gain", () => {
    const source = createSynthSource(preset)(tone);
    source.trigger(row(69), 1, 1.5, 127);
    source.trigger(row(81), 1, 2.25, 127 / 2);

    expect(h.voices[0].attacks).toEqual([[440, 1, 1]]);
    expect(h.voices[0].releases).toEqual([1.5]);
    expect(h.voices[1].attacks[0][0]).toBeCloseTo(880);
    expect(h.voices[1].attacks[0][2]).toBeCloseTo(0.5);
    expect(h.voices[1].releases).toEqual([2.25]);
  });

  it("resolves load immediately", async () => {
    await expect(createSynthSource(preset)(tone).load([])).resolves.toBeUndefined();
  });

  it("gives the 33rd note the oldest voice instead of dropping it", () => {
    const source = createSynthSource(preset)(tone);
    for (let i = 0; i < MAX_POLYPHONY; i++) source.trigger(row(40 + i), 1 + i * 0.01, 100, 100);
    source.trigger(row(90), 2, 100, 100);

    expect(h.voices).toHaveLength(MAX_POLYPHONY);
    expect(h.voices[0].attacks).toHaveLength(2);
    expect(h.voices[0].attacks[1][1]).toBe(2);
    expect(h.voices[1].attacks).toHaveLength(1);
  });

  it("steals the next-oldest voice on the following note", () => {
    const source = createSynthSource(preset)(tone);
    for (let i = 0; i < MAX_POLYPHONY; i++) source.trigger(row(40 + i), 1 + i * 0.01, 100, 100);
    source.trigger(row(90), 2, 100, 100);
    source.trigger(row(91), 2.1, 100, 100);
    expect(h.voices[1].attacks).toHaveLength(2);
  });

  it("drops the note when every voice started at or after it", () => {
    const source = createSynthSource(preset)(tone);
    for (let i = 0; i < MAX_POLYPHONY; i++) source.trigger(row(40 + i), 1, 100, 100);
    source.trigger(row(90), 1, 100, 100);
    expect(h.voices).toHaveLength(MAX_POLYPHONY);
    expect(h.voices.every((v) => v.attacks.length === 1)).toBe(true);
  });

  it("does not steal a voice queued for later than an earlier-sounding note", () => {
    const source = createSynthSource(preset)(tone);
    for (let i = 0; i < MAX_POLYPHONY; i++) source.trigger(row(40 + i), 1.15, 100, 100);
    source.trigger(row(90), 1.01, 1.51, 100);
    expect(h.voices.every((v) => v.attacks.length === 1)).toBe(true);
  });

  it("does not reuse a voice that is still in its release tail", () => {
    const source = createSynthSource(preset)(tone);
    source.trigger(row(60), 1, 2, 100);
    source.trigger(row(62), 2 + RELEASE / 2, 4, 100);
    expect(h.voices).toHaveLength(2);
  });

  it("reuses a voice once its release tail has finished", () => {
    const source = createSynthSource(preset)(tone);
    source.trigger(row(60), 1, 2, 100);
    source.trigger(row(62), 2 + RELEASE, 4, 100);
    expect(h.voices).toHaveLength(1);
  });

  it("stopAll fades out and disposes the old voices, and later notes get fresh ones", () => {
    const source = createSynthSource(preset)(tone);
    source.trigger(row(60), 1, 100, 100);
    const [old] = h.voices;
    const oldBus = old.bus as unknown as MockGain;

    source.stopAll();
    expect(oldBus.ramps).toEqual([0]);
    expect(old.disposed).toBe(false);
    vi.runAllTimers();
    expect(old.disposed).toBe(true);
    expect(oldBus.disposed).toBe(true);

    source.trigger(row(60), 5, 6, 100);
    expect(h.voices).toHaveLength(2);
    expect(h.voices[1].bus).not.toBe(oldBus);
    expect(old.attacks).toHaveLength(1);
    expect(old.releases).toEqual([100]);
  });
});

describe("synth source routing", () => {
  const destination = { name: "destination" };
  const output = { name: "channel" };
  const routedTone = {
    Gain,
    FMSynth,
    Reverb: class {
      dispose() {}
    },
    getDestination: () => destination,
  } as never;

  it("ends a preset's effect chain at the supplied output, not the destination", () => {
    createSynthSource(pianoPreset)(routedTone, output as never);
    const [chain] = h.chains;
    expect(chain).toHaveLength(2);
    expect(chain.at(-1)).toBe(output);
    expect(chain).not.toContain(destination);
  });

  it("routes the fallback preset to the supplied output", () => {
    createSynthSource(fallbackPreset)(routedTone, output as never);
    expect(h.chains).toEqual([[output]]);
  });

  it("uses the destination when no output is supplied", () => {
    createSynthSource(pianoPreset)(routedTone);
    expect(h.chains[0].at(-1)).toBe(destination);
  });
});
