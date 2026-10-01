import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
// Written before localStorage so a blocked or full storage still lets a change stick for the session.
const memory = new Map<string, unknown>();

// Tests share one module instance, so without this a value set in one test would shadow the next test's storage.
export const clearStoredValueCache = () => memory.clear();

// A layout preference, so it lives outside any document or undo history, and a blocked or full
// localStorage only costs the remembered value rather than breaking the page.
export function useStoredValue<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | null,
): [T, (value: T | null) => void] {
  const read = (): T => {
    if (memory.has(key)) return (memory.get(key) as T | null) ?? fallback;
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (parse(raw) ?? fallback);
    } catch {
      return fallback;
    }
  };
  const value = useSyncExternalStore(
    (cb) => {
      // Another tab's write is the truth now, so the local copy that shadowed storage has to go.
      const onStorage = (e: StorageEvent) => {
        if (e.key === null) memory.clear();
        else memory.delete(e.key);
        cb();
      };
      listeners.add(cb);
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    read,
    () => fallback,
  );
  const set = useCallback(
    (next: T | null) => {
      memory.set(key, next);
      try {
        if (next === null) localStorage.removeItem(key);
        else localStorage.setItem(key, String(next));
      } catch {
        // The in-memory value above keeps the change for this session; only persistence is lost.
      }
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}
