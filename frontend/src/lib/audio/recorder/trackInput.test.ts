import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInputManager } from "./inputManager";
import { loadInputChoice } from "./inputPrefs";
import type { RecorderTap } from "./recorderTap";
import { createInputOwner } from "./trackInput";

function setup(opts: { reject?: string; devices?: string[]; tapFails?: boolean } = {}) {
  const devices = (opts.devices ?? ["Built-in", "Scarlett"]).map((label, i) => ({ kind: "audioinput", deviceId: `d${i}`, label }));
  let ended: (() => void) | null = null;
  const stopped = vi.fn();
  const track = {
    getSettings: () => ({ channelCount: 1 }),
    stop: stopped,
    addEventListener: (...args: ["ended", () => void]) => {
      ended = args[1];
    },
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  // Lets a test keep the browser "asking" for a while, to let go of the input in the meantime.
  const gate: { wait: Promise<void> | null } = { wait: null };
  const getUserMedia = vi.fn(async (...args: [MediaStreamConstraints]) => {
    void args;
    await gate.wait;
    if (opts.reject) throw Object.assign(new Error("no"), { name: opts.reject });
    return stream;
  });
  const manager = createInputManager({
    mediaDevices: { enumerateDevices: async () => devices, getUserMedia },
    queryPermission: async () => "granted",
  });
  const peakCbs = new Set<(p: { frame: number; peak: number }) => void>();
  const tap = {
    startCapture: vi.fn(),
    stopCapture: async () => {},
    subscribePeaks: (cb: (p: { frame: number; peak: number }) => void) => {
      peakCbs.add(cb);
      return () => peakCbs.delete(cb);
    },
    clipHeld: () => false,
    clearClip: vi.fn(),
    dispose: vi.fn(),
  } as RecorderTap & { dispose: ReturnType<typeof vi.fn> };
  const owner = createInputOwner(manager, {
    createTap: async () => {
      if (opts.tapFails) throw new Error("worklet failed to load");
      return tap;
    },
    nativeContext: () => ({ createMediaStreamSource: () => ({}) }) as never });
  const engine = { prepareInput: async () => ({ sampleRate: 48000, createMediaStreamSource: () => ({}) }) as never };
  return { owner, engine, getUserMedia, gate, tap, stopped, unplug: () => ended?.(), peak: (peak: number) => peakCbs.forEach((cb) => cb({ frame: 0, peak })) };
}

beforeEach(() => localStorage.clear());

describe("input owner", () => {
  it("shares one open input between the meter, monitoring and a take", async () => {
    const { owner, engine, getUserMedia, tap, stopped } = setup();
    const meter = await owner.acquire(engine, "t1", "meter");
    const take = await owner.acquire(engine, "t1", "record");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    if (!("input" in meter) || !("input" in take)) throw new Error("refused");
    expect(take.input.tap).toBe(meter.input.tap);

    // The take letting go must not cut the meter's input out from under it.
    take.input.release();
    expect(tap.dispose).not.toHaveBeenCalled();
    expect(owner.getView("t1").status).toBe("ready");

    meter.input.release();
    expect(tap.dispose).toHaveBeenCalled();
    expect(stopped).toHaveBeenCalled();
    expect(owner.getView("t1").status).toBe("idle");
  });

  it("reports a device that disappears to whoever is recording, while the tap still exists to flush", async () => {
    const { owner, engine, unplug } = setup();
    const result = await owner.acquire(engine, "t1", "record");
    if (!("input" in result)) throw new Error("refused");
    let tapThen: unknown = "unset";
    const lost = vi.fn(() => {
      tapThen = owner.tap("t1");
    });
    result.input.onLost?.(lost);
    unplug();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(tapThen).not.toBeNull();
    expect(owner.getView("t1").status).toBe("no-input");
    expect(owner.tap("t1")).toBeNull();
  });

  it("remembers a denial the browser cannot report, until an input opens", async () => {
    const { owner, engine } = setup({ reject: "NotAllowedError" });
    expect(await owner.acquire(engine, "t1", "popover")).toEqual({ reason: "denied" });
    await owner.refresh();
    expect(owner.getEnv().permission).toBe("granted");
    expect(owner.getView("t1").status).toBe("denied");
  });

  it("refuses when there is no input device", async () => {
    const { owner, engine, getUserMedia } = setup({ devices: [] });
    expect(await owner.acquire(engine, "t1", "record")).toEqual({ reason: "no-input" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reopens on a new device and keeps the choice for the track", async () => {
    const { owner, engine, getUserMedia } = setup();
    await owner.acquire(engine, "t1", "meter");
    const before = owner.getView("t1").revision;
    await owner.setChoice(engine, "t1", { deviceId: "d1", channels: 2, label: "Scarlett" });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect((getUserMedia.mock.calls[1][0].audio as MediaTrackConstraints).deviceId).toBe("d1");
    expect(owner.getView("t1").revision).toBeGreaterThan(before);
    expect(loadInputChoice("t1")).toMatchObject({ deviceId: "d1", channels: 2, label: "Scarlett" });
  });

  it("keeps a clip latched after the input closes, until it is cleared", async () => {
    const { owner, engine, peak, tap } = setup();
    const result = await owner.acquire(engine, "t1", "meter");
    if (!("input" in result)) throw new Error("refused");
    peak(0.5);
    expect(owner.getView("t1").clipped).toBe(false);
    peak(1);
    result.input.release();
    expect(owner.getView("t1").clipped).toBe(true);

    owner.clearClip("t1");
    expect(owner.getView("t1").clipped).toBe(false);
    expect(tap.clearClip).not.toHaveBeenCalled();
  });

  it("gives the microphone back when setup fails after the stream opened", async () => {
    const { owner, engine, stopped } = setup({ tapFails: true });
    expect(await owner.acquire(engine, "t1", "meter")).toEqual({ reason: "failed" });
    expect(stopped).toHaveBeenCalled();
    expect(owner.getView("t1").status).toBe("failed");
  });

  it("closes a reopened input when everyone let go while it was opening", async () => {
    const { owner, engine, gate, stopped } = setup();
    await owner.acquire(engine, "t1", "meter");
    let open!: () => void;
    gate.wait = new Promise((resolve) => (open = resolve));
    const changing = owner.setChoice(engine, "t1", { deviceId: "d1", channels: 1 });
    owner.drop("t1", "meter");
    gate.wait = null;
    open();
    await changing;
    expect(owner.getView("t1").status).toBe("idle");
    // Once when the old input closed for the change, and once more for the new one nobody wanted.
    expect(stopped).toHaveBeenCalledTimes(2);
  });

  it("does not change the input of a track that is recording", async () => {
    const { owner, engine, getUserMedia } = setup();
    const take = await owner.acquire(engine, "t1", "record");
    if (!("input" in take)) throw new Error("refused");
    expect(owner.isRecording("t1")).toBe(true);
    expect(await owner.setChoice(engine, "t1", { deviceId: "d1", channels: 2 })).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(loadInputChoice("t1")).toEqual({ channels: 1 });
    take.input.release();
    expect(await owner.setChoice(engine, "t1", { deviceId: "d1", channels: 2 })).toBe(true);
  });

  it("a late release from an earlier take does not drop the next take's hold", async () => {
    const { owner, engine, stopped } = setup();
    const first = await owner.acquire(engine, "t1", "record");
    const second = await owner.acquire(engine, "t1", "record");
    if (!("input" in first) || !("input" in second)) throw new Error("refused");
    first.input.release();
    // A second, late release of the same take must not count against the take that is now recording.
    first.input.release();
    expect(owner.getView("t1").status).toBe("ready");
    expect(stopped).not.toHaveBeenCalled();
    second.input.release();
    expect(owner.getView("t1").status).toBe("idle");
  });

  it("does not reopen under a take that started while the first open was still settling", async () => {
    const { owner, engine, gate, getUserMedia } = setup();
    let open!: () => void;
    gate.wait = new Promise((resolve) => (open = resolve));
    const meter = owner.acquire(engine, "t1", "meter");
    // A change arrives while the browser is still asking, and a take then takes the input.
    const changing = owner.setChoice(engine, "t1", { deviceId: "d1", channels: 1 });
    const take = owner.acquire(engine, "t1", "record");
    gate.wait = null;
    open();
    await meter;
    expect(await changing).toBe(false);
    const result = await take;
    expect("input" in result).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
