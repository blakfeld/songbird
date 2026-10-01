import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackPreset, pianoPreset } from "./presets";
import { createSynthSource, MAX_POLYPHONY, type SynthPreset } from "./synthSource";

const RELEASE = 0.5;

const h = vi.hoisted(() => ({
  voices: [] as MockSynth[],
  buses: [] as MockGain[],
  chains: [] as unknown[][],
  filters: [] as MockFilter[],
  connects: [] as [unknown, unknown][],
  disconnects: [] as [unknown, unknown][],
  voiceOptions: [] as Record<string, unknown>[],
}));

interface MockFilter {
  options: Record<string, unknown>;
  freqRamps: [number, number][];
  qRamps: [number, number][];
  disposed: boolean;
}

interface MockGain {
  ramps: number[];
  disposed: boolean;
}
interface MockSynth {
  sets: unknown[];
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
  connect(node?: unknown) {
    h.connects.push([this, node]);
    return this;
  }
  disconnect(node?: unknown) {
    h.disconnects.push([this, node]);
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
  sets: unknown[] = [];
  disposed = false;
  bus: MockGain | null = null;
  envelope = { release: RELEASE };
  constructor(options: Record<string, unknown>) {
    h.voices.push(this);
    h.voiceOptions.push(options);
    const release = (options.envelope as { release?: number } | undefined)?.release;
    if (release !== undefined) this.envelope.release = release;
  }
  set(values: { envelope: { release: number } }) {
    this.sets.push(values);
    this.envelope.release = values.envelope.release;
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

class Filter implements MockFilter {
  freqRamps: [number, number][] = [];
  qRamps: [number, number][] = [];
  disposed = false;
  frequency = { exponentialRampTo: (v: number, t: number) => this.freqRamps.push([v, t]) };
  Q = { rampTo: (v: number, t: number) => this.qRamps.push([v, t]) };
  constructor(public options: Record<string, unknown>) {
    h.filters.push(this);
  }
  connect(node?: unknown) {
    h.connects.push([this, node]);
    return this;
  }
  dispose() {
    this.disposed = true;
  }
}

const tone = { Gain, FMSynth, Filter, getDestination: () => ({}) } as never;
const defaultEnvelope = { attack: 0.01, decay: 0.2, sustain: 0.6, release: RELEASE };
const preset: SynthPreset = { voice: "FMSynth", options: {}, defaults: { envelope: defaultEnvelope } };
const row = (midi_note: number) => ({ id: `n${midi_note}`, name: "x", midi_note });

beforeEach(() => {
  h.voices = [];
  h.buses = [];
  h.chains = [];
  h.filters = [];
  h.connects = [];
  h.disconnects = [];
  h.voiceOptions = [];
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

describe("synth source held notes", () => {
  it("attacks without releasing until noteOff", () => {
    const source = createSynthSource(preset)(tone);
    const handle = source.noteOn(row(69), 1, 127);
    expect(h.voices[0].attacks).toEqual([[440, 1, 1]]);
    expect(h.voices[0].releases).toEqual([]);

    source.noteOff(handle, 3);
    expect(h.voices[0].releases).toEqual([3]);
  });

  it("does not reuse a held voice until noteOff and its release tail are done", () => {
    const source = createSynthSource(preset)(tone);
    const handle = source.noteOn(row(60), 1, 100);
    source.trigger(row(62), 1000, 1001, 100);
    expect(h.voices).toHaveLength(2);

    source.noteOff(handle, 2);
    source.trigger(row(64), 2 + RELEASE, 4, 100);
    expect(h.voices).toHaveLength(2);
    expect(h.voices[0].attacks).toHaveLength(2);
  });

  it("steals a releasing voice before a held one when the pool is full", () => {
    const source = createSynthSource(preset)(tone);
    const handles = [];
    for (let i = 0; i < MAX_POLYPHONY; i++) {
      handles.push(source.noteOn(row(40 + i), 1 + i * 0.01, 100));
    }
    // The newest voice is released, so it is the only one stealable without cutting a held key.
    source.noteOff(handles[MAX_POLYPHONY - 1], 1.5);
    source.trigger(row(90), 2, 3, 100);

    expect(h.voices[MAX_POLYPHONY - 1].attacks).toHaveLength(2);
    expect(h.voices[0].attacks).toHaveLength(1);
  });

  it("steals the oldest held voice only when every voice is held", () => {
    const source = createSynthSource(preset)(tone);
    for (let i = 0; i < MAX_POLYPHONY; i++) source.noteOn(row(40 + i), 1 + i * 0.01, 100);
    source.noteOn(row(90), 2, 100);
    expect(h.voices).toHaveLength(MAX_POLYPHONY);
    expect(h.voices[0].attacks).toHaveLength(2);
  });

  it("ignores a noteOff for a voice that has since been stolen", () => {
    const source = createSynthSource(preset)(tone);
    const first = source.noteOn(row(40), 1, 100);
    for (let i = 1; i < MAX_POLYPHONY; i++) source.noteOn(row(40 + i), 1 + i * 0.01, 100);
    source.noteOn(row(90), 2, 100);
    source.noteOff(first, 3);
    expect(h.voices[0].releases).toEqual([]);
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

describe("synth source tone controls", () => {
  const output = { name: "channel" } as never;
  const bassLike: SynthPreset = {
    ...preset,
    defaults: { filterCutoffHz: 900, envelope: defaultEnvelope },
  };

  it("adds no filter when nothing asks for one", () => {
    createSynthSource(preset)(tone, output);
    expect(h.filters).toHaveLength(0);
    expect(h.chains).toEqual([[output]]);
  });

  it("keeps a preset's default filter without any controls", () => {
    createSynthSource(bassLike)(tone, output);
    expect(h.filters[0].options).toMatchObject({ type: "lowpass", rolloff: -24, frequency: 900, Q: 1 });
    expect(h.chains[0]).toEqual([h.filters[0], output]);
  });

  it("adds no filter for empty controls, so an untouched track keeps the preset's own graph", () => {
    const source = createSynthSource(preset)(tone, output, {});
    source.setTone?.({ envelope: { attack: 0.1 } });
    expect(h.filters).toHaveLength(0);
    expect(h.chains).toEqual([[output]]);
  });

  it("splices a filter in after the preset's last node on the first cutoff override", () => {
    const source = createSynthSource(preset)(tone, output, {});
    source.setTone?.({ filterCutoffHz: 800 });
    // Created open and swept to the target so the first edit does not jump.
    expect(h.filters[0].options).toMatchObject({ frequency: 20000, Q: 1 });
    expect(h.filters[0].freqRamps).toEqual([[800, 0.02]]);
    const master = h.buses[0];
    expect(h.disconnects).toEqual([[master, output]]);
    expect(h.connects).toContainEqual([master, h.filters[0]]);
    expect(h.connects).toContainEqual([h.filters[0], output]);
  });

  it("builds the filter once, then ramps it", () => {
    const source = createSynthSource(preset)(tone, output, {});
    source.setTone?.({ filterCutoffHz: 800 });
    source.setTone?.({ filterCutoffHz: 500 });
    expect(h.filters).toHaveLength(1);
    expect(h.filters[0].freqRamps).toEqual([[800, 0.02], [500, 0.02]]);
  });

  it("starts from the supplied cutoff and resonance", () => {
    createSynthSource(bassLike)(tone, output, { filterCutoffHz: 300, filterResonance: 1 });
    expect(h.filters[0].options).toMatchObject({ frequency: 300, Q: 6 });
  });

  it("ramps cutoff and resonance briefly instead of jumping", () => {
    const source = createSynthSource(bassLike)(tone, output);
    source.setTone?.({ filterCutoffHz: 400, filterResonance: 0.5 });
    expect(h.filters[0].freqRamps).toEqual([[400, 0.02]]);
    expect(h.filters[0].qRamps).toEqual([[3.5, 0.02]]);
  });

  it("returns to the preset cutoff when the override is dropped", () => {
    const source = createSynthSource(bassLike)(tone, output);
    source.setTone?.({ filterCutoffHz: 400 });
    source.setTone?.({});
    expect(h.filters[0].freqRamps.at(-1)).toEqual([900, 0.02]);
    expect(h.filters[0].qRamps.at(-1)).toEqual([1, 0.02]);
  });

  it("sets the envelope on every pooled voice", () => {
    const source = createSynthSource(preset)(tone, output, {});
    source.trigger(row(60), 1, 2, 100);
    source.trigger(row(62), 1, 2, 100);
    const envelope = { attack: 0.5, decay: 1, sustain: 0.3, release: 2 };
    source.setTone?.({ envelope });
    expect(h.voices.map((v) => v.sets)).toEqual([[{ envelope }], [{ envelope }]]);
  });

  it("gives voices created after an edit the edited envelope, keeping preset-only options", () => {
    const withCurve: SynthPreset = {
      ...preset,
      options: { envelope: { decayCurve: "exponential" } },
    };
    const source = createSynthSource(withCurve)(tone, output, {});
    const envelope = { attack: 0.5, decay: 1, sustain: 0.3, release: 2 };
    source.setTone?.({ envelope });
    source.trigger(row(60), 1, 2, 100);
    expect(h.voiceOptions[0]).toEqual({ envelope: { decayCurve: "exponential", ...envelope } });
  });

  it("waits out an edited release before reusing a voice for later notes", () => {
    const source = createSynthSource(preset)(tone, output, {});
    source.setTone?.({ envelope: { ...defaultEnvelope, release: 4 } });
    source.trigger(row(60), 1, 2, 100);
    source.trigger(row(62), 5, 6, 100);
    expect(h.voices).toHaveLength(2);
  });

  it("disposes its filter with the source", () => {
    const source = createSynthSource(bassLike)(tone, output);
    source.dispose?.();
    vi.runAllTimers();
    expect(h.filters[0].disposed).toBe(true);
  });
});

describe("synth source resonance", () => {
  const output = { name: "channel" } as never;
  const withRolloff = (filterRolloff: -12 | -24 | -48): SynthPreset => ({
    ...preset,
    defaults: { filterCutoffHz: 900, filterRolloff, envelope: defaultEnvelope },
  });

  // Tone gives every cascaded biquad the same Q, so the peak is the stage count times the per-stage Q.
  it.each([
    [-12, 1],
    [-24, 2],
    [-48, 4],
  ] as const)("keeps the full-resonance peak at +12 dB for rolloff %d", (rolloff, stages) => {
    createSynthSource(withRolloff(rolloff))(tone, output, { filterResonance: 1 });
    expect((h.filters[0].options.Q as number) * stages).toBeCloseTo(12);
  });

  it("leaves zero resonance at Tone's default Q for every rolloff", () => {
    for (const rolloff of [-12, -24, -48] as const) {
      createSynthSource(withRolloff(rolloff))(tone, output, { filterResonance: 0 });
    }
    expect(h.filters.map((f) => f.options.Q)).toEqual([1, 1, 1]);
  });
});
