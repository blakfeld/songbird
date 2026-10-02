"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing } from "@/components/ui/classes";
import { loadInputChoice, type InputChoice } from "@/lib/audio/recorder/inputPrefs";
import type { InputEnvironment, TrackInputView } from "@/lib/audio/recorder/trackInput";
import { useRecordingOverlay } from "@/lib/song/songStore";
import { useStoredValue } from "@/lib/useStoredValue";
import type { Track } from "@/lib/song/types";
import { useAudioInput, useInputEnvironment, useTrackInputView, type AudioInputContextValue } from "./AudioInputContext";
import { AudioInputPopover } from "./AudioInputPopover";
import { ClipIndicator, InputMeter } from "./InputMeter";
import { MONITOR_WARNED_KEY, MonitorWarningDialog } from "./MonitorWarningDialog";

const triggerClass = `inline-flex h-7 min-w-0 max-w-28 items-center gap-1 rounded border border-zinc-300 bg-white px-1.5 text-xs text-zinc-700 hover:bg-zinc-100 aria-expanded:border-zinc-900 aria-expanded:bg-zinc-200 aria-expanded:inset-ring-1 aria-expanded:inset-ring-zinc-900 pointer-coarse:h-9 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:aria-expanded:border-zinc-100 dark:aria-expanded:bg-zinc-800 dark:aria-expanded:inset-ring-zinc-100 ${focusRing}`;
const toggleClass = `relative inline-flex size-7 shrink-0 items-center justify-center rounded text-xs font-bold pointer-coarse:size-9 ${focusRing}`;
const toggleOff =
  "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800";

interface TriggerState {
  label: string;
  name: string;
  busy?: boolean;
  glyph?: "blocked" | "none";
  amber?: boolean;
  // Whether there is an input to meter or monitor; otherwise the trigger takes the freed width.
  usable: boolean;
}

// One place maps the three sources of truth (browser permission, the device list, what the stream said) to the
// cues in the design, so the trigger, the meter and Monitor can never disagree about what is wrong.
export function describeInput(
  trackName: string,
  env: InputEnvironment,
  view: TrackInputView,
  choice: InputChoice,
): TriggerState {
  const prefix = `Input for ${trackName}`;
  if (env.permission === "unavailable") return { label: "Unavailable", name: `${prefix}: recording not supported`, glyph: "blocked", usable: false };
  if (env.permission === "denied" || view.status === "denied")
    return { label: "Blocked", name: `${prefix}: microphone blocked`, glyph: "blocked", usable: false };
  if (view.status === "asking") return { label: "Allow mic", name: `${prefix}: waiting for permission`, busy: true, usable: false };
  if (view.status === "no-input" || (env.permission === "granted" && env.devices !== null && env.devices.length === 0))
    return { label: "No input", name: `${prefix}: no input found`, glyph: "none", usable: false };
  if (env.permission !== "granted" && view.status !== "ready")
    return { label: "Allow mic", name: `${prefix}: allow microphone`, usable: false };
  const channels = choice.channels === 2 ? "stereo" : "mono";
  const present = env.devices?.find((d) => d.deviceId === choice.deviceId);
  if (choice.deviceId && (view.fellBack || (env.devices !== null && !present))) {
    return {
      label: "Default",
      name: `${prefix}: default input (${choice.label ?? "remembered input"} not connected)`,
      amber: true,
      usable: true,
    };
  }
  if (present) return { label: present.label, name: `${prefix}: ${present.label}, ${channels}`, usable: true };
  return { label: "Default", name: `${prefix}: default input, ${channels}`, usable: true };
}

export function AudioInputRow({ track, selected, audible }: { track: Track; selected: boolean; audible: boolean }) {
  const ctx = useAudioInput();
  if (!ctx) return null;
  return <Row ctx={ctx} track={track} selected={selected} audible={audible} />;
}

function Row({
  ctx,
  track,
  selected,
  audible,
}: {
  ctx: AudioInputContextValue;
  track: Track;
  selected: boolean;
  audible: boolean;
}) {
  const { owner, engine, announce } = ctx;
  const env = useInputEnvironment(owner);
  const view = useTrackInputView(owner, track.id);
  const [choice, setChoice] = useState(() => loadInputChoice(track.id));
  const recording = useRecordingOverlay(ctx.store, track.id) !== null;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const [monitoring, setMonitoring] = useState(false);
  const [warning, setWarning] = useState(false);
  const [warned, setWarned] = useStoredValue(MONITOR_WARNED_KEY, false, (raw) => raw === "true");
  const trigger = useRef<HTMLButtonElement>(null);
  const monitor = useRef<HTMLButtonElement>(null);
  const triggerId = useId();

  const state = describeInput(track.name, env, view, choice);
  const unavailable = !state.usable && state.label !== "Allow mic";
  const meterOn = state.usable || view.status === "ready";

  const openPopover = () => {
    const rect = trigger.current?.getBoundingClientRect();
    setAnchor({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
    setOpen(true);
  };

  // The page asks for this when Record is refused for a blocked or missing input, so the explanation is in view.
  const request = ctx.popoverRequest;
  useEffect(() => {
    if (!request || request.trackId !== track.id) return;
    openPopover();
    trigger.current?.focus();
    // Keyed on the nonce so the same request is never replayed by an unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce, request?.trackId, track.id]);

  // The meter is live for the selected track without prompting, since a prompt on selection would be a surprise.
  useEffect(() => {
    if (!selected || env.permission !== "granted") return;
    void owner.acquire(engine, track.id, "meter");
    return () => owner.drop(track.id, "meter");
  }, [owner, engine, track.id, selected, env.permission]);

  // Opening the popover is what first asks for the microphone.
  useEffect(() => {
    if (!open) return;
    void owner.acquire(engine, track.id, "popover");
    return () => owner.drop(track.id, "popover");
  }, [owner, engine, track.id, open]);

  useEffect(() => {
    if (!monitoring) return;
    let live = true;
    void owner.acquire(engine, track.id, "monitor").then((result) => {
      if (live && "reason" in result) {
        setMonitoring(false);
        openPopover();
      }
    });
    return () => {
      live = false;
      engine.setMonitoring(track.id, false);
      owner.drop(track.id, "monitor");
    };
  }, [owner, engine, track.id, monitoring]);

  // A new device or channel count makes a new source, which monitoring has to be pointed at again.
  useEffect(() => {
    if (!monitoring || view.status !== "ready") return;
    const source = owner.source(track.id);
    if (source) engine.setMonitoring(track.id, true, source);
  }, [owner, engine, track.id, monitoring, view.status, view.revision]);

  const toggleMonitor = () => {
    if (monitoring) return setMonitoring(false);
    if (unavailable) return openPopover();
    if (!warned) return setWarning(true);
    setMonitoring(true);
  };

  const choose = (next: InputChoice) => {
    if (recording) return;
    setChoice(next);
    void owner.setChoice(engine, track.id, next);
  };

  return (
    <div className="flex min-w-0 items-center gap-2 pl-12 max-md:pl-0">
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        aria-label={state.name}
        title={state.name}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={state.busy || undefined}
        onClick={() => (open ? setOpen(false) : openPopover())}
        className={`${triggerClass} ${meterOn ? "" : "flex-1"}`}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 shrink-0 fill-none stroke-current" strokeWidth="1.5">
          <rect x="7" y="2" width="6" height="10" rx="3" />
          <path d="M4 9a6 6 0 0 0 12 0M10 15v3" />
        </svg>
        <span className="truncate max-md:hidden">{state.label}</span>
        {state.busy && <Spinner />}
        {state.glyph && (
          <span aria-hidden="true" className="text-red-700 dark:text-red-300">
            ⊘
          </span>
        )}
        {state.amber && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-amber-500" />}
        <span aria-hidden="true">▾</span>
      </button>
      {meterOn && (
        <>
          <InputMeter owner={owner} trackId={track.id} trackName={track.name} size="sm" />
          <ClipIndicator owner={owner} trackId={track.id} trackName={track.name} onAnnounce={announce} />
        </>
      )}
      <button
        ref={monitor}
        type="button"
        aria-label={`Monitor ${track.name}`}
        aria-pressed={monitoring}
        aria-disabled={unavailable || undefined}
        aria-describedby={unavailable ? triggerId : undefined}
        title={monitoring && !audible ? "Monitor: silenced by Mute" : "Monitor: hear your input through this track's effects"}
        onClick={toggleMonitor}
        className={`${toggleClass} ${
          monitoring ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950" : toggleOff
        } ${monitoring && !audible ? "opacity-60" : ""}`}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 fill-none stroke-current" strokeWidth="1.5">
          <path d="M3 12V10a7 7 0 0 1 14 0v2" />
          <rect x="2.5" y="11.5" width="3.5" height="6" rx="1" className="fill-current" />
          <rect x="14" y="11.5" width="3.5" height="6" rx="1" className="fill-current" />
        </svg>
      </button>
      <AudioInputPopover
        open={open}
        anchor={anchor}
        trackId={track.id}
        trackName={track.name}
        owner={owner}
        env={env}
        view={view}
        choice={choice}
        onChoice={choose}
        locked={recording}
        onRetry={() => {
          // Browsers that allow a re-ask do so on this request; the rest just report the denial again.
          void owner.refresh().then(() => owner.acquire(engine, track.id, "popover"));
        }}
        onClose={() => setOpen(false)}
        returnFocusTo={() => trigger.current}
        anchorElement={() => trigger.current}
        onAnnounce={announce}
      />
      <MonitorWarningDialog
        open={warning}
        onCancel={() => {
          setWarning(false);
          monitor.current?.focus();
        }}
        onConfirm={() => {
          setWarned(true);
          setWarning(false);
          setMonitoring(true);
          monitor.current?.focus();
        }}
      />
    </div>
  );
}
