"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import type { LoopRange, Playback } from "@/lib/audio/types";
import { ErrorAlert } from "./ErrorAlert";

interface Props {
  playback: Playback;
  onToggle: () => void;
  measures: number;
  stepsPerMeasure: number;
  beatSteps: number;
  loop: LoopRange;
  onLoopChange: (r: LoopRange) => void;
  follow: boolean;
  onFollowChange: (v: boolean) => void;
}

function PositionReadout({
  subscribePosition,
  stepsPerMeasure,
  beatSteps,
}: Pick<Props, "stepsPerMeasure" | "beatSteps"> & { subscribePosition: Playback["subscribePosition"] }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let lastBeat = -1;
    return subscribePosition((step) => {
      const el = ref.current;
      if (!el) return;
      if (step === null) {
        lastBeat = -1;
        el.textContent = "";
        return;
      }
      // Beat granularity keeps DOM writes to a few per second.
      const beat = Math.floor(step / beatSteps);
      if (beat === lastBeat) return;
      lastBeat = beat;
      const bar = Math.floor(step / stepsPerMeasure) + 1;
      const inBar = Math.floor((step % stepsPerMeasure) / beatSteps) + 1;
      el.textContent = `Bar ${bar} · Beat ${inBar}`;
    });
  }, [subscribePosition, stepsPerMeasure, beatSteps]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="min-w-28 font-mono text-sm tabular-nums text-zinc-600 dark:text-zinc-400"
    />
  );
}

export function Transport({
  playback,
  onToggle,
  measures,
  stepsPerMeasure,
  beatSteps,
  loop,
  onLoopChange,
  follow,
  onFollowChange,
}: Props) {
  const id = useId();
  const loading = playback.status === "loading";
  const numbers = Array.from({ length: measures }, (_, i) => i + 1);
  const whole = loop.start === 1 && loop.end === measures;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Button
          variant="primary"
          className="min-w-24"
          disabled={loading}
          aria-keyshortcuts="Space"
          onClick={onToggle}
        >
          {loading ? (
            <>
              <Spinner />
              Loading sounds…
            </>
          ) : playback.isPlaying ? (
            <>
              <span aria-hidden="true">■</span>Stop
            </>
          ) : (
            <>
              <span aria-hidden="true">▶</span>Play
            </>
          )}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Loop measures</span>
          <Select
            aria-label="Loop start measure"
            value={loop.start}
            onChange={(e) => {
              const start = Number(e.target.value);
              onLoopChange({ start, end: Math.max(start, loop.end) });
            }}
          >
            {numbers.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <span className="text-sm text-zinc-600 dark:text-zinc-400">to</span>
          <Select
            aria-label="Loop end measure"
            value={loop.end}
            onChange={(e) => onLoopChange({ start: loop.start, end: Number(e.target.value) })}
          >
            {numbers
              .filter((n) => n >= loop.start)
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </Select>
          {!whole && (
            <Button onClick={() => onLoopChange({ start: 1, end: measures })}>Loop whole pattern</Button>
          )}
        </div>
        <label htmlFor={`${id}-follow`} className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          <input
            id={`${id}-follow`}
            type="checkbox"
            checked={follow}
            onChange={(e) => onFollowChange(e.target.checked)}
            className="size-4 accent-indigo-600"
          />
          Follow playhead
        </label>
        <PositionReadout
          subscribePosition={playback.subscribePosition}
          stepsPerMeasure={stepsPerMeasure}
          beatSteps={beatSteps}
        />
      </div>
      {playback.status === "error" && (
        <ErrorAlert message="Couldn't start audio. Check your browser allows sound, then try again." />
      )}
    </div>
  );
}
