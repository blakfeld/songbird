import type { LoopRange } from "./audio/types";

// A null region means none has been drawn, which is the default; looping with no region loops the
// whole length, so the two halves are kept apart rather than encoding "whole" as a region.
export interface LoopSetting {
  region: LoopRange | null;
  enabled: boolean;
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);

// Stored or computed values can be fractional or non-finite, and every consumer assumes whole measures.
const whole = (n: number, fallback: number) =>
  Number.isFinite(n) ? Math.round(n) : fallback;

export function defaultLoop(): LoopSetting {
  return { region: null, enabled: false };
}

// The engine treats a null range as the whole length, so "no region" needs no length here.
export function playRange(loop: LoopSetting): LoopRange | null {
  return loop.region;
}

// A drawn region is always a deliberate choice, so a length change only clamps it and never grows it.
export function clampLoop(loop: LoopSetting, measures: number): LoopSetting {
  if (!loop.region) return loop;
  const max = Math.max(1, measures);
  const end = clamp(whole(loop.region.end, max), 1, max);
  const start = clamp(whole(loop.region.start, 1), 1, end);
  if (start === loop.region.start && end === loop.region.end) return loop;
  return { ...loop, region: { start, end } };
}

export function drawRegion(a: number, b: number, measures?: number): LoopRange {
  const max = measures === undefined ? Infinity : Math.max(1, measures);
  const x = clamp(whole(a, 1), 1, max);
  const y = clamp(whole(b, 1), 1, max);
  return { start: Math.min(x, y), end: Math.max(x, y) };
}

// The length is preserved at the bounds so a move past the end slides the region to rest against it.
export function moveRegion(region: LoopRange, delta: number, measures: number): LoopRange {
  const length = region.end - region.start;
  const max = Math.max(1, measures);
  const start = clamp(region.start + whole(delta, 0), 1, Math.max(1, max - length));
  return { start, end: start + length };
}

export function resizeStart(region: LoopRange, start: number, measures: number): LoopRange {
  const end = Math.min(region.end, Math.max(1, measures));
  return { start: clamp(whole(start, region.start), 1, end), end };
}

export function resizeEnd(region: LoopRange, end: number, measures: number): LoopRange {
  const max = Math.max(1, measures);
  const start = Math.min(region.start, max);
  return { start, end: clamp(whole(end, region.end), start, max) };
}

const isWhole = (v: unknown): v is number => Number.isInteger(v);

// Stored documents are untrusted and older builds wrote a flat shape, so anything that is not
// exactly a LoopSetting falls back to the default rather than half-applying.
export function parseLoop(raw: unknown): LoopSetting {
  if (typeof raw !== "object" || raw === null) return defaultLoop();
  const { region, enabled } = raw as Record<string, unknown>;
  if (typeof enabled !== "boolean") return defaultLoop();
  if (region === null) return { region: null, enabled };
  if (typeof region !== "object" || region === undefined) return defaultLoop();
  const { start, end } = region as Record<string, unknown>;
  if (!isWhole(start) || !isWhole(end) || start < 1 || end < start) return defaultLoop();
  return { region: { start, end }, enabled };
}
