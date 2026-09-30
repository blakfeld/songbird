"use client";

import { loopColour } from "./loopPalette";
import { menuItemClass } from "./Menu";
import { clipSpan, type ClipActions } from "./useClipActions";
import {
  freeSpanAt,
  loopUseCount,
  nextFreeMeasure,
} from "@/lib/song/clipOps";
import { MAX_CLIPS, MAX_LOOPS, type Clip, type Song, type Track } from "@/lib/song/types";

const hintClass = "px-3 pb-2 text-xs text-zinc-600 dark:text-zinc-400";
const separator = <div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />;

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function LinkGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.6.6" />
      <path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.6-.6" />
    </svg>
  );
}

export function LoopSwatch({ index }: { index: number }) {
  return <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-sm ${loopColour(index).swatch}`} />;
}

const countLabel = (n: number) => (n === 0 ? "not placed" : n === 1 ? "1 clip" : `${n} clips`);

export const clipMenuLabel = (track: Track, clip: Clip) => {
  const loop = track.loops.find((l) => l.id === clip.loop_id);
  return `Clip actions for ${loop?.name ?? "clip"}, ${clipSpan(clip)}`;
};

// Shared by the right-click menu, Shift+F10 and the dock's Clip actions button so they offer the same things.
export function ClipMenuItems({
  track,
  song,
  clip,
  actions,
  close,
  invoker,
  focusResult,
}: {
  track: Track;
  song: Song;
  clip: Clip;
  actions: ClipActions;
  close: () => void;
  invoker: () => HTMLElement | null;
  // True when the invoker is a clip, so results keep focus in the lane instead of the dock button.
  focusResult: boolean;
}) {
  const loop = track.loops.find((l) => l.id === clip.loop_id);
  if (!loop) return null;
  const uses = loopUseCount(track, loop.id);
  const room = freeSpanAt(track, clip.start_measure + clip.measures, song) >= clip.measures;
  const clipLimit = track.clips.length >= MAX_CLIPS;
  const loopLimit = track.loops.length >= MAX_LOOPS;
  const duplicateHint = clipLimit
    ? `This track has ${MAX_CLIPS} clips, the most it can hold`
    : room
      ? null
      : "No room after this clip";
  const uniqueHint =
    uses < 2 ? `Only this clip uses ${loop.name}` : loopLimit ? `This track has ${MAX_LOOPS} loops, the most it can hold` : null;
  const id = `clip-menu-${clip.id}`;
  const shortcut = isMac() ? "⌘D" : "Ctrl+D";

  return (
    <>
      <button
        type="button"
        role="menuitem"
        aria-disabled={duplicateHint !== null}
        aria-describedby={duplicateHint ? `${id}-dup` : undefined}
        aria-keyshortcuts="Meta+D Control+D"
        className={menuItemClass}
        onClick={() => {
          if (duplicateHint) return;
          close();
          actions.duplicate(track.id, clip.id, { focus: focusResult });
        }}
      >
        Duplicate
        <kbd className="ml-auto font-sans text-xs text-zinc-600 dark:text-zinc-400">{shortcut}</kbd>
      </button>
      {duplicateHint && (
        <p id={`${id}-dup`} className={hintClass}>
          {duplicateHint}
        </p>
      )}
      <button
        type="button"
        role="menuitem"
        aria-disabled={uniqueHint !== null}
        aria-describedby={uniqueHint ? `${id}-unique` : undefined}
        className={menuItemClass}
        onClick={() => {
          if (uniqueHint) return;
          close();
          actions.makeUnique(track.id, clip.id);
          invoker()?.focus();
        }}
      >
        Make unique
      </button>
      {uniqueHint && (
        <p id={`${id}-unique`} className={hintClass}>
          {uniqueHint}
        </p>
      )}
      <button
        type="button"
        role="menuitem"
        aria-keyshortcuts="F2"
        className={menuItemClass}
        onClick={() => {
          close();
          actions.select(track.id, clip.id);
          actions.requestRename(loop.id, invoker());
        }}
      >
        Rename loop…
        <kbd className="ml-auto font-sans text-xs text-zinc-600 dark:text-zinc-400">F2</kbd>
      </button>
      {separator}
      <button
        type="button"
        role="menuitem"
        aria-keyshortcuts="Delete"
        className={menuItemClass}
        onClick={() => {
          close();
          actions.remove(track.id, clip.id, { focus: focusResult });
        }}
      >
        Delete clip
        <kbd className="ml-auto font-sans text-xs text-zinc-600 dark:text-zinc-400">Del</kbd>
      </button>
    </>
  );
}

// A button press has no pointer position, so continuing after the selected clip keeps new clips beside the one being worked on.
export function defaultLaneMeasure(song: Song, track: Track, selectedClipId: string | null): number | null {
  const selected = track.clips.find((c) => c.id === selectedClipId);
  const after = selected ? selected.start_measure + selected.measures : 1;
  return nextFreeMeasure(track, song, after) ?? nextFreeMeasure(track, song, 1);
}

export function LaneMenuItems({
  track,
  measure,
  actions,
  close,
  extra,
}: {
  track: Track;
  measure: number | null;
  actions: ClipActions;
  close: () => void;
  extra?: React.ReactNode;
}) {
  const clipLimit = track.clips.length >= MAX_CLIPS;
  const loopLimit = track.loops.length >= MAX_LOOPS;
  const noRoom = measure === null;
  const placeHint = clipLimit
    ? `This track has ${MAX_CLIPS} clips, the most it can hold`
    : noRoom
      ? "No empty measures on this track"
      : null;
  const newHint = placeHint ?? (loopLimit ? `This track has ${MAX_LOOPS} loops, the most it can hold` : null);
  const id = `lane-menu-${track.id}`;

  return (
    <>
      <button
        type="button"
        role="menuitem"
        aria-disabled={newHint !== null}
        aria-describedby={newHint ? `${id}-new` : undefined}
        className={menuItemClass}
        onClick={() => {
          if (newHint || measure === null) return;
          close();
          actions.create(track.id, measure);
        }}
      >
        {measure === null ? "New clip" : `New clip at measure ${measure}`}
      </button>
      {newHint && (
        <p id={`${id}-new`} className={hintClass}>
          {newHint}
        </p>
      )}
      <div role="group" aria-labelledby={`${id}-place`}>
        <p id={`${id}-place`} className="px-3 pt-2 pb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {measure === null ? "Place loop" : `Place loop at measure ${measure}`}
        </p>
        {track.loops.length === 0 && <p className={hintClass}>No loops yet</p>}
        {track.loops.map((loop, i) => {
          const uses = loopUseCount(track, loop.id);
          return (
            <button
              key={loop.id}
              type="button"
              role="menuitem"
              aria-disabled={placeHint !== null}
              aria-describedby={placeHint ? `${id}-place-hint` : undefined}
              aria-label={`Place ${loop.name}, ${uses === 0 ? "not placed" : `used by ${uses === 1 ? "1 clip" : `${uses} clips`}`}`}
              className={menuItemClass}
              onClick={() => {
                if (placeHint || measure === null) return;
                close();
                actions.place(track.id, loop.id, measure);
              }}
            >
              <LoopSwatch index={i} />
              <span className="min-w-0 truncate">{loop.name}</span>
              <span className="ml-auto shrink-0 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                {countLabel(uses)}
              </span>
            </button>
          );
        })}
        {placeHint && track.loops.length > 0 && (
          <p id={`${id}-place-hint`} className={hintClass}>
            {placeHint}
          </p>
        )}
      </div>
      {extra && (
        <>
          {separator}
          {extra}
        </>
      )}
    </>
  );
}
