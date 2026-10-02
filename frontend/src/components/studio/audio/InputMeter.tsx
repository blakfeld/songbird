"use client";

import { useEffect, useRef, useState } from "react";
import { focusRing } from "@/components/ui/classes";
import type { InputOwner } from "@/lib/audio/recorder/trackInput";
import { useTrackInputView } from "./AudioInputContext";

const DB_MIN = -60;
const HOLD_MS = 1500;
// Announcing every value would drown a screen reader, and four a second is enough to follow a level.
const ARIA_MS = 250;

const toDb = (peak: number) => (peak <= 0 ? -Infinity : 20 * Math.log10(peak));
const percent = (db: number) => Math.min(100, Math.max(0, ((db - DB_MIN) / -DB_MIN) * 100));

// The colour zones are a hint on top of the fill's length, which is what carries the level.
const zoneClass = (db: number) =>
  db >= -0.1
    ? "bg-red-600 dark:bg-red-500"
    : db >= -6
      ? "bg-amber-400"
      : "bg-indigo-600 dark:bg-indigo-400";

const spoken = (db: number) => (db <= DB_MIN ? "silent" : `minus ${Math.round(-db)} decibels`);

export function InputMeter({
  owner,
  trackId,
  trackName,
  size,
}: {
  owner: InputOwner;
  trackId: string;
  trackName: string;
  size: "sm" | "md";
}) {
  const view = useTrackInputView(owner, trackId);
  const live = view.status === "ready";
  const track = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);

  // Written through refs because peaks arrive about 30 times a second, and a React render for each would cost far
  // more than the meter is worth.
  useEffect(() => {
    const bar = fill.current;
    const peakLine = hold.current;
    const meter = track.current;
    if (!bar || !peakLine || !meter) return;
    const reset = () => {
      bar.style.width = "0%";
      peakLine.style.left = "0%";
      meter.setAttribute("aria-valuenow", String(DB_MIN));
      meter.setAttribute("aria-valuetext", "silent");
    };
    reset();
    const tap = live ? owner.tap(trackId) : null;
    if (!tap) return;
    let holdLevel = 0;
    let holdUntil = 0;
    let lastAria = 0;
    let lastZone = "";
    const off = tap.subscribePeaks(({ peak }) => {
      const db = toDb(peak);
      const pct = percent(db);
      bar.style.width = `${pct}%`;
      const zone = zoneClass(db);
      if (zone !== lastZone) {
        bar.className = `absolute inset-y-0 left-0 ${zone}`;
        lastZone = zone;
      }
      const now = performance.now();
      if (pct >= holdLevel || now > holdUntil) {
        holdLevel = pct;
        holdUntil = now + HOLD_MS;
        peakLine.style.left = `calc(${pct}% - 2px)`;
      }
      if (now - lastAria > ARIA_MS) {
        lastAria = now;
        meter.setAttribute("aria-valuenow", String(Math.max(DB_MIN, Math.round(db))));
        meter.setAttribute("aria-valuetext", spoken(db));
      }
    });
    return () => {
      off();
      reset();
    };
  }, [owner, trackId, live, view.revision]);

  return (
    <div
      ref={track}
      role="meter"
      aria-label={`${trackName} input level`}
      aria-valuemin={DB_MIN}
      aria-valuemax={0}
      // Constant so React never rewrites what the peak handler sets by hand.
      aria-valuenow={DB_MIN}
      aria-valuetext="silent"
      title={live ? undefined : `Select ${trackName} to see its input level`}
      className={`relative min-w-10 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 ${
        size === "md" ? "h-3" : "h-2"
      } ${live ? "" : "opacity-40"}`}
    >
      <div ref={fill} className="absolute inset-y-0 left-0 bg-indigo-600 dark:bg-indigo-400" style={{ width: 0 }} />
      {[-18, -6].map((db) => (
        <div
          key={db}
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-zinc-900/30 dark:bg-zinc-50/30"
          style={{ left: `${percent(db)}%` }}
        />
      ))}
      <div ref={hold} aria-hidden="true" className="absolute inset-y-0 w-0.5 bg-zinc-900 dark:bg-zinc-50" style={{ left: 0 }} />
    </div>
  );
}

export function ClipIndicator({
  owner,
  trackId,
  trackName,
  onAnnounce,
}: {
  owner: InputOwner;
  trackId: string;
  trackName: string;
  onAnnounce: (message: string) => void;
}) {
  const lit = useTrackInputView(owner, trackId).clipped;
  const [focused, setFocused] = useState(false);
  const was = useRef(lit);
  useEffect(() => {
    // Only the change to lit is news; saying it on every overload would repeat it for as long as the clip lasts.
    if (lit && !was.current) onAnnounce(`${trackName} input clipped. Turn down the gain on your microphone or interface.`);
    was.current = lit;
  }, [lit, trackName, onAnnounce]);

  return (
    <button
      type="button"
      aria-label={`Clear clip indicator for ${trackName}`}
      aria-disabled={!lit}
      data-clipped={lit ? "true" : undefined}
      title={lit ? "Input clipped. Click to clear." : undefined}
      // Staying tabbable while focused means clearing the light never drops the focus it was cleared with.
      tabIndex={lit || focused ? 0 : -1}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={() => {
        if (lit) owner.clearClip(trackId);
      }}
      className={`inline-flex h-7 w-6 shrink-0 items-center justify-center rounded pointer-coarse:h-9 ${focusRing}`}
    >
      <span
        aria-hidden="true"
        className={`h-3 w-2 rounded-sm ${
          lit ? "bg-red-600 dark:bg-red-500" : "border border-zinc-400 dark:border-zinc-600"
        }`}
      />
    </button>
  );
}
