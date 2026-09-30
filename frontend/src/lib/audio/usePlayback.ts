import { useEffect, useMemo, useSyncExternalStore } from "react";
import { usePatternStore } from "@/lib/patternStore";
import { getPlaybackEngine } from "./engine";
import { playRange, type LoopSetting } from "@/lib/loopRegion";
import type { Playback } from "./types";

export function usePlayback(instrumentId: string, loop: LoopSetting): Playback {
  const engine = getPlaybackEngine(instrumentId);
  const snapshot = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot,
  );

  const { enabled } = loop;
  const range = playRange(loop);
  const start = range?.start;
  const end = range?.end;
  useEffect(() => {
    // Primitives keep a fresh-but-equal region object from re-running this every render.
    engine.setLoop(start === undefined || end === undefined ? null : { start, end });
  }, [engine, start, end]);
  useEffect(() => {
    engine.setLooping(enabled);
  }, [engine, enabled]);

  useEffect(() => () => engine.stop(), [engine]);

  const rows = usePatternStore(instrumentId, (s) => s.pattern?.rows);
  useEffect(() => {
    void engine.preload(rows);
  }, [engine, rows]);

  return useMemo(
    () => ({
      ...snapshot,
      toggle: engine.toggle,
      stop: engine.stop,
      preload: engine.preload,
      subscribePosition: engine.subscribePosition,
    }),
    [engine, snapshot],
  );
}
