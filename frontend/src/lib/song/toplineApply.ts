import type { Note } from "@/generated/Note";
import type { ToplineSource } from "@/generated/ToplineSource";
import { applyGeneratedRange, clearMeasureRange, placeLoop, type ClipFailure } from "./clipOps";
import { addTrack } from "./songOps";
import { LOOP_NAME_MAX, MAX_TRACKS, type Song } from "./types";

export const VOCAL_INSTRUMENT = { id: "vocal", name: "Vocal" } as const;

export type ToplineTarget = { kind: "new-vocal" } | { kind: "track"; trackId: string };

export interface MeasureSpan {
  start_measure: number;
  end_measure: number;
}

export interface ApplyToplineArgs {
  trackChoice: ToplineTarget;
  range: MeasureSpan;
  // Steps count from the first step of `range.start_measure`, as the server returns them.
  notes: Note[];
  source: ToplineSource;
  // Other same-named sections; each gets a clip of the same loop, so editing one chorus melody edits them all.
  alsoRanges?: MeasureSpan[];
}

export type ToplineFailure = ClipFailure | "track-limit";

export type ApplyToplineResult =
  | { song: Song; trackId: string; clipId: string }
  | { song: null; reason: ToplineFailure };

// The endpoint reads the target track from the song it is sent, so a track that does not exist yet has to be
// drafted into the request. It is thrown away afterwards: applyTopline adds the real one.
export function withVocalTrack(song: Song): { song: Song; trackId: string } | null {
  if (song.tracks.length >= MAX_TRACKS) return null;
  const drafted = addTrack(song, VOCAL_INSTRUMENT);
  return { song: drafted, trackId: drafted.tracks[drafted.tracks.length - 1].id };
}

const overlaps = (a: MeasureSpan, b: MeasureSpan) =>
  a.start_measure <= b.end_measure && b.start_measure <= a.end_measure;

// One pure song-to-song function so the store can commit the whole result as a single history entry.
export function applyTopline(song: Song, args: ApplyToplineArgs): ApplyToplineResult {
  const { trackChoice, range, notes, source } = args;
  let work = song;
  let trackId: string;
  if (trackChoice.kind === "new-vocal") {
    if (song.tracks.length >= MAX_TRACKS) return { song: null, reason: "track-limit" };
    work = addTrack(song, VOCAL_INSTRUMENT);
    trackId = work.tracks[work.tracks.length - 1].id;
  } else {
    trackId = trackChoice.trackId;
  }

  const placed = applyGeneratedRange(work, trackId, range, notes);
  if (placed.song === null) return { song: null, reason: placed.reason };
  const clipId = placed.clipId as string;
  const track = placed.song.tracks.find((t) => t.id === trackId);
  const loopId = track?.clips.find((c) => c.id === clipId)?.loop_id;
  if (!track || loopId === undefined) return { song: null, reason: "not-found" };

  work = {
    ...placed.song,
    tracks: placed.song.tracks.map((t) =>
      t.id !== trackId
        ? t
        : {
            ...t,
            loops: t.loops.map((l) =>
              l.id === loopId
                ? { ...l, name: `${source.section_name} topline`.slice(0, LOOP_NAME_MAX), topline: source }
                : l,
            ),
          },
    ),
  };

  // An extra range that overlapped the first would clear the clip just placed, so only disjoint ones are linked.
  const placedRanges: MeasureSpan[] = [range];
  for (const extra of args.alsoRanges ?? []) {
    if (placedRanges.some((r) => overlaps(r, extra))) continue;
    const cleared = clearMeasureRange(work, trackId, extra.start_measure, extra.end_measure);
    if (cleared.song === null) return { song: null, reason: cleared.reason };
    const linked = placeLoop(
      cleared.song,
      trackId,
      loopId,
      extra.start_measure,
      extra.end_measure - extra.start_measure + 1,
    );
    if (linked.song === null) return { song: null, reason: linked.reason };
    work = linked.song;
    placedRanges.push(extra);
  }
  return { song: work, trackId, clipId };
}
