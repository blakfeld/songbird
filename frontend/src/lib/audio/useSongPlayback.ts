import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Row } from "@/generated/Row";
import type { SongStore } from "@/lib/song/songStore";
import { createPlaybackEngine, type AuditionOptions } from "./engine";
import { createSongPlaybackModel } from "./songPlaybackModel";
import type { LoopRange, Playback } from "./types";

export interface SongPlayback extends Playback {
  audition(row: Row, options?: AuditionOptions): Promise<void>;
}

export function useSongPlayback(
  store: SongStore,
  instruments: InstrumentInfo[] | null,
  loop: LoopRange,
): SongPlayback {
  const [model] = useState(() => createSongPlaybackModel(store, instruments));
  useEffect(() => {
    model.setInstruments(instruments);
  }, [model, instruments]);
  const [engine] = useState(() => createPlaybackEngine(model));
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  const { start, end } = loop;
  useEffect(() => {
    engine.setLoop({ start, end });
  }, [engine, start, end]);

  useEffect(() => () => engine.dispose(), [engine]);

  // Tone and the samples are fetched ahead of Play so its first press stays inside the user gesture.
  const instrumentKey = useSyncExternalStore(
    store.subscribe,
    () => store.getState().song?.tracks.map((t) => t.instrument).join(",") ?? "",
    () => "",
  );
  useEffect(() => {
    if (instruments && instrumentKey) void engine.preload();
  }, [engine, instruments, instrumentKey]);

  return useMemo(
    () => ({
      ...snapshot,
      toggle: engine.toggle,
      stop: engine.stop,
      seek: engine.seek,
      preload: engine.preload,
      subscribePosition: engine.subscribePosition,
      audition: engine.audition,
    }),
    [engine, snapshot],
  );
}
