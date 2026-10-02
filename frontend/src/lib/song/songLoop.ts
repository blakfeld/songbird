import { clampLoop, defaultLoop, parseLoop, type LoopSetting } from "../loopRegion";
import { timelineMeasures } from "./songOps";
import { implicitName, implicitSections } from "./implicitSections";
import { newId, type Song } from "./types";

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
  return withLoopSetting(snapshot, songLoop(current));
}

// Preview songs clamp from the setting captured when a drag began, never from the previous preview,
// so a drag that shrinks the timeline and then returns gets the full region back.
export function withLoopSetting(snapshot: Song, loop: LoopSetting): Song {
  return withSongLoop(snapshot, clampLoop(loop, timelineMeasures(snapshot)));
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
  const loop = clampLoop(parsed, timelineMeasures(song));
  if (!loop.enabled && loop.region === null) {
    const { loop_region: _dropped, ...rest } = song;
    void _dropped;
    return rest;
  }
  return withSongLoop(song, loop);
}

// Generation reads 32 measures at most, the same bound the backend enforces on a range.
export const MAX_GENERATE_MEASURES = 32;

// Only a region the user is actually hearing counts; "Whole song" already covers the other cases, so the
// dialog and the chat share this one rule and cannot disagree about when a loop range exists.
export function activeLoopRange(
  song: Song,
): { start_measure: number; end_measure: number } | null {
  const { region, enabled } = songLoop(song);
  if (!enabled || !region) return null;
  if (region.start <= 1 && region.end >= song.measures) return null;
  if (region.end - region.start + 1 > MAX_GENERATE_MEASURES) return null;
  return { start_measure: region.start, end_measure: region.end };
}

// Notes are typed outside the undo history like lyrics, so a snapshot's sections take the notes written since.
// Typing in an unsectioned song's implicit section is what created its lone real section, and without it
// undoing past that point would discard the notes along with the section they live in.
function withLiveSectionNotes(snapshot: Song, current: Song): Song {
  const live = current.sections ?? [];
  if (live.length === 0) return snapshot;
  const kept = snapshot.sections ?? [];
  if (kept.length === 0) {
    // Matched by name rather than position, because real sections added since the typing sit among the chunks.
    const chunks = implicitSections(snapshot.measures).map((chunk, i) => {
      const typed = live.find((l) => l.name === implicitName(i) && l.kind === "other");
      return { ...chunk, id: typed?.id ?? newId(), notes: typed?.notes ?? "" };
    });
    // Clips can have changed the length since the notes were typed, so the chunks are refitted to the snapshot's.
    return chunks.some((c) => c.notes !== "") ? { ...snapshot, sections: chunks } : snapshot;
  }
  const notes = new Map(live.map((s) => [s.id, s.notes]));
  const next = kept.map((s) => (notes.has(s.id) && notes.get(s.id) !== s.notes ? { ...s, notes: notes.get(s.id)! } : s));
  return next.some((s, i) => s !== kept[i]) ? { ...snapshot, sections: next } : snapshot;
}

// Chat and lyrics are written by the user outside the arrangement: undo must remove an added track but keep the
// message that explains it and the words being written, so snapshots restored by undo or redo take the live values.
export function withLiveFields(snapshot: Song, current: Song): Song {
  let result = withLiveSectionNotes(snapshot, current);
  for (const key of ["chat", "lyrics"] as const) {
    if (result[key] === current[key]) continue;
    if (current[key] === undefined) {
      const { [key]: _dropped, ...rest } = result;
      void _dropped;
      result = rest;
    } else {
      result = { ...result, [key]: current[key] };
    }
  }
  return result;
}
