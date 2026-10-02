import { loadInputChoice, type InputChoice } from "./inputPrefs";

export type InputPermission = "prompt" | "granted" | "denied" | "unavailable";

export interface InputDevice {
  deviceId: string;
  label: string;
}

export type InputFailure = "denied" | "unavailable" | "no-input" | "failed";

export class InputError extends Error {
  constructor(
    readonly reason: InputFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface MediaTrackLike {
  getSettings(): { latency?: number; deviceId?: string; channelCount?: number };
  stop(): void;
  // Absent on a test double; the real track fires "ended" when its device is unplugged.
  addEventListener?(type: "ended", listener: () => void): void;
}

export interface MediaStreamLike {
  getAudioTracks(): MediaTrackLike[];
  getTracks(): MediaTrackLike[];
}

export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
  enumerateDevices(): Promise<{ kind: string; deviceId: string; label: string }[]>;
}

export interface InputContext {
  sampleRate: number;
  createMediaStreamSource(stream: never): unknown;
}

export interface InputManagerDeps {
  mediaDevices?: MediaDevicesLike | null;
  queryPermission?: () => Promise<InputPermission | null>;
}

// What a take needs from an open input. `source` is the dry tap: nothing is between it and the capture node.
export interface OpenInput<S = unknown> {
  source: S;
  stream: MediaStreamLike;
  deviceId: string | undefined;
  channels: 1 | 2;
  // Seconds, from the browser's own report when it gives one; zero is the honest answer when it does not.
  inputLatency: number;
  // Set when the remembered device is gone, so the UI can say the default was used instead of failing silently.
  fellBack: boolean;
  close(): void;
}

const browserDevices = (): MediaDevicesLike | null =>
  typeof navigator !== "undefined" && navigator.mediaDevices
    ? (navigator.mediaDevices as unknown as MediaDevicesLike)
    : null;

async function browserPermission(): Promise<InputPermission | null> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch {
    // Not every browser can query the microphone, and then only asking for it will tell.
    return null;
  }
}

const isMissingDevice = (e: unknown) => {
  const name = (e as { name?: string } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError";
};

export function createInputManager(deps: InputManagerDeps = {}) {
  const devices = () => (deps.mediaDevices !== undefined ? deps.mediaDevices : browserDevices());
  const queryPermission = deps.queryPermission ?? browserPermission;

  async function permission(): Promise<InputPermission> {
    const md = devices();
    if (!md || typeof md.getUserMedia !== "function") return "unavailable";
    return (await queryPermission()) ?? "prompt";
  }

  // Browsers hide labels until permission is granted, so an unlabelled device is still listed and still selectable.
  async function listDevices(): Promise<InputDevice[]> {
    const md = devices();
    if (!md) return [];
    const all = await md.enumerateDevices();
    return all
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }));
  }

  const constraints = (ctx: InputContext, deviceId: string | undefined, channels: 1 | 2): MediaStreamConstraints => ({
    audio: {
      ...(deviceId ? { deviceId } : {}),
      channelCount: channels,
      // Processing meant for calls would colour the take and add latency, and monitoring does its own work.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: ctx.sampleRate,
    },
  });

  async function open(ctx: InputContext, trackId: string, override?: InputChoice): Promise<OpenInput> {
    const md = devices();
    if (!md || typeof md.getUserMedia !== "function") {
      throw new InputError("unavailable", "This browser cannot record audio");
    }
    const choice = override ?? loadInputChoice(trackId);
    let deviceId = choice.deviceId;
    let fellBack = false;
    // Only checkable once labels exist, but a granted device always lists its id, and a stale id is the common case.
    if (deviceId) {
      try {
        const present = (await md.enumerateDevices()).some((d) => d.kind === "audioinput" && d.deviceId === deviceId);
        if (!present) {
          deviceId = undefined;
          fellBack = true;
        }
      } catch {
        // Enumeration failing says nothing about the device, so the request below decides.
      }
    }

    let stream: MediaStreamLike;
    try {
      stream = await md.getUserMedia(constraints(ctx, deviceId, choice.channels));
    } catch (e) {
      if (deviceId && isMissingDevice(e)) {
        deviceId = undefined;
        fellBack = true;
        stream = await md.getUserMedia(constraints(ctx, undefined, choice.channels)).catch(fail);
      } else {
        fail(e);
      }
    }

    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new InputError("failed", "The input has no audio");
    }
    const settings = track.getSettings();
    const latency = settings.latency;
    // The remembered choice is left alone on a fallback, so an interface that was only unplugged is used again once back.
    return {
      source: ctx.createMediaStreamSource(stream as never),
      stream,
      deviceId: settings.deviceId ?? deviceId,
      channels: choice.channels,
      inputLatency: typeof latency === "number" && Number.isFinite(latency) && latency > 0 ? latency : 0,
      fellBack,
      close: () => stream.getTracks().forEach((t) => t.stop()),
    };
  }

  return { permission, listDevices, open };
}

function fail(e: unknown): never {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    throw new InputError("denied", "Microphone access was denied");
  }
  throw new InputError("failed", e instanceof Error ? e.message : "The input could not be opened");
}

export type InputManager = ReturnType<typeof createInputManager>;

// Shared so the permission state a header shows and the one a take acts on cannot disagree.
export const inputManager: InputManager = createInputManager();
