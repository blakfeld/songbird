"use client";

import { useId, useRef, useState } from "react";
import type { Note } from "@/generated/Note";
import { focusRing, hintClass, inputClass, labelClass } from "@/components/ui/classes";

const ONE_SHOT_HINT = "One-shot sounds always play in full.";

const sameValue = (values: number[]) => values.every((v) => v === values[0]);

// Committing per keystroke would make typing "90" two undo steps, so edits commit on Enter or blur.
function NumberField({
  id,
  value,
  min,
  max,
  mixedId,
  readOnly,
  hint,
  className,
  onCommit,
}: {
  id: string;
  // Null rather than a sentinel number so a mixed selection can show a blank instead of implying a value.
  value: number | null;
  min: number;
  max?: number;
  mixedId: string;
  readOnly?: boolean;
  hint?: string;
  className: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const hintId = useId();
  const shown = draft ?? (value === null ? "" : String(value));
  const n = Number(shown);
  const invalid =
    draft !== null && (draft.trim() === "" || !Number.isFinite(n) || n < min || (max !== undefined && n > max));

  function commit() {
    if (draft !== null && !invalid && Math.round(n) !== value) onCommit(Math.round(n));
    setDraft(null);
  }

  return (
    <>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={shown}
        readOnly={readOnly}
        title={readOnly ? hint : undefined}
        placeholder={value === null ? "Mixed" : undefined}
        aria-invalid={invalid}
        aria-describedby={readOnly ? hintId : value === null ? mixedId : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
        className={className}
      />
      {readOnly && (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      )}
    </>
  );
}

export function NoteInspector({
  notes,
  oneShot,
  compact,
  onSetVelocity,
  onSetLength,
}: {
  notes: Note[];
  oneShot: boolean;
  compact: boolean;
  onSetVelocity: (velocity: number) => void;
  onSetLength: (length: number) => void;
}) {
  const velId = useId();
  const lenId = useId();
  const velMixedId = useId();
  const lenMixedId = useId();
  const [sliderDraft, setSliderDraft] = useState<number | null>(null);
  // The ref is authoritative so a release right after the last input event never commits a stale value.
  const sliderRef = useRef<number | null>(null);

  if (notes.length === 0) {
    return (
      <p className={`${hintClass} flex min-h-10 items-center`}>
        {compact
          ? "No notes selected"
          : "No notes selected. Click a note, or drag across the grid to select several."}
      </p>
    );
  }

  const velocities = notes.map((n) => n.velocity);
  const lengths = notes.map((n) => n.length_steps);
  const velocity = sameValue(velocities) ? velocities[0] : null;
  const length = sameValue(lengths) ? lengths[0] : null;
  const meanVelocity = Math.round(velocities.reduce((a, b) => a + b, 0) / velocities.length);
  const sliderValue = sliderDraft ?? velocity ?? meanVelocity;
  const height = compact ? "!h-8" : "";
  const fieldClass = `${inputClass} ${height} w-20 font-mono tabular-nums placeholder:text-zinc-500 dark:placeholder:text-zinc-400`;

  function commitSlider() {
    const d = sliderRef.current;
    sliderRef.current = null;
    setSliderDraft(null);
    if (d !== null && d !== velocity) onSetVelocity(d);
  }

  return (
    <div role="group" aria-label="Selected notes" className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-2">
      <p className="text-sm font-medium tabular-nums">
        {notes.length} {notes.length === 1 ? "note" : "notes"} selected
      </p>
      <div className="flex items-center gap-2">
        <label htmlFor={velId} className={labelClass}>
          Velocity
        </label>
        <NumberField
          id={velId}
          value={velocity}
          min={1}
          max={127}
          mixedId={velMixedId}
          className={fieldClass}
          onCommit={onSetVelocity}
        />
        {velocity === null && (
          <span id={velMixedId} className="sr-only">
            Selected notes have different velocities
          </span>
        )}
        <input
          type="range"
          min={1}
          max={127}
          aria-label="Velocity slider"
          value={sliderValue}
          aria-valuetext={velocity === null && sliderDraft === null ? "Mixed" : undefined}
          onChange={(e) => {
            sliderRef.current = Number(e.target.value);
            setSliderDraft(sliderRef.current);
          }}
          // Capture keeps the release event on the slider even when the pointer ends outside it.
          onPointerDown={(e) => e.currentTarget.setPointerCapture?.(e.pointerId)}
          onPointerUp={commitSlider}
          onKeyUp={commitSlider}
          onBlur={commitSlider}
          className={`w-28 accent-indigo-600 max-sm:hidden ${focusRing}`}
        />
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={lenId} className={labelClass}>
          Length<span className="sr-only"> in steps</span>
        </label>
        <NumberField
          id={lenId}
          value={length}
          min={1}
          mixedId={lenMixedId}
          readOnly={oneShot}
          hint={ONE_SHOT_HINT}
          className={`${fieldClass} read-only:bg-zinc-100 read-only:text-zinc-600 dark:read-only:bg-zinc-900 dark:read-only:text-zinc-400`}
          onCommit={onSetLength}
        />
        {length === null && (
          <span id={lenMixedId} className="sr-only">
            Selected notes have different lengths
          </span>
        )}
        <span aria-hidden="true" className="text-sm text-zinc-600 dark:text-zinc-400">
          steps
        </span>
      </div>
    </div>
  );
}
