import type { PlaybackEngine } from "../engine";
import {
  InputError,
  inputManager,
  type InputDevice,
  type InputManager,
  type InputPermission,
  type OpenInput,
} from "./inputManager";
import { saveInputChoice, type InputChoice } from "./inputPrefs";
import type { InputRefusal, RecordingInput } from "./recordingInput";
import { nativeContextOf } from "./nativeContext";
import { createRecorderTap, type RecorderTap, type TapContext, type TapSource } from "./recorderTap";

export type TrackInputStatus = "idle" | "asking" | "ready" | "denied" | "no-input" | "unavailable" | "failed";

export interface TrackInputView {
  status: TrackInputStatus;
  // The remembered device is gone and the default is in use, which the UI must say rather than hide.
  fellBack: boolean;
  // What the device reported, so Stereo can be refused on a one-channel input.
  channelCount: number | null;
  // Latched at full scale until the user clears it, and kept when the input closes so a clip that happened is never
  // forgotten just because the track was deselected.
  clipped: boolean;
  // Bumped on every open, so a consumer holding the source or tap knows to take the new ones.
  revision: number;
}

export interface InputEnvironment {
  permission: InputPermission;
  devices: InputDevice[] | null;
}

type Engine = Pick<PlaybackEngine, "prepareInput">;

interface Open {
  input: OpenInput;
  tap: RecorderTap;
  ctx: TapContext;
}

interface Entry {
  // Who needs the input open (the meter, monitoring, the popover, a take), by a token unique to each request so a
  // late release from one take cannot drop the hold of the next. It closes when the last one lets go.
  holds: Map<string, string>;
  opening: Promise<InputRefusal | null> | null;
  open: Open | null;
  view: TrackInputView;
  listeners: Set<() => void>;
  lost: Set<() => void>;
}

const IDLE: TrackInputView = { status: "idle", fellBack: false, channelCount: null, clipped: false, revision: 0 };

// One owner for every track's input so monitoring, the meter and a take share a single open stream. A second
// getUserMedia per use would double the latency and the permission prompts, and two taps could not agree on a clip flag.
export function createInputOwner(
  manager: InputManager = inputManager,
  deps: { createTap?: typeof createRecorderTap; nativeContext?: typeof nativeContextOf } = {},
) {
  const createTap = deps.createTap ?? createRecorderTap;
  const toNative = deps.nativeContext ?? nativeContextOf;
  let env: InputEnvironment = { permission: "prompt", devices: null };
  const envListeners = new Set<() => void>();
  // The browser cannot always report a denial, so a refused attempt has to be remembered until a grant is seen.
  let deniedByAttempt = false;
  const entries = new Map<string, Entry>();

  const setEnv = (patch: Partial<InputEnvironment>) => {
    env = { ...env, ...patch };
    envListeners.forEach((cb) => cb());
  };

  const entry = (trackId: string): Entry => {
    let e = entries.get(trackId);
    if (!e) {
      e = { holds: new Map(), opening: null, open: null, view: IDLE, listeners: new Set(), lost: new Set() };
      entries.set(trackId, e);
    }
    return e;
  };

  const setView = (e: Entry, patch: Partial<TrackInputView>) => {
    e.view = { ...e.view, ...patch };
    e.listeners.forEach((cb) => cb());
  };

  async function refresh(): Promise<void> {
    let permission = await manager.permission();
    if (permission === "granted") deniedByAttempt = false;
    else if (permission === "prompt" && deniedByAttempt) permission = "denied";
    let devices: InputDevice[] | null = null;
    try {
      devices = permission === "unavailable" ? [] : await manager.listDevices();
    } catch {
      // A failed listing says nothing about the devices, so the last known list stays.
      devices = env.devices;
    }
    setEnv({ permission, devices });
  }

  function close(e: Entry) {
    const open = e.open;
    if (!open) return;
    e.open = null;
    // Disposing waits for a running capture to flush, so what a take already heard is not lost with the input.
    void Promise.resolve(open.tap.dispose());
    open.input.close();
    setView(e, { status: "idle" });
  }

  async function openNow(engine: Engine, trackId: string, e: Entry): Promise<InputRefusal | null> {
    setView(e, { status: "asking" });
    // Held outside the try so a failure part-way through setup can still give the microphone back.
    let input: OpenInput | undefined;
    let tap: RecorderTap | undefined;
    try {
      const ctx = (await engine.prepareInput()) as unknown as TapContext & Parameters<InputManager["open"]>[0];
      const native = toNative(ctx as { rawContext?: unknown }) as unknown as TapContext & { createMediaStreamSource(stream: never): unknown };
      if ((await manager.permission()) === "unavailable") throw new InputError("unavailable", "unsupported");
      const devices = await manager.listDevices();
      setEnv({ devices });
      if (devices.length === 0) throw new InputError("no-input", "no input");
      input = await manager.open(ctx, trackId);
      // A second source on the same stream, native, because the one in `input` is a wrapper node that cannot feed the
      // native worklet; the wrapper one stays for monitoring, which lives in Tone's graph.
      const opened = input;
      tap = await createTap(native, native.createMediaStreamSource(opened.stream as never) as TapSource, opened.channels);
      tap.subscribePeaks((p) => {
        if (p.peak >= 1 && !e.view.clipped) setView(e, { clipped: true });
      });
      const track = opened.stream.getAudioTracks()[0];
      const open: Open = { input: opened, tap, ctx };
      track.addEventListener?.("ended", () => {
        if (e.open !== open) return;
        // Told before the input closes, so a take can end and ask the tap to flush while it still exists.
        e.lost.forEach((cb) => cb());
        close(e);
        setView(e, { status: "no-input" });
        void refresh();
      });
      e.open = open;
      deniedByAttempt = false;
      setView(e, {
        status: "ready",
        fellBack: opened.fellBack,
        channelCount: track.getSettings().channelCount ?? null,
        revision: e.view.revision + 1,
      });
      void refresh();
      return null;
    } catch (err) {
      if (tap) void Promise.resolve(tap.dispose());
      input?.close();
      const reason: InputRefusal = err instanceof InputError ? err.reason : "failed";
      if (reason === "denied") deniedByAttempt = true;
      setView(e, { status: reason });
      void refresh();
      return reason;
    }
  }

  // By kind, for the holders that exist once per track (meter, popover, monitor). A take lets go of its own token.
  function drop(trackId: string, kind: string) {
    const e = entries.get(trackId);
    if (!e) return;
    for (const [token, held] of e.holds) if (held === kind) e.holds.delete(token);
    if (e.holds.size === 0 && !e.opening) close(e);
  }

  let tokens = 0;

  async function acquire(
    engine: Engine,
    trackId: string,
    holder: string,
  ): Promise<{ input: RecordingInput } | { reason: InputRefusal }> {
    const e = entry(trackId);
    const token = `${holder}#${++tokens}`;
    e.holds.set(token, holder);
    if (!e.open) {
      e.opening ??= openNow(engine, trackId, e).finally(() => {
        e.opening = null;
      });
      const refusal = await e.opening;
      if (refusal) {
        e.holds.delete(token);
        return { reason: refusal };
      }
      // Everyone who asked may have let go while the browser prompted.
      if (e.holds.size === 0) {
        close(e);
        return { reason: "failed" };
      }
    }
    const open = e.open!;
    return {
      input: {
        tap: open.tap,
        sampleRate: open.ctx.sampleRate,
        channels: open.input.channels,
        inputLatency: open.input.inputLatency,
        fellBack: open.input.fellBack,
        release: () => {
          e.holds.delete(token);
          if (e.holds.size === 0 && !e.opening) close(e);
        },
        onLost(cb) {
          e.lost.add(cb);
          return () => e.lost.delete(cb);
        },
      },
    };
  }

  return {
    acquire,
    drop,
    refresh,
    // Applied at once to an open input, which is reopened on the new device and channel count.
    async setChoice(engine: Engine, trackId: string, choice: InputChoice) {
      const e = entry(trackId);
      // Reopening would cut the capture of a take that is running, and take its last words with it.
      if ([...e.holds.values()].includes("record")) return false;
      saveInputChoice(trackId, choice);
      if (!e.open && !e.opening) return true;
      if (e.opening) await e.opening;
      // A take may have started while the first open was still settling.
      if ([...e.holds.values()].includes("record")) return false;
      if (!e.open) return true;
      close(e);
      await (e.opening = openNow(engine, trackId, e).finally(() => {
        e.opening = null;
      }));
      // Everyone may have let go while the new device was opening.
      if (e.holds.size === 0) close(e);
      return true;
    },
    isRecording: (trackId: string) => [...(entries.get(trackId)?.holds.values() ?? [])].includes("record"),
    clearClip(trackId: string) {
      const e = entry(trackId);
      e.open?.tap.clearClip();
      if (e.view.clipped) setView(e, { clipped: false });
    },
    source: (trackId: string): TapSource | null => (entries.get(trackId)?.open?.input.source as TapSource | undefined) ?? null,
    tap: (trackId: string): RecorderTap | null => entries.get(trackId)?.open?.tap ?? null,
    getView: (trackId: string): TrackInputView => entries.get(trackId)?.view ?? IDLE,
    subscribeView(trackId: string, cb: () => void) {
      const e = entry(trackId);
      e.listeners.add(cb);
      return () => e.listeners.delete(cb);
    },
    getEnv: () => env,
    subscribeEnv(cb: () => void) {
      envListeners.add(cb);
      return () => envListeners.delete(cb);
    },
  };
}

export type InputOwner = ReturnType<typeof createInputOwner>;

export const inputOwner: InputOwner = createInputOwner();
