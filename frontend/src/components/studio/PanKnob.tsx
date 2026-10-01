"use client";

import { Knob } from "./Knob";

// A short snap zone makes exact center reachable by dragging, where 1% steps would otherwise miss it.
const CENTER_SNAP_PERCENT = 3;

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
  return (
    <Knob
      label={`Pan ${name}`}
      title="Pan. Double-click or press Delete to center."
      value={Math.round(value * 100)}
      min={-100}
      max={100}
      step={1}
      defaultValue={0}
      bipolar
      snap={{ value: 0, within: CENTER_SNAP_PERCENT }}
      extraResetKeys={["Backspace", "0"]}
      format={panText}
      formatReadout={(p) => (p === 0 ? "C" : `${p < 0 ? "L" : "R"}${Math.abs(p)}`)}
      onChange={(percent, o) => onChange(percent / 100, o)}
      onGestureStart={onGestureStart}
      onGestureEnd={onGestureEnd}
    />
  );
}
