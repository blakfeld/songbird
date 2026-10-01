import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInsertChain, REVERB_DEBOUNCE_MS } from "./insertChain";
import { EFFECT_DEFAULTS, type ResolvedEffects } from "./voiceSound";

vi.mock("tone", () => ({}));

type Param = { ramps: [number, number][]; rampTo(v: number, t: number): void };
const h = vi.hoisted(() => ({ nodes: [] as unknown[] }));

interface MockNode {
  type: string;
  opts: Record<string, unknown>;
  disposed: boolean;
  params: Record<string, Param>;
  ready?: Promise<void>;
  release?: () => void;
  distortion?: number;
  depth?: number;
}

function makeTone() {
  const param = (): Param => {
    const p: Param = {
      ramps: [],
      rampTo(v, t) {
        p.ramps.push([v, t]);
      },
    };
    return p;
  };
  class Base implements MockNode {
    type = "";
    disposed = false;
    params: Record<string, Param> = {};
    constructor(
      public opts: Record<string, unknown> = {},
      ...names: string[]
    ) {
      this.type = this.constructor.name;
      for (const n of names) {
        this.params[n] = param();
        (this as unknown as Record<string, Param>)[n] = this.params[n];
      }
      h.nodes.push(this);
    }
    connect() {
      return this;
    }
    disconnect() {
      return this;
    }
    dispose() {
      this.disposed = true;
    }
  }
  const classes = {
    Gain: class Gain extends Base {
      constructor(value: number) {
        super({ value }, "gain");
      }
    },
    Filter: class Filter extends Base {
      constructor(o: Record<string, unknown>) {
        super(o, "gain");
      }
    },
    Distortion: class Distortion extends Base {
      distortion: number;
      constructor(o: Record<string, unknown>) {
        super(o, "wet");
        this.distortion = o.distortion as number;
      }
    },
    Chorus: class Chorus extends Base {
      depth: number;
      constructor(o: Record<string, unknown>) {
        super(o, "frequency", "wet");
        this.depth = o.depth as number;
      }
      start() {
        return this;
      }
    },
    FeedbackDelay: class FeedbackDelay extends Base {
      constructor(o: Record<string, unknown>) {
        super(o, "delayTime", "feedback", "wet");
      }
    },
    Reverb: class Reverb extends Base {
      ready: Promise<void>;
      release!: () => void;
      constructor(o: Record<string, unknown>) {
        super(o, "wet");
        this.ready = new Promise((resolve) => {
          this.release = resolve;
        });
      }
    },
  };
  return classes as never;
}

const nodes = (type: string) => (h.nodes as MockNode[]).filter((n) => n.type === type);
const reverbs = () => nodes("Reverb");
const gainRamps = (n: MockNode) => n.params.gain.ramps;

const withEffects = (over: Partial<ResolvedEffects>): ResolvedEffects => ({ ...EFFECT_DEFAULTS, ...over });
const reverbOn = (decayS: number, mix = 0.3) => withEffects({ reverb: { enabled: true, decayS, mix } });

beforeEach(() => {
  h.nodes = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

// Lets a pending `ready` continuation run without advancing timers.
const flush = () => Promise.resolve().then(() => Promise.resolve());

describe("insert chain laziness", () => {
  it("builds only its two end gains until something is enabled", () => {
    const chain = createInsertChain(makeTone());
    chain.apply(EFFECT_DEFAULTS, 120);
    expect(h.nodes).toHaveLength(2);
  });
});

describe("insert chain reverb", () => {
  it("waits out the debounce before regenerating the impulse response", () => {
    const chain = createInsertChain(makeTone());
    chain.apply(reverbOn(2.5), 120);
    chain.apply(reverbOn(4), 120);
    chain.apply(reverbOn(5), 120);
    expect(reverbs()).toHaveLength(1);
    vi.advanceTimersByTime(REVERB_DEBOUNCE_MS - 1);
    expect(reverbs()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(reverbs()).toHaveLength(2);
    expect(reverbs()[1].opts.decay).toBe(5);
  });

  it("crossfades to the rebuilt tank and disposes the old one after the fade", async () => {
    const chain = createInsertChain(makeTone());
    chain.apply(reverbOn(2.5), 120);
    chain.apply(reverbOn(4), 120);
    vi.advanceTimersByTime(REVERB_DEBOUNCE_MS);
    const [oldTank, next] = reverbs();
    next.release?.();
    await flush();

    const fades = (nodes("Gain") as MockNode[]).filter((n) => gainRamps(n).some(([, t]) => t === 0.1));
    expect(fades.map((n) => gainRamps(n).at(-1)![0]).sort()).toEqual([0, 1]);
    expect(oldTank.disposed).toBe(false);
    vi.advanceTimersByTime(200);
    expect(oldTank.disposed).toBe(true);
    expect(next.disposed).toBe(false);
  });

  it("feeds the new tank from the start and fades only its output", () => {
    const chain = createInsertChain(makeTone());
    chain.apply(reverbOn(2.5), 120);
    chain.apply(reverbOn(4), 120);
    vi.advanceTimersByTime(REVERB_DEBOUNCE_MS);
    // The newest Gain is the new tank's output fade, created silent; no input-side gain was added to gate it.
    const gains = nodes("Gain") as MockNode[];
    expect(gains.at(-1)!.opts.value).toBe(0);
    expect(gains).toHaveLength(8);
  });

  it("discards a build that finishes after the decay returned to the current value", async () => {
    const chain = createInsertChain(makeTone());
    chain.apply(reverbOn(2.5), 120);
    chain.apply(reverbOn(4), 120);
    vi.advanceTimersByTime(REVERB_DEBOUNCE_MS);
    const next = reverbs()[1];
    chain.apply(reverbOn(2.5), 120);
    next.release?.();
    await flush();
    expect(next.disposed).toBe(true);
    expect(reverbs()[0].disposed).toBe(false);
  });

  it("discards a build superseded by a newer decay and keeps the newest", async () => {
    const chain = createInsertChain(makeTone());
    chain.apply(reverbOn(2.5), 120);
    chain.apply(reverbOn(4), 120);
    vi.advanceTimersByTime(REVERB_DEBOUNCE_MS);
    chain.apply(reverbOn(6), 120);
    vi.advanceTimersByTime(REVERB_DEBOUNCE_MS);
    const [, stale, newest] = reverbs();
    stale.release?.();
    newest.release?.();
    await flush();
    expect(stale.disposed).toBe(true);
    expect(newest.disposed).toBe(false);
  });

  it("does not restart a build already running for the wanted decay", () => {
    const chain = createInsertChain(makeTone());
    chain.apply(reverbOn(2.5), 120);
    chain.apply(reverbOn(4), 120);
    vi.advanceTimersByTime(REVERB_DEBOUNCE_MS);
    chain.apply(reverbOn(4, 0.6), 120);
    vi.advanceTimersByTime(REVERB_DEBOUNCE_MS * 2);
    expect(reverbs()).toHaveLength(2);
  });

  it("leaves the dry signal alone until the first impulse response exists", async () => {
    const chain = createInsertChain(makeTone());
    chain.apply(reverbOn(2.5, 1), 120);
    const dryRamps = () => (nodes("Gain") as MockNode[]).flatMap((n) => gainRamps(n));
    expect(dryRamps()).toEqual([]);
    reverbs()[0].release?.();
    await flush();
    expect(dryRamps()).toContainEqual([0, 0.02]);
  });
});

describe("insert chain EQ, distortion, chorus", () => {
  it("uses biquad shelves and a peak that return to 0 dB when disabled", () => {
    const chain = createInsertChain(makeTone());
    const eq = { enabled: true, lowDb: 5, midDb: 5, highDb: 5 };
    chain.apply(withEffects({ eq }), 120);
    chain.apply(withEffects({ eq: { ...eq, enabled: false } }), 120);
    expect(nodes("Filter").map((n) => n.opts.type)).toEqual(["lowshelf", "peaking", "highshelf"]);
    expect(nodes("Filter").map((n) => n.params.gain.ramps.at(-1)![0])).toEqual([0, 0, 0]);
  });

  it("crossfades between two shapers on a drive change instead of reshaping the live one", () => {
    const chain = createInsertChain(makeTone());
    const base = { enabled: true, drive: 0.4, mix: 0.5 };
    chain.apply(withEffects({ distortion: base }), 120);
    chain.apply(withEffects({ distortion: { ...base, drive: 0.9 } }), 120);
    const [live, idle] = nodes("Distortion");
    expect(live.distortion).toBe(0.4);
    expect(idle.distortion).toBe(0.9);
  });

  it("holds a drive requested mid-fade until the fade ends", () => {
    const chain = createInsertChain(makeTone());
    const base = { enabled: true, drive: 0.4, mix: 0.5 };
    chain.apply(withEffects({ distortion: base }), 120);
    chain.apply(withEffects({ distortion: { ...base, drive: 0.9 } }), 120);
    chain.apply(withEffects({ distortion: { ...base, drive: 0.2 } }), 120);
    const [first, second] = nodes("Distortion");
    expect(first.distortion).toBe(0.4);
    vi.advanceTimersByTime(30);
    expect(first.distortion).toBe(0.2);
    expect(second.distortion).toBe(0.9);
  });

  it("applies makeup gain to the processed path only, leaving dry at 1 - mix", () => {
    const chain = createInsertChain(makeTone());
    chain.apply(withEffects({ distortion: { enabled: true, drive: 1, mix: 0.5 } }), 120);
    const ramps = (nodes("Gain") as MockNode[]).flatMap((n) => gainRamps(n).map(([v]) => v));
    // Dry is 1 - mix; the wet path carries mix * (0.5 + 0.5 * (1 - drive)).
    expect(ramps).toContain(0.5);
    expect(ramps).toContain(0.25);
  });

  it("glides chorus depth in small steps instead of jumping", () => {
    const chain = createInsertChain(makeTone());
    const base = { enabled: true, rateHz: 1.5, depth: 0.2, mix: 0.5 };
    chain.apply(withEffects({ chorus: base }), 120);
    chain.apply(withEffects({ chorus: { ...base, depth: 1 } }), 120);
    const [node] = nodes("Chorus");
    vi.advanceTimersByTime(5);
    expect(node.depth).toBeGreaterThan(0.2);
    expect(node.depth).toBeLessThan(1);
    vi.advanceTimersByTime(30);
    expect(node.depth).toBeCloseTo(1);
  });

  it("ends on the drive the user returned to when it matches the one already swapped in", () => {
    const chain = createInsertChain(makeTone());
    const base = { enabled: true, drive: 0.4, mix: 0.5 };
    chain.apply(withEffects({ distortion: base }), 120);
    chain.apply(withEffects({ distortion: { ...base, drive: 0.41 } }), 120);
    chain.apply(withEffects({ distortion: { ...base, drive: 0.42 } }), 120);
    chain.apply(withEffects({ distortion: { ...base, drive: 0.41 } }), 120);
    vi.advanceTimersByTime(100);
    const [a, b] = nodes("Distortion");
    expect(a.distortion).toBe(0.4);
    expect(b.distortion).toBe(0.41);
  });

  it("still glides to a depth that equals an intermediate step of the previous glide", () => {
    const chain = createInsertChain(makeTone());
    const base = { enabled: true, rateHz: 1.5, depth: 0.2, mix: 0.5 };
    chain.apply(withEffects({ chorus: base }), 120);
    chain.apply(withEffects({ chorus: { ...base, depth: 1 } }), 120);
    vi.advanceTimersByTime(5);
    const [node] = nodes("Chorus");
    const midway = node.depth!;
    chain.apply(withEffects({ chorus: { ...base, depth: midway } }), 120);
    vi.advanceTimersByTime(100);
    expect(node.depth).toBeCloseTo(midway);
  });
});
