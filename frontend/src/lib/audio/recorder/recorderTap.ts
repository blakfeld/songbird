export const RECORDER_PROCESSOR = "songbird-recorder";
export const RECORDER_MODULE_URL = "/worklets/recorder.js";

// `frame` is the context frame of the first sample, so chunks sit on the same clock as playback and loop passes
// can be cut at exact frames. Channel arrays are all the same length.
export interface RecorderChunk {
  frame: number;
  channels: Float32Array[];
}

export interface PeakReading {
  frame: number;
  peak: number;
}

// The minimal surface of AudioWorkletNode and a media source this module needs, so tests can stand in a fake.
export interface WorkletNodeLike {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: unknown): void };
  connect(destination: unknown): unknown;
  disconnect(): void;
}

// The native context, not Tone's wrapper: the wrapper loads worklet modules through blob URLs, which the Content
// Security Policy blocks, while a native addModule of a same-origin file is allowed.
export interface TapContext {
  sampleRate: number;
  audioWorklet: { addModule(url: string): Promise<void> };
}

export interface TapSource {
  connect(destination: unknown): unknown;
  disconnect(destination?: unknown): void;
}

export interface TapDeps {
  createNode(ctx: TapContext, channels: number): WorkletNodeLike;
}

// Modules load once per context: re-adding one is wasted work and a second registration of the same name throws.
const loaded = new WeakMap<object, Promise<void>>();

const defaultDeps: TapDeps = {
  createNode: (ctx, channels) =>
    new AudioWorkletNode(ctx as unknown as BaseAudioContext, RECORDER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: channels,
      channelCountMode: "explicit",
      processorOptions: { channels },
    }) as unknown as WorkletNodeLike,
};

export interface RecorderTap {
  startCapture(onChunk: (chunk: RecorderChunk) => void): void;
  // Resolves once the worklet has flushed its last partial chunk, so no tail audio is lost to the stop.
  stopCapture(): Promise<void>;
  // Stays live while not capturing so the meter works while the track is merely armed.
  subscribePeaks(cb: (reading: PeakReading) => void): () => void;
  // Latched until cleared, so a clip that flashes by between two looks at the meter is still reported.
  clipHeld(): boolean;
  clearClip(): void;
  // Waits for a running capture to flush, so closing the input never throws away the last partial chunk.
  dispose(): Promise<void>;
}

// A sample at full scale is the first one a converter would clip.
const FULL_SCALE = 1;

// Taps the source before anything else touches it, so what is recorded is the dry input however the track is
// monitored.
export async function createRecorderTap(
  ctx: TapContext,
  source: TapSource,
  channels: 1 | 2,
  deps: TapDeps = defaultDeps,
  stopTimeoutMs = 2000,
): Promise<RecorderTap> {
  let ready = loaded.get(ctx);
  if (!ready) {
    ready = ctx.audioWorklet.addModule(RECORDER_MODULE_URL);
    loaded.set(ctx, ready);
    // A failed load must not be cached, or every retry would reuse the rejection.
    ready.catch(() => loaded.delete(ctx));
  }
  await ready;

  const node = deps.createNode(ctx, channels);
  const peakListeners = new Set<(reading: PeakReading) => void>();
  let onChunk: ((chunk: RecorderChunk) => void) | null = null;
  let stopped: (() => void) | null = null;
  let capturing = false;
  let stopping: Promise<void> | null = null;
  let clip = false;

  node.port.onmessage = (event) => {
    const data = event.data as { type?: string; frame?: number; peak?: number; channels?: Float32Array[] };
    if (data.type === "chunk" && data.channels && typeof data.frame === "number") {
      onChunk?.({ frame: data.frame, channels: data.channels });
    } else if (data.type === "peak" && typeof data.peak === "number" && typeof data.frame === "number") {
      if (data.peak >= FULL_SCALE) clip = true;
      peakListeners.forEach((cb) => cb({ frame: data.frame!, peak: data.peak! }));
    } else if (data.type === "stopped") {
      stopped?.();
      stopped = null;
    }
  };
  source.connect(node);

  const tap: RecorderTap = {
    startCapture(cb) {
      onChunk = cb;
      capturing = true;
      node.port.postMessage({ type: "start" });
    },
    // Shared by every caller, so a stop from the take and one from closing the input cannot cancel each other, and
    // bounded because a worklet that has died would otherwise hold the input open for ever.
    stopCapture() {
      if (!capturing) return Promise.resolve();
      stopping ??= new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          capturing = false;
          onChunk = null;
          stopped = null;
          stopping = null;
          resolve();
        };
        const timer = setTimeout(finish, stopTimeoutMs);
        stopped = finish;
        node.port.postMessage({ type: "stop" });
      });
      return stopping;
    },
    subscribePeaks(cb) {
      peakListeners.add(cb);
      return () => peakListeners.delete(cb);
    },
    clipHeld: () => clip,
    clearClip() {
      clip = false;
    },
    async dispose() {
      await tap.stopCapture();
      source.disconnect(node);
      node.port.onmessage = null;
      node.disconnect();
      peakListeners.clear();
    },
  };
  return tap;
}

// Cuts captured chunks to `[fromFrame, toFrame)` for one channel, which is how a loop pass is separated from the
// one before it at the exact wrap frame. Frames the worklet never delivered stay zero rather than shifting the rest.
export function collectFrames(chunks: RecorderChunk[], channel: number, fromFrame: number, toFrame: number): Float32Array {
  const out = new Float32Array(Math.max(0, toFrame - fromFrame));
  for (const chunk of chunks) {
    const data = chunk.channels[channel] ?? chunk.channels[0];
    if (!data) continue;
    const start = Math.max(fromFrame, chunk.frame);
    const end = Math.min(toFrame, chunk.frame + data.length);
    if (end > start) out.set(data.subarray(start - chunk.frame, end - chunk.frame), start - fromFrame);
  }
  return out;
}

// Writes the interleaved samples straight from the chunks, and lets go of each chunk the range has finished with, so a
// long take is held about once at its peak instead of once per intermediate copy. Spent slots become null.
export function takeInterleaved(
  chunks: (RecorderChunk | null)[],
  channels: number,
  fromFrame: number,
  toFrame: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, toFrame - fromFrame) * channels);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const length = chunk.channels[0]?.length ?? 0;
    const start = Math.max(fromFrame, chunk.frame);
    const end = Math.min(toFrame, chunk.frame + length);
    for (let c = 0; c < channels && end > start; c++) {
      const data = chunk.channels[c] ?? chunk.channels[0];
      for (let f = start; f < end; f++) out[(f - fromFrame) * channels + c] = data[f - chunk.frame];
    }
    if (chunk.frame + length <= toFrame) chunks[i] = null;
  }
  return out;
}
