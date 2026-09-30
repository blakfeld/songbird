import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
// Written before localStorage so a blocked or full storage still lets a resize stick for the session.
const memory = new Map<string, number | null>();

const read = (key: string): number | null => {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

// A layout preference, so it lives outside any document or undo history, and a blocked or full
// localStorage only costs the remembered size rather than breaking the page.
export function useStoredHeight(key: string): [number | null, (px: number | null) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    () => read(key),
    () => null,
  );
  const set = useCallback(
    (px: number | null) => {
      memory.set(key, px === null ? null : Math.round(px));
      try {
        if (px === null) localStorage.removeItem(key);
        else localStorage.setItem(key, String(Math.round(px)));
      } catch {
        // The in-memory value above keeps the size for this session; only persistence is lost.
      }
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}
