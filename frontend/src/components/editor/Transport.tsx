"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { Playback } from "@/lib/audio/types";
import type { LoopSetting } from "@/lib/loopRegion";
import type { MidiAccess } from "@/lib/midi/access";
import { useMetronomeSettings } from "@/lib/audio/useMetronomeSettings";
import { ErrorAlert } from "./ErrorAlert";
import { MidiInputControl } from "./MidiInputControl";
import { COUNT_IN_CANCELLED, COUNT_IN_STARTED } from "./recordingMessages";
import { useRecordControl, type RecordingState } from "./useRecordControl";

// Shared so the transport's on/off toggles read as one family.
const toggleClass =
  "sm:min-w-20 aria-pressed:border-zinc-900 aria-pressed:bg-zinc-200 aria-pressed:inset-ring-1 aria-pressed:inset-ring-zinc-900 aria-pressed:hover:bg-zinc-300 dark:aria-pressed:border-zinc-100 dark:aria-pressed:bg-zinc-800 dark:aria-pressed:inset-ring-zinc-100 dark:aria-pressed:hover:bg-zinc-700";

const recordClass =
  "min-w-32 aria-pressed:border-red-600 aria-pressed:bg-red-50 aria-pressed:text-red-700 aria-pressed:inset-ring-1 aria-pressed:inset-ring-red-600 aria-pressed:hover:bg-red-100 dark:aria-pressed:border-red-400 dark:aria-pressed:bg-red-950/40 dark:aria-pressed:text-red-300 dark:aria-pressed:inset-ring-red-400 dark:aria-pressed:hover:bg-red-950/60 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-white dark:aria-disabled:hover:bg-zinc-950";

const iconClass = "size-4 shrink-0";

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={iconClass}
    >
      {children}
    </svg>
  );
}

interface Props {
  playback: Playback;
  onToggle: () => void;
  stepsPerMeasure: number;
  beatSteps: number;
  loop: LoopSetting;
  onLoopChange: (loop: LoopSetting) => void;
  follow: boolean;
  onFollowChange: (v: boolean) => void;
  // Owned by the page's recording orchestration; Transport only reflects and requests it.
  recording?: RecordingState;
  // One handler for every state so the Record button and the R key cannot disagree about what a press means.
  onRecordToggle?: () => void;
  subscribeCountIn?: (cb: (beatsLeft: number | null) => void) => () => void;
  onAnnounce?: (msg: string) => void;
  // Injectable so tests can drive a fake; defaults to the shared browser singleton.
  midi?: MidiAccess;
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
  recording = "idle",
  onRecordToggle,
  subscribeCountIn,
  onAnnounce,
  midi,
}: Props) {
  const id = useId();
  const loading = playback.status === "loading";
  const { metronome, countIn, setMetronome, setCountIn } = useMetronomeSettings();
  const { reason, toggleRecord } = useRecordControl({
    playback,
    recording,
    onRecordToggle,
    onAnnounce,
    midi,
  });
  const counting = recording === "counting-in";
  const armed = recording !== "idle";
  const [beatsLeft, setBeatsLeft] = useState<number | null>(null);

  useEffect(() => subscribeCountIn?.(setBeatsLeft), [subscribeCountIn]);

  const prevRecording = useRef(recording);
  useEffect(() => {
    const prev = prevRecording.current;
    prevRecording.current = recording;
    if (prev === recording) return;
    if (recording === "counting-in") onAnnounce?.(COUNT_IN_STARTED);
    else if (prev === "counting-in" && recording === "idle") onAnnounce?.(COUNT_IN_CANCELLED);
  }, [recording, onAnnounce]);

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
            ) : playback.isPlaying || counting ? (
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
            className={toggleClass}
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
            <span className="max-sm:sr-only">Loop</span>
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
        <div className="flex items-center gap-2">
          <Button
            aria-pressed={armed}
            aria-disabled={reason ? true : undefined}
            aria-describedby={reason ? `${id}-record-reason` : undefined}
            aria-keyshortcuts="R"
            aria-label="Record"
            title={reason ?? "Record (R)"}
            onClick={toggleRecord}
            className={recordClass}
          >
            <span
              aria-hidden="true"
              className={`size-2.5 shrink-0 rounded-full bg-red-600 dark:bg-red-500 ${recording === "recording" ? "motion-safe:animate-pulse" : ""}`}
            />
            {recording === "recording" ? "Recording" : "Record"}
          </Button>
          {reason && (
            <span id={`${id}-record-reason`} className="sr-only">
              {reason}
            </span>
          )}
          <Button
            aria-pressed={countIn}
            aria-label="Count-in"
            title="Count-in: one bar of clicks before recording from stopped"
            onClick={() => setCountIn(!countIn)}
            className={toggleClass}
          >
            <Icon>
              <circle cx="10" cy="11" r="6" />
              <path d="M10 11V8M8 2.5h4M10 2.5V5" />
            </Icon>
            <span className="max-sm:sr-only">Count-in</span>
          </Button>
          <Button
            aria-pressed={metronome}
            aria-label="Metronome"
            title="Metronome: click on every beat"
            onClick={() => setMetronome(!metronome)}
            className={toggleClass}
          >
            <Icon>
              <path d="M7.5 3h5l3 14h-11z" />
              <path d="M10 13l4-8" />
            </Icon>
            <span className="max-sm:sr-only">Metronome</span>
          </Button>
        </div>
        <MidiInputControl midi={midi} onAnnounce={onAnnounce} />
        <div className="min-w-28">
          {beatsLeft !== null ? (
            <span
              aria-hidden="true"
              className="inline-flex min-w-28 items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Count-in
              <span className="inline-flex size-7 items-center justify-center rounded-full bg-red-50 font-mono text-base font-semibold tabular-nums text-red-700 inset-ring-1 inset-ring-red-600 dark:bg-red-950/40 dark:text-red-300 dark:inset-ring-red-400">
                {beatsLeft}
              </span>
            </span>
          ) : (
            <PositionReadout
              subscribePosition={playback.subscribePosition}
              stepsPerMeasure={stepsPerMeasure}
              beatSteps={beatSteps}
            />
          )}
        </div>
      </div>
      {playback.status === "error" && (
        <ErrorAlert message="Couldn't start audio. Check your browser allows sound, then try again." />
      )}
    </div>
  );
}
