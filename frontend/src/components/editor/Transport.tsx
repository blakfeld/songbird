"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { Playback } from "@/lib/audio/types";
import type { LoopSetting } from "@/lib/loopRegion";
import { ErrorAlert } from "./ErrorAlert";

interface Props {
  playback: Playback;
  onToggle: () => void;
  stepsPerMeasure: number;
  beatSteps: number;
  loop: LoopSetting;
  onLoopChange: (loop: LoopSetting) => void;
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
  stepsPerMeasure,
  beatSteps,
  loop,
  onLoopChange,
  follow,
  onFollowChange,
}: Props) {
  const id = useId();
  const loading = playback.status === "loading";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
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
          <Button
            aria-pressed={loop.enabled}
            aria-label="Loop playback"
            title="Loop playback"
            onClick={() => onLoopChange({ ...loop, enabled: !loop.enabled })}
            className="min-w-20 aria-pressed:border-zinc-900 aria-pressed:bg-zinc-200 aria-pressed:inset-ring-1 aria-pressed:inset-ring-zinc-900 aria-pressed:hover:bg-zinc-300 dark:aria-pressed:border-zinc-100 dark:aria-pressed:bg-zinc-800 dark:aria-pressed:inset-ring-zinc-100 dark:aria-pressed:hover:bg-zinc-700"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4 shrink-0"
            >
              <path d="M4 9V7.5A2.5 2.5 0 0 1 6.5 5H15M12.5 2.5 15 5l-2.5 2.5" />
              <path d="M16 11v1.5a2.5 2.5 0 0 1-2.5 2.5H5M7.5 17.5 5 15l2.5-2.5" />
            </svg>
            Loop
          </Button>
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
