import type { Row } from "@/generated/Row";
import { stepToSeconds } from "@/lib/timing";
import { createPatternPlaybackModel } from "./patternPlaybackModel";
import { getSoundSourceFactory } from "./registry";
import type {
  LoopRange,
  Playback,
  PlaybackModel,
  PlaybackStatus,
  PlaybackTiming,
  SoundSource,
  Voice,
} from "./types";

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

// Short enough to meet the 50 ms mixer response without audible clicks.
const MIXER_RAMP_SECONDS = 0.02;

// Finite rather than -Infinity so the dB-to-gain ramp stays well defined.
const SILENT_DB = -100;

// Long enough for the fade-out ramp to finish before the channel is torn down.
const DISPOSE_DELAY_MS = 100;

const targetDb = (voice: Voice) => (voice.audible ? voice.volumeDb : SILENT_DB);

interface VoiceChannel {
  instrument: string;
  source: SoundSource;
  channel: InstanceType<ToneModule["Channel"]>;
  volumeDb: number;
  pan: number;
}

export interface AuditionOptions {
  // Routes through that voice's channel so its volume and pan apply.
  voiceKey?: string;
  velocity?: number;
}

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
  audition(row: Row, options?: AuditionOptions): Promise<void>;
  dispose(): void;
  getSnapshot(): PlaybackSnapshot;
  subscribe(cb: () => void): () => void;
}

export interface EngineDeps {
  // Deferred so importing this module never touches the AudioContext (SSR).
  loadTone?: () => Promise<ToneModule>;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
}

export function createPlaybackEngine(
  model: PlaybackModel,
  deps: EngineDeps = {},
): PlaybackEngine {
  const loadTone = deps.loadTone ?? (() => import("tone"));
  const requestFrame =
    deps.requestFrame ?? ((cb) => window.requestAnimationFrame(cb));
  const cancelFrame =
    deps.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));

  let snapshot: PlaybackSnapshot = { isPlaying: false, status: "idle", error: null };
  const listeners = new Set<() => void>();
  const positionListeners = new Set<(step: number | null) => void>();

  let loop: LoopRange | null = null;
  // Consumed by the next bar so a seek lands on a bar boundary, and survives until Play when idle.
  let jumpTo: number | null = null;
  let tone: ToneModule | null = null;
  const channels = new Map<string, VoiceChannel>();
  // Separate from `channels` because the scheduler's mute floor would otherwise fade a preview out mid-note.
  const previews = new Map<string, VoiceChannel>();
  const auditionSources = new Map<string, SoundSource>();
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
  const nextMeasure = (timing: PlaybackTiming, current: number | null) => {
    const start = Math.min(Math.max(loop?.start ?? 1, 1), timing.measures);
    const end = Math.min(
      Math.max(loop?.end ?? timing.measures, start),
      timing.measures,
    );
    if (current === null || current + 1 < start || current + 1 > end) return start;
    return current + 1;
  };

  const startBar = (timing: PlaybackTiming) => {
    const previous = bars.at(-1)?.measure ?? null;
    const measure =
      jumpTo === null ? nextMeasure(timing, previous) : Math.min(Math.max(jumpTo, 1), timing.measures);
    jumpTo = null;
    const steps = timing.stepsPerMeasure;
    const tempo = timing.tempo;
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
        swing: timing.swing,
        measure,
      },
    ].slice(-BARS_KEPT);
    nextBarStart += duration;
    stepInBar = 0;
  };

  // Fading first, then disposing later, avoids a click from cutting a channel that is still sounding.
  const disposeVoice = (entry: VoiceChannel, immediate = false) => {
    if (entry.source.dispose) entry.source.dispose();
    else entry.source.stopAll();
    if (immediate) {
      entry.channel.dispose();
      return;
    }
    entry.channel.volume.rampTo(SILENT_DB, MIXER_RAMP_SECONDS);
    setTimeout(() => entry.channel.dispose(), DISPOSE_DELAY_MS);
  };

  const applyMixer = (entry: VoiceChannel, voice: Voice) => {
    const db = targetDb(voice);
    if (entry.volumeDb !== db) {
      entry.channel.volume.rampTo(db, MIXER_RAMP_SECONDS);
      entry.volumeDb = db;
    }
    if (entry.pan !== voice.pan) {
      entry.channel.pan.rampTo(voice.pan, MIXER_RAMP_SECONDS);
      entry.pan = voice.pan;
    }
  };

  const makeEntry = (t: ToneModule, voice: Voice, db: number): VoiceChannel => {
    const channel = new t.Channel({ volume: db, pan: voice.pan }).toDestination();
    return {
      instrument: voice.instrument,
      source: getSoundSourceFactory(voice.instrument)(t, channel),
      channel,
      volumeDb: db,
      pan: voice.pan,
    };
  };

  // Created lazily and per key so a voice added mid-play needs no restart, and
  // rebuilt when its instrument changes because the source is instrument-bound.
  const ensureVoice = (t: ToneModule, voice: Voice): VoiceChannel => {
    let entry = channels.get(voice.key);
    if (entry && entry.instrument !== voice.instrument) {
      disposeVoice(entry);
      channels.delete(voice.key);
      entry = undefined;
    }
    if (!entry) {
      entry = makeEntry(t, voice, targetDb(voice));
      channels.set(voice.key, entry);
      // Best-effort: a voice added mid-play stays silent until its samples
      // arrive, and Play is where load failures are surfaced.
      void entry.source.load(voice.rows).catch(() => {});
    } else {
      applyMixer(entry, voice);
    }
    return entry;
  };

  // A preview must be heard even on a muted or soloed-out track, but still through its volume and pan.
  const previewVoice = (t: ToneModule, voice: Voice): VoiceChannel => {
    let entry = previews.get(voice.key);
    if (entry && entry.instrument !== voice.instrument) {
      disposeVoice(entry);
      previews.delete(voice.key);
      entry = undefined;
    }
    if (!entry) {
      entry = makeEntry(t, voice, voice.volumeDb);
      previews.set(voice.key, entry);
    } else {
      entry.channel.volume.rampTo(voice.volumeDb, MIXER_RAMP_SECONDS);
      entry.channel.pan.rampTo(voice.pan, MIXER_RAMP_SECONDS);
      entry.volumeDb = voice.volumeDb;
      entry.pan = voice.pan;
    }
    return entry;
  };

  const syncVoices = (t: ToneModule, voices: Voice[]) => {
    const keys = new Set(voices.map((v) => v.key));
    for (const [key, entry] of channels) {
      if (keys.has(key)) continue;
      disposeVoice(entry);
      channels.delete(key);
    }
    return voices.map((voice) => ({ voice, entry: ensureVoice(t, voice) }));
  };

  const scheduleStep = (
    voices: { voice: Voice; entry: VoiceChannel }[],
    bar: ScheduledBar,
    audioTime: number,
  ) => {
    const absStep = bar.firstStep + stepInBar;
    const offset = stepToSeconds(stepInBar, bar.tempo, bar.swing);
    for (const { voice, entry } of voices) {
      if (!voice.audible) continue;
      for (const note of voice.notes) {
        if (note.step !== absStep) continue;
        const row = voice.rows.find((r) => r.id === note.row_id);
        if (!row) continue;
        const length =
          stepToSeconds(stepInBar + note.length_steps, bar.tempo, bar.swing) -
          offset;
        entry.source.trigger(row, audioTime, audioTime + length, note.velocity);
      }
    }
  };

  // Steps are scheduled step by step, just ahead of time, and each step
  // re-reads the model so edits are heard the next time that step plays.
  const tick = (mySession: number, audioNow: number) => {
    if (mySession !== session || !tone) return;
    const t = tone;
    // Applied every tick, not only when a step is due, so a mixer change lands
    // within one tick even between steps.
    syncVoices(t, model.getVoices());
    const horizon = tickTime + LOOKAHEAD_SECONDS;
    for (;;) {
      const bar = bars.at(-1);
      const atBoundary = !bar || stepInBar >= bar.steps;
      const stepTime = atBoundary
        ? nextBarStart
        : bar.transportStart + stepToSeconds(stepInBar, bar.tempo, bar.swing);
      if (stepTime > horizon) break;

      const timing = model.getTiming();
      if (!timing) {
        stop();
        return;
      }
      if (atBoundary) startBar(timing);
      const current = bars.at(-1)!;
      scheduleStep(
        syncVoices(t, model.getVoices()),
        current,
        audioNow + (stepTime - tickTime),
      );
      stepInBar += 1;
    }
    tickTime += TICK_SECONDS;
    t.getTransport().scheduleOnce((time) => tick(mySession, time), tickTime);
  };

  const play = async () => {
    if (!model.getTiming() || snapshot.status === "loading") return;
    const mySession = ++session;
    // Started before any await so it still counts as part of the user
    // gesture; browsers may leave the context suspended otherwise.
    const alreadyStarted = tone?.start();
    setSnapshot({ status: "loading", error: null });
    try {
      const t = (tone ??= await loadTone());
      await (alreadyStarted ?? t.start());
      const voices = syncVoices(t, model.getVoices());
      await Promise.all(voices.map((v) => v.entry.source.load(v.voice.rows)));
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
      transport.scheduleOnce((time) => tick(mySession, time), 0);
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
    for (const entry of channels.values()) entry.source.stopAll();
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
        const voices = syncVoices(t, model.getVoices());
        await Promise.all(
          voices.map((v) => v.entry.source.load(rows ?? v.voice.rows)),
        );
      } catch {}
    },
    setLoop(range) {
      loop = range;
    },
    seek(measure) {
      jumpTo = measure;
    },
    async audition(row, options = {}) {
      // Started before any await for the same user-gesture reason as play().
      const alreadyStarted = tone?.start();
      try {
        const t = (tone ??= await loadTone());
        await (alreadyStarted ?? t.start());
        const voice = options.voiceKey
          ? model.getVoices().find((v) => v.key === options.voiceKey)
          : undefined;
        let active: SoundSource;
        if (voice) {
          active = previewVoice(t, voice).source;
        } else {
          const instrument = model.instrument;
          if (!instrument) return;
          // Not routed through a channel: this is the single-instrument path,
          // which has no mixer.
          let standalone = auditionSources.get(instrument);
          if (!standalone) {
            standalone = getSoundSourceFactory(instrument)(t);
            auditionSources.set(instrument, standalone);
          }
          active = standalone;
        }
        await active.load([row]);
        const start = t.getContext().currentTime + AUDITION_DELAY_SECONDS;
        active.trigger(
          row,
          start,
          start + AUDITION_SECONDS,
          options.velocity ?? AUDITION_VELOCITY,
        );
      } catch {
        // Best-effort: Play is where audio failures are surfaced to the user.
      }
    },
    subscribePosition(cb) {
      positionListeners.add(cb);
      return () => positionListeners.delete(cb);
    },
    dispose() {
      stop();
      for (const entry of channels.values()) disposeVoice(entry, true);
      channels.clear();
      for (const entry of previews.values()) disposeVoice(entry, true);
      previews.clear();
      for (const src of auditionSources.values()) src.dispose?.();
      auditionSources.clear();
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
    engine = createPlaybackEngine(createPatternPlaybackModel(instrumentId));
    engines.set(instrumentId, engine);
  }
  return engine;
}
