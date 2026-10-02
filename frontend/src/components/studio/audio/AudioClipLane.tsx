"use client";

import { useEffect, useRef, useState } from "react";
import type { AudioClip } from "@/generated/AudioClip";
import type { Sample } from "@/generated/Sample";
import { useSampleOverview } from "@/lib/audio/useSampleLibrary";
import * as ops from "@/lib/song/audioClipOps";
import { formatBarsBeats, formatFade, formatPosition, lastFrameTicks, spanLabel } from "@/lib/song/audioTime";
import {
  TICKS_PER_SIXTEENTH,
  clipEndTicks,
  samplesToTicks,
  sampleMap,
  ticksToSamples,
} from "@/lib/song/audioTiming";
import type { Song, Track } from "@/lib/song/types";
import { ContextMenu } from "../ContextMenu";
import { menuItemClass } from "../Menu";
import { PastEnd } from "../PastEnd";
import { loopColour } from "../loopPalette";
import { formatDb } from "../VolumeSlider";
import { draggedSample, dragKind, readDrop, type SampleDrop } from "../samples/useSampleDrop";
import type { AudioActions } from "../useAudioActions";
import { AudioClipBlock } from "./AudioClipBlock";
import { AudioClipMenuItems } from "./AudioClipMenu";
import { LaneRecording } from "./RecordingOverlay";

const DRAG_THRESHOLD_PX = 4;
export const AUDIO_CLIP_KEYS_HELP_ID = "audio-clip-keys-help";
export const AUDIO_CLIP_KEYS_HELP =
  "Left and Right arrows move the clip by a sixteenth. Shift with Left or Right changes its length. Up and Down arrows change its gain by 1 decibel. Alt with Left or Right moves to the previous or next clip. Enter opens the clip panel. Delete removes it. Command or Control D duplicates it. Shift F10 opens more actions.";

type Mode = "move" | "trim-start" | "trim-end" | "gain" | "fade-in" | "fade-out";

interface DragState {
  mode: Mode;
  clipId: string;
  pointerId: number;
  startX: number;
  startY: number;
  ticksPerPx: number;
  origStart: number;
  origEnd: number;
  origGain: number;
  origFadeIn: number;
  origFadeOut: number;
  crossed: boolean;
  cancelled: boolean;
}

type MenuState =
  | { kind: "clip"; clipId: string; anchor: { x: number; y: number } }
  | { kind: "lane"; ticks: number; anchor: { x: number; y: number } };

// Looked up per clip so each block reads its own overview without the lane holding them all.
function ClipView(props: Omit<React.ComponentProps<typeof AudioClipBlock>, "overview"> & { sampleId: string }) {
  const overview = useSampleOverview(props.sampleId);
  return <AudioClipBlock {...props} overview={overview} />;
}

export function AudioClipLane({
  song,
  timeline,
  track,
  audible,
  selectedClipId,
  first,
  actions,
  drop,
  onSeek,
}: {
  song: Song;
  timeline: number;
  track: Track;
  audible: boolean;
  selectedClipId: string | null;
  first: boolean;
  actions: AudioActions;
  drop: SampleDrop;
  onSeek: (measureIndex: number) => void;
}) {
  const lane = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const holding = useRef(false);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ mode: Mode; clipId: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [hover, setHover] = useState<{ ticks: number; free: boolean } | null>(null);
  const spm = song.steps_per_measure;
  const clips = track.audio_clips ?? [];
  const samples = sampleMap(song.samples);
  const stepsTotal = timeline * spm;
  const totalTicks = stepsTotal * TICKS_PER_SIXTEENTH;

  const laneHasSelection = clips.some((c) => c.id === selectedClipId);
  const stopId = laneHasSelection ? selectedClipId : clips[0]?.id;

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      e.stopPropagation();
      if (drag.current.crossed) actions.cancelGesture();
      drag.current.cancelled = true;
      setPreview(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [preview, actions]);

  const dragCursor = !preview ? "" : preview.mode === "move" ? "grabbing" : preview.mode === "gain" ? "ns-resize" : "ew-resize";
  useEffect(() => {
    document.body.style.cursor = dragCursor;
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragCursor]);

  const ticksAt = (clientX: number) => {
    const rect = lane.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.max(0, ((clientX - rect.left) / rect.width) * totalTicks);
  };
  const snap = (ticks: number, free: boolean) => ops.snapTicks(ticks, free);

  function endHold() {
    if (!holding.current) return;
    holding.current = false;
    actions.endGesture();
  }

  function finishDrag(commit: boolean) {
    const d = drag.current;
    drag.current = null;
    setPreview(null);
    if (!d) return;
    if (d.crossed) suppressClick.current = true;
    if (!d.crossed || d.cancelled) return;
    if (commit) actions.endGesture();
    else actions.cancelGesture();
  }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>, clip: AudioClip, sample: Sample | undefined) {
    if (e.button !== 0 || !sample) return;
    suppressClick.current = false;
    const rect = lane.current?.getBoundingClientRect();
    const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset.handle;
    drag.current = {
      mode: (handle as Mode | undefined) ?? "move",
      clipId: clip.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      ticksPerPx: rect && rect.width > 0 ? totalTicks / rect.width : 0,
      origStart: clip.start_ticks,
      origEnd: clipEndTicks(clip, sample.sample_rate, song.tempo_bpm),
      origGain: clip.gain_db,
      origFadeIn: clip.fade_in_samples,
      origFadeOut: clip.fade_out_samples,
      crossed: false,
      cancelled: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>, clip: AudioClip, sample: Sample | undefined) {
    const d = drag.current;
    if (!d || d.clipId !== clip.id || d.cancelled || !sample) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.crossed) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      d.crossed = true;
      actions.select(track.id, clip.id);
      actions.beginGesture();
    }
    if (d.ticksPerPx <= 0) return;
    const deltaTicks = dx * d.ticksPerPx;
    const toSamples = (ticks: number) => ticksToSamples(ticks, sample.sample_rate, song.tempo_bpm);
    switch (d.mode) {
      case "move":
        actions.move(track.id, clip.id, d.origStart + deltaTicks, e.shiftKey);
        break;
      case "trim-start":
        actions.trimStart(track.id, clip.id, d.origStart + deltaTicks, e.shiftKey);
        break;
      case "trim-end":
        actions.trimEnd(track.id, clip.id, d.origEnd + deltaTicks, e.shiftKey);
        break;
      case "gain":
        actions.gain(track.id, clip.id, Math.round((d.origGain - dy * (e.shiftKey ? 0.1 : 0.5)) * 10) / 10);
        break;
      case "fade-in":
        actions.fades(track.id, clip.id, { fadeIn: d.origFadeIn + toSamples(deltaTicks) });
        break;
      case "fade-out":
        actions.fades(track.id, clip.id, { fadeOut: d.origFadeOut - toSamples(deltaTicks) });
        break;
    }
    setPreview({ mode: d.mode, clipId: clip.id });
  }

  function focusSibling(current: HTMLElement, target: "prev" | "next" | "first" | "last") {
    const all = [...(lane.current?.querySelectorAll<HTMLElement>("[data-audio-clip-id]") ?? [])];
    const at = all.indexOf(current);
    ({ prev: all[at - 1], next: all[at + 1], first: all[0], last: all.at(-1) })[target]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, clip: AudioClip) {
    const el = e.currentTarget;
    const key = e.key;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && key.toLowerCase() === "d") {
      e.preventDefault();
      actions.duplicate(track.id, clip.id, { focus: true });
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const hold = () => {
      // Auto-repeat folds into one gesture that ends on key-up, so a held arrow is a single undo step.
      if (!holding.current) {
        holding.current = true;
        actions.beginGesture();
      }
    };
    if (key === "Enter") {
      e.preventDefault();
      actions.select(track.id, clip.id);
      actions.openDock();
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('section[aria-label^="Editor"] [role="slider"]')?.focus(),
      );
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      e.preventDefault();
      if (e.altKey) return focusSibling(el, key === "ArrowLeft" ? "prev" : "next");
      hold();
      const dir = key === "ArrowLeft" ? -1 : 1;
      if (e.shiftKey) actions.stretch(track.id, clip.id, dir);
      else actions.nudge(track.id, clip.id, dir);
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      e.preventDefault();
      hold();
      actions.gainStep(track.id, clip.id, key === "ArrowUp" ? 1 : -1);
    } else if (key === "Home" || key === "End") {
      e.preventDefault();
      focusSibling(el, key === "Home" ? "first" : "last");
    } else if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      actions.remove(track.id, clip.id);
    } else if (key === "ContextMenu" || (key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      actions.select(track.id, clip.id);
      setMenu({ kind: "clip", clipId: clip.id, anchor: { x: rect.left, y: rect.bottom } });
    }
  }

  const ticksStyle = (startTicks: number, durationTicks: number): React.CSSProperties => ({
    left: `calc(var(--cell-w) * ${startTicks / TICKS_PER_SIXTEENTH})`,
    width: `calc(var(--cell-w) * ${durationTicks / TICKS_PER_SIXTEENTH} - 1px)`,
  });

  const dragged = hover ? draggedSample() : null;
  const draggedAsSample: Sample | null = dragged
    ? { id: dragged.id, name: dragged.name, sample_rate: dragged.sampleRate, channels: dragged.channels, length_samples: dragged.length, origin: "import" }
    : null;
  const hoverTicks = hover ? snap(hover.ticks, hover.free) : 0;
  const ghostRefusal =
    draggedAsSample && hover
      ? (() => {
          const r = ops.placeSample(song, track.id, draggedAsSample, hoverTicks);
          return r.song ? null : r.reason;
        })()
      : null;

  const menuClip = menu?.kind === "clip" ? clips.find((c) => c.id === menu.clipId) : undefined;
  const dragging = preview ? clips.find((c) => c.id === preview.clipId) : undefined;
  const tooltip = (() => {
    if (!preview || !dragging) return null;
    const sample = samples.get(dragging.sample_id);
    if (!sample) return null;
    const timing = { ...song };
    const end = clipEndTicks(dragging, sample.sample_rate, song.tempo_bpm);
    let text = "";
    switch (preview.mode) {
      case "move":
        text = formatPosition(dragging.start_ticks, timing);
        break;
      case "trim-start":
        text = `Starts ${formatPosition(dragging.start_ticks, timing)}`;
        break;
      case "trim-end":
        text = `Ends ${formatPosition(lastFrameTicks(dragging, sample.sample_rate, timing), timing)} · ${formatBarsBeats(end - dragging.start_ticks, timing)}`;
        if (dragging.loop && dragging.length_samples > dragging.slice_samples)
          text += ` · plays ${Math.ceil(dragging.length_samples / dragging.slice_samples)} times`;
        break;
      case "gain":
        text = formatDb(dragging.gain_db);
        break;
      case "fade-in":
        text = `Fade in ${formatFade(dragging.fade_in_samples, sample.sample_rate)}`;
        break;
      case "fade-out":
        text = `Fade out ${formatFade(dragging.fade_out_samples, sample.sample_rate)}`;
        break;
    }
    return { left: dragging.start_ticks, text };
  })();

  const laneRing = drop.active
    ? hover
      ? "ring-2 ring-inset ring-indigo-600 bg-indigo-500/5 dark:ring-indigo-400"
      : "ring-1 ring-inset ring-indigo-600/40"
    : "";

  return (
    <div
      ref={lane}
      data-testid="clip-lane"
      data-audio-lane
      style={{ "--cell-w": `calc(100cqw / ${stepsTotal})` } as React.CSSProperties}
      className={`@container relative min-w-0 cursor-pointer ${laneRing}`}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        onSeek(Math.min(timeline - 1, Math.floor(ticksAt(e.clientX) / (spm * TICKS_PER_SIXTEENTH))));
      }}
      onDoubleClick={(e) => {
        if (e.target !== e.currentTarget) return;
        actions.importHere(track.id, snap(ticksAt(e.clientX), e.shiftKey));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (e.target !== e.currentTarget) return;
        setMenu({ kind: "lane", ticks: snap(ticksAt(e.clientX), e.shiftKey), anchor: { x: e.clientX, y: e.clientY } });
      }}
      onDragOver={(e) => {
        const kind = dragKind(e.dataTransfer);
        if (!kind) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = ghostRefusal ? "none" : "copy";
        setHover({ ticks: ticksAt(e.clientX), free: e.shiftKey });
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null);
      }}
      onDrop={(e) => {
        if (!dragKind(e.dataTransfer)) return;
        e.preventDefault();
        const at = snap(ticksAt(e.clientX), e.shiftKey);
        setHover(null);
        void readDrop(e.dataTransfer).then((payload) => payload && drop.onDrop(track.id, at, e.shiftKey, payload));
      }}
    >
      <PastEnd song={song} timeline={timeline} />
      {clips.length === 0 && !hover && (
        <span
          className={`pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-zinc-600 dark:text-zinc-400 ${audible ? "" : "opacity-40"}`}
        >
          Drop audio here or drag from Samples
          <span className="max-sm:hidden"> · double-click to import</span>
        </span>
      )}
      {clips.map((clip) => {
        const sample = samples.get(clip.sample_id);
        const name = sample?.name ?? "Missing sample";
        const rate = sample?.sample_rate ?? 48000;
        const selected = clip.id === selectedClipId;
        const index = (song.samples ?? []).findIndex((s) => s.id === clip.sample_id);
        const span = sample ? spanLabel(clip, rate, song) : "";
        const duration = samplesToTicks(clip.length_samples, rate, song.tempo_bpm);
        const pieces = [`${name}, ${span}`];
        if (clip.loop) pieces.push("looping");
        if (clip.gain_db !== 0) pieces.push(`gain ${formatDb(clip.gain_db)}`);
        return (
          <ClipView
            key={clip.id}
            sampleId={clip.sample_id}
            clip={clip}
            name={name}
            palette={loopColour(Math.max(0, index))}
            label={pieces.join(", ")}
            title={`${name} · ${formatPosition(clip.start_ticks, song)}${clip.loop ? " · looping" : ""}${clip.gain_db !== 0 ? ` · ${formatDb(clip.gain_db)}` : ""}`}
            selected={selected}
            audible={audible}
            dragging={preview?.clipId === clip.id}
            tabIndex={clip.id === stopId ? 0 : -1}
            style={ticksStyle(clip.start_ticks, duration)}
            describedBy={AUDIO_CLIP_KEYS_HELP_ID}
            handlers={{
              onClick: (e) => {
                e.stopPropagation();
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                actions.select(track.id, clip.id);
              },
              onDoubleClick: (e) => {
                e.stopPropagation();
                actions.select(track.id, clip.id);
                actions.openDock();
              },
              onContextMenu: (e) => {
                e.preventDefault();
                e.stopPropagation();
                actions.select(track.id, clip.id);
                setMenu({ kind: "clip", clipId: clip.id, anchor: { x: e.clientX, y: e.clientY } });
              },
              onPointerDown: (e) => onPointerDown(e, clip, sample),
              onPointerMove: (e) => onPointerMove(e, clip, sample),
              onPointerUp: () => finishDrag(true),
              onPointerCancel: () => finishDrag(false),
              onKeyDown: (e) => onKeyDown(e, clip),
              onKeyUp: (e) => {
                if (e.key.startsWith("Arrow")) endHold();
              },
              onBlur: endHold,
            }}
          />
        );
      })}
      <LaneRecording trackId={track.id} tempoBpm={song.tempo_bpm} />
      {hover && draggedAsSample && (
        <div
          aria-hidden="true"
          data-testid="drop-ghost"
          style={ticksStyle(hoverTicks, samplesToTicks(draggedAsSample.length_samples, draggedAsSample.sample_rate, song.tempo_bpm))}
          className={`pointer-events-none absolute top-1 bottom-1 rounded-md border border-dashed opacity-70 ${
            ghostRefusal ? "border-red-700 bg-red-500/10 dark:border-red-400" : "border-zinc-600 bg-zinc-500/15"
          }`}
        >
          <span className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-zinc-900 text-[10px] font-bold text-white dark:bg-zinc-50 dark:text-zinc-950">
            {ghostRefusal ? "⊘" : "+"}
          </span>
        </div>
      )}
      {hover && !draggedAsSample && (
        <div
          aria-hidden="true"
          style={{ left: `calc(var(--cell-w) * ${hoverTicks / TICKS_PER_SIXTEENTH})` }}
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-indigo-600 dark:bg-indigo-400"
        />
      )}
      {hover && (
        <div
          aria-hidden="true"
          style={{ left: `calc(var(--cell-w) * ${hoverTicks / TICKS_PER_SIXTEENTH})` }}
          className={`pointer-events-none absolute z-50 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900 ${
            first ? "top-full mt-1" : "-top-7"
          }`}
        >
          {draggedAsSample
            ? ghostRefusal
              ? ghostRefusal === "no-room"
                ? "Space taken"
                : "Past measure 128"
              : `${draggedAsSample.name} · ${formatPosition(hoverTicks, song)}`
            : `Import here · ${formatPosition(hoverTicks, song)}`}
        </div>
      )}
      {tooltip && (
        <div
          aria-hidden="true"
          style={{ left: `calc(var(--cell-w) * ${tooltip.left / TICKS_PER_SIXTEENTH})` }}
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
          label={`Clip actions for ${samples.get(menuClip.sample_id)?.name ?? "clip"}`}
          onClose={() => setMenu(null)}
          returnFocusTo={() => lane.current?.querySelector<HTMLElement>(`[data-audio-clip-id="${menuClip.id}"]`) ?? null}
        >
          {(close) => (
            <AudioClipMenuItems
              song={song}
              trackId={track.id}
              clip={menuClip}
              actions={actions}
              close={close}
              focusResult
              canDuplicate={canDuplicate(song, track, menuClip)}
              invoker={() => lane.current?.querySelector<HTMLElement>(`[data-audio-clip-id="${menuClip.id}"]`) ?? null}
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
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => {
                close();
                actions.importHere(track.id, menu.ticks);
              }}
            >
              Import audio here…
            </button>
          )}
        </ContextMenu>
      )}
    </div>
  );
}

// Dry-runs the real operation so the menu hint can never disagree with what Duplicate would do.
export function canDuplicate(song: Song, track: Track, clip: AudioClip): boolean {
  return ops.duplicateClip(song, track.id, clip.id).song !== null;
}
