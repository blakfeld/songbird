"use client";

import { useRef, useState } from "react";
import { focusRing } from "@/components/ui/classes";

const MAX_ANGLE = 135;
// Matches the pan knob's long-standing feel: a full sweep takes about 200 px of drag.
const TRAVEL_PER_PX = 0.005;
const FINE_FACTOR = 0.25;
const ARROW_TRAVEL = 0.01;
const PAGE_MULTIPLIER = 10;

export type KnobScale = "linear" | "log";

export interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  // Pan needs whole-percent keys to land on exact values; knobs without a natural unit use travel instead.
  step?: number;
  defaultValue: number;
  // Log needs min > 0 and gives each octave of travel the same share, which is how pitch is heard.
  scale?: KnobScale;
  // Units belong here because this text is all a screen reader user gets for the value.
  format: (value: number) => string;
  // The readout floats over a small knob, so it may need terser text than the spoken value.
  formatReadout?: (value: number) => string;
  onChange: (value: number, options: { transient: boolean }) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  // A zone where a drag lands exactly on `value`, since reaching an exact value by pixels is otherwise luck.
  snap?: { value: number; within: number };
  // Marks the center of travel for knobs whose default sits in the middle, like pan.
  bipolar?: boolean;
  // Pan also resets on 0 and Backspace, which musicians reach for; other knobs keep to Delete.
  extraResetKeys?: string[];
  title?: string;
  // Replaces the default size so a layout can tune the knob without forking it.
  className?: string;
  // The larger dial draws its value as an arc, which shows boost against cut without reading the number.
  size?: "sm" | "md";
  // Greys the value arc for a setting whose effect is off while keeping the knob fully usable.
  muted?: boolean;
  describedBy?: string;
}

const DEFAULT_SIZES = {
  sm: "size-7 pointer-coarse:size-9",
  md: "size-10 pointer-coarse:size-11",
};

const point = (angle: number, radius: number) => {
  const rad = (angle * Math.PI) / 180;
  return [20 + radius * Math.sin(rad), 20 - radius * Math.cos(rad)] as const;
};

function arcPath(from: number, to: number) {
  const [a, b] = from <= to ? [from, to] : [to, from];
  if (b - a < 0.5) return null;
  const [x1, y1] = point(a, 16);
  const [x2, y2] = point(b, 16);
  return `M${x1} ${y1}A16 16 0 ${b - a > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

function DialFace({
  position,
  defaultPosition,
  bipolar,
  muted,
}: {
  position: number;
  defaultPosition: number;
  bipolar: boolean;
  muted: boolean;
}) {
  const angle = (t: number) => (t - 0.5) * 2 * MAX_ANGLE;
  const value = arcPath(bipolar ? 0 : -MAX_ANGLE, angle(position));
  const [tx, ty] = point(angle(position), 11);
  const [d1x, d1y] = point(angle(defaultPosition), 18);
  const [d2x, d2y] = point(angle(defaultPosition), 19.5);
  return (
    <svg aria-hidden="true" viewBox="0 0 40 40" className="absolute inset-0 size-full fill-none">
      <path
        d={arcPath(-MAX_ANGLE, MAX_ANGLE)!}
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-zinc-200 dark:stroke-zinc-800"
      />
      {value && (
        <path
          d={value}
          strokeWidth="3"
          strokeLinecap="round"
          className={muted ? "stroke-zinc-400 dark:stroke-zinc-600" : "stroke-indigo-600 dark:stroke-indigo-400"}
        />
      )}
      <line x1={d1x} y1={d1y} x2={d2x} y2={d2y} strokeWidth="1" className="stroke-zinc-400" />
      <line x1="20" y1="20" x2={tx} y2={ty} strokeWidth="2" strokeLinecap="round" className="stroke-zinc-900 dark:stroke-zinc-100" />
    </svg>
  );
}

export function Knob({
  label,
  value,
  min,
  max,
  step,
  defaultValue,
  scale = "linear",
  format,
  formatReadout,
  onChange,
  onGestureStart,
  onGestureEnd,
  snap,
  bipolar = false,
  extraResetKeys = [],
  title,
  className,
  size = "sm",
  muted = false,
  describedBy,
}: KnobProps) {
  const [showing, setShowing] = useState(false);
  const drag = useRef<{ x: number; y: number; start: number } | null>(null);

  const log = scale === "log";
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const toPosition = (v: number) =>
    log ? Math.log(clamp(v) / min) / Math.log(max / min) : (clamp(v) - min) / (max - min);
  const fromPosition = (t: number) => {
    const p = Math.min(1, Math.max(0, t));
    const raw = log ? min * (max / min) ** p : min + p * (max - min);
    // A step on a log knob has no uniform meaning, so only linear knobs are quantised.
    const stepped = step && !log ? min + Math.round((raw - min) / step) * step : raw;
    // Strips float noise such as 0.30000000000000004 from what is announced and stored.
    return clamp(Number(stepped.toPrecision(12)));
  };

  const position = toPosition(value);
  const emit = (v: number, transient: boolean) => onChange(v, { transient });
  const end = () => {
    drag.current = null;
    onGestureEnd?.();
    setShowing(false);
  };

  const nudge = (direction: number, multiplier: number) => {
    if (step && !log) emit(clamp(value + direction * step * multiplier), true);
    else emit(fromPosition(position + direction * ARROW_TRAVEL * multiplier), true);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-1, 1],
      ArrowDown: [-1, 1],
      ArrowRight: [1, 1],
      ArrowUp: [1, 1],
      PageUp: [1, PAGE_MULTIPLIER],
      PageDown: [-1, PAGE_MULTIPLIER],
    };
    if (e.key in moves) {
      e.preventDefault();
      nudge(...moves[e.key]);
    } else if (e.key === "Home") {
      e.preventDefault();
      emit(min, true);
    } else if (e.key === "End") {
      e.preventDefault();
      emit(max, true);
    } else if (e.key === "Delete" || extraResetKeys.includes(e.key)) {
      e.preventDefault();
      emit(defaultValue, false);
    }
  }

  const readout = (formatReadout ?? format)(value);

  return (
    <span className="relative inline-flex">
      <span
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation={size === "md" ? "vertical" : "horizontal"}
        aria-describedby={describedBy}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        aria-keyshortcuts="Delete"
        title={title}
        onKeyDown={onKeyDown}
        onKeyUp={onGestureEnd}
        onFocus={() => setShowing(true)}
        onBlur={end}
        onDoubleClick={() => emit(defaultValue, false)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, start: position };
          onGestureStart?.();
          setShowing(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const perPx = TRAVEL_PER_PX * (e.shiftKey ? FINE_FACTOR : 1);
          // Either axis works because users reach for both; up and right both raise the value.
          const next = fromPosition(d.start + (e.clientX - d.x - (e.clientY - d.y)) * perPx);
          const snapped =
            snap && Math.abs(next - snap.value) <= snap.within ? snap.value : next;
          emit(snapped, true);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        className={`relative inline-flex ${className ?? DEFAULT_SIZES[size]} cursor-ns-resize touch-none items-center justify-center rounded-full border border-zinc-400 bg-white dark:border-zinc-600 dark:bg-zinc-900 ${focusRing}`}
      >
        {size === "md" ? (
          <DialFace
            position={position}
            defaultPosition={toPosition(defaultValue)}
            bipolar={bipolar}
            muted={muted}
          />
        ) : (
          <>
            {bipolar && <span aria-hidden="true" className="absolute top-0 h-1 w-px bg-zinc-400" />}
            <span
              aria-hidden="true"
              className="absolute inset-0"
              style={{ transform: `rotate(${(position - 0.5) * 2 * MAX_ANGLE}deg)` }}
            >
              <span className="absolute top-0.5 left-1/2 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-indigo-600 dark:bg-indigo-400" />
            </span>
          </>
        )}
      </span>
      {showing && (
        <output className="pointer-events-none absolute -top-7 left-1/2 z-50 -translate-x-1/2 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900">
          {readout}
        </output>
      )}
    </span>
  );
}
