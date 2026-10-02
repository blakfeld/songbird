import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInputManager, InputError, type MediaDevicesLike, type MediaStreamLike } from "./inputManager";
import {
  RECORDING_OFFSET_KEY,
  clampRecordingOffsetMs,
  loadInputChoice,
  loadRecordingOffsetMs,
  saveInputChoice,
  resetRecordingOffsetForTests,
  saveRecordingOffsetMs,
} from "./inputPrefs";
import { placeTake, songSecondsOfFrame, type Latencies, type TakeOrigin } from "./placement";
import { collectFrames, createRecorderTap, takeInterleaved, type RecorderChunk, type WorkletNodeLike } from "./recorderTap";

const fakeStream = (latency?: number, deviceId = "built-in"): MediaStreamLike & { stopped: number } => {
  const track = {
    getSettings: () => ({ latency, deviceId }),
    stop() {
      stream.stopped += 1;
    },
  };
  const stream = { stopped: 0, getAudioTracks: () => [track], getTracks: () => [track] };
  return stream;
};

const ctx = { sampleRate: 44100, createMediaStreamSource: (stream: unknown) => ({ stream }) };

function devices(opts: {
  present?: string[];
  reject?: { name: string; when?: (c: MediaStreamConstraints) => boolean };
  latency?: number;
}) {
  const calls: MediaStreamConstraints[] = [];
  const mediaDevices: MediaDevicesLike = {
    enumerateDevices: async () => [
      ...(opts.present ?? ["built-in"]).map((id) => ({ kind: "audioinput", deviceId: id, label: "" })),
      { kind: "videoinput", deviceId: "cam", label: "Cam" },
    ],
    getUserMedia: async (c) => {
      calls.push(c);
      if (opts.reject && (opts.reject.when?.(c) ?? true)) throw Object.assign(new Error("no"), { name: opts.reject.name });
      return fakeStream(opts.latency);
    },
  };
  return { mediaDevices, calls };
}

beforeEach(() => {
  localStorage.clear();
  resetRecordingOffsetForTests();
});

describe("input manager", () => {
  it("asks for raw, uncorrected audio on the context's rate, with the stored device and channels", async () => {
    saveInputChoice("t1", { deviceId: "usb", channels: 2 });
    const { mediaDevices, calls } = devices({ present: ["built-in", "usb"] });
    const input = await createInputManager({ mediaDevices }).open(ctx, "t1");
    expect(calls).toEqual([
      {
        audio: {
          deviceId: "usb",
          channelCount: 2,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 44100,
        },
      },
    ]);
    expect(input.channels).toBe(2);
    expect(input.fellBack).toBe(false);
  });

  it("asks for mono and no device when nothing is remembered", async () => {
    const { mediaDevices, calls } = devices({});
    await createInputManager({ mediaDevices }).open(ctx, "t1");
    expect(calls[0]).toEqual({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 44100 },
    });
  });

  it("falls back to the default input and says so when the remembered device is missing", async () => {
    saveInputChoice("t1", { deviceId: "unplugged", channels: 1 });
    const { mediaDevices, calls } = devices({});
    const input = await createInputManager({ mediaDevices }).open(ctx, "t1");
    expect(input.fellBack).toBe(true);
    expect((calls[0].audio as MediaTrackConstraints).deviceId).toBeUndefined();
    // Kept so the interface is used again when it is plugged back in.
    expect(loadInputChoice("t1").deviceId).toBe("unplugged");
  });

  it("falls back when the browser rejects a device that enumeration still listed", async () => {
    saveInputChoice("t1", { deviceId: "stale", channels: 1 });
    const { mediaDevices, calls } = devices({
      present: ["stale"],
      reject: { name: "OverconstrainedError", when: (c) => !!(c.audio as MediaTrackConstraints).deviceId },
    });
    const input = await createInputManager({ mediaDevices }).open(ctx, "t1");
    expect(calls).toHaveLength(2);
    expect(input.fellBack).toBe(true);
  });

  it("reports a denied permission as a typed error and opens nothing", async () => {
    const { mediaDevices } = devices({ reject: { name: "NotAllowedError" } });
    await expect(createInputManager({ mediaDevices }).open(ctx, "t1")).rejects.toMatchObject({
      reason: "denied",
      name: "Error",
    });
    await expect(createInputManager({ mediaDevices }).open(ctx, "t1")).rejects.toBeInstanceOf(InputError);
  });

  it("maps the browser's permission state, and unavailable when there is no capture API", async () => {
    const { mediaDevices } = devices({});
    for (const state of ["prompt", "granted", "denied"] as const) {
      expect(await createInputManager({ mediaDevices, queryPermission: async () => state }).permission()).toBe(state);
    }
    expect(await createInputManager({ mediaDevices, queryPermission: async () => null }).permission()).toBe("prompt");
    expect(await createInputManager({ mediaDevices: null }).permission()).toBe("unavailable");
    await expect(createInputManager({ mediaDevices: null }).open(ctx, "t1")).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("lists audio inputs only, naming unlabelled ones", async () => {
    const { mediaDevices } = devices({ present: ["a", "b"] });
    expect(await createInputManager({ mediaDevices }).listDevices()).toEqual([
      { deviceId: "a", label: "Input 1" },
      { deviceId: "b", label: "Input 2" },
    ]);
  });

  it("takes the input latency from the track's settings, or zero when absent", async () => {
    expect((await createInputManager({ mediaDevices: devices({ latency: 0.008 }).mediaDevices }).open(ctx, "t")).inputLatency).toBe(0.008);
    expect((await createInputManager({ mediaDevices: devices({}).mediaDevices }).open(ctx, "t")).inputLatency).toBe(0);
  });
});

describe("recording preferences", () => {
  it("remembers a choice per track and survives storage that throws", () => {
    saveInputChoice("a", { deviceId: "x", channels: 2 });
    saveInputChoice("b", { channels: 1 });
    expect(loadInputChoice("a")).toEqual({ deviceId: "x", channels: 2 });
    expect(loadInputChoice("b")).toEqual({ deviceId: undefined, channels: 1 });
    expect(loadInputChoice("c")).toEqual({ channels: 1 });

    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(loadInputChoice("a")).toEqual({ channels: 1 });
    expect(() => saveInputChoice("a", { channels: 1 })).not.toThrow();
    expect(loadRecordingOffsetMs()).toBe(0);
    spy.mockRestore();
    set.mockRestore();
  });

  it("clamps the recording offset to plus or minus 200 ms with a default of 0", () => {
    expect(loadRecordingOffsetMs()).toBe(0);
    expect(saveRecordingOffsetMs(500)).toBe(200);
    expect(loadRecordingOffsetMs()).toBe(200);
    expect(saveRecordingOffsetMs(-1000)).toBe(-200);
    expect(clampRecordingOffsetMs(Number.NaN)).toBe(0);
    resetRecordingOffsetForTests();
    localStorage.setItem(RECORDING_OFFSET_KEY, "garbage");
    expect(loadRecordingOffsetMs()).toBe(0);
  });
});

describe("placement", () => {
  // 120 BPM in 4/4: a measure is 2 s and 3840 ticks, so 1 ms is about 1.92 ticks.
  const MEASURE_TICKS = 3840;
  const RATE = 48000;
  const TEMPO = 120;
  const origin: TakeOrigin = { contextTime: 10, songSeconds: 0 };
  const ticksToMs = (ticks: number) => (ticks / (16 * TEMPO)) * 1000;

  // The clap is played on the beat: it is emitted at context time 12 (song 2 s), heard `output + base` later, and
  // reaches the capture node `input` after that.
  const clapFrame = (l: Latencies) => Math.round((10 + 2 + l.outputLatency + l.baseLatency + l.inputLatency + l.userOffset) * RATE);

  function clapMsFromMeasure2(l: Latencies) {
    // The recording started early so the take has audio before the clap.
    const firstFrame = Math.round(10.5 * RATE);
    const placed = placeTake(firstFrame, RATE, TEMPO, origin, l, 0);
    const clapInTake = clapFrame(l) - firstFrame - placed.offsetSamples;
    const clapTicks = placed.startTicks + (clapInTake / RATE) * 16 * TEMPO;
    return ticksToMs(clapTicks - MEASURE_TICKS);
  }

  it("Latency compensated: a clap on the beat of measure 2 lands within 5 ms of it", () => {
    const l: Latencies = { outputLatency: 0.01, baseLatency: 0, inputLatency: 0.008, userOffset: 0 };
    expect(Math.abs(clapMsFromMeasure2(l))).toBeLessThan(5);
  });

  it("Adjust offset: +15 ms places the take 15 ms earlier than offset 0", () => {
    const base: Latencies = { outputLatency: 0.01, baseLatency: 0, inputLatency: 0.008, userOffset: 0 };
    const firstFrame = Math.round(10.5 * RATE);
    const zero = placeTake(firstFrame, RATE, TEMPO, origin, base, 0);
    const shifted = placeTake(firstFrame, RATE, TEMPO, origin, { ...base, userOffset: 0.015 }, 0);
    expect(Math.abs(ticksToMs(zero.startTicks - shifted.startTicks) - 15)).toBeLessThan(1);
    // The same clap is judged against the same offset, so only the placement moves.
    expect(songSecondsOfFrame(firstFrame, RATE, origin, base) - songSecondsOfFrame(firstFrame, RATE, origin, { ...base, userOffset: 0.015 })).toBeCloseTo(0.015, 9);
  });

  it("trims samples that compensation moves before the punch-in instead of placing them early", () => {
    const l: Latencies = { outputLatency: 0.02, baseLatency: 0.005, inputLatency: 0, userOffset: 0 };
    // Capture began exactly at the punch frame, so 25 ms of the take compensates to before the punch.
    const placed = placeTake(10 * RATE, RATE, TEMPO, origin, l);
    expect(placed.startTicks).toBe(0);
    expect(placed.offsetSamples).toBe(Math.round(0.025 * RATE));
  });

  it("never places a start before zero", () => {
    const l: Latencies = { outputLatency: 0.5, baseLatency: 0, inputLatency: 0, userOffset: 0 };
    expect(placeTake(10 * RATE, RATE, TEMPO, origin, l).startTicks).toBe(0);
  });

  it("keeps the count-in out of song time through the origin", () => {
    // Capture starts 2 s of count-in before the first bar, which is song time 0 at context time 12.
    const countIn: TakeOrigin = { contextTime: 12, songSeconds: 0 };
    const none: Latencies = { outputLatency: 0, baseLatency: 0, inputLatency: 0, userOffset: 0 };
    const placed = placeTake(11 * RATE, RATE, TEMPO, countIn, none);
    expect(placed.startTicks).toBe(0);
    expect(placed.offsetSamples).toBe(RATE);
  });
});

describe("recorder tap", () => {
  function fake() {
    const node: WorkletNodeLike & { sent: unknown[]; connections: unknown[] } = {
      sent: [],
      connections: [],
      port: { onmessage: null, postMessage: (m) => node.sent.push(m) },
      connect(d) {
        node.connections.push(d);
        return d;
      },
      disconnect() {},
    };
    const source = { connected: [] as unknown[], connect: (d: unknown) => source.connected.push(d), disconnect: vi.fn() };
    const addModule = vi.fn(async () => {});
    return { node, source, addModule, tapCtx: { sampleRate: 48000, audioWorklet: { addModule } } };
  }
  const post = (node: WorkletNodeLike, data: unknown) => node.port.onmessage?.({ data });

  it("loads the worklet once per context and taps the source", async () => {
    const { node, source, addModule, tapCtx } = fake();
    await createRecorderTap(tapCtx, source, 1, { createNode: () => node });
    await createRecorderTap(tapCtx, source, 1, { createNode: () => node });
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(addModule).toHaveBeenCalledWith("/worklets/recorder.js");
    expect(source.connected[0]).toBe(node);
  });

  it("delivers chunks while capturing and waits for the flush on stop", async () => {
    const { node, source, tapCtx } = fake();
    const tap = await createRecorderTap(tapCtx, source, 1, { createNode: () => node });
    const chunks: RecorderChunk[] = [];
    tap.startCapture((c) => chunks.push(c));
    expect(node.sent).toContainEqual({ type: "start" });
    post(node, { type: "chunk", frame: 480, channels: [new Float32Array(4)] });
    expect(chunks).toEqual([{ frame: 480, channels: [new Float32Array(4)] }]);

    let done = false;
    const stopping = tap.stopCapture().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    post(node, { type: "chunk", frame: 484, channels: [new Float32Array(2)] });
    post(node, { type: "stopped" });
    await stopping;
    expect(chunks).toHaveLength(2);
  });

  it("streams peaks and latches clipping until cleared", async () => {
    const { node, source, tapCtx } = fake();
    const tap = await createRecorderTap(tapCtx, source, 1, { createNode: () => node });
    const peaks: number[] = [];
    const off = tap.subscribePeaks((p) => peaks.push(p.peak));
    post(node, { type: "peak", frame: 1, peak: 0.4 });
    expect(tap.clipHeld()).toBe(false);
    post(node, { type: "peak", frame: 2, peak: 1 });
    post(node, { type: "peak", frame: 3, peak: 0.1 });
    expect(peaks).toEqual([0.4, 1, 0.1]);
    expect(tap.clipHeld()).toBe(true);
    tap.clearClip();
    expect(tap.clipHeld()).toBe(false);
    off();
    post(node, { type: "peak", frame: 4, peak: 0.2 });
    expect(peaks).toHaveLength(3);
  });

  it("cuts chunks at an exact frame across a chunk boundary", () => {
    const a = Float32Array.from([1, 2, 3, 4]);
    const b = Float32Array.from([5, 6, 7, 8]);
    const chunks: RecorderChunk[] = [
      { frame: 100, channels: [a] },
      { frame: 104, channels: [b] },
    ];
    expect([...collectFrames(chunks, 0, 102, 106)]).toEqual([3, 4, 5, 6]);
    expect([...collectFrames(chunks, 0, 106, 110)]).toEqual([7, 8, 0, 0]);
  });

  it("waits for the worklet's flush before closing, so the last partial chunk is kept", async () => {
    const { node, source, tapCtx } = fake();
    const tap = await createRecorderTap(tapCtx, source, 1, { createNode: () => node });
    const chunks: RecorderChunk[] = [];
    tap.startCapture((c) => chunks.push(c));
    let closed = false;
    const closing = tap.dispose().then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(source.disconnect).not.toHaveBeenCalled();
    // The tail arrives after the close was asked for, and still reaches the take.
    post(node, { type: "chunk", frame: 0, channels: [new Float32Array(3)] });
    post(node, { type: "stopped" });
    await closing;
    expect(chunks).toHaveLength(1);
    expect(source.disconnect).toHaveBeenCalled();
  });

  it("shares one stop between the take and a close, and gives up on a worklet that never answers", async () => {
    vi.useFakeTimers();
    try {
      const { node, source, tapCtx } = fake();
      const tap = await createRecorderTap(tapCtx, source, 1, { createNode: () => node }, 500);
      tap.startCapture(() => {});
      const stops = () => node.sent.filter((m) => (m as { type: string }).type === "stop").length;
      const a = tap.stopCapture();
      const b = tap.dispose();
      expect(stops()).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([a, b]);
      expect(source.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes interleaved samples straight from the chunks and lets go of the ones it has finished with", () => {
    const left = (from: number) => Float32Array.from([from, from + 1, from + 2, from + 3]);
    const right = (from: number) => Float32Array.from([-from, -from - 1, -from - 2, -from - 3]);
    const chunks: (RecorderChunk | null)[] = [
      { frame: 0, channels: [left(0), right(0)] },
      { frame: 4, channels: [left(4), right(4)] },
      { frame: 8, channels: [left(8), right(8)] },
    ];
    // Frames 2-6 take the end of the first chunk and the start of the second.
    const out = takeInterleaved(chunks, 2, 2, 6);
    expect([...out]).toEqual([2, -2, 3, -3, 4, -4, 5, -5]);
    // The first chunk ends inside the range's lifetime and goes; the second ends past it and stays for the next pass.
    expect(chunks[0]).toBeNull();
    expect(chunks[1]).not.toBeNull();
    expect(chunks[2]).not.toBeNull();
  });
});
