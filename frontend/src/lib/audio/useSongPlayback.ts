import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Row } from "@/generated/Row";
import type { SongStore } from "@/lib/song/songStore";
import { createPlaybackEngine, type AuditionOptions, type PlaybackEngine } from "./engine";
import { createSongPlaybackModel } from "./songPlaybackModel";
import { playRange, type LoopSetting } from "@/lib/loopRegion";
import type { Playback } from "./types";

export interface SongPlayback extends Playback {
  audition(row: Row, options?: AuditionOptions): Promise<void>;
  // Exposed so recording can drive live notes and count-in on the same engine that plays the song.
  engine: PlaybackEngine;
}

export function useSongPlayback(
  store: SongStore,
  instruments: InstrumentInfo[] | null,
  loop: LoopSetting,
): SongPlayback {
  const [model] = useState(() => createSongPlaybackModel(store, instruments));
  useEffect(() => {
    model.setInstruments(instruments);
  }, [model, instruments]);
  const [engine] = useState(() => createPlaybackEngine(model));
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

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
      engine,
    }),
    [engine, snapshot],
  );
}
