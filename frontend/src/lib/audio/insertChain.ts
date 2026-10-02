import type { DelayTime, ResolvedEffects } from "./voiceSound";

type ToneModule = typeof import("tone");
type Node = import("tone").ToneAudioNode;

// Short enough to meet the 50 ms live-edit budget, long enough that a jump never clicks.
export const EFFECT_RAMP_SECONDS = 0.02;

// Dragging decay would otherwise regenerate the impulse response, which is expensive, on every pixel.
export const REVERB_DEBOUNCE_MS = 150;
const REVERB_CROSSFADE_SECONDS = 0.1;

// A 1/2 note at slow tempos exceeds Tone's 1 s default, which would silently clamp the echo time.
const MAX_DELAY_SECONDS = 4;

const DELAY_BEATS: Record<DelayTime, number> = {
  "1/16": 0.25,
  "1/8": 0.5,
  "1/8d": 0.75,
  "1/4": 1,
  "1/2": 2,
};

// Computed from the tempo the engine is playing at: it frames bars itself and never sets Tone's transport BPM.
export const delaySeconds = (time: DelayTime, bpm: number) =>
  Math.min(MAX_DELAY_SECONDS, (DELAY_BEATS[time] * 60) / bpm);

interface Stage<P> {
  input: Node;
  output: Node;
  // `at` is the scheduling time when called from inside a transport callback, where Tone requires it.
  apply(params: P, bpm: number, at?: number): void;
  // Only stages that build something slowly have anything to wait for.
  ready?(): Promise<void>;
  dispose(): void;
}

type Slot<P> = { stage: Stage<P> | null; applied: string };

export interface InsertChain {
  // A fixed entry point lets a source be built before any stage exists, since stages are spliced in behind it later.
  input: Node;
  // A fixed exit point so consumers can connect once and never see stages come and go.
  output: Node;
  apply(effects: ResolvedEffects, bpm: number, at?: number): void;
  // An offline render starts at once and cannot wait for a reverb's impulse response the way live playback can.
  ready(): Promise<void>;
  dispose(): void;
}

// Steps this small sound continuous while the parameter has no ramp of its own to ride.
const GLIDE_STEP_MS = 5;

// Chorus depth and the distortion curve are plain setters with no audio-rate smoothing, so a jump is
// audible as a click; stepping toward the target spreads it over the ramp time.
function glide(initial: number, read: () => number, write: (v: number) => void) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let wanted = initial;
  return {
    // Compared against this, not the live value: a target that equals an intermediate step is still a change.
    target: () => wanted,
    to(target: number) {
      wanted = target;
      if (timer) clearInterval(timer);
      const from = read();
      const steps = Math.max(1, Math.round((EFFECT_RAMP_SECONDS * 1000) / GLIDE_STEP_MS));
      let i = 0;
      timer = setInterval(() => {
        i += 1;
        write(from + ((target - from) * i) / steps);
        if (i >= steps && timer) {
          clearInterval(timer);
          timer = null;
        }
      }, GLIDE_STEP_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// Shelves and a peak are used instead of Tone's EQ3 because a biquad at 0 dB is exactly flat, whereas
// EQ3 splits the band with matched low and high pass filters that leave notches at the crossovers even
// when every gain is zero, which would color a track whose EQ was switched off.
const EQ_LOW_HZ = 400;
const EQ_MID_HZ = 1000;
const EQ_HIGH_HZ = 2500;

const eq = (t: ToneModule): Stage<ResolvedEffects["eq"]> => {
  const low = new t.Filter({ type: "lowshelf", frequency: EQ_LOW_HZ, gain: 0 });
  const mid = new t.Filter({ type: "peaking", frequency: EQ_MID_HZ, Q: 0.7, gain: 0 });
  const high = new t.Filter({ type: "highshelf", frequency: EQ_HIGH_HZ, gain: 0 });
  low.connect(mid);
  mid.connect(high);
  return {
    input: low,
    output: high,
    apply(p, _bpm, at) {
      low.gain.rampTo(p.enabled ? p.lowDb : 0, EFFECT_RAMP_SECONDS, at);
      mid.gain.rampTo(p.enabled ? p.midDb : 0, EFFECT_RAMP_SECONDS, at);
      high.gain.rampTo(p.enabled ? p.highDb : 0, EFFECT_RAMP_SECONDS, at);
    },
    dispose() {
      [low, mid, high].forEach((n) => n.dispose());
    },
  };
};

// Two shapers alternate: the idle one gets the new drive while silent, then the pair crossfade, because
// reshaping a live waveshaper's curve steps its output and clicks.
const distortion = (t: ToneModule, initial: ResolvedEffects["distortion"]): Stage<ResolvedEffects["distortion"]> => {
  const input = new t.Gain(1);
  const output = new t.Gain(1);
  const dry = new t.Gain(1);
  // Compensation sits on the processed path only; after the mix it would also quieten the dry signal.
  const makeup = new t.Gain(0);
  input.connect(dry);
  dry.connect(output);
  makeup.connect(output);
  const shapers = [0, 1].map((i) => {
    const node = new t.Distortion({ distortion: initial.drive, wet: 1 });
    const level = new t.Gain(i === 0 ? 1 : 0);
    input.connect(node);
    node.connect(level);
    level.connect(makeup);
    return { node, level };
  });
  let active = 0;
  let drive = initial.drive;
  let pending: number | null = null;
  let fading: ReturnType<typeof setTimeout> | null = null;

  const swapTo = (next: number, at?: number) => {
    const idle = 1 - active;
    shapers[idle].node.distortion = next;
    shapers[idle].level.gain.rampTo(1, EFFECT_RAMP_SECONDS, at);
    shapers[active].level.gain.rampTo(0, EFFECT_RAMP_SECONDS, at);
    active = idle;
    drive = next;
    // A drag asks for a new drive faster than the fade; the shaper that is still fading out must not be reshaped mid-fade.
    fading = setTimeout(() => {
      fading = null;
      if (pending !== null && pending !== drive) {
        const queued = pending;
        pending = null;
        swapTo(queued);
      }
    }, EFFECT_RAMP_SECONDS * 1000 + 5);
  };

  return {
    input,
    output,
    apply(p, _bpm, at) {
      if (p.drive !== drive || (fading && pending !== null)) {
        // Returning to the drive already swapped in must cancel a queued in-between value, or the chain ends on it.
        if (fading) pending = p.drive === drive ? null : p.drive;
        else swapTo(p.drive, at);
      }
      const compensation = 0.5 + 0.5 * (1 - p.drive);
      const wet = p.enabled ? p.mix : 0;
      dry.gain.rampTo(1 - wet, EFFECT_RAMP_SECONDS, at);
      makeup.gain.rampTo(wet * compensation, EFFECT_RAMP_SECONDS, at);
    },
    dispose() {
      if (fading) clearTimeout(fading);
      shapers.forEach((s) => {
        s.node.dispose();
        s.level.dispose();
      });
      [input, output, dry, makeup].forEach((n) => n.dispose());
    },
  };
};

const chorus = (t: ToneModule, initial: ResolvedEffects["chorus"]): Stage<ResolvedEffects["chorus"]> => {
  // The LFO is silent until started.
  const node = new t.Chorus({ frequency: initial.rateHz, delayTime: 3.5, depth: initial.depth, wet: 0 }).start();
  const depth = glide(
    initial.depth,
    () => node.depth,
    (v) => {
      node.depth = v;
    },
  );
  return {
    input: node,
    output: node,
    apply(p, _bpm, at) {
      node.frequency.rampTo(p.rateHz, EFFECT_RAMP_SECONDS, at);
      if (p.depth !== depth.target()) depth.to(p.depth);
      node.wet.rampTo(p.enabled ? p.mix : 0, EFFECT_RAMP_SECONDS, at);
    },
    dispose() {
      depth.cancel();
      node.dispose();
    },
  };
};

const delay = (t: ToneModule): Stage<ResolvedEffects["delay"]> => {
  const node = new t.FeedbackDelay({ delayTime: 0.25, feedback: 0, maxDelay: MAX_DELAY_SECONDS, wet: 0 });
  return {
    input: node,
    output: node,
    apply(p, bpm, at) {
      node.delayTime.rampTo(delaySeconds(p.time, bpm), EFFECT_RAMP_SECONDS, at);
      node.feedback.rampTo(p.feedback, EFFECT_RAMP_SECONDS, at);
      node.wet.rampTo(p.enabled ? p.mix : 0, EFFECT_RAMP_SECONDS, at);
    },
    dispose: () => node.dispose(),
  };
};

// Built from fully wet convolvers behind a dry/send split, rather than Reverb's own wet control, because
// crossfading two reverbs that each pass the dry signal would double it for the length of the fade.
const reverb = (t: ToneModule, initial: ResolvedEffects["reverb"]): Stage<ResolvedEffects["reverb"]> => {
  const input = new t.Gain(1);
  const output = new t.Gain(1);
  const dry = new t.Gain(1);
  const send = new t.Gain(0);
  input.connect(dry);
  dry.connect(output);
  input.connect(send);

  interface Tank {
    node: InstanceType<ToneModule["Reverb"]>;
    fade: InstanceType<ToneModule["Gain"]>;
    decayS: number;
  }
  // Fading the output rather than the input lets a new tank hear the signal from the moment it exists,
  // so its tail is already built when it fades in instead of starting from silence.
  const makeTank = (decayS: number, level: number): Tank => {
    const fade = new t.Gain(level);
    const node = new t.Reverb({ decay: decayS, wet: 1 });
    send.connect(node);
    node.connect(fade);
    fade.connect(output);
    return { node, fade, decayS };
  };
  const disposeTank = (tank: Tank) => {
    tank.node.dispose();
    tank.fade.dispose();
  };

  let tank = makeTank(initial.decayS, 1);
  let ready = false;
  let latest: ResolvedEffects["reverb"] = initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // Bumped to invalidate a build whose result is no longer wanted.
  let building = 0;
  let inFlight: number | null = null;

  // The impulse response is generated asynchronously, so the dry level is left alone until it exists;
  // otherwise enabling would dip the sound for the length of the generation.
  const settle = (at?: number) => {
    if (!ready) return;
    const wet = latest.enabled ? latest.mix : 0;
    send.gain.rampTo(wet, EFFECT_RAMP_SECONDS, at);
    dry.gain.rampTo(1 - wet, EFFECT_RAMP_SECONDS, at);
  };
  const firstReady = tank.node.ready.then(() => {
    if (disposed) return;
    ready = true;
    settle();
  });

  const rebuild = async (decayS: number) => {
    const ticket = ++building;
    inFlight = decayS;
    const next = makeTank(decayS, 0);
    await next.node.ready;
    if (ticket === building) inFlight = null;
    // The user may have moved the decay again, or back to the current value (an undo), while the
    // impulse response was generated; swapping in the stale one would leave the wrong tail length.
    if (disposed || ticket !== building || latest.decayS !== decayS) {
      disposeTank(next);
      return;
    }
    const old = tank;
    tank = next;
    next.fade.gain.rampTo(1, REVERB_CROSSFADE_SECONDS);
    old.fade.gain.rampTo(0, REVERB_CROSSFADE_SECONDS);
    setTimeout(() => disposeTank(old), REVERB_CROSSFADE_SECONDS * 1000 + 50);
  };

  return {
    input,
    output,
    ready: () => firstReady,
    apply(p, _bpm, at) {
      latest = p;
      settle(at);
      if (timer) clearTimeout(timer);
      timer = null;
      if (p.decayS === tank.decayS) {
        building += 1;
        inFlight = null;
        return;
      }
      // A build already running for this decay would only be restarted, wasting an impulse-response generation.
      if (p.decayS === inFlight) return;
      timer = setTimeout(() => {
        timer = null;
        if (latest.decayS !== tank.decayS) void rebuild(latest.decayS);
      }, REVERB_DEBOUNCE_MS);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      disposeTank(tank);
      [input, output, dry, send].forEach((n) => n.dispose());
    },
  };
};

type Factory = (t: ToneModule, initial: never) => Stage<never>;

const ORDER = ["eq", "distortion", "chorus", "delay", "reverb"] as const;
const FACTORIES: Record<(typeof ORDER)[number], Factory> = {
  eq: eq as Factory,
  distortion: distortion as Factory,
  chorus: chorus as Factory,
  delay: delay as Factory,
  reverb: reverb as Factory,
};

// Nodes are created the first time a stage is enabled, because a Reverb generates an impulse response
// and a Chorus runs an LFO, which would be wasted on the common track with no effects. Once built a stage
// stays, so later toggles are ramps rather than graph changes.
export function createInsertChain(t: ToneModule): InsertChain {
  const input = new t.Gain(1);
  const output = new t.Gain(1);
  input.connect(output);

  const slots = new Map<string, Slot<never>>(ORDER.map((k) => [k, { stage: null, applied: "" }]));

  const rewire = () => {
    input.disconnect();
    const built = ORDER.flatMap((k) => {
      const s = slots.get(k)?.stage;
      return s ? [s] : [];
    });
    built.forEach((s) => s.output.disconnect());
    let previous: Node = input;
    for (const s of built) {
      previous.connect(s.input);
      previous = s.output;
    }
    previous.connect(output);
  };

  return {
    input,
    output,
    async ready() {
      await Promise.all([...slots.values()].map((slot) => slot.stage?.ready?.()));
    },
    apply(effects, bpm, at) {
      let created = false;
      for (const key of ORDER) {
        const slot = slots.get(key)!;
        const params = effects[key];
        if (!slot.stage) {
          if (!params.enabled) continue;
          slot.stage = FACTORIES[key](t, params as never);
          created = true;
        }
        // Delay time depends on tempo, so the tempo is part of what makes a stage's settings "changed".
        const signature = JSON.stringify(key === "delay" ? [params, bpm] : params);
        if (signature === slot.applied) continue;
        slot.applied = signature;
        (slot.stage as Stage<unknown>).apply(params, bpm, at);
      }
      if (created) rewire();
    },
    dispose() {
      for (const slot of slots.values()) slot.stage?.dispose();
      input.dispose();
      output.dispose();
    },
  };
}
