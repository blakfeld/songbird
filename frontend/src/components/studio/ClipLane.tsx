"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Row } from "@/generated/Row";
import { focusRing } from "@/components/ui/classes";
import {
  freeSpanAt,
  loopUseCount,
  nearestFreeMeasure,
  nextFreeMeasure,
  resolveTrackNotes,
} from "@/lib/song/clipOps";
import type { Clip, Loop, Song, Track } from "@/lib/song/types";
import { ClipMenuItems, LaneMenuItems, LinkGlyph, clipMenuLabel } from "./ClipMenu";
import { ContextMenu } from "./ContextMenu";
import { loopColour } from "./loopPalette";
import { clipSpan, type ClipActions } from "./useClipActions";

// Below this a press is a click, so selecting a clip never nudges it.
const DRAG_THRESHOLD_PX = 4;
export const CLIP_KEYS_HELP_ID = "clip-keys-help";

export const CLIP_KEYS_HELP =
  "Left and Right arrows move the clip by a measure. Shift with Left or Right changes its length. Alt with Left or Right moves to the previous or next clip. Delete removes it. Command or Control D duplicates it. F2 renames its loop. Shift F10 opens more actions.";

export function clipLabel(loop: Loop, clip: Clip, linked: number): string {
  const parts = [loop.name, clipSpan(clip)];
  if (linked > 1) parts.push(`linked, ${linked} clips`);
  if (clip.measures > loop.measures) parts.push(`loop plays ${Math.ceil(clip.measures / loop.measures)} times`);
  return parts.join(", ");
}

// The vertical range is shared by every clip of a track so one pitch sits at one height in all of them.
export function trackRange(track: Track, rows: Row[], melodic: boolean) {
  if (!melodic) return { low: 0, span: Math.max(rows.length, 1) };
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const used = track.loops.flatMap((l) => l.notes.flatMap((n) => index.get(n.row_id) ?? []));
  if (used.length === 0) return { low: 0, span: Math.max(rows.length, 1) };
  // Fitting to the track's own range keeps a bass line from becoming a flat strip across 61 rows.
  const low = Math.min(...used) - 1;
  return { low, span: Math.max(...used) - low + 2 };
}

// Notes are drawn in step units so the path never needs rebuilding when the lane is resized.
export function clipPaths(song: Song, track: Track, rows: Row[], melodic: boolean) {
  const { low, span } = trackRange(track, rows, melodic);
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const resolved = resolveTrackNotes(song, track);
  const spm = song.steps_per_measure;
  const paths = new Map<string, string>();
  for (const clip of track.clips) {
    const base = (clip.start_measure - 1) * spm;
    const end = base + clip.measures * spm;
    let d = "";
    for (const n of resolved) {
      if (n.step < base || n.step >= end) continue;
      const i = index.get(n.row_id);
      if (i === undefined) continue;
      d += `M${n.step - base} ${i - low}h${n.length_steps}v1h-${n.length_steps}z`;
    }
    paths.set(clip.id, d);
  }
  return { paths, span };
}

type DragMode = "move" | "resize" | "copy";

interface DragState {
  mode: DragMode;
  clipId: string;
  pointerId: number;
  startX: number;
  origStart: number;
  origMeasures: number;
  measureWidth: number;
  crossed: boolean;
  cancelled: boolean;
}

type MenuState =
  | { kind: "clip"; clipId: string; anchor: { x: number; y: number } }
  | { kind: "lane"; measure: number | null; anchor: { x: number; y: number } };

export function ClipLane({
  song,
  track,
  rows,
  melodic,
  audible,
  selectedClipId,
  first,
  actions,
  onSeek,
}: {
  song: Song;
  track: Track;
  rows: Row[] | null;
  melodic: boolean;
  audible: boolean;
  selectedClipId: string | null;
  first: boolean;
  actions: ClipActions;
  onSeek: (measureIndex: number) => void;
}) {
  const lane = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const holding = useRef(false);
  // The browser fires a click on the pressed block after a drag, which would re-select the source of an Alt-drag copy.
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ mode: DragMode; clipId: string; ghost: number | null } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const spm = song.steps_per_measure;

  const layout = useMemo(
    () => (rows ? clipPaths(song, track, rows, melodic) : null),
    [song, track, rows, melodic],
  );

  const laneHasSelection = track.clips.some((c) => c.id === selectedClipId);
  const stopId = laneHasSelection ? selectedClipId : track.clips[0]?.id;
  const selectedLoopId = track.clips.find((c) => c.id === selectedClipId)?.loop_id;

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      e.stopPropagation();
      if (drag.current.mode !== "copy" && drag.current.crossed) actions.cancelGesture();
      drag.current.cancelled = true;
      setPreview(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [preview, actions]);

  // Set on the body so the cursor holds when the pointer leaves the block mid-drag.
  const dragCursor = !preview
    ? ""
    : preview.mode === "move"
      ? "grabbing"
      : preview.mode === "resize"
        ? "ew-resize"
        : preview.ghost === null
          ? "not-allowed"
          : "copy";
  useEffect(() => {
    document.body.style.cursor = dragCursor;
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragCursor]);

  const measureAt = (clientX: number) => {
    const rect = lane.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 1;
    const at = Math.floor(((clientX - rect.left) / rect.width) * song.measures) + 1;
    return Math.min(song.measures, Math.max(1, at));
  };

  function endHold() {
    if (!holding.current) return;
    holding.current = false;
    actions.endGesture();
  }

  function finishDrag(e: React.PointerEvent, commit: boolean) {
    const d = drag.current;
    drag.current = null;
    setPreview(null);
    if (!d) return;
    if (d.crossed) suppressClick.current = true;
    if (!d.crossed || d.cancelled) return;
    if (d.mode === "copy") {
      if (commit) {
        const delta = Math.round((e.clientX - d.startX) / d.measureWidth);
        actions.copyTo(track.id, d.clipId, d.origStart + delta);
      }
    } else if (commit) {
      actions.endGesture();
    } else {
      actions.cancelGesture();
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>, clip: Clip) {
    if (e.button !== 0) return;
    suppressClick.current = false;
    const rect = lane.current?.getBoundingClientRect();
    const onHandle = (e.target as HTMLElement).closest("[data-handle]") !== null;
    drag.current = {
      mode: onHandle ? "resize" : "move",
      clipId: clip.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      origStart: clip.start_measure,
      origMeasures: clip.measures,
      measureWidth: rect && rect.width > 0 ? rect.width / song.measures : 0,
      crossed: false,
      cancelled: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>, clip: Clip) {
    const d = drag.current;
    if (!d || d.clipId !== clip.id || d.cancelled) return;
    const dx = e.clientX - d.startX;
    if (!d.crossed) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      d.crossed = true;
      if (d.mode === "move" && e.altKey) d.mode = "copy";
      actions.select(track.id, clip.id);
      if (d.mode !== "copy") actions.beginGesture();
    }
    if (d.measureWidth <= 0) return;
    const delta = Math.round(dx / d.measureWidth);
    if (d.mode === "move") {
      actions.move(track.id, clip.id, d.origStart + delta);
      setPreview({ mode: "move", clipId: clip.id, ghost: null });
    } else if (d.mode === "resize") {
      actions.resize(track.id, clip.id, d.origMeasures + delta);
      setPreview({ mode: "resize", clipId: clip.id, ghost: null });
    } else {
      const at = nearestFreeMeasure(track, song, d.origStart + delta);
      setPreview({ mode: "copy", clipId: clip.id, ghost: at });
    }
  }

  function focusSibling(current: HTMLElement, target: "prev" | "next" | "first" | "last") {
    const all = [...(lane.current?.querySelectorAll<HTMLElement>("[data-clip-id]") ?? [])];
    const at = all.indexOf(current);
    const next = { prev: all[at - 1], next: all[at + 1], first: all[0], last: all.at(-1) }[target];
    next?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, clip: Clip) {
    const el = e.currentTarget;
    const key = e.key;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && key.toLowerCase() === "d") {
      e.preventDefault();
      actions.duplicate(track.id, clip.id, { focus: true });
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      e.preventDefault();
      if (e.altKey) {
        focusSibling(el, key === "ArrowLeft" ? "prev" : "next");
        return;
      }
      // Auto-repeat folds into one gesture that ends on key-up, so a held arrow is a single undo step.
      if (!holding.current) {
        holding.current = true;
        actions.beginGesture();
      }
      const dir = key === "ArrowLeft" ? -1 : 1;
      if (e.shiftKey) actions.stretch(track.id, clip.id, dir);
      else actions.nudge(track.id, clip.id, dir);
    } else if (key === "Home" || key === "End") {
      e.preventDefault();
      focusSibling(el, key === "Home" ? "first" : "last");
    } else if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      actions.remove(track.id, clip.id);
    } else if (key === "F2") {
      e.preventDefault();
      actions.select(track.id, clip.id);
      actions.requestRename(clip.loop_id, el);
    } else if (key === "ContextMenu" || (key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      actions.select(track.id, clip.id);
      setMenu({ kind: "clip", clipId: clip.id, anchor: { x: rect.left, y: rect.bottom } });
    }
  }

  const style = (start: number, measures: number, extra = ""): React.CSSProperties => ({
    left: `calc(var(--cell-w) * ${(start - 1) * spm})`,
    width: `calc(var(--cell-w) * ${measures * spm} - 1px${extra})`,
  });

  const draggedClip = preview ? track.clips.find((c) => c.id === preview.clipId) : undefined;
  const ghostLoop = draggedClip ? track.loops.find((l) => l.id === draggedClip.loop_id) : undefined;
  const ghostSpan =
    preview?.mode === "copy" && preview.ghost !== null && draggedClip
      ? { start: preview.ghost, measures: Math.max(1, Math.min(draggedClip.measures, freeSpanAt(track, preview.ghost, song))) }
      : null;
  const tooltip = (() => {
    if (!preview || !draggedClip) return null;
    if (preview.mode === "move")
      return {
        start: draggedClip.start_measure,
        measures: draggedClip.measures,
        text: `Measures ${draggedClip.start_measure}–${draggedClip.start_measure + draggedClip.measures - 1}`,
      };
    if (preview.mode === "resize")
      return { start: draggedClip.start_measure, measures: draggedClip.measures, text: `${draggedClip.measures} ${draggedClip.measures === 1 ? "bar" : "bars"}` };
    if (!ghostSpan) return null;
    return {
      ...ghostSpan,
      text: `Copy to measures ${ghostSpan.start}–${ghostSpan.start + ghostSpan.measures - 1}`,
    };
  })();

  const menuClip = menu?.kind === "clip" ? track.clips.find((c) => c.id === menu.clipId) : undefined;

  return (
    <div
      ref={lane}
      data-testid="clip-lane"
      // Container units make blocks follow the lane's width on any resize with no JS measuring.
      style={{ "--cell-w": `calc(100cqw / ${song.measures * spm})` } as React.CSSProperties}
      className="@container relative min-w-0 cursor-pointer"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        onSeek(measureAt(e.clientX) - 1);
      }}
      onDoubleClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const at = measureAt(e.clientX);
        if (freeSpanAt(track, at, song) > 0) actions.create(track.id, at);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (e.target !== e.currentTarget) return;
        const at = measureAt(e.clientX);
        const free = freeSpanAt(track, at, song) > 0 ? at : nextFreeMeasure(track, song, at);
        setMenu({ kind: "lane", measure: free, anchor: { x: e.clientX, y: e.clientY } });
      }}
    >
      {track.clips.length === 0 && (
        <span
          className={`pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-zinc-600 dark:text-zinc-400 ${audible ? "" : "opacity-40"}`}
        >
          Double-click to add a clip
        </span>
      )}
      {layout &&
        track.clips.map((clip) => {
          const loop = track.loops.find((l) => l.id === clip.loop_id);
          if (!loop) return null;
          const loopIndex = track.loops.indexOf(loop);
          const palette = loopColour(loopIndex);
          const linked = loopUseCount(track, loop.id);
          const selected = clip.id === selectedClipId;
          const sibling = !selected && linked > 1 && loop.id === selectedLoopId;
          const label = clipLabel(loop, clip, linked);
          const path = layout.paths.get(clip.id) ?? "";
          const clipSteps = clip.measures * spm;
          const repeats = clip.measures > loop.measures ? Math.ceil(clip.measures / loop.measures) - 1 : 0;
          const dragging = preview?.clipId === clip.id && preview.mode !== "copy";
          return (
            <button
              key={clip.id}
              type="button"
              aria-roledescription="clip"
              aria-label={label}
              aria-describedby={CLIP_KEYS_HELP_ID}
              aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Delete Meta+D Control+D F2 Shift+F10"
              aria-current={selected ? "true" : undefined}
              data-clip-id={clip.id}
              data-selected={selected ? "true" : undefined}
              title={`${loop.name} · ${clipSpan(clip).replace(" to ", "–")}${linked > 1 ? ` · linked, ${linked} clips` : ""}`}
              tabIndex={clip.id === stopId ? 0 : -1}
              style={style(clip.start_measure, clip.measures)}
              className={`group/clip @container/clip absolute top-1 bottom-1 min-w-[3px] cursor-grab touch-pan-y overflow-hidden rounded-md text-left select-none hover:brightness-95 dark:hover:brightness-110 ${palette.block} ${
                sibling ? "border-2 border-dashed" : "border"
              } ${selected ? "shadow-sm ring-2 ring-zinc-900 dark:ring-zinc-50" : ""} ${dragging ? "z-20 cursor-grabbing shadow-md" : ""} ${
                audible ? "" : "opacity-40"
              } ${focusRing}`}
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                actions.select(track.id, clip.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                actions.select(track.id, clip.id);
                actions.focusRoll();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                actions.select(track.id, clip.id);
                setMenu({ kind: "clip", clipId: clip.id, anchor: { x: e.clientX, y: e.clientY } });
              }}
              onPointerDown={(e) => onPointerDown(e, clip)}
              onPointerMove={(e) => onPointerMove(e, clip)}
              onPointerUp={(e) => finishDrag(e, true)}
              onPointerCancel={(e) => finishDrag(e, false)}
              onKeyDown={(e) => onKeyDown(e, clip)}
              onKeyUp={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") endHold();
              }}
              onBlur={endHold}
            >
              <span className="absolute inset-x-0 top-0 flex h-4 items-center gap-1 px-1.5 text-[11px] leading-4 font-medium text-zinc-900 @max-[2rem]/clip:hidden dark:text-zinc-50">
                {linked > 1 && <LinkGlyph />}
                <span className={`truncate ${selected ? "font-semibold" : ""}`}>{loop.name}</span>
              </span>
              <svg
                aria-hidden="true"
                viewBox={`0 0 ${clipSteps} ${layout.span}`}
                preserveAspectRatio="none"
                className="absolute inset-x-0 top-4 bottom-0.5 h-[calc(100%-1.125rem)] w-full"
              >
                {path && (
                  <path
                    data-testid="clip-notes"
                    d={path}
                    className={palette.note}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </svg>
              {repeats > 0 && (
                <svg aria-hidden="true" viewBox={`0 0 ${clipSteps} 1`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                  {Array.from({ length: repeats }, (_, k) => (
                    <line
                      key={k}
                      data-testid="repeat-mark"
                      x1={(k + 1) * loop.measures * spm}
                      x2={(k + 1) * loop.measures * spm}
                      y1={0}
                      y2={1}
                      className="stroke-zinc-900/40 dark:stroke-zinc-50/40"
                      strokeDasharray="2 2"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
              )}
              <span
                aria-hidden="true"
                data-handle="resize"
                className="absolute inset-y-0 right-0 z-10 flex w-2 cursor-ew-resize touch-none items-center justify-center @max-[1.5rem]/clip:hidden pointer-coarse:w-4 pointer-coarse:@max-[2.5rem]/clip:hidden"
              >
                <span
                  className={`h-3 w-0.5 rounded-full bg-zinc-900/60 group-hover/clip:visible dark:bg-zinc-50/60 ${selected || dragging ? "visible" : "invisible"}`}
                />
              </span>
            </button>
          );
        })}
      {preview?.mode === "copy" && ghostSpan && ghostLoop && draggedClip && (
        <div
          aria-hidden="true"
          data-testid="clip-ghost"
          style={style(ghostSpan.start, ghostSpan.measures)}
          className={`pointer-events-none absolute top-1 bottom-1 rounded-md border border-dashed opacity-70 shadow-md ${loopColour(track.loops.indexOf(ghostLoop)).block}`}
        >
          <span className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-zinc-900 text-[10px] font-bold text-white dark:bg-zinc-50 dark:text-zinc-950">
            +
          </span>
        </div>
      )}
      {tooltip && (
        <div
          aria-hidden="true"
          style={{ left: `calc(var(--cell-w) * ${(tooltip.start - 1) * spm})` }}
          className={`pointer-events-none absolute z-50 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900 ${
            first ? "top-full mt-1" : "-top-7"
          }`}
        >
          {tooltip.text}
        </div>
      )}
      {menu?.kind === "clip" && menuClip && (
        <ContextMenu
          open
          anchor={menu.anchor}
          label={clipMenuLabel(track, menuClip)}
          onClose={() => setMenu(null)}
          returnFocusTo={() => lane.current?.querySelector<HTMLElement>(`[data-clip-id="${menuClip.id}"]`) ?? null}
        >
          {(close) => (
            <ClipMenuItems
              track={track}
              song={song}
              clip={menuClip}
              actions={actions}
              close={close}
              focusResult
              invoker={() => lane.current?.querySelector<HTMLElement>(`[data-clip-id="${menuClip.id}"]`) ?? null}
            />
          )}
        </ContextMenu>
      )}
      {menu?.kind === "lane" && (
        <ContextMenu
          open
          anchor={menu.anchor}
          label={`Track options for ${track.name}`}
          onClose={() => setMenu(null)}
          returnFocusTo={() => null}
        >
          {(close) => (
            <LaneMenuItems track={track} measure={menu.measure} actions={actions} close={close} />
          )}
        </ContextMenu>
      )}
    </div>
  );
}
