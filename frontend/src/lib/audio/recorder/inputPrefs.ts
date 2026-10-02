export interface InputChoice {
  // Absent means the browser's default input.
  deviceId?: string;
  channels: 1 | 2;
  // Kept so the trigger can name a device that is unplugged, when the browser no longer lists it.
  label?: string;
}

export const DEFAULT_INPUT_CHOICE: InputChoice = { channels: 1 };

export const INPUT_CHOICE_KEY_PREFIX = "songbird.recording.input.";
export const RECORDING_OFFSET_KEY = "songbird.recording.offsetMs.v1";
export const RECORDING_OFFSET_RANGE_MS = { min: -200, max: 200 } as const;

// Keyed by track id but kept in the browser rather than the song: an interface belongs to this machine, and a
// shared song must not carry one person's device ids to another.
const keyFor = (trackId: string) => `${INPUT_CHOICE_KEY_PREFIX}${trackId}`;

export function loadInputChoice(trackId: string): InputChoice {
  try {
    const raw = localStorage.getItem(keyFor(trackId));
    if (!raw) return DEFAULT_INPUT_CHOICE;
    const p = JSON.parse(raw) as Partial<InputChoice>;
    return {
      deviceId: typeof p.deviceId === "string" && p.deviceId ? p.deviceId : undefined,
      channels: p.channels === 2 ? 2 : 1,
      label: typeof p.label === "string" && p.label ? p.label : undefined,
    };
  } catch {
    return DEFAULT_INPUT_CHOICE;
  }
}

export function saveInputChoice(trackId: string, choice: InputChoice): void {
  try {
    localStorage.setItem(keyFor(trackId), JSON.stringify(choice));
  } catch {
    // A blocked or full storage only costs the remembered device; recording still works with the default.
  }
}

export const clampRecordingOffsetMs = (ms: number) =>
  Number.isFinite(ms) ? Math.min(RECORDING_OFFSET_RANGE_MS.max, Math.max(RECORDING_OFFSET_RANGE_MS.min, Math.round(ms))) : 0;

export function parseRecordingOffsetMs(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? clampRecordingOffsetMs(n) : null;
}

// Private browsing can refuse writes; the session still honours the offset from here.
let offsetMemory: number | null = null;
const offsetListeners = new Set<() => void>();
export const subscribeRecordingOffset = (cb: () => void) => {
  offsetListeners.add(cb);
  return () => offsetListeners.delete(cb);
};

export function loadRecordingOffsetMs(): number {
  if (offsetMemory !== null) return offsetMemory;
  try {
    const raw = localStorage.getItem(RECORDING_OFFSET_KEY);
    return raw === null ? 0 : (parseRecordingOffsetMs(raw) ?? 0);
  } catch {
    return 0;
  }
}

export function saveRecordingOffsetMs(ms: number): number {
  const clamped = clampRecordingOffsetMs(ms);
  offsetMemory = clamped;
  offsetListeners.forEach((cb) => cb());
  try {
    localStorage.setItem(RECORDING_OFFSET_KEY, String(clamped));
  } catch {
    // The offset then applies to this page load only, which beats refusing the change.
  }
  return clamped;
}

// Lets a test start from storage again, since the in-memory copy otherwise outlives a cleared localStorage.
export const resetRecordingOffsetForTests = () => {
  offsetMemory = null;
};
