"use client";

import { useId } from "react";
import { DENIED_MIC_TEXT } from "@/components/editor/recordingMessages";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { hintClass, labelClass } from "@/components/ui/classes";
import type { InputChoice } from "@/lib/audio/recorder/inputPrefs";
import type { InputEnvironment, InputOwner, TrackInputView } from "@/lib/audio/recorder/trackInput";
import { AnchoredPopover } from "../AnchoredPopover";
import { ClipIndicator, InputMeter } from "./InputMeter";
import { RecordingOffsetField } from "./RecordingOffsetField";

const optionClass =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900";
const segmentClass =
  "flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-center text-sm peer-checked:border-zinc-900 peer-checked:bg-zinc-200 peer-checked:inset-ring-1 peer-checked:inset-ring-zinc-900 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:opacity-50 dark:border-zinc-700 dark:peer-checked:border-zinc-100 dark:peer-checked:bg-zinc-800 dark:peer-checked:inset-ring-zinc-100 dark:peer-focus-visible:outline-white";

// The browser lists these aliases beside the real devices; choosing one would store a name, not an input.
const isAlias = (id: string) => id === "default" || id === "communications";

export function AudioInputPopover({
  open,
  anchor,
  trackId,
  trackName,
  owner,
  env,
  view,
  choice,
  onChoice,
  locked,
  onRetry,
  onClose,
  returnFocusTo,
  anchorElement,
  onAnnounce,
}: {
  open: boolean;
  anchor: { x: number; y: number };
  trackId: string;
  trackName: string;
  owner: InputOwner;
  env: InputEnvironment;
  view: TrackInputView;
  choice: InputChoice;
  onChoice: (choice: InputChoice) => void;
  // Changing the input would cut the capture of a take that is running, so it waits for the take to end.
  locked: boolean;
  onRetry: () => void;
  onClose: () => void;
  returnFocusTo: () => HTMLElement | null;
  anchorElement: () => HTMLElement | null;
  onAnnounce: (message: string) => void;
}) {
  const id = useId();
  const label = `Input for ${trackName}`;
  const devices = (env.devices ?? []).filter((d) => !isAlias(d.deviceId));
  const system = (env.devices ?? []).find((d) => d.deviceId === "default");
  const systemName = system?.label.replace(/^Default - /, "");
  const remembered = choice.deviceId;
  const missing = remembered !== undefined && env.devices !== null && !devices.some((d) => d.deviceId === remembered);
  const rememberedLabel = choice.label ?? "Remembered input";
  const oneChannel = view.channelCount === 1;

  const body = () => {
    if (env.permission === "unavailable") {
      return (
        <p className="text-sm">
          Recording isn&apos;t supported in this browser. To record, open Songbird in a current version of Chrome, Edge,
          Firefox, or Safari.
        </p>
      );
    }
    if (view.status === "asking") {
      return (
        <p aria-live="polite" className="flex items-start gap-2 text-sm">
          <Spinner />
          <span>Waiting for permission… Your browser is asking to use the microphone. Choose Allow.</span>
        </p>
      );
    }
    if (env.permission === "denied" || view.status === "denied") {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{DENIED_MIC_TEXT}</p>
          <div>
            <Button onClick={onRetry}>Try again</Button>
          </div>
        </div>
      );
    }
    if (view.status === "no-input" || (env.devices !== null && env.devices.length === 0 && env.permission === "granted")) {
      return <p className="text-sm">No microphone or audio interface found. Plug one in and it appears here.</p>;
    }
    return (
      <>
        {view.fellBack && remembered && (
          <p
            role="status"
            className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <span aria-hidden="true">⚠</span>
            <span>
              {rememberedLabel} isn&apos;t connected, so {trackName} is using the default input.
            </span>
          </p>
        )}
        {locked && <p className={hintClass}>Stop recording to change the input.</p>}
        <fieldset className="flex flex-col gap-0.5" disabled={locked}>
          <legend className={`${labelClass} mb-1`}>Device</legend>
          {[
            { deviceId: undefined, name: `Default input${systemName ? ` (${systemName})` : ""}`, absent: false },
            ...devices.map((d) => ({ deviceId: d.deviceId, name: d.label, absent: false })),
            ...(missing ? [{ deviceId: remembered, name: rememberedLabel, absent: true }] : []),
          ].map((o) => (
            <label key={o.deviceId ?? "default"} className={optionClass}>
              <input
                type="radio"
                name={`${id}-device`}
                aria-label={o.name}
                checked={o.deviceId === remembered}
                onChange={() => onChoice({ ...choice, deviceId: o.deviceId, label: o.deviceId ? o.name : undefined })}
                className="size-4 accent-indigo-600"
              />
              <span className="min-w-0 flex-1 truncate">{o.name}</span>
              {o.absent && <span className="shrink-0 text-xs text-zinc-600 dark:text-zinc-400">Not connected</span>}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1" disabled={locked}>
          <legend className={`${labelClass} mb-1`}>Channels</legend>
          <div className="flex gap-2">
            {([1, 2] as const).map((n) => (
              <div key={n} className="relative flex flex-1">
                <input
                  type="radio"
                  id={`${id}-ch-${n}`}
                  name={`${id}-channels`}
                  aria-label={n === 1 ? "Mono" : "Stereo"}
                  aria-describedby={`${id}-channels-${n}`}
                  disabled={n === 2 && oneChannel}
                  checked={choice.channels === n}
                  onChange={() => onChoice({ ...choice, channels: n })}
                  className="peer sr-only"
                />
                <label htmlFor={`${id}-ch-${n}`} className={`${segmentClass} cursor-pointer`}>
                  <span id={`${id}-channels-${n}`}>{n === 1 ? "Mono · input 1" : "Stereo · inputs 1–2"}</span>
                </label>
              </div>
            ))}
          </div>
          {oneChannel && <p className={hintClass}>This input has one channel.</p>}
        </fieldset>
        <div className="flex items-center gap-2">
          <span className={labelClass}>Level</span>
          <InputMeter owner={owner} trackId={trackId} trackName={trackName} size="md" />
          <ClipIndicator owner={owner} trackId={trackId} trackName={trackName} onAnnounce={onAnnounce} />
        </div>
      </>
    );
  };

  return (
    <AnchoredPopover
      open={open}
      anchor={anchor}
      label={label}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      anchorElement={anchorElement}
      panelClassName="w-72 max-w-[calc(100vw-2rem)] p-3"
    >
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{label}</h2>
        {body()}
        <div role="separator" className="border-t border-zinc-200 dark:border-zinc-800" />
        <RecordingOffsetField />
        <p className={hintClass}>Saved in this browser only. Plug in a microphone or interface and it appears here.</p>
      </div>
    </AnchoredPopover>
  );
}
