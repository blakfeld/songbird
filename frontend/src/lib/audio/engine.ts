import type { Pattern } from "@/generated/Pattern";
import type { Row } from "@/generated/Row";
import { getPatternStore, type PatternStore } from "@/lib/patternStore";
import { stepToSeconds } from "@/lib/timing";
import { getSoundSourceFactory } from "./registry";
import type { LoopRange, Playback, PlaybackStatus, SoundSource } from "./types";

type ToneModule = typeof import("tone");

// Small head start so the first tick is scheduled before the transport
// reaches it.
const START_DELAY = "+0.05";

// Steps are read from the store only this far before they sound, so a live
// edit is missed only if made within this window of the step playing.
const LOOKAHEAD_SECONDS = 0.1;
const TICK_SECONDS = 0.025;

const AUDITION_DELAY_SECONDS = 0.01;
const AUDITION_SECONDS = 0.5;
const AUDITION_VELOCITY = 100;

// Tempo and swing are frozen per bar so step times within a bar stay
// consistent even if the user edits them mid-bar.
interface ScheduledBar {
  transportStart: number;
  duration: number;
  firstStep: number;
  steps: number;
  tempo: number;
  swing: number;
  measure: number;
}

// Enough to cover the gap between what is scheduled and what is audible.
const BARS_KEPT = 3;

export type PlaybackSnapshot = Pick<Playback, "isPlaying" | "status" | "error">;

export interface PlaybackEngine extends Playback {
  setLoop(range: LoopRange | null): void;
  audition(row: Row): Promise<void>;
  getSnapshot(): PlaybackSnapshot;
  subscribe(cb: () => void): () => void;
}

export interface EngineDeps {
  store?: PatternStore;
  // Deferred so importing this module never touches the AudioContext (SSR).
  loadTone?: () => Promise<ToneModule>;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
}

export function createPlaybackEngine(
  instrumentId: string,
  deps: EngineDeps = {},
): PlaybackEngine {
  const store = deps.store ?? getPatternStore(instrumentId);
  const loadTone = deps.loadTone ?? (() => import("tone"));
  const requestFrame =
    deps.requestFrame ?? ((cb) => window.requestAnimationFrame(cb));
  const cancelFrame =
    deps.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));

  let snapshot: PlaybackSnapshot = { isPlaying: false, status: "idle", error: null };
  const listeners = new Set<() => void>();
  const positionListeners = new Set<(step: number | null) => void>();

  let loop: LoopRange | null = null;
  let tone: ToneModule | null = null;
  let source: SoundSource | null = null;
  let bars: ScheduledBar[] = [];
  let nextBarStart = 0;
  let stepInBar = 0;
  let tickTime = 0;
  let lastEmitted: number | null = null;
  let frame: number | null = null;
  // Invalidates an in-flight play() when stop() lands during loading.
  let session = 0;

  const setSnapshot = (patch: Partial<PlaybackSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => l());
  };

  const emitPosition = (step: number | null) => {
    if (step === lastEmitted) return;
    lastEmitted = step;
    positionListeners.forEach((cb) => cb(step));
  };

  const getPosition = (): number | null => {
    if (!tone) return null;
    // The audio clock, not Transport.seconds, which runs ahead by the
    // scheduler's lookahead and would make the playhead lead the sound.
    const t = tone
      .getTransport()
      .getSecondsAtTime(tone.getContext().currentTime);
    let current: ScheduledBar | undefined;
    for (const bar of bars) if (bar.transportStart <= t) current = bar;
    if (!current) return null;
    const elapsed = t - current.transportStart;
    let rel = 0;
    while (
      rel + 1 < current.steps &&
      stepToSeconds(rel + 1, current.tempo, current.swing) <= elapsed
    ) {
      rel += 1;
    }
    return current.firstStep + rel;
  };

  const frameLoop = () => {
    emitPosition(getPosition());
    if (snapshot.isPlaying) frame = requestFrame(frameLoop);
  };

  // Deriving the next measure from the current one (rather than a running
  // counter) keeps a loop-range change mid-play landing inside the new range.
  const nextMeasure = (pattern: Pattern, current: number | null) => {
    const start = Math.min(Math.max(loop?.start ?? 1, 1), pattern.measures);
    const end = Math.min(
      Math.max(loop?.end ?? pattern.measures, start),
      pattern.measures,
    );
    if (current === null || current + 1 < start || current + 1 > end) return start;
    return current + 1;
  };

  const startBar = (pattern: Pattern) => {
    const previous = bars.at(-1)?.measure ?? null;
    const measure = nextMeasure(pattern, previous);
    const steps = pattern.steps_per_measure;
    const tempo = pattern.tempo_bpm;
    // Steps per measure is even, so swing delays cancel at each barline.
    const duration = stepToSeconds(steps, tempo, 0);
    bars = [
      ...bars,
      {
        transportStart: nextBarStart,
        duration,
        firstStep: (measure - 1) * steps,
        steps,
        tempo,
        swing: pattern.swing,
        measure,
      },
    ].slice(-BARS_KEPT);
    nextBarStart += duration;
    stepInBar = 0;
  };

  const scheduleStep = (
    active: SoundSource,
    pattern: Pattern,
    bar: ScheduledBar,
    audioTime: number,
  ) => {
    const absStep = bar.firstStep + stepInBar;
    const offset = stepToSeconds(stepInBar, bar.tempo, bar.swing);
    for (const note of pattern.notes) {
      if (note.step !== absStep) continue;
      const row = pattern.rows.find((r) => r.id === note.row_id);
      if (!row) continue;
      const length =
        stepToSeconds(stepInBar + note.length_steps, bar.tempo, bar.swing) -
        offset;
      active.trigger(row, audioTime, audioTime + length, note.velocity);
    }
  };

  // Steps are scheduled step by step, just ahead of time, and each step
  // re-reads the store so edits are heard the next time that step plays.
  const tick = (active: SoundSource, mySession: number, audioNow: number) => {
    if (mySession !== session || !tone) return;
    const horizon = tickTime + LOOKAHEAD_SECONDS;
    for (;;) {
      const bar = bars.at(-1);
      const atBoundary = !bar || stepInBar >= bar.steps;
      const stepTime = atBoundary
        ? nextBarStart
        : bar.transportStart + stepToSeconds(stepInBar, bar.tempo, bar.swing);
      if (stepTime > horizon) break;

      const pattern = store.getState().pattern;
      if (!pattern) {
        stop();
        return;
      }
      if (atBoundary) startBar(pattern);
      const current = bars.at(-1)!;
      scheduleStep(active, pattern, current, audioNow + (stepTime - tickTime));
      stepInBar += 1;
    }
    tickTime += TICK_SECONDS;
    tone
      .getTransport()
      .scheduleOnce((t) => tick(active, mySession, t), tickTime);
  };

  const ensureSource = (t: ToneModule) => {
    return (source ??= getSoundSourceFactory(instrumentId)(t));
  };

  const play = async () => {
    const pattern = store.getState().pattern;
    if (!pattern || snapshot.status === "loading") return;
    const mySession = ++session;
    // Started before any await so it still counts as part of the user
    // gesture; browsers may leave the context suspended otherwise.
    const alreadyStarted = tone?.start();
    setSnapshot({ status: "loading", error: null });
    try {
      const t = (tone ??= await loadTone());
      await (alreadyStarted ?? t.start());
      const active = ensureSource(t);
      await active.load(pattern.rows);
      if (mySession !== session) return;

      const transport = t.getTransport();
      transport.stop();
      transport.cancel();
      transport.seconds = 0;
      bars = [];
      nextBarStart = 0;
      stepInBar = 0;
      tickTime = 0;
      lastEmitted = null;
      transport.scheduleOnce((time) => tick(active, mySession, time), 0);
      transport.start(START_DELAY);
      setSnapshot({ status: "ready", isPlaying: true });
      frame = requestFrame(frameLoop);
    } catch (e) {
      if (mySession === session) {
        setSnapshot({
          status: "error",
          isPlaying: false,
          error: e instanceof Error ? e.message : "Audio failed to start",
        });
      }
    }
  };

  function stop() {
    session += 1;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    if (tone) {
      const transport = tone.getTransport();
      transport.stop();
      transport.cancel();
    }
    source?.stopAll();
    bars = [];
    if (snapshot.isPlaying || snapshot.status === "loading") {
      setSnapshot({ isPlaying: false, status: "idle" });
    }
    emitPosition(null);
  }

  return {
    get isPlaying() {
      return snapshot.isPlaying;
    },
    get status(): PlaybackStatus {
      return snapshot.status;
    },
    get error() {
      return snapshot.error;
    },
    toggle() {
      if (snapshot.isPlaying || snapshot.status === "loading") stop();
      else void play();
    },
    stop,
    async preload(rows?: Row[]) {
      // Errors are left for play() to surface; warming is best-effort.
      try {
        const t = (tone ??= await loadTone());
        const kitRows = rows ?? store.getState().pattern?.rows;
        if (kitRows) await ensureSource(t).load(kitRows);
      } catch {}
    },
    setLoop(range) {
      loop = range;
    },
    async audition(row) {
      // Started before any await for the same user-gesture reason as play().
      const alreadyStarted = tone?.start();
      try {
        const t = (tone ??= await loadTone());
        await (alreadyStarted ?? t.start());
        const active = ensureSource(t);
        await active.load([row]);
        const start = t.getContext().currentTime + AUDITION_DELAY_SECONDS;
        active.trigger(row, start, start + AUDITION_SECONDS, AUDITION_VELOCITY);
      } catch {
        // Best-effort: Play is where audio failures are surfaced to the user.
      }
    },
    subscribePosition(cb) {
      positionListeners.add(cb);
      return () => positionListeners.delete(cb);
    },
    getSnapshot: () => snapshot,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const engines = new Map<string, PlaybackEngine>();

export function getPlaybackEngine(instrumentId: string): PlaybackEngine {
  let engine = engines.get(instrumentId);
  if (!engine) {
    engine = createPlaybackEngine(instrumentId);
    engines.set(instrumentId, engine);
  }
  return engine;
}
