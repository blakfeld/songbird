"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listLibrary,
  removeFromLibrary,
  renameLibrarySample,
  type SampleLibraryEntry,
} from "./sampleLibrary";
import { getSampleOverview } from "./sampleStore";

type Listener = () => void;
const listeners = new Set<Listener>();
// Imports and removals happen in several components, so one signal keeps every list in step.
export function notifyLibraryChanged() {
  for (const l of listeners) l();
}

export type LibraryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; entries: SampleLibraryEntry[] };

export function useSampleLibrary() {
  const [state, setState] = useState<LibraryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onChange = () => setVersion((v) => v + 1);
    listeners.add(onChange);
    return () => void listeners.delete(onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listLibrary().then(
      (entries) => !cancelled && setState({ status: "ready", entries }),
      () => !cancelled && setState({ status: "error" }),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, version]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((a) => a + 1);
  }, []);
  const rename = useCallback(async (id: string, name: string) => {
    await renameLibrarySample(id, name);
    notifyLibraryChanged();
  }, []);
  const remove = useCallback(async (id: string) => {
    await removeFromLibrary(id);
    notifyLibraryChanged();
  }, []);
  return { state, retry, rename, remove };
}

const overviews = new Map<string, Float32Array>();

// Missing is a result of its own because a song can legitimately reference audio this browser never stored.
export function useSampleOverview(id: string): Float32Array | null | "missing" {
  const [result, setResult] = useState<{ id: string; value: Float32Array | "missing" } | null>(() => {
    const hit = overviews.get(id);
    return hit ? { id, value: hit } : null;
  });
  useEffect(() => {
    if (overviews.has(id)) return;
    let cancelled = false;
    getSampleOverview(id).then(
      (o) => {
        if (cancelled) return;
        if (o) overviews.set(id, o);
        setResult({ id, value: o ?? "missing" });
      },
      () => !cancelled && setResult({ id, value: "missing" }),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  const hit = overviews.get(id);
  if (hit) return hit;
  return result && result.id === id ? result.value : null;
}

// A freshly imported sample must be readable before the first render that draws it.
export function primeOverview(id: string, overview: Float32Array) {
  overviews.set(id, overview);
}
