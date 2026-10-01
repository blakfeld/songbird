import type { Row } from "@/generated/Row";
import { stepToSeconds } from "@/lib/timing";
import { createMetronomeSource, type MetronomeSource } from "./metronomeSource";
import { createPatternPlaybackModel } from "./patternPlaybackModel";
import { getSoundSourceFactory } from "./registry";
import { createInsertChain, type InsertChain } from "./insertChain";
import { DEFAULT_VOICE_SOUND, type VoiceSound } from "./voiceSound";
import type {
  LoopRange,
  NoteHandle,
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
  // Shared by playback and previews so a track has one set of effects, not one per way of playing it.
  chain: InsertChain;
  sound: VoiceSound;
}

// A preview is routed through its track's chain, so it only owns the source and the mixer-faithful channel.
interface PreviewChannel {
  instrument: string;
  source: SoundSource;
  channel: InstanceType<ToneModule["Channel"]>;
  // The way out for previews of an inaudible track, whose own channel is silent. It is gated shut
  // except while a preview sounds, so the track's scheduled notes still fade on mute.
  tap: InstanceType<ToneModule["Gain"]>;
  tapOpen: boolean;
  audible: boolean;
  held: number;
  lingering: boolean;
  closeTimer: ReturnType<typeof setTimeout> | null;
  track: VoiceChannel;
  volumeDb: number;
  pan: number;
  sound: VoiceSound;
}

const DEFAULT_TEMPO = 120;

// Covers a preview's release and its effect tails; the tap closes after this so a muted track goes quiet again.
const TAP_TAIL_SECONDS = 3;

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export interface AuditionOptions {
  // Routes through that voice's channel so its volume and pan apply.
  voiceKey?: string;
  velocity?: number;
}

export interface LiveNoteOptions {
  voiceKey?: string;
  velocity?: number;
}

export interface LiveNote {
  source: SoundSource;
  handle: NoteHandle;
  // Lets the engine keep a muted track's preview path open for as long as the key is down.
  released?: () => void;
}

export interface PlayOptions {
  // A take from stopped needs a bar to settle into the tempo before any note counts.
  countIn?: boolean;
}

export interface StepPosition {
  // Song-absolute, so it already reflects loop wrapping.
  step: number;
  // Kept so a caller can tell how sloppy the timing was, since quantizing to the step hides it.
  frac: number;
  // Transport time of the event, so two events can be compared for how long apart they were even when
  // loop wrapping maps them to the same step.
  seconds: number;
  // One sixteenth at the bar's tempo, which turns that time gap into steps without the caller knowing the tempo.
  stepSeconds: number;
}

const DEFAULT_BEAT_STEPS = 4;

// Tempo and swing are frozen per bar so step times within a bar stay
// consistent even if the user edits them mid-bar.
interface ScheduledBar {
  transportStart: number;
  duration: number;
  firstStep: number;
  steps: number;
  tempo: number;
  swing: number;
  // 0 marks the count-in bar, which sounds clicks only and is not part of the song.
  measure: number;
  beatSteps: number;
}

// Enough to cover the gap between what is scheduled and what is audible.
const BARS_KEPT = 3;

export type PlaybackSnapshot = Pick<Playback, "isPlaying" | "status" | "error">;

export interface PlaybackEngine extends Playback {
  setLoop(range: LoopRange | null): void;
  setLooping(enabled: boolean): void;
  play(options?: PlayOptions): Promise<void>;
  audition(row: Row, options?: AuditionOptions): Promise<void>;
  // Starts audio and loads the target's samples ahead of the first key press, which must not wait.
  prepareLive(voiceKey?: string, rows?: Row[]): Promise<void>;
  // Null while the audio context is not running, so a held-back note cannot queue and fire in a burst later.
  liveNoteOn(row: Row, options?: LiveNoteOptions): LiveNote | null;
  liveNoteOff(note: LiveNote): void;
  // Lets the caller tell a note dropped for browser autoplay policy from one dropped for any other reason.
  liveBlocked(): boolean;
  // Asked before Play because Play consumes a pending seek, and the take's announcement must still name that bar.
  startMeasure(): number;
  // Output latency separates what was scheduled from what the player heard, so the step is the heard one.
  stepAt(domTimeStamp: number): StepPosition | null;
  setMetronome(enabled: boolean): void;
  // Beats remaining in the count-in bar (4, 3, 2, 1), then null. Driven by animation frames, so it only suits display.
  subscribeCountIn(cb: (beatsLeft: number | null) => void): () => void;
  // Fires from the transport, not from frames, so a take can start recording even when frames are throttled.
  subscribeCountInEnd(cb: () => void): () => void;
  // Applies the model's current sound to live tracks, so held notes follow edits while playback is stopped.
  syncSound(): void;
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
  const countInListeners = new Set<(beatsLeft: number | null) => void>();
  const countInEndListeners = new Set<() => void>();

  let loop: LoopRange | null = null;
  let looping = true;
  // Transport time the last scheduled note stops sounding, so a play-once run can end after its tail.
  let lastNoteEnd = 0;
  // Consumed by the next bar so a seek lands on a bar boundary, and survives until Play when idle.
  let jumpTo: number | null = null;
  let tone: ToneModule | null = null;
  const channels = new Map<string, VoiceChannel>();
  // Separate from `channels` because the scheduler's mute floor would otherwise fade a preview out mid-note.
  const previews = new Map<string, PreviewChannel>();
  const auditionSources = new Map<string, SoundSource>();
  let bars: ScheduledBar[] = [];
  let nextBarStart = 0;
  let stepInBar = 0;
  let tickTime = 0;
  let lastEmitted: number | null = null;
  let lastCountIn: number | null = null;
  let metronomeOn = false;
  let metronome: MetronomeSource | null = null;
  // Consumed by the first bar of a run, so only that bar is the count-in.
  let countInPending = false;
  // Unlike countInPending this is known as soon as Play is called, which is while samples are still loading.
  let countInRequested = false;
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

  const emitCountIn = (beatsLeft: number | null) => {
    if (beatsLeft === lastCountIn) return;
    lastCountIn = beatsLeft;
    countInListeners.forEach((cb) => cb(beatsLeft));
  };

  // The audio clock, not Transport.seconds, which runs ahead by the
  // scheduler's lookahead and would make the playhead lead the sound.
  const locate = (): { bar: ScheduledBar; rel: number } | null => {
    if (!tone) return null;
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
    return { bar: current, rel };
  };

  const getPosition = (): number | null => {
    const at = locate();
    if (!at || at.bar.measure === 0) return null;
    return at.bar.firstStep + at.rel;
  };

  const getCountInBeatsLeft = (): number | null => {
    const at = locate();
    if (!at || at.bar.measure !== 0) return null;
    const beats = Math.ceil(at.bar.steps / at.bar.beatSteps);
    return beats - Math.floor(at.rel / at.bar.beatSteps);
  };

  const frameLoop = () => {
    emitPosition(getPosition());
    emitCountIn(getCountInBeatsLeft());
    if (snapshot.isPlaying) frame = requestFrame(frameLoop);
  };

  // Deriving the next measure from the current one (rather than a running
  // counter) keeps a loop-range change mid-play landing inside the new range.
  const nextMeasure = (timing: PlaybackTiming, current: number | null) => {
    if (!looping) {
      return current === null ? 1 : Math.min(current + 1, timing.measures);
    }
    const start = Math.min(Math.max(loop?.start ?? 1, 1), timing.measures);
    const end = Math.min(
      Math.max(loop?.end ?? timing.measures, start),
      timing.measures,
    );
    if (current === null || current + 1 < start || current + 1 > end) return start;
    return current + 1;
  };

  const startBar = (timing: PlaybackTiming) => {
    // The count-in bar (measure 0) is not a position, so the first real bar starts the run.
    const previous = bars.at(-1)?.measure || null;
    const afterPreRoll = bars.at(-1)?.measure === 0;
    const preRoll = countInPending;
    countInPending = false;
    const measure = preRoll
      ? 0
      : jumpTo === null
        ? nextMeasure(timing, previous)
        : Math.min(Math.max(jumpTo, 1), timing.measures);
    if (!preRoll) jumpTo = null;
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
        beatSteps: timing.beatSteps ?? DEFAULT_BEAT_STEPS,
      },
    ].slice(-BARS_KEPT);
    if (afterPreRoll && tone) {
      const startedSession = session;
      // Deferred because Tone warns about transport changes made inside a scheduled callback.
      tone.getTransport().scheduleOnce(() => {
        queueMicrotask(() => {
          if (startedSession === session) countInEndListeners.forEach((cb) => cb());
        });
      }, nextBarStart);
    }
    nextBarStart += duration;
    stepInBar = 0;
  };

  const firstMeasure = (timing: PlaybackTiming) =>
    !looping && jumpTo !== null
      ? Math.min(Math.max(jumpTo, 1), timing.measures)
      : nextMeasure(timing, null);

  const tempoOf = () => model.getTiming()?.tempo ?? DEFAULT_TEMPO;

  // Fading first, then disposing later, avoids a click from cutting a channel that is still sounding.
  const disposeVoice = (entry: VoiceChannel, immediate = false) => {
    if (entry.source.dispose) entry.source.dispose();
    else entry.source.stopAll();
    if (immediate) {
      entry.channel.dispose();
      entry.chain.dispose();
      return;
    }
    entry.channel.volume.rampTo(SILENT_DB, MIXER_RAMP_SECONDS);
    setTimeout(() => {
      entry.channel.dispose();
      entry.chain.dispose();
    }, DISPOSE_DELAY_MS);
  };

  const disposePreview = (entry: PreviewChannel, immediate = false) => {
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    if (entry.source.dispose) entry.source.dispose();
    else entry.source.stopAll();
    if (immediate) {
      entry.tap.dispose();
      entry.channel.dispose();
      return;
    }
    entry.tap.gain.rampTo(0, MIXER_RAMP_SECONDS);
    setTimeout(() => {
      entry.tap.dispose();
      entry.channel.dispose();
    }, DISPOSE_DELAY_MS);
  };

  // Ramped only on a change: this runs every tick, and a ramp per tick is wasted work that Tone
  // also warns about when it is issued inside a scheduled callback without the scheduling time.
  const updateTap = (entry: PreviewChannel, at?: number) => {
    const open = !entry.audible && (entry.held > 0 || entry.lingering);
    if (open === entry.tapOpen) return;
    entry.tapOpen = open;
    entry.tap.gain.rampTo(open ? 1 : 0, MIXER_RAMP_SECONDS, at);
  };

  const keepTapOpen = (entry: PreviewChannel, seconds: number) => {
    entry.lingering = true;
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    entry.closeTimer = setTimeout(() => {
      entry.lingering = false;
      entry.closeTimer = null;
      updateTap(entry);
    }, seconds * 1000);
    updateTap(entry);
  };

  const applyMixer = (entry: VoiceChannel, voice: Voice, at?: number) => {
    const db = targetDb(voice);
    if (entry.volumeDb !== db) {
      entry.channel.volume.rampTo(db, MIXER_RAMP_SECONDS, at);
      entry.volumeDb = db;
    }
    if (entry.pan !== voice.pan) {
      entry.channel.pan.rampTo(voice.pan, MIXER_RAMP_SECONDS, at);
      entry.pan = voice.pan;
    }
    const preview = previews.get(voice.key);
    if (preview) {
      preview.audible = voice.audible;
      updateTap(preview, at);
    }
  };

  // Diffed by value because the model resolves a fresh object on every read.
  const applySound = (entry: VoiceChannel, voice: Voice, tempo: number, at?: number) => {
    const next = voice.sound ?? DEFAULT_VOICE_SOUND;
    if (!sameJson(entry.sound.tone, next.tone)) entry.source.setTone?.(next.tone);
    entry.sound = next;
    entry.chain.apply(next.effects, tempo, at);
    // Held live notes sound on the preview source, which a track-only update would leave on stale tone.
    const preview = previews.get(voice.key);
    if (preview && !sameJson(preview.sound.tone, next.tone)) preview.source.setTone?.(next.tone);
    if (preview) preview.sound = next;
  };

  const makeEntry = (t: ToneModule, voice: Voice, db: number): VoiceChannel => {
    const channel = new t.Channel({ volume: db, pan: voice.pan }).toDestination();
    const chain = createInsertChain(t);
    chain.output.connect(channel);
    const sound = voice.sound ?? DEFAULT_VOICE_SOUND;
    chain.apply(sound.effects, tempoOf());
    return {
      instrument: voice.instrument,
      source: getSoundSourceFactory(voice.instrument)(t, chain.input, sound.tone),
      channel,
      volumeDb: db,
      pan: voice.pan,
      chain,
      sound,
    };
  };

  // Created lazily and per key so a voice added mid-play needs no restart, and
  // rebuilt when its instrument changes because the source is instrument-bound.
  const ensureVoice = (t: ToneModule, voice: Voice, tempo: number, at?: number): VoiceChannel => {
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
      applyMixer(entry, voice, at);
      applySound(entry, voice, tempo, at);
    }
    return entry;
  };

  // A preview must be heard even on a muted or soloed-out track, but still through its volume and pan.
  const previewVoice = (t: ToneModule, voice: Voice): PreviewChannel => {
    const track = ensureVoice(t, voice, tempoOf());
    let entry = previews.get(voice.key);
    // Both checks matter: a rebuilt track has a new chain, and the old preview would feed a disposed one.
    if (entry && (entry.instrument !== voice.instrument || entry.track !== track)) {
      disposePreview(entry);
      previews.delete(voice.key);
      entry = undefined;
    }
    if (!entry) {
      const channel = new t.Channel({ volume: voice.volumeDb, pan: voice.pan }).toDestination();
      const tap = new t.Gain(0);
      track.chain.output.connect(tap);
      tap.connect(channel);
      const sound = voice.sound ?? DEFAULT_VOICE_SOUND;
      entry = {
        instrument: voice.instrument,
        // Its own source so held preview notes and the track's pooled voices never steal from each other,
        // but the same effect chain so there is one reverb per track.
        source: getSoundSourceFactory(voice.instrument)(t, track.chain.input, sound.tone),
        channel,
        tap,
        tapOpen: false,
        audible: voice.audible,
        held: 0,
        lingering: false,
        closeTimer: null,
        track,
        volumeDb: voice.volumeDb,
        pan: voice.pan,
        sound,
      };
      previews.set(voice.key, entry);
    } else {
      entry.channel.volume.rampTo(voice.volumeDb, MIXER_RAMP_SECONDS);
      entry.channel.pan.rampTo(voice.pan, MIXER_RAMP_SECONDS);
      entry.audible = voice.audible;
      updateTap(entry);
      entry.volumeDb = voice.volumeDb;
      entry.pan = voice.pan;
    }
    return entry;
  };

  // A voice key routes through that voice's preview channel; without one the single-instrument
  // path plays straight out, as it has no mixer.
  const resolveLiveTarget = (
    t: ToneModule,
    voiceKey?: string,
  ): { source: SoundSource; preview?: PreviewChannel } | null => {
    const voice = voiceKey
      ? model.getVoices().find((v) => v.key === voiceKey)
      : undefined;
    if (voice) {
      const preview = previewVoice(t, voice);
      return { source: preview.source, preview };
    }
    const instrument = model.instrument;
    if (!instrument) return null;
    let standalone = auditionSources.get(instrument);
    if (!standalone) {
      standalone = getSoundSourceFactory(instrument)(t);
      auditionSources.set(instrument, standalone);
    }
    return { source: standalone };
  };

  const syncVoices = (t: ToneModule, voices: Voice[], at?: number) => {
    const keys = new Set(voices.map((v) => v.key));
    for (const [key, entry] of channels) {
      if (keys.has(key)) continue;
      disposeVoice(entry);
      channels.delete(key);
      const preview = previews.get(key);
      if (preview) {
        disposePreview(preview);
        previews.delete(key);
      }
    }
    const tempo = tempoOf();
    return voices.map((voice) => ({ voice, entry: ensureVoice(t, voice, tempo, at) }));
  };

  const scheduleStep = (
    voices: { voice: Voice; entry: VoiceChannel }[],
    bar: ScheduledBar,
    audioTime: number,
  ) => {
    const absStep = bar.firstStep + stepInBar;
    const offset = stepToSeconds(stepInBar, bar.tempo, bar.swing);
    const preRoll = bar.measure === 0;
    if ((preRoll || metronomeOn) && stepInBar % bar.beatSteps === 0 && tone) {
      metronome ??= createMetronomeSource(tone);
      metronome.click(audioTime, stepInBar === 0);
    }
    if (preRoll) return;
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
        lastNoteEnd = Math.max(lastNoteEnd, bar.transportStart + offset + length);
      }
    }
  };

  // A pending seek still wins so a jump requested during the last bar is honoured rather than ended.
  const isLastBarOfRun = (bar: ScheduledBar, timing: PlaybackTiming) =>
    !looping && jumpTo === null && bar.measure >= timing.measures;

  // Tone fires scheduled callbacks up to its lookahead before their time, so the padding keeps the
  // transport and UI reset from landing before the last note's tail has finished.
  const finishAfterTail = (mySession: number) => {
    if (!tone) return;
    const at = Math.max(nextBarStart, lastNoteEnd) + LOOKAHEAD_SECONDS;
    tone.getTransport().scheduleOnce(() => {
      // Deferred because Tone warns about transport changes made inside a scheduled callback.
      queueMicrotask(() => {
        if (mySession === session) reset(false);
      });
    }, at);
  };

  // Steps are scheduled step by step, just ahead of time, and each step
  // re-reads the model so edits are heard the next time that step plays.
  const tick = (mySession: number, audioNow: number) => {
    if (mySession !== session || !tone) return;
    const t = tone;
    // Applied every tick, not only when a step is due, so a mixer change lands
    // within one tick even between steps.
    syncVoices(t, model.getVoices(), audioNow);
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
      if (atBoundary && bar && isLastBarOfRun(bar, timing)) {
        finishAfterTail(mySession);
        return;
      }
      if (atBoundary) startBar(timing);
      const current = bars.at(-1)!;
      scheduleStep(
        syncVoices(t, model.getVoices(), audioNow),
        current,
        audioNow + (stepTime - tickTime),
      );
      stepInBar += 1;
    }
    tickTime += TICK_SECONDS;
    t.getTransport().scheduleOnce((time) => tick(mySession, time), tickTime);
  };

  const play = async (options: PlayOptions = {}) => {
    if (!model.getTiming() || snapshot.status === "loading") return;
    const mySession = ++session;
    countInRequested = options.countIn === true;
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
      lastCountIn = null;
      lastNoteEnd = 0;
      countInPending = options.countIn === true;
      // With looping on, Play starts at the region; a seek only chooses a start when looping is off.
      if (looping) jumpTo = null;
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

  // A natural end skips stopAll so one-shot samples and synth releases already triggered ring out;
  // only a user Stop has to silence everything at once.
  function reset(hardStop: boolean) {
    session += 1;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    if (tone) {
      const transport = tone.getTransport();
      transport.stop();
      transport.cancel();
    }
    if (hardStop) for (const entry of channels.values()) entry.source.stopAll();
    bars = [];
    countInPending = false;
    countInRequested = false;
    if (snapshot.isPlaying || snapshot.status === "loading") {
      setSnapshot({ isPlaying: false, status: "idle" });
    }
    emitPosition(null);
    emitCountIn(null);
  }

  function stop() {
    reset(true);
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
    play,
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
    setLooping(enabled) {
      looping = enabled;
    },
    seek(measure) {
      // While idle with looping on, Play must start at the region, so a seek made then must not
      // resurface as the start once looping is switched off.
      if (looping && !snapshot.isPlaying && snapshot.status !== "loading") return;
      jumpTo = measure;
    },
    async audition(row, options = {}) {
      // Started before any await for the same user-gesture reason as play().
      const alreadyStarted = tone?.start();
      try {
        const t = (tone ??= await loadTone());
        await (alreadyStarted ?? t.start());
        const target = resolveLiveTarget(t, options.voiceKey);
        if (!target) return;
        const active = target.source;
        await active.load([row]);
        const start = t.getContext().currentTime + AUDITION_DELAY_SECONDS;
        active.trigger(
          row,
          start,
          start + AUDITION_SECONDS,
          options.velocity ?? AUDITION_VELOCITY,
        );
        if (target.preview) {
          keepTapOpen(target.preview, AUDITION_DELAY_SECONDS + AUDITION_SECONDS + TAP_TAIL_SECONDS);
        }
      } catch {
        // Best-effort: Play is where audio failures are surfaced to the user.
      }
    },
    async prepareLive(voiceKey, rows) {
      const alreadyStarted = tone?.start();
      try {
        const t = (tone ??= await loadTone());
        await (alreadyStarted ?? t.start());
        const source = resolveLiveTarget(t, voiceKey)?.source;
        const wanted =
          rows ?? model.getVoices().find((v) => v.key === voiceKey)?.rows ?? [];
        await source?.load(wanted);
      } catch {
        // Best-effort: Play is where audio failures are surfaced to the user.
      }
    },
    liveNoteOn(row, options = {}) {
      if (!tone || tone.getContext().state !== "running") return null;
      const target = resolveLiveTarget(tone, options.voiceKey);
      if (!target) return null;
      const { source, preview } = target;
      const handle = source.noteOn(
        row,
        tone.getContext().currentTime,
        options.velocity ?? AUDITION_VELOCITY,
      );
      if (preview) {
        preview.held += 1;
        updateTap(preview);
      }
      return {
        source,
        handle,
        released: preview
          ? () => {
              preview.held = Math.max(0, preview.held - 1);
              keepTapOpen(preview, TAP_TAIL_SECONDS);
            }
          : undefined,
      };
    },
    liveNoteOff(note) {
      if (!tone) return;
      note.source.noteOff(note.handle, tone.getContext().currentTime);
      note.released?.();
    },
    liveBlocked() {
      // Not-yet-loaded audio is a loading state, not the autoplay block a click would fix.
      return !!tone && tone.getContext().state !== "running";
    },
    startMeasure() {
      const timing = model.getTiming();
      return timing ? firstMeasure(timing) : 1;
    },
    stepAt(domTimeStamp) {
      if (!tone) return null;
      const ctx = tone.getContext();
      const raw = ctx.rawContext as { outputLatency?: number; baseLatency?: number };
      // Both add to what the player hears: base latency is the graph's processing delay and output latency
      // is the device's, and browsers that omit one still report the other.
      const latency = (raw.baseLatency ?? 0) + (raw.outputLatency ?? 0);
      const audioTime =
        ctx.currentTime - (performance.now() - domTimeStamp) / 1000 - latency;
      const t = tone.getTransport().getSecondsAtTime(audioTime);

      // A player who hits the downbeat just as Record is pressed plays before the first bar sounds. That note
      // belongs on the first step, not in the bin: Play loads samples first, so the gap is not short.
      const runPending =
        !countInRequested &&
        (snapshot.status === "loading" ||
          (snapshot.isPlaying && (bars.length === 0 || t < bars[0].transportStart)));
      const timing = model.getTiming();
      if (runPending && timing) {
        return {
          step: (firstMeasure(timing) - 1) * timing.stepsPerMeasure,
          frac: 0,
          seconds: t,
          stepSeconds: stepToSeconds(1, timing.tempo, 0),
        };
      }

      const index = bars.findIndex(
        (b) => t >= b.transportStart && t < b.transportStart + b.duration,
      );
      if (index < 0) return null;
      const bar = bars[index];
      const elapsed = t - bar.transportStart;

      let rel = 0;
      let best = Infinity;
      for (let r = 0; r <= bar.steps; r++) {
        const at =
          r === bar.steps ? bar.duration : stepToSeconds(r, bar.tempo, bar.swing);
        const distance = Math.abs(at - elapsed);
        if (distance < best) {
          best = distance;
          rel = r;
        }
      }
      const sixteenth = stepToSeconds(1, bar.tempo, 0);
      const frac =
        (elapsed -
          (rel === bar.steps ? bar.duration : stepToSeconds(rel, bar.tempo, bar.swing))) /
        sixteenth;

      const at = (step: number): StepPosition => ({ step, frac, seconds: t, stepSeconds: sixteenth });
      if (rel < bar.steps) {
        return bar.measure === 0 ? null : at(bar.firstStep + rel);
      }
      const following = bars[index + 1];
      if (following) return at(following.firstStep);
      if (!timing || (!looping && jumpTo === null && bar.measure >= timing.measures)) return null;
      // The next bar is not scheduled yet, so a pending seek has to be honoured here as startBar will.
      const measure =
        jumpTo === null
          ? nextMeasure(timing, bar.measure || null)
          : Math.min(Math.max(jumpTo, 1), timing.measures);
      return at((measure - 1) * timing.stepsPerMeasure);
    },
    setMetronome(enabled) {
      metronomeOn = enabled;
    },
    subscribeCountIn(cb) {
      countInListeners.add(cb);
      return () => countInListeners.delete(cb);
    },
    subscribeCountInEnd(cb) {
      countInEndListeners.add(cb);
      return () => countInEndListeners.delete(cb);
    },
    subscribePosition(cb) {
      positionListeners.add(cb);
      return () => positionListeners.delete(cb);
    },
    syncSound() {
      if (!tone) return;
      const tempo = tempoOf();
      for (const voice of model.getVoices()) {
        const entry = channels.get(voice.key);
        if (entry) applySound(entry, voice, tempo);
      }
    },
    dispose() {
      stop();
      for (const entry of channels.values()) disposeVoice(entry, true);
      channels.clear();
      for (const entry of previews.values()) disposePreview(entry, true);
      previews.clear();
      for (const src of auditionSources.values()) src.dispose?.();
      auditionSources.clear();
      metronome?.dispose();
      metronome = null;
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
