"use client";

import { useEffect, useId, useRef, useState } from "react";
import { focusRing } from "@/components/ui/classes";
import type { LoopRange } from "@/lib/audio/types";
import {
  drawRegion,
  moveRegion,
  resizeEnd,
  resizeStart,
  type LoopSetting,
} from "@/lib/loopRegion";

// A press that moves less than this is a click, so a slightly unsteady click never becomes a drag.
const DRAG_THRESHOLD_PX = 4;
const PAGE_STEP = 4;
// Below this the two handle strips would cover the body, so they move outside it.
const COMPACT_REGION_PX = 32;

type Part = "draw" | "move" | "start" | "end";

interface Drag {
  part: Part;
  pointerId: number;
  originX: number;
  anchor: number;
  origin: LoopRange;
  moved: boolean;
  // Only a drag that began on the body is followed by a click on it.
  onBody: boolean;
}

const focusOutline =
  "focus-visible:outline-2 focus-visible:outline-black dark:focus-visible:outline-white";

// Stands in while no region exists so the geometry below stays total; nothing renders from it then.
const NO_REGION: LoopRange = { start: 1, end: 1 };

const sameSetting = (a: LoopSetting, b: LoopSetting) =>
  a.enabled === b.enabled && a.region?.start === b.region?.start && a.region?.end === b.region?.end;

const span = (l: LoopRange) =>
  l.start === l.end ? `${l.start}` : `${l.start}–${l.end}`;

export function LoopRegion({
  loop,
  measures,
  stepsPerMeasure,
  measurePx,
  onChange,
}: {
  loop: LoopSetting;
  measures: number;
  stepsPerMeasure: number;
  // Only used to pick the handle placement; pointer maths reads the live bounds so zoom and scroll stay correct.
  measurePx: number;
  onChange: (loop: LoopSetting) => void;
}) {
  const helpId = useId();
  const setHelpId = useId();
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // A drag ends in a click on the body, which must not also toggle looping.
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<LoopRange | null>(null);
  const [dragPart, setDragPart] = useState<Part | null>(null);
  const [focused, setFocused] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // The button that created the region unmounts with it, so focus has to be placed once the sliders exist.
  const focusEndNext = useRef(false);

  useEffect(() => {
    if (!loop.region || !focusEndNext.current) return;
    focusEndNext.current = false;
    root.current?.querySelector<HTMLElement>('[aria-label="Loop region end"]')?.focus();
  }, [loop.region]);

  const region = loop.region;
  const r = region ?? NO_REGION;
  const shown = preview ?? r;
  // A draw preview shows the region as it will be, which is with looping on.
  const enabled = preview ? true : loop.enabled;
  const single = shown.start === shown.end;
  const unit = `calc(${stepsPerMeasure} * var(--cell-w))`;
  const left = `calc(${shown.start - 1} * ${unit})`;
  const right = `calc(${shown.end} * ${unit})`;
  const width = `calc(${shown.end - shown.start + 1} * ${unit})`;
  const regionPx = (shown.end - shown.start + 1) * measurePx;
  const compact = regionPx < COMPACT_REGION_PX;
  const solid = regionPx < 6;
  const name = `Loop region, ${single ? "measure" : "measures"} ${single ? shown.start : `${shown.start} to ${shown.end}`}, looping ${loop.enabled ? "on" : "off"}`;

  const measureAt = (clientX: number) => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 1;
    const m = Math.floor((clientX - rect.left) / (rect.width / measures)) + 1;
    return Math.min(Math.max(m, 1), measures);
  };

  const begin = (part: Part, e: React.PointerEvent<HTMLElement>, onBody = false) => {
    if (e.button !== 0) return;
    suppressClick.current = false;
    drag.current = {
      part,
      pointerId: e.pointerId,
      originX: e.clientX,
      anchor: measureAt(e.clientX),
      origin: r,
      moved: false,
      onBody,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const next = (d: Drag, m: number): LoopRange => {
    switch (d.part) {
      case "draw":
        return drawRegion(d.anchor, m, measures);
      case "move":
        return moveRegion(d.origin, m - d.anchor, measures);
      case "start":
        return resizeStart(d.origin, m, measures);
      case "end":
        return resizeEnd(d.origin, m, measures);
    }
  };

  const track = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientX - d.originX) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    setDragPart(d.part);
    setPreview(next(d, measureAt(e.clientX)));
  };

  const finish = (e: React.PointerEvent<HTMLElement>, commit: boolean) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setPreview(null);
    setDragPart(null);
    if (!d.moved) return;
    if (d.onBody) suppressClick.current = true;
    if (!commit) return;
    const range = next(d, measureAt(e.clientX));
    // Drawing turns looping on; moving and resizing keep the setting.
    const result: LoopSetting = { region: range, enabled: d.part === "draw" ? true : loop.enabled };
    if (sameSetting(result, loop)) return;
    onChange(result);
    setAnnouncement(
      `Loop region measures ${range.start} to ${range.end}, looping ${result.enabled ? "on" : "off"}.`,
    );
  };

  const handlers = {
    onPointerMove: track,
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => finish(e, true),
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => finish(e, false),
  };

  // The roll and the page treat arrows and Space as their own, so handled keys stop here.
  const key = (e: React.KeyboardEvent, apply: (() => LoopRange) | null) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!apply) return;
    e.preventDefault();
    e.stopPropagation();
    const result = { ...loop, region: apply() };
    if (!sameSetting(result, loop)) onChange(result);
  };

  const bodyKey = (e: React.KeyboardEvent) => {
    // A cancelled drag never produces the click that would clear this, and a stale flag would swallow the key's own click.
    suppressClick.current = false;
    if (e.key === "Enter" || e.key === " ") {
      // The native click this key produces does the toggle.
      e.stopPropagation();
      return;
    }
    const apply: Record<string, () => LoopRange> = {
      ArrowLeft: () => moveRegion(r, -1, measures),
      ArrowRight: () => moveRegion(r, 1, measures),
      Home: () => moveRegion(r, -measures, measures),
      End: () => moveRegion(r, measures, measures),
    };
    key(e, apply[e.key] ?? null);
  };

  const handleKey = (part: "start" | "end") => (e: React.KeyboardEvent) => {
    const to = (n: number) =>
      part === "start" ? resizeStart(r, n, measures) : resizeEnd(r, n, measures);
    const at = part === "start" ? r.start : r.end;
    const apply: Record<string, () => LoopRange> = {
      ArrowLeft: () => to(at - 1),
      ArrowRight: () => to(at + 1),
      PageDown: () => to(at - PAGE_STEP),
      PageUp: () => to(at + PAGE_STEP),
      Home: () => to(1),
      End: () => to(measures),
    };
    if (e.key === " " || e.key === "Enter") {
      // Space would otherwise scroll the roll, since a slider has no activation of its own.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    key(e, apply[e.key] ?? null);
  };

  // Without a region there is nothing focusable, so keyboard users need a way to make the first one.
  const createFromKeyboard = () => {
    const created: LoopSetting = { region: { start: 1, end: 1 }, enabled: true };
    focusEndNext.current = true;
    onChange(created);
    setAnnouncement("Loop region measure 1, looping on.");
  };

  const halfHandle = "calc(var(--hw) / 2)";
  const fullHandle = "var(--hw)";
  const startStyle: React.CSSProperties =
    shown.start === 1
      ? { left: 0 }
      : { left: `calc(${left} - ${compact ? fullHandle : halfHandle})` };
  const endStyle: React.CSSProperties =
    shown.end === measures
      ? { right: 0 }
      : { left: compact ? right : `calc(${right} - ${halfHandle})` };

  const showGrip = (part: "start" | "end") =>
    // On touch both grips would overlap on a tiny region, and the end handle is the one on top.
    !(part === "start" && regionPx < 8) &&
    "pointer-coarse:opacity-100";

  const handleClass =
    "group/handle absolute inset-y-0 w-[var(--hw)] cursor-ew-resize touch-none focus-visible:-outline-offset-2 " +
    focusOutline;
  const grip = (part: "start" | "end") =>
    `absolute top-1/2 left-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-800 opacity-0 group-hover/loop:opacity-100 group-focus-visible/handle:opacity-100 dark:bg-zinc-200 ${showGrip(part) || ""} ${dragPart === part ? "opacity-100" : ""}`;

  const bodyLook = enabled
    ? `bg-zinc-900/10 hover:bg-zinc-900/15 dark:bg-white/15 dark:hover:bg-white/20 ${solid ? "bg-zinc-800 dark:bg-zinc-200" : "border-x-2 border-zinc-800 before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-zinc-800 dark:border-zinc-200 dark:before:bg-zinc-200"}`
    : `bg-zinc-900/[0.04] hover:bg-zinc-900/10 dark:bg-white/5 dark:hover:bg-white/10 ${solid ? "outline-1 outline-dashed outline-zinc-500" : "border-x-2 border-dashed border-zinc-500 before:absolute before:inset-x-0 before:top-0 before:h-0 before:border-t-2 before:border-dashed before:border-zinc-500 dark:border-zinc-400 dark:before:border-zinc-400"}`;

  // Without a region or preview the stand-in geometry would make the chip describe a region that does not exist.
  const showChip = (region !== null || preview !== null) && (dragPart !== null || focused);
  const chipAnchor = shown.start > measures / 2 ? { right: `calc(100% - ${right})` } : { left };

  return (
    <div
      ref={root}
      data-loop-region
      onFocus={(e) => {
        try {
          setFocused(e.target.matches(":focus-visible"));
        } catch {
          setFocused(true);
        }
      }}
      onBlur={() => setFocused(false)}
      className="absolute inset-0 [--hw:12px] pointer-coarse:[--hw:24px]"
    >
      <div
        data-testid="loop-hit-layer"
        aria-hidden="true"
        onPointerDown={(e) => begin("draw", e)}
        {...handlers}
        className={`absolute inset-0 z-0 touch-none select-none ${dragPart === "draw" ? "cursor-ew-resize" : "cursor-crosshair"}`}
      />
      {!region && (
        <>
          <button
            type="button"
            aria-describedby={setHelpId}
            onClick={createFromKeyboard}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") e.stopPropagation();
            }}
            className={`sr-only focus:not-sr-only focus:absolute focus:inset-y-0 focus:left-0 focus:z-20 focus:flex focus:items-center focus:rounded-sm focus:bg-white focus:px-2 focus:text-xs focus:font-medium focus:whitespace-nowrap focus:text-zinc-900 dark:focus:bg-zinc-900 dark:focus:text-zinc-100 ${focusRing} focus-visible:-outline-offset-2`}
          >
            Set loop region
          </button>
          <p id={setHelpId} className="sr-only">
            Creates a one-measure loop region at measure 1 and turns looping on. Then use Left and Right to extend it.
          </p>
        </>
      )}
      {!region && preview && (
        <div
          aria-hidden="true"
          style={{ left, width }}
          className="pointer-events-none absolute inset-y-0 z-10 border-x-2 border-zinc-800 bg-zinc-900/10 dark:border-zinc-200 dark:bg-white/15"
        />
      )}
      {region && (
      <div role="group" aria-label="Loop region" className="group/loop">
        <div
          role="slider"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Loop region start"
          aria-valuemin={1}
          aria-valuemax={r.end}
          aria-valuenow={r.start}
          aria-valuetext={`Measure ${r.start}`}
          onPointerDown={(e) => begin("start", e)}
          onKeyDown={handleKey("start")}
          {...handlers}
          style={startStyle}
          className={`${handleClass} z-20`}
        >
          <span aria-hidden="true" className={grip("start")} />
        </div>
        <button
          type="button"
          data-testid="loop-region"
          data-enabled={String(loop.enabled)}
          data-start={r.start}
          data-end={r.end}
          data-compact={compact ? "" : undefined}
          aria-pressed={loop.enabled}
          aria-label={name}
          aria-describedby={helpId}
          title={`Loop region: measures ${span(r)} (looping ${loop.enabled ? "on" : "off"})`}
          onPointerDown={(e) => begin("move", e, true)}
          onKeyDown={bodyKey}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            onChange({ ...loop, enabled: !loop.enabled });
          }}
          {...handlers}
          style={{ left, width }}
          className={`absolute inset-y-0 z-10 min-w-[3px] cursor-grab touch-none select-none transition-colors active:cursor-grabbing focus-visible:-outline-offset-4 data-[compact]:focus-visible:outline-offset-0 motion-reduce:transition-none ${focusOutline} ${bodyLook} ${dragPart ? "shadow-sm" : ""} ${dragPart === "move" ? "cursor-grabbing" : ""}`}
        />
        <div
          role="slider"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Loop region end"
          aria-valuemin={r.start}
          aria-valuemax={measures}
          aria-valuenow={r.end}
          aria-valuetext={`Measure ${r.end}`}
          onPointerDown={(e) => begin("end", e)}
          onKeyDown={handleKey("end")}
          {...handlers}
          style={endStyle}
          className={`${handleClass} z-[21]`}
        >
          <span aria-hidden="true" className={grip("end")} />
        </div>
      </div>
      )}
      <p id={helpId} className="sr-only">
        Enter or Space turns looping on or off. Left and Right move the region. Drag on the ruler to draw a new region.
      </p>
      {showChip && (
        <div
          aria-hidden="true"
          data-testid="loop-chip"
          style={chipAnchor}
          className="pointer-events-none absolute top-full z-50 mt-1 rounded bg-zinc-900 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-white tabular-nums dark:bg-zinc-100 dark:text-zinc-900"
        >
          {span(shown)}
          {!enabled && !dragPart ? " · off" : ""}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
