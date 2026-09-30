"use client";

import { useRef, useState } from "react";
import { focusRing } from "@/components/ui/classes";

// A short snap zone makes exact center reachable by dragging, where 1% steps would otherwise miss it.
const CENTER_SNAP_PERCENT = 3;
const MAX_ANGLE = 135;

const clampPercent = (p: number) => Math.max(-100, Math.min(100, Math.round(p)));

export function panText(percent: number) {
  if (percent === 0) return "Center";
  return `${Math.abs(percent)}% ${percent < 0 ? "left" : "right"}`;
}

export function PanKnob({
  name,
  value,
  onChange,
  onGestureStart,
  onGestureEnd,
}: {
  name: string;
  // Stored as -1..1 to match the song model; the UI works in whole percent.
  value: number;
  onChange: (pan: number, options: { transient: boolean }) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
}) {
  const percent = Math.round(value * 100);
  const [showing, setShowing] = useState(false);
  const drag = useRef<{ x: number; y: number; start: number } | null>(null);

  const set = (p: number, transient: boolean) => onChange(clampPercent(p) / 100, { transient });
  const end = () => {
    drag.current = null;
    onGestureEnd();
    setShowing(false);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowDown: -1,
      ArrowRight: 1,
      ArrowUp: 1,
      PageUp: 10,
      PageDown: -10,
    };
    if (e.key in steps) {
      e.preventDefault();
      set(percent + steps[e.key], true);
    } else if (e.key === "Home") {
      e.preventDefault();
      set(-100, true);
    } else if (e.key === "End") {
      e.preventDefault();
      set(100, true);
    } else if (e.key === "Delete" || e.key === "Backspace" || e.key === "0") {
      e.preventDefault();
      set(0, false);
    }
  }

  return (
    <span className="relative inline-flex">
      <span
        role="slider"
        tabIndex={0}
        aria-label={`Pan ${name}`}
        aria-orientation="horizontal"
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={panText(percent)}
        aria-keyshortcuts="Delete"
        title="Pan. Double-click or press Delete to center."
        onKeyDown={onKeyDown}
        onKeyUp={onGestureEnd}
        onFocus={() => setShowing(true)}
        onBlur={end}
        onDoubleClick={() => set(0, false)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, start: percent };
          onGestureStart();
          setShowing(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const perPx = e.shiftKey ? 0.25 : 1;
          const raw = d.start + ((e.clientX - d.x) - (e.clientY - d.y)) * perPx;
          set(Math.abs(raw) <= CENTER_SNAP_PERCENT ? 0 : raw, true);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        className={`relative inline-flex size-7 cursor-ns-resize touch-none items-center justify-center rounded-full border border-zinc-400 bg-white pointer-coarse:size-9 dark:border-zinc-600 dark:bg-zinc-900 ${focusRing}`}
      >
        <span aria-hidden="true" className="absolute top-0 h-1 w-px bg-zinc-400" />
        <span
          aria-hidden="true"
          className="absolute inset-0"
          style={{ transform: `rotate(${(percent / 100) * MAX_ANGLE}deg)` }}
        >
          <span className="absolute top-0.5 left-1/2 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-indigo-600 dark:bg-indigo-400" />
        </span>
      </span>
      {showing && (
        <output className="pointer-events-none absolute -top-7 left-1/2 z-50 -translate-x-1/2 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900">
          {percent === 0 ? "C" : `${percent < 0 ? "L" : "R"}${Math.abs(percent)}`}
        </output>
      )}
    </span>
  );
}
