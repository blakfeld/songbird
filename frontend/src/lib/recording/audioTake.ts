import type { Sample } from "@/generated/Sample";
import type { PlaybackEngine } from "../audio/engine";
import type { PcmSample } from "../audio/sampleAnalysis";
import { LOW_STORAGE_BYTES } from "../audio/sampleImport";
import { placeTake, totalLatency, type Latencies, type TakeOrigin } from "../audio/recorder/placement";
import { loadRecordingOffsetMs } from "../audio/recorder/inputPrefs";
import { openRecordingInput, type InputRefusal, type RecordingInput } from "../audio/recorder/recordingInput";
import { takeInterleaved, type RecorderChunk } from "../audio/recorder/recorderTap";
import { pinSample } from "../audio/sampleGc";
import { putSample as storePutSample } from "../audio/sampleStore";
import { recordTake } from "../song/audioClipOps";
import {
  AUDIO_INSTRUMENT_ID,
  MAX_SAMPLES,
  MAX_SAMPLE_SECONDS,
  MAX_TAKES_PER_TRACK,
  RECORDING_ORIGIN,
  TICKS_PER_SECOND_PER_BPM,
  TICKS_PER_SIXTEENTH,
  cutUtf16,
  samplesToTicks,
} from "../song/audioTiming";
import type { SongStore } from "../song/songStore";
import { MEASURE_RANGE } from "../song/types";
import { createPeakFeed } from "./recordingOverlay";
import type { AudioTakeLimit, AudioTakeOutcome, TakeTarget } from "./take";

export interface AudioSampleStore {
  // `unpin` is returned by stores that pinned the audio against cleanup; the take calls it once the song holds it.
  putSample(pcm: PcmSample): Promise<{ id: string; unpin?: () => void }>;
}

// Pinned inside the write's own exclusive section; the take unpins once the song names the audio or gives up on it.
export const defaultAudioStore: AudioSampleStore = {
  putSample: async (pcm) => {
    let unpin = () => {};
    const { id } = await storePutSample(pcm, async (stored) => {
      unpin = pinSample(stored);
    });
    return { id, unpin };
  },
};

type TakeEngine = Pick<PlaybackEngine, "isPlaying" | "markTake" | "subscribeLoopWrap"> & Partial<Pick<PlaybackEngine, "startMeasure" | "claimOpenEnded">>;

export interface AudioTakeOptions {
  offsetMs?: () => number;
  // The worklet can die with its tab's audio thread, and a Stop that never completes would trap the take.
  stopTimeoutMs?: number;
}

const SAMPLE_NAME_MAX = 80;
const MAX_TAKE_SECONDS = 20 * 60;

// The highest existing number plus one, rather than a count, so deleting an old take never makes a name repeat.
export function nextTakeNumber(samples: Sample[], trackId: string, trackName: string): number {
  const prefix = `${trackName} Take `;
  let highest = 0;
  for (const s of samples) {
    if (s.origin !== RECORDING_ORIGIN || s.track_id !== trackId || !s.name.startsWith(prefix)) continue;
    const n = Number(s.name.slice(prefix.length));
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return highest + 1;
}

const takesOnTrack = (samples: Sample[], trackId: string) =>
  samples.filter((s) => s.origin === RECORDING_ORIGIN && s.track_id === trackId).length;

export function createAudioTake(
  store: SongStore,
  audioStore: AudioSampleStore,
  trackId: string,
  engine: TakeEngine,
  input: RecordingInput,
  options: AudioTakeOptions = {},
): TakeTarget {
  const { sampleRate, channels } = input;
  const tap = input.tap;
  let chunks: (RecorderChunk | null)[] = [];
  let passes: TakeOrigin[] = [];
  let latencies: Latencies = { outputLatency: 0, baseLatency: 0, inputLatency: input.inputLatency, userOffset: 0 };
  let offsetSeconds = 0;
  let cutFrame: number | null = null;
  let limit: AudioTakeLimit | undefined;
  let captured = 0;
  let lastEnd = 0;
  let firstNumber = 1;
  let trackName = "Audio";
  let existingTakes = 0;
  let existingSamples = 0;
  let tempo = 120;
  // Where the run will begin when it starts from stopped, which is all the count-in has to show.
  let plannedTicks: number | null = null;
  let songSecondsMax = Infinity;
  let unsubscribe: (() => void) | null = null;
  let unsubscribePeaks: (() => void) | null = null;
  let unsubscribeLost: (() => void) | null = null;
  let claim: { settle(): void; release(): void } | null = null;
  let begun = false;
  const limitListeners = new Set<(limit: AudioTakeLimit) => void>();
  const peaks = createPeakFeed();

  const latency = () => totalLatency(latencies);
  const frameOf = (contextTime: number) => Math.ceil((contextTime + latency()) * sampleRate);
  const takeName = (pass: number) => cutUtf16(`${trackName} Take ${firstNumber + pass}`, SAMPLE_NAME_MAX);

  const showOverlay = () =>
    store.getState().setRecordingOverlay({
      trackId,
      startTicks: passes.length ? Math.round(passes[passes.length - 1].songSeconds * TICKS_PER_SECOND_PER_BPM * tempo) : plannedTicks,
      started: passes.length > 0,
      takeName: takeName(Math.max(0, passes.length - 1)),
      pass: Math.max(1, passes.length),
      peaks,
    });

  const hitLimit = (reason: AudioTakeLimit) => {
    if (limit) return;
    limit = reason;
    limitListeners.forEach((cb) => cb(reason));
  };

  const readLatencies = () => {
    const mark = engine.markTake();
    latencies = {
      outputLatency: mark?.outputLatency ?? 0,
      baseLatency: mark?.baseLatency ?? 0,
      inputLatency: input.inputLatency,
      userOffset: offsetSeconds,
    };
  };

  const startPass = (origin: TakeOrigin) => {
    if (!passes.length) readLatencies();
    passes = [...passes, origin];
    // Earlier passes are not drawn: the clip will play the last one.
    peaks.clear();
    showOverlay();
  };

  const onWrap = (wrap: { kind: "start" | "wrap" | "seek"; contextTime: number; songSeconds: number }) => {
    if (wrap.kind === "start") {
      if (!passes.length) startPass({ contextTime: wrap.contextTime, songSeconds: wrap.songSeconds });
      return;
    }
    if (!passes.length || limit) return;
    if (wrap.kind === "seek") {
      // What was played before the jump is kept; the jump itself is not part of any performance.
      cutFrame = frameOf(wrap.contextTime);
      return hitLimit("seek");
    }
    // A pass needs a sample and a take of its own, so the one that would not fit is never started.
    const full =
      existingTakes + passes.length >= MAX_TAKES_PER_TRACK
        ? "takes"
        : existingSamples + passes.length >= MAX_SAMPLES
          ? "samples"
          : null;
    if (full) {
      cutFrame = frameOf(wrap.contextTime);
      return hitLimit(full);
    }
    startPass({ contextTime: wrap.contextTime, songSeconds: wrap.songSeconds });
  };

  const onChunk = (chunk: RecorderChunk) => {
    chunks.push(chunk);
    const frames = chunk.channels[0]?.length ?? 0;
    captured += frames;
    lastEnd = Math.max(lastEnd, chunk.frame + frames);
    if (captured >= MAX_TAKE_SECONDS * sampleRate) hitLimit("duration");
    const origin = passes[passes.length - 1];
    if (origin && (lastEnd / sampleRate - origin.contextTime) + origin.songSeconds - latency() >= songSecondsMax) hitLimit("song");
  };

  const build = async (unpins: (() => void)[]): Promise<AudioTakeOutcome> => {
    const song = store.getState().song;
    const track = song?.tracks.find((t) => t.id === trackId);
    if (!song || !track || !chunks.length || !passes.length) return { kind: "empty", trackName, limit };
    const firstChunk = chunks.reduce((m, c) => Math.min(m, c?.frame ?? Infinity), Infinity);
    const endFrame = Math.min(
      cutFrame ?? Infinity,
      lastEnd,
      firstChunk + MAX_TAKE_SECONDS * sampleRate,
      // Nothing may run past the song's last measure, which would be rejected as a whole.
      Math.floor(
        (passes[passes.length - 1].contextTime + (songSecondsMax - passes[passes.length - 1].songSeconds) + latency()) * sampleRate,
      ),
    );
    const maxFrames = MAX_SAMPLE_SECONDS * sampleRate;
    // Planned from the frames alone, so no audio is copied until a pass is about to be stored.
    const planned: { sample: Sample; from: number; startTicks: number; offset: number; frames: number }[] = [];
    for (const [i, origin] of passes.entries()) {
      const from = Math.max(frameOf(origin.contextTime), firstChunk);
      const to = Math.min(i + 1 < passes.length ? frameOf(passes[i + 1].contextTime) : endFrame, endFrame);
      const frames = Math.min(to - from, maxFrames);
      if (frames < 1) continue;
      // A last pass shorter than a beat is a stop just after the loop restarted, not a take; keeping it would make
      // the clip play a sliver of silence instead of the pass before it.
      if (i > 0 && i === passes.length - 1 && frames < Math.round((60 / song.tempo_bpm) * sampleRate)) continue;
      const placed = placeTake(from, sampleRate, song.tempo_bpm, origin, latencies);
      if (placed.offsetSamples >= frames) continue;
      planned.push({
        sample: {
          id: "",
          name: takeName(i),
          sample_rate: sampleRate,
          channels,
          length_samples: frames,
          origin: RECORDING_ORIGIN,
          track_id: trackId,
          // Where the take's first sample sat in the song, so choosing it later can line it up by song time.
          recorded_at_ticks: Math.max(0, Math.round(placed.startTicks - samplesToTicks(placed.offsetSamples, sampleRate, song.tempo_bpm))),
        },
        from,
        startTicks: placed.startTicks,
        offset: placed.offsetSamples,
        frames,
      });
    }
    if (!planned.length) return { kind: "empty", trackName, limit };
    const built = planned;

    try {
      // One pass at a time, each written straight from the chunks that are then released, because a 20 minute
      // stereo take is hundreds of megabytes and every intermediate copy of it would add that again.
      for (const b of built) {
        const data = takeInterleaved(chunks, channels, b.from, b.from + b.frames);
        const stored = await audioStore.putSample({ sampleRate, channels, data });
        b.sample.id = stored.id;
        if (stored.unpin) unpins.push(stored.unpin);
      }
    } catch {
      return { kind: "failed", reason: "storage" };
    }

    const last = built[built.length - 1];
    // Read again because the song may have been edited while the audio was being stored.
    const fresh = store.getState().song;
    const current = fresh?.tracks.find((t) => t.id === trackId);
    if (!fresh || !current) return { kind: "failed", reason: "song" };
    const error = store.getState().audioEdit(trackId, (s) =>
      recordTake(
        s,
        trackId,
        built.map((b) => b.sample),
        { sampleId: last.sample.id, startTicks: last.startTicks, offsetSamples: last.offset, lengthSamples: last.frames - last.offset },
      ),
    );
    if (error) return { kind: "failed", reason: "song" };
    const measureSeconds = (fresh.steps_per_measure * TICKS_PER_SIXTEENTH) / (TICKS_PER_SECOND_PER_BPM * fresh.tempo_bpm);
    return {
      kind: "saved",
      trackName: current.name,
      takeName: last.sample.name,
      takes: built.length,
      measures: Math.max(1, Math.round((last.frames - last.offset) / sampleRate / measureSeconds)),
      limit,
    };
  };

  // Pins last until the song names the audio, or the attempt fails and the audio may be collected as garbage again.
  const finalize = async (): Promise<AudioTakeOutcome> => {
    const unpins: (() => void)[] = [];
    try {
      return await build(unpins);
    } finally {
      unpins.forEach((unpin) => unpin());
    }
  };

  const teardown = () => {
    unsubscribe?.();
    unsubscribePeaks?.();
    unsubscribeLost?.();
    unsubscribe = unsubscribePeaks = unsubscribeLost = null;
    begun = false;
    // Only our own overlay: a newer take may already be drawing its own.
    if (store.getState().recording?.peaks === peaks) store.getState().setRecordingOverlay(null);
  };

  return {
    begin() {
      const song = store.getState().song;
      const track = song?.tracks.find((t) => t.id === trackId);
      chunks = [];
      passes = [];
      cutFrame = null;
      limit = undefined;
      captured = 0;
      lastEnd = 0;
      offsetSeconds = (options.offsetMs ?? loadRecordingOffsetMs)() / 1000;
      tempo = song?.tempo_bpm ?? 120;
      trackName = track?.name ?? "Audio";
      existingTakes = takesOnTrack(song?.samples ?? [], trackId);
      existingSamples = song?.samples?.length ?? 0;
      firstNumber = nextTakeNumber(song?.samples ?? [], trackId, trackName);
      songSecondsMax = song
        ? (MEASURE_RANGE.max * song.steps_per_measure * TICKS_PER_SIXTEENTH) / (TICKS_PER_SECOND_PER_BPM * song.tempo_bpm)
        : Infinity;
      plannedTicks = song && !engine.isPlaying ? ((engine.startMeasure?.() ?? 1) - 1) * song.steps_per_measure * TICKS_PER_SIXTEENTH : null;
      peaks.clear();
      showOverlay();
      // The song may be shorter than this take and only grows once the take is saved, so the run must not stop at
      // the song's last bar while recording.
      claim = engine.claimOpenEnded?.() ?? null;
      begun = true;
      unsubscribe = engine.subscribeLoopWrap(onWrap);
      unsubscribePeaks = tap.subscribePeaks((p) => peaks.push(p.peak));
      unsubscribeLost = input.onLost?.(() => hitLimit("input")) ?? null;
      // Already playing means the punch-in is now; from stopped it is the run's first bar, delivered as "start".
      const mark = engine.isPlaying ? engine.markTake() : null;
      if (mark && mark.songSeconds !== null) startPass({ contextTime: mark.contextTime, songSeconds: mark.songSeconds });
      tap.startCapture(onChunk);
    },
    add() {},
    end() {
      unsubscribe?.();
      unsubscribe = null;
      // From here the claim lasts only for this run, so a Play started while the audio is being saved is not
      // open-ended; it is released once the song has been extended.
      claim?.settle();
      const settled = (async () => {
        await Promise.race([tap.stopCapture(), new Promise((r) => setTimeout(r, options.stopTimeoutMs ?? 2000))]);
        try {
          return await finalize();
        } finally {
          // Released only now, after the song has been extended to hold the take: letting go at Stop would end the
          // run at the old, shorter end and cut playback off mid-bar.
          claim?.release();
          claim = null;
          teardown();
          input.release();
        }
      })();
      return { recorded: 0, dropped: {}, settled };
    },
    discard() {
      // A target that never began owns neither an overlay nor a claim; clearing them would take another take's.
      if (begun) {
        claim?.release();
        claim = null;
        teardown();
      }
      // Bounded inside the tap, so the hold on the input is always given back even if the worklet has gone quiet.
      void tap.stopCapture().finally(() => input.release());
    },
    onLimit(cb) {
      limitListeners.add(cb);
      return () => limitListeners.delete(cb);
    },
  };
}

export type AudioTakeRefusal = InputRefusal | "takes-full" | "samples-full" | "no-space";

// A minute is the floor because a take's length is unknown at the start, and a session that cannot hold even that
// would fail at the end with the performance already lost.
export const MIN_RECORD_SECONDS = 60;

export async function prepareAudioTake(
  store: SongStore,
  audioStore: AudioSampleStore,
  trackId: string,
  engine: TakeEngine & Pick<PlaybackEngine, "prepareInput">,
  deps: {
    openInput?: typeof openRecordingInput;
    estimate?: () => Promise<{ quota?: number; usage?: number } | undefined>;
    options?: AudioTakeOptions;
  } = {},
): Promise<{ target: TakeTarget } | { reason: AudioTakeRefusal }> {
  const song = store.getState().song;
  const track = song?.tracks.find((t) => t.id === trackId);
  if (!song || !track || track.instrument !== AUDIO_INSTRUMENT_ID) return { reason: "failed" };
  if (takesOnTrack(song.samples ?? [], trackId) >= MAX_TAKES_PER_TRACK) return { reason: "takes-full" };
  if ((song.samples ?? []).length >= MAX_SAMPLES) return { reason: "samples-full" };

  const estimate = deps.estimate ?? (async () => navigator.storage?.estimate?.());
  const space = await estimate().catch(() => undefined);
  const opened = await (deps.openInput ?? openRecordingInput)(engine, trackId);
  if ("reason" in opened) return opened;
  const { input } = opened;
  if (space?.quota !== undefined && space.usage !== undefined) {
    const needed = Math.max(MIN_RECORD_SECONDS * input.sampleRate * input.channels * 4, 0);
    if (space.quota - space.usage < Math.min(needed, LOW_STORAGE_BYTES)) {
      input.release();
      return { reason: "no-space" };
    }
  }
  return { target: createAudioTake(store, audioStore, trackId, engine, input, deps.options) };
}
