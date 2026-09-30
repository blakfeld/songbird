import { useEffect, useMemo, useSyncExternalStore } from "react";
import { usePatternStore } from "@/lib/patternStore";
import { getPlaybackEngine } from "./engine";
import type { LoopRange, Playback } from "./types";

export function usePlayback(instrumentId: string, loop: LoopRange): Playback {
  const engine = getPlaybackEngine(instrumentId);
  const snapshot = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot,
  );

  const { start, end } = loop;
  useEffect(() => {
    engine.setLoop({ start, end });
  }, [engine, start, end]);

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
