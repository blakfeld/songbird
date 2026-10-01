import { useMemo } from "react";
import {
  nearestFreeMeasure,
  type ClipFailure,
} from "@/lib/song/clipOps";
import type { SongStore } from "@/lib/song/songStore";
import { MAX_CLIPS, MAX_LOOPS, type Clip, type Song, type Track } from "@/lib/song/types";

export interface ClipActions {
  select(trackId: string, clipId: string | null): void;
  create(trackId: string, measure: number): void;
  place(trackId: string, loopId: string, measure: number): void;
  // Snapping keeps a drop that lands on a neighbouring clip from silently doing nothing.
  copyTo(trackId: string, clipId: string, desiredMeasure: number): void;
  duplicate(trackId: string, clipId: string, options?: { focus?: boolean }): void;
  duplicateSelected(): void;
  move(trackId: string, clipId: string, toStart: number): void;
  resize(trackId: string, clipId: string, measures: number): void;
  // Focus stays on the same button, so the status line must carry the result or the limit that blocked it.
  nudge(trackId: string, clipId: string, delta: number): void;
  stretch(trackId: string, clipId: string, delta: number): void;
  remove(trackId: string, clipId: string, options?: { focus?: boolean }): void;
  makeUnique(trackId: string, clipId: string): void;
  renameLoop(trackId: string, loopId: string, name: string): void;
  deleteLoop(trackId: string, loopId: string): void;
  beginGesture(): void;
  endGesture(): void;
  cancelGesture(): void;
  requestRename(loopId: string, invoker?: HTMLElement | null): void;
  focusRoll(): void;
  announce(message: string): void;
}

export const clipSpan = (c: Pick<Clip, "start_measure" | "measures">) =>
  c.measures === 1
    ? `measure ${c.start_measure}`
    : `measures ${c.start_measure} to ${c.start_measure + c.measures - 1}`;

const findTrack = (song: Song | null, trackId: string) => song?.tracks.find((t) => t.id === trackId);

function failureMessage(reason: ClipFailure, track: Track, clip?: Clip): string {
  switch (reason) {
    case "clip-limit":
      return `${track.name} already has ${MAX_CLIPS} clips, the most a track can hold.`;
    case "loop-limit":
      return `${track.name} already has ${MAX_LOOPS} loops, the most a track can hold. Delete an unused loop to add another.`;
    case "no-room": {
      if (clip) {
        const loop = track.loops.find((l) => l.id === clip.loop_id);
        return `No room to duplicate “${loop?.name ?? "clip"}”. The next ${clip.measures} ${clip.measures === 1 ? "bar" : "bars"} after it aren't free.`;
      }
      return `There are no empty measures on ${track.name}.`;
    }
    case "generating":
      return `${track.name} is being generated. Wait for it to finish.`;
    default:
      return "That clip is no longer there.";
  }
}

function neighbourLimit(track: Track, clip: Clip, song: Song, direction: "left" | "right") {
  const others = track.clips.filter((c) => c.id !== clip.id);
  if (direction === "right") {
    const next = others.find((c) => c.start_measure >= clip.start_measure + clip.measures);
    return next
      ? `the next clip starts at measure ${next.start_measure}`
      : `the song ends at measure ${song.measures}`;
  }
  const prev = [...others].reverse().find((c) => c.start_measure + c.measures <= clip.start_measure);
  return prev
    ? `the previous clip ends at measure ${prev.start_measure + prev.measures - 1}`
    : "the song starts at measure 1";
}

const focusLater = (selector: string) =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());

const focusClip = (id: string) => focusLater(`[data-clip-id="${id}"]`);

const activeIsClip = () =>
  document.activeElement instanceof HTMLElement && document.activeElement.hasAttribute("data-clip-id");

export function useClipActions(
  store: SongStore,
  announce: (message: string) => void,
  requestRename: (loopId: string, invoker: HTMLElement | null) => void,
  // A drag starting mid-take would share the take's gesture, so the take has to end first.
  guardEdit: (edit: () => void) => void = (edit) => edit(),
): ClipActions {
  return useMemo<ClipActions>(() => {
    const state = () => store.getState();
    const context = (trackId: string, clipId?: string) => {
      const song = state().song;
      const track = findTrack(song, trackId);
      return { song, track, clip: track?.clips.find((c) => c.id === clipId) };
    };
    // Refusals are spoken instead of silently doing nothing, per the failure-message spec.
    const report = (reason: ClipFailure | null, trackId: string, clipId?: string) => {
      if (!reason) return false;
      const { track, clip } = context(trackId, clipId);
      if (track) announce(failureMessage(reason, track, clipId ? clip : undefined));
      return true;
    };
    const selectedClipId = () => state().selectedClipId;

    const api: ClipActions = {
      select: (trackId, clipId) => {
        if (clipId) state().selectClip(clipId);
        else state().selectTrack(trackId);
      },
      create: (trackId, measure) => {
        if (report(state().newClip(trackId, measure), trackId)) return;
        const id = selectedClipId();
        if (id) focusClip(id);
      },
      place: (trackId, loopId, measure) => {
        if (report(state().placeLoop(trackId, loopId, measure), trackId)) return;
        const id = selectedClipId();
        if (id) focusClip(id);
      },
      copyTo: (trackId, clipId, desired) => {
        const { song, track, clip } = context(trackId, clipId);
        if (!song || !track || !clip) return;
        const at = nearestFreeMeasure(track, song, desired);
        if (at === null) {
          announce(`There are no empty measures on ${track.name}.`);
          return;
        }
        report(state().placeLoop(trackId, clip.loop_id, at, clip.measures), trackId);
      },
      duplicate: (trackId, clipId, options) => {
        const shouldFocus = options?.focus ?? activeIsClip();
        if (report(state().duplicateClip(trackId, clipId), trackId, clipId)) return;
        const id = selectedClipId();
        if (shouldFocus && id) focusClip(id);
      },
      duplicateSelected: () => {
        const { selectedTrackId, selectedClipId: clipId } = state();
        if (selectedTrackId && clipId) api.duplicate(selectedTrackId, clipId);
      },
      move: (trackId, clipId, toStart) => {
        state().moveClip(trackId, clipId, toStart, { transient: true });
      },
      resize: (trackId, clipId, measures) => {
        state().resizeClip(trackId, clipId, measures, { transient: true });
      },
      nudge: (trackId, clipId, delta) => {
        const { song, track, clip } = context(trackId, clipId);
        if (!song || !track || !clip) return;
        state().selectClip(clipId);
        state().moveClip(trackId, clipId, clip.start_measure + delta, { transient: true });
        const after = context(trackId, clipId);
        if (!after.clip) return;
        if (after.clip.start_measure === clip.start_measure) {
          announce(
            `Can't move further: ${neighbourLimit(track, clip, song, delta > 0 ? "right" : "left")}.`,
          );
          return;
        }
        const loop = track.loops.find((l) => l.id === clip.loop_id);
        announce(`${loop?.name ?? "Clip"}, ${clipSpan(after.clip)}`);
      },
      stretch: (trackId, clipId, delta) => {
        const { song, track, clip } = context(trackId, clipId);
        if (!song || !track || !clip) return;
        state().selectClip(clipId);
        state().resizeClip(trackId, clipId, clip.measures + delta, { transient: true });
        const after = context(trackId, clipId);
        if (!after.clip) return;
        if (after.clip.measures === clip.measures) {
          announce(
            delta > 0
              ? `Can't lengthen further: ${neighbourLimit(track, clip, song, "right")}.`
              : "A clip is at least 1 bar long.",
          );
          return;
        }
        const loop = track.loops.find((l) => l.id === clip.loop_id);
        announce(`${loop?.name ?? "Clip"}, ${clipSpan(after.clip)}`);
      },
      remove: (trackId, clipId, options) => {
        const { track, clip } = context(trackId, clipId);
        if (!track || !clip) return;
        const wasSelected = selectedClipId() === clipId;
        const hadFocus =
          options?.focus ?? document.activeElement?.getAttribute("data-clip-id") === clipId;
        const index = track.clips.indexOf(clip);
        const successor = track.clips[index + 1] ?? track.clips[index - 1];
        const loop = track.loops.find((l) => l.id === clip.loop_id);
        if (report(state().deleteClip(trackId, clipId), trackId)) return;
        if (wasSelected || hadFocus) {
          if (successor) state().selectClip(successor.id);
          else state().selectTrack(trackId);
        }
        if (hadFocus) {
          if (successor) focusClip(successor.id);
          else focusLater(`[data-track-select="${trackId}"]`);
        }
        announce(
          `Deleted a clip of “${loop?.name ?? "loop"}”. The loop is still available in Place loop. Undo to restore.`,
        );
      },
      makeUnique: (trackId, clipId) => {
        if (report(state().makeUnique(trackId, clipId), trackId, clipId)) return;
        const { track, clip } = context(trackId, clipId);
        const loop = track?.loops.find((l) => l.id === clip?.loop_id);
        announce(`This clip now plays “${loop?.name ?? "a copy"}”. Editing it won't change the other clips.`);
      },
      renameLoop: (trackId, loopId, name) => {
        state().renameLoop(trackId, loopId, name);
      },
      deleteLoop: (trackId, loopId) => {
        const { track } = context(trackId);
        const loop = track?.loops.find((l) => l.id === loopId);
        if (!track || !loop) return;
        const count = track.clips.filter((c) => c.loop_id === loopId).length;
        if (report(state().deleteLoop(trackId, loopId), trackId)) return;
        const tail =
          count === 0 ? "" : count === 1 ? " and its clip" : ` and its ${count} clips`;
        // Falling back to the track's earliest clip keeps the dock useful instead of dropping to its empty state.
        if (!state().selectedClipId && state().selectedTrackId === trackId) {
          const remaining = context(trackId).track?.clips[0];
          if (remaining) state().selectClip(remaining.id);
        }
        announce(`Deleted the loop “${loop.name}”${tail}. Undo to restore.`);
      },
      beginGesture: () => guardEdit(() => state().beginGesture()),
      endGesture: () => state().endGesture(),
      cancelGesture: () => state().cancelGesture(),
      requestRename: (loopId, invoker) =>
        requestRename(loopId, invoker ?? (document.activeElement as HTMLElement | null)),
      focusRoll: () =>
        focusLater('[aria-roledescription="piano roll"] [tabindex="0"]'),
      announce,
    };
    return api;
  }, [store, announce, requestRename, guardEdit]);
}
