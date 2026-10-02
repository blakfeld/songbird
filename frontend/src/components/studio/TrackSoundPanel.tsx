"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { DelayEffect } from "@/generated/DelayEffect";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Effects } from "@/generated/Effects";
import type { Tone } from "@/generated/Tone";
import type { Track } from "@/generated/Track";
import { focusRing, hintClass } from "@/components/ui/classes";
import { usesDrumTone } from "@/lib/song/sampler";
import { EFFECT_DEFAULTS, isSoundCustomized, toneDefaults } from "@/lib/song/soundDefaults";
import type { SoundPatch } from "@/lib/song/songOps";
import { DELAY_TIMES, SOUND_RANGES } from "@/lib/song/trackSound";
import { Knob } from "./Knob";

const MINUS = "−";
const signed = (n: number, text: string) => (n > 0 ? `+${text}` : n < 0 ? `${MINUS}${text.replace("-", "")}` : text);

const hz = (v: number) =>
  v < 1000 ? `${Math.round(v)} Hz` : v < 10000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v / 1000)} kHz`;
const percent = (v: number) => `${Math.round(v * 100)}%`;
const seconds = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
export const semitones = (v: number) => `${signed(v, String(Math.abs(v)))} st`;
export const decibels = (v: number) => `${signed(v, Math.abs(v) % 1 === 0 && v === 0 ? "0" : Math.abs(v).toFixed(1))} dB`;
const rate = (v: number) => `${Number(v.toFixed(1))} Hz`;

// Screen readers drop the minus glyph and the abbreviations, so the spoken text is spelled out.
export const spokenSemitones = (v: number) =>
  `${v < 0 ? "minus " : v > 0 ? "plus " : ""}${Math.abs(v)} semitone${Math.abs(v) === 1 ? "" : "s"}`;
export const spokenDecibels = (v: number) =>
  `${v < 0 ? "minus " : v > 0 ? "plus " : ""}${Number(Math.abs(v).toFixed(1))} decibels`;

interface Spec {
  field: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  log?: boolean;
  bipolar?: boolean;
  visual: (v: number) => string;
  spoken?: (v: number) => string;
}

const R = SOUND_RANGES;
const pct = (field: string, label: string): Spec => ({
  field, label, ...R.mix, step: 0.01, visual: percent,
});
const TONE_SPECS: Spec[] = [
  { field: "filter_cutoff_hz", label: "Cutoff", ...R.filter_cutoff_hz, log: true, visual: hz },
  { field: "filter_resonance", label: "Resonance", ...R.filter_resonance, step: 0.01, visual: percent },
  { field: "attack_s", label: "Attack", ...R.attack_s, log: true, visual: seconds },
  { field: "decay_s", label: "Decay", ...R.decay_s, log: true, visual: seconds },
  { field: "sustain", label: "Sustain", ...R.sustain, step: 0.01, visual: percent },
  { field: "release_s", label: "Release", ...R.release_s, log: true, visual: seconds },
  { field: "pitch_semitones", label: "Pitch", ...R.pitch_semitones, step: 1, bipolar: true, visual: semitones, spoken: spokenSemitones },
];
const TONE_ARIA: Record<string, string> = {
  filter_cutoff_hz: "Filter cutoff",
  filter_resonance: "Filter resonance",
};
const MELODIC_ONLY = new Set(["attack_s", "decay_s", "sustain", "release_s"]);

const eqKnob = (field: string, label: string): Spec => ({
  field, label, ...R.eq_db, step: 0.5, bipolar: true, visual: decibels, spoken: spokenDecibels,
});

type EffectKey = keyof Effects;
const EFFECT_SPECS: { key: EffectKey; title: string; knobs: Spec[] }[] = [
  { key: "eq", title: "EQ", knobs: [eqKnob("low_db", "Low"), eqKnob("mid_db", "Mid"), eqKnob("high_db", "High")] },
  {
    key: "distortion",
    title: "Distortion",
    knobs: [{ field: "drive", label: "Drive", ...R.drive, step: 0.01, visual: percent }, pct("mix", "Mix")],
  },
  {
    key: "chorus",
    title: "Chorus",
    knobs: [
      { field: "rate_hz", label: "Rate", ...R.rate_hz, step: 0.1, visual: rate },
      { field: "depth", label: "Depth", ...R.depth, step: 0.01, visual: percent },
      pct("mix", "Mix"),
    ],
  },
  {
    key: "delay",
    title: "Delay",
    knobs: [{ field: "feedback", label: "Feedback", ...R.feedback, step: 0.01, visual: percent }, pct("mix", "Mix")],
  },
  {
    key: "reverb",
    title: "Reverb",
    knobs: [{ field: "decay_s", label: "Decay", ...R.reverb_decay_s, step: 0.1, visual: seconds }, pct("mix", "Mix")],
  },
];

const TIME_LABELS: Record<NonNullable<DelayEffect["time"]>, [text: string, name: string]> = {
  "1/16": ["1/16", "Sixteenth"],
  "1/8": ["1/8", "Eighth"],
  "1/8d": ["1/8.", "Dotted eighth"],
  "1/4": ["1/4", "Quarter"],
  "1/2": ["1/2", "Half"],
};

const GUTTER = 8;

export interface TrackSoundPanelProps {
  track: Track;
  instrument: InstrumentInfo | null;
  showInstrument: boolean;
  anchor: React.RefObject<HTMLElement | null>;
  onSound: (patch: SoundPatch, options?: { transient?: boolean }) => void;
  onReset: () => void;
  beginGesture: () => void;
  endGesture: () => void;
  // The caller knows which control opened the panel, so it decides where focus goes back to.
  onClose: (returnFocus: boolean) => void;
}

export function TrackSoundPanel({
  track,
  instrument,
  showInstrument,
  anchor,
  onSound,
  onReset,
  beginGesture,
  endGesture,
  onClose,
}: TrackSoundPanelProps) {
  const root = useRef<HTMLElement>(null);
  const titleId = useId();
  const [announce, setAnnounce] = useState("");
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // Whether a field was unset when its gesture began, so a drag back to the default can delete it again
  // and add no undo step.
  const startedAbsent = useRef(new Map<string, boolean>());

  // Decided from the id, as the validator does, because the instrument lookup is empty while loading or
  // after a failed fetch and a wrong guess would write fields the document rejects.
  const drums = usesDrumTone(track.instrument);
  const toneDef = toneDefaults(track.instrument);
  const sound = track.sound;

  useEffect(() => {
    const frame = requestAnimationFrame(() => root.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // Fixed positioning keeps the panel out of the lanes' overflow clipping, while rendering it beside the
  // trigger keeps Tab order natural; the popover therefore needs measured coordinates.
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const a = anchor.current;
      const panel = root.current;
      if (!a || !panel || a.getClientRects().length === 0) return setPlace(null);
      const r = a.getBoundingClientRect();
      const { offsetWidth: w, offsetHeight: h } = panel;
      const left = Math.max(GUTTER, Math.min(r.left, window.innerWidth - w - GUTTER));
      const below = r.bottom + 4;
      const top =
        below + h <= window.innerHeight - GUTTER
          ? below
          : Math.max(GUTTER, Math.min(r.top - 4 - h, window.innerHeight - h - GUTTER));
      setPlace((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [anchor]);

  const stored = (group: "tone" | EffectKey, field: string): unknown =>
    ((group === "tone" ? sound?.tone : sound?.effects?.[group]) as Record<string, unknown> | undefined)?.[field];

  const send = (group: "tone" | EffectKey, field: string, value: unknown, transient: boolean) => {
    onSound(
      (group === "tone" ? { tone: { [field]: value } } : { effects: { [group]: { [field]: value } } }) as SoundPatch,
      { transient },
    );
  };

  const knob = (group: "tone" | EffectKey, spec: Spec, def: number, ariaPrefix: string, extra: { muted?: boolean; describedBy?: string } = {}) => {
    const key = `${group}.${spec.field}`;
    const value = (stored(group, spec.field) as number | undefined) ?? def;
    return (
      <KnobCell
        key={key}
        spec={spec}
        value={value}
        ariaLabel={ariaPrefix}
        defaultValue={def}
        {...extra}
        onChange={(v, o) => {
          if (!startedAbsent.current.has(key)) startedAbsent.current.set(key, stored(group, spec.field) == null);
          const atDefault = Math.abs(v - def) < 1e-9;
          // A reset arrives non-transient; a drag only drops the field when it began without one.
          const drop = atDefault && (!o.transient || startedAbsent.current.get(key));
          send(group, spec.field, drop ? null : Number(v.toPrecision(10)), o.transient);
          if (!o.transient) startedAbsent.current.delete(key);
        }}
        onGestureStart={beginGesture}
        onGestureEnd={() => {
          startedAbsent.current.clear();
          endGesture();
        }}
      />
    );
  };

  const toneSpecs = TONE_SPECS.filter((s) =>
    drums ? s.field === "pitch_semitones" || !MELODIC_ONLY.has(s.field) : s.field !== "pitch_semitones",
  );

  return (
    <section
      ref={root}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      }}
      style={
        place
          ? ({ "--sound-left": `${place.left}px`, "--sound-top": `${place.top}px` } as React.CSSProperties)
          : undefined
      }
      className="fixed z-50 flex max-h-[60dvh] flex-col rounded-lg border border-zinc-200 bg-white text-zinc-900 shadow-lg focus-visible:outline-2 focus-visible:outline-black max-md:inset-x-0 max-md:bottom-0 max-md:rounded-t-2xl max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:pb-[env(safe-area-inset-bottom)] md:top-[var(--sound-top,4rem)] md:left-[var(--sound-left,16rem)] md:max-h-[calc(100dvh-1rem)] md:w-[47rem] md:max-w-[calc(100vw-1rem)] dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:outline-white"
    >
      <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-zinc-300 md:hidden dark:bg-zinc-700" />
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h2 id={titleId} className="truncate text-sm font-semibold">
          {track.name} sound
        </h2>
        {showInstrument && instrument && <span className={`${hintClass} truncate`}>{instrument.name}</span>}
        <button
          type="button"
          aria-disabled={!isSoundCustomized(track)}
          onClick={() => {
            if (!isSoundCustomized(track)) return;
            onReset();
            setAnnounce(`${track.name} sound reset`);
          }}
          className={`ml-auto rounded-md px-2 py-1 text-sm hover:bg-zinc-100 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 dark:hover:bg-zinc-900 ${focusRing}`}
        >
          Reset sound
        </button>
        <button
          type="button"
          aria-label="Close sound panel"
          onClick={() => onClose(true)}
          className={`inline-flex size-7 items-center justify-center rounded-md hover:bg-zinc-100 pointer-coarse:size-9 dark:hover:bg-zinc-800 ${focusRing}`}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="flex flex-col gap-2 overflow-y-auto overscroll-contain p-3">
        <div className="flex flex-wrap gap-2">
          {/* The document rejects tone settings on an audio track, so the group is not offered at all. */}
          {track.instrument !== "audio" && (
            <Group title="Tone" className="flex-auto">
              {() =>
                toneSpecs.map((s) =>
                  knob("tone", s, toneDef[s.field as keyof Tone & keyof typeof toneDef], TONE_ARIA[s.field] ?? s.label),
                )
              }
            </Group>
          )}
          {EFFECT_SPECS.slice(0, 2).map((e) => renderEffect(e))}
        </div>
        <div className="flex flex-wrap gap-2">{EFFECT_SPECS.slice(2).map((e) => renderEffect(e))}</div>
      </div>
      <p role="status" className="sr-only">
        {announce}
      </p>
    </section>
  );

  function renderEffect(e: (typeof EFFECT_SPECS)[number]) {
    const enabled = stored(e.key, "enabled") === true;
    const defaults = EFFECT_DEFAULTS[e.key] as Record<string, unknown>;
    return (
      <Group
        key={e.key}
        title={e.title}
        className="flex-auto"
        off={!enabled}
        enabled={enabled}
        onToggle={() => send(e.key, "enabled", enabled ? null : true, false)}
      >
        {(switchId) => (
          <>
            {e.key === "delay" && (
              <DelayTime
                value={(stored("delay", "time") as DelayEffect["time"]) ?? EFFECT_DEFAULTS.delay.time}
                onChange={(t) => send("delay", "time", t === EFFECT_DEFAULTS.delay.time ? null : t, false)}
              />
            )}
            {e.knobs.map((s) =>
              knob(e.key, s, defaults[s.field] as number, `${e.title} ${s.label}`, {
                muted: !enabled,
                describedBy: switchId,
              }),
            )}
          </>
        )}
      </Group>
    );
  }
}

function Group({
  title,
  className = "",
  off,
  enabled = false,
  onToggle,
  children,
}: {
  title: string;
  className?: string;
  off?: boolean;
  enabled?: boolean;
  onToggle?: () => void;
  children: (switchId: string) => React.ReactNode;
}) {
  const headingId = useId();
  const switchId = useId();
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={`rounded-md border px-3 pt-2 pb-3 ${off ? "border-dashed border-zinc-300 dark:border-zinc-700" : "border-zinc-200 dark:border-zinc-800"} ${className}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-xs font-semibold tracking-wide text-zinc-600 uppercase dark:text-zinc-400">
          {title}
        </h3>
        {onToggle && (
          <button
            type="button"
            id={switchId}
            role="switch"
            aria-checked={enabled}
            aria-labelledby={headingId}
            onClick={onToggle}
            className={`inline-flex items-center gap-1.5 rounded-full px-1 py-0.5 text-xs font-medium pointer-coarse:py-1.5 ${focusRing}`}
          >
            <span
              aria-hidden="true"
              className={`relative h-4 w-7 rounded-full motion-safe:transition-colors ${enabled ? "bg-indigo-600 dark:bg-indigo-400" : "bg-zinc-300 dark:bg-zinc-700"}`}
            >
              <span
                className={`absolute top-0.5 size-3 rounded-full bg-white shadow-sm ${enabled ? "left-3.5" : "left-0.5"}`}
              />
            </span>
            <span
              aria-hidden="true"
              className={enabled ? "text-indigo-700 dark:text-indigo-300" : "text-zinc-600 dark:text-zinc-400"}
            >
              {enabled ? "On" : "Off"}
            </span>
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">{children(switchId)}</div>
    </div>
  );
}

function KnobCell({
  spec,
  value,
  defaultValue,
  ariaLabel,
  muted,
  describedBy,
  onChange,
  onGestureStart,
  onGestureEnd,
}: {
  spec: Spec;
  value: number;
  defaultValue: number;
  ariaLabel: string;
  muted?: boolean;
  describedBy?: string;
  onChange: (value: number, options: { transient: boolean }) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
}) {
  const [active, setActive] = useState(false);
  return (
    <div className="flex w-14 flex-col items-center gap-1">
      <span aria-hidden="true" className="text-[11px] leading-none whitespace-nowrap text-zinc-700 dark:text-zinc-300">
        {spec.label}
      </span>
      <Knob
        size="md"
        label={ariaLabel}
        title={`${spec.label}. Double-click or press Delete to reset.`}
        value={value}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        scale={spec.log ? "log" : "linear"}
        bipolar={spec.bipolar}
        defaultValue={defaultValue}
        format={spec.spoken ?? spec.visual}
        formatReadout={spec.visual}
        muted={muted}
        describedBy={describedBy}
        onChange={onChange}
        onGestureStart={() => {
          setActive(true);
          onGestureStart();
        }}
        onGestureEnd={() => {
          setActive(false);
          onGestureEnd();
        }}
      />
      <span
        aria-hidden="true"
        className={`font-mono text-[11px] leading-none tabular-nums ${active ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}`}
      >
        {spec.visual(value)}
      </span>
    </div>
  );
}

function DelayTime({
  value,
  onChange,
}: {
  value: NonNullable<DelayEffect["time"]>;
  onChange: (time: NonNullable<DelayEffect["time"]>) => void;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label="Delay time"
      className="mb-2 inline-flex w-full rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700"
    >
      {DELAY_TIMES.map((t) => (
        <label
          key={t}
          className="relative cursor-pointer rounded px-2 py-1 text-center font-mono text-xs min-w-9 pointer-coarse:py-2 has-checked:bg-indigo-600 has-checked:font-semibold has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-black dark:has-checked:bg-indigo-400 dark:has-checked:text-zinc-950 dark:has-focus-visible:outline-white"
        >
          <input
            type="radio"
            name={name}
            value={t}
            checked={value === t}
            aria-label={TIME_LABELS[t][1]}
            onChange={() => onChange(t)}
            className="sr-only"
          />
          <span aria-hidden="true">{TIME_LABELS[t][0]}</span>
        </label>
      ))}
    </div>
  );
}
