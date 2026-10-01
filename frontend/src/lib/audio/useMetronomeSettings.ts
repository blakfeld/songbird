import { useCallback, useSyncExternalStore } from "react";

export interface MetronomeSettings {
  metronome: boolean;
  countIn: boolean;
}

export const METRONOME_STORAGE_KEY = "songbird.metronome.v1";

const DEFAULTS: MetronomeSettings = { metronome: false, countIn: true };

const listeners = new Set<() => void>();
let cached: { raw: string | null; value: MetronomeSettings } = { raw: null, value: DEFAULTS };
// Private browsing can refuse writes; the session still honours the choice from here.
let memory: MetronomeSettings | null = null;

function parse(raw: string | null): MetronomeSettings {
  if (!raw) return DEFAULTS;
  try {
    const p = JSON.parse(raw) as Partial<MetronomeSettings>;
    return {
      metronome: typeof p.metronome === "boolean" ? p.metronome : DEFAULTS.metronome,
      countIn: typeof p.countIn === "boolean" ? p.countIn : DEFAULTS.countIn,
    };
  } catch {
    return DEFAULTS;
  }
}

// Read through on every call so every consumer, and tests that clear storage, see one truth.
function getSnapshot(): MetronomeSettings {
  if (memory) return memory;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(METRONOME_STORAGE_KEY);
  } catch {
    return cached.value;
  }
  // Same reference for same content, as useSyncExternalStore requires a stable snapshot.
  if (raw !== cached.raw) cached = { raw, value: parse(raw) };
  return cached.value;
}

const getServerSnapshot = () => DEFAULTS;

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function update(patch: Partial<MetronomeSettings>) {
  const next = { ...getSnapshot(), ...patch };
  try {
    localStorage.setItem(METRONOME_STORAGE_KEY, JSON.stringify(next));
    memory = null;
  } catch {
    memory = next;
  }
  listeners.forEach((l) => l());
}

export function resetMetronomeSettingsForTests() {
  memory = null;
  cached = { raw: null, value: DEFAULTS };
}

export function useMetronomeSettings() {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setMetronome = useCallback((metronome: boolean) => update({ metronome }), []);
  const setCountIn = useCallback((countIn: boolean) => update({ countIn }), []);
  return { ...settings, setMetronome, setCountIn };
}
