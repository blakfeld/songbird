"use client";

import { useRef } from "react";
import { focusRing } from "@/components/ui/classes";

const KEY_STEP_PX = 24;

// `grows` is needed because the same control sits below one region and above another.
export function HeightHandle({
  label,
  value,
  min,
  max,
  grows,
  onChange,
  onReset,
  className = "",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  grows: "down" | "up";
  onChange: (px: number) => void;
  onReset: () => void;
  className?: string;
}) {
  const drag = useRef<{ y: number; start: number } | null>(null);
  const clamp = (px: number) => Math.min(max, Math.max(min, Math.round(px)));
  const sign = grows === "down" ? 1 : -1;

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { y: e.clientY, start: value };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onChange(clamp(d.start + (e.clientY - d.y) * sign));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        // Arrow keys move the handle itself, so Down on a bottom-edge handle makes the region taller.
        const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        if (step !== 0) {
          e.preventDefault();
          onChange(clamp(value + step * sign * KEY_STEP_PX));
        } else if (e.key === "Home") {
          e.preventDefault();
          onChange(min);
        } else if (e.key === "End") {
          e.preventDefault();
          onChange(max);
        }
      }}
      className={`group flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center bg-zinc-100 hover:bg-indigo-100 dark:bg-zinc-900 dark:hover:bg-indigo-950 ${focusRing} ${className}`}
    >
      <span aria-hidden="true" className="h-0.5 w-10 rounded-full bg-zinc-400 group-hover:bg-indigo-600 dark:bg-zinc-600" />
    </div>
  );
}
