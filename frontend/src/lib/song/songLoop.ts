import { clampLoop, defaultLoop, parseLoop, type LoopSetting } from "../loopRegion";
import type { Song } from "./types";

export function songLoop(song: Pick<Song, "loop_region">): LoopSetting {
  const r = song.loop_region;
  if (!r) return defaultLoop();
  return {
    region: r.region ? { start: r.region.start_measure, end: r.region.end_measure } : null,
    enabled: r.enabled,
  };
}

const toStored = (loop: LoopSetting): NonNullable<Song["loop_region"]> => ({
  region: loop.region ? { start_measure: loop.region.start, end_measure: loop.region.end } : null,
  enabled: loop.enabled,
});

// Returns the same song when nothing changes so callers can rely on identity to skip redundant saves.
export function withSongLoop(song: Song, loop: LoopSetting): Song {
  const current = songLoop(song);
  if (
    current.enabled === loop.enabled &&
    current.region?.start === loop.region?.start &&
    current.region?.end === loop.region?.end
  ) {
    return song;
  }
  return { ...song, loop_region: toStored(loop) };
}

// Snapshots restored by undo, redo, or a cancelled drag carry the region from when they were taken;
// the live region wins so those actions never move it, except where a length change forces a clamp.
export function withLiveLoop(snapshot: Song, current: Song): Song {
  if (current.loop_region === undefined && snapshot.loop_region === undefined) return snapshot;
  return withSongLoop(snapshot, clampLoop(songLoop(current), snapshot.measures));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

// Stored documents are untrusted, so anything but the current shape (including the flat one from
// unreleased builds) reads as the default, which is stored as an absent field.
export function normalizeLoopRegion(song: Song): Song {
  const raw = song.loop_region as unknown;
  if (raw === undefined) return song;
  const region = isObject(raw) ? raw.region : undefined;
  const parsed = parseLoop({
    enabled: isObject(raw) ? raw.enabled : undefined,
    region: isObject(region) ? { start: region.start_measure, end: region.end_measure } : region,
  });
  const loop = clampLoop(parsed, song.measures);
  if (!loop.enabled && loop.region === null) {
    const { loop_region: _dropped, ...rest } = song;
    void _dropped;
    return rest;
  }
  return withSongLoop(song, loop);
}
