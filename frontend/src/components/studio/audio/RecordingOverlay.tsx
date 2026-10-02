"use client";

import { useEffect, useRef } from "react";
import { TICKS_PER_SECOND_PER_BPM, TICKS_PER_SIXTEENTH } from "@/lib/song/audioTiming";
import type { RecordingOverlay as Overlay } from "@/lib/recording/recordingOverlay";
import { useRecordingOverlay } from "@/lib/song/songStore";
import { useAudioInput } from "./AudioInputContext";

// The worklet posts about this many peaks a second, so the count is also the elapsed time on the audio clock the
// take is cut on, without asking the page for a playhead.
const PEAKS_PER_SECOND = 30;

const cells = (ticks: number) => ticks / TICKS_PER_SIXTEENTH;

// Draws a mirrored envelope from the peaks seen so far.
function envelope(values: readonly number[]) {
  if (values.length === 0) return "";
  const top = values.map((p, i) => `${i === 0 ? "M" : "L"}${i} ${-Math.min(1, p)}`);
  const bottom = values.map((p, i) => `L${values.length - 1 - i} ${Math.min(1, values[values.length - 1 - i])}`);
  return `${top.join("")}${bottom.join("")}Z`;
}

function OverlayView({ overlay, tempoBpm }: { overlay: Overlay; tempoBpm: number }) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const path = useRef<SVGPathElement>(null);
  const started = overlay.started;

  // Appended through refs on animation frames, which also coalesces the 30 Hz posts, since a React render per peak
  // would redraw the whole lane for a sliver of waveform.
  useEffect(() => {
    if (!started) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const n = overlay.peaks.values.length;
      const ticks = (n / PEAKS_PER_SECOND) * TICKS_PER_SECOND_PER_BPM * tempoBpm;
      if (box.current) box.current.style.width = `calc(var(--cell-w) * ${cells(ticks)} - 1px)`;
      svg.current?.setAttribute("viewBox", `0 -1 ${Math.max(n, 1)} 2`);
      path.current?.setAttribute("d", envelope(overlay.peaks.values));
    };
    const off = overlay.peaks.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(draw);
    });
    draw();
    return () => {
      off();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [overlay, tempoBpm, started]);

  const left = `calc(var(--cell-w) * ${cells(overlay.startTicks ?? 0)})`;
  if (!started) {
    // Only where the take will land, since nothing is being recorded during the count-in.
    return (
      <div
        aria-hidden="true"
        data-testid="recording-start"
        style={{ left }}
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-600 dark:bg-red-400"
      />
    );
  }
  return (
    <div
      ref={box}
      aria-hidden="true"
      data-testid="recording-overlay"
      style={{ left, width: 0 }}
      className="pointer-events-none absolute top-1 bottom-1 z-10 overflow-hidden rounded-md border border-red-600 bg-red-50/90 dark:border-red-400 dark:bg-red-950/70"
    >
      <div className="absolute inset-x-0 top-0 flex h-4 items-center gap-1 px-2 text-[11px] leading-4 font-medium text-red-800 dark:text-red-200">
        <span className="size-1.5 shrink-0 rounded-full bg-red-600 motion-safe:animate-pulse dark:bg-red-400" />
        <span className="truncate">
          Recording · {overlay.takeName.replace(/^.* (Take \d+)$/, "$1")}
          {overlay.pass > 1 ? ` · pass ${overlay.pass}` : ""}
        </span>
      </div>
      <svg
        ref={svg}
        viewBox="0 -1 1 2"
        preserveAspectRatio="none"
        className="absolute inset-x-0 top-4 bottom-0.5 h-[calc(100%-1.125rem)] w-full"
      >
        <path ref={path} className="fill-red-600/70 dark:fill-red-400/70" />
      </svg>
    </div>
  );
}

// Present only while a take is being recorded onto this track, and absent without the recording context.
export function LaneRecording({ trackId, tempoBpm }: { trackId: string; tempoBpm: number }) {
  const ctx = useAudioInput();
  if (!ctx) return null;
  return <LaneOverlay store={ctx.store} trackId={trackId} tempoBpm={tempoBpm} />;
}

function LaneOverlay({
  store,
  trackId,
  tempoBpm,
}: {
  store: NonNullable<ReturnType<typeof useAudioInput>>["store"];
  trackId: string;
  tempoBpm: number;
}) {
  const overlay = useRecordingOverlay(store, trackId);
  return overlay && overlay.startTicks !== null ? <OverlayView overlay={overlay} tempoBpm={tempoBpm} /> : null;
}
