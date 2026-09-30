"use client";

import { useState } from "react";
import { focusRing } from "@/components/ui/classes";
import { VOLUME_DB_RANGE } from "@/lib/song/types";

export const formatDb = (db: number) =>
  `${db < 0 ? "−" : ""}${Math.abs(db).toFixed(Number.isInteger(db) ? 0 : 1)} dB`;

export function VolumeSlider({
  name,
  value,
  onChange,
  onGestureStart,
  onGestureEnd,
}: {
  name: string;
  value: number;
  onChange: (db: number, options: { transient: boolean }) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
}) {
  const [showing, setShowing] = useState(false);
  const end = () => {
    onGestureEnd();
    setShowing(false);
  };

  return (
    <span className="relative flex min-w-12 flex-1 items-center">
      <input
        type="range"
        aria-label={`Volume ${name}`}
        aria-valuetext={formatDb(value)}
        min={VOLUME_DB_RANGE.min}
        max={VOLUME_DB_RANGE.max}
        step={0.5}
        value={value}
        title="Double-click to reset to 0 dB"
        onChange={(e) => onChange(Number(e.target.value), { transient: true })}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          onGestureStart();
          setShowing(true);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => {
          if (e.key === "0") onChange(0, { transient: false });
        }}
        onKeyUp={onGestureEnd}
        onFocus={() => setShowing(true)}
        onBlur={end}
        onDoubleClick={() => onChange(0, { transient: false })}
        className={`w-full touch-none accent-indigo-600 ${focusRing}`}
      />
      {showing && (
        <output className="pointer-events-none absolute -top-7 left-1/2 z-50 -translate-x-1/2 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900">
          {formatDb(value)}
        </output>
      )}
    </span>
  );
}
