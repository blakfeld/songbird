"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";
import { focusRing, hintClass, inputClass, labelClass } from "@/components/ui/classes";
import {
  RECORDING_OFFSET_RANGE_MS,
  clampRecordingOffsetMs,
  loadRecordingOffsetMs,
  saveRecordingOffsetMs,
  subscribeRecordingOffset,
} from "@/lib/audio/recorder/inputPrefs";

export function useRecordingOffset(): [number, (ms: number) => void] {
  const value = useSyncExternalStore(subscribeRecordingOffset, loadRecordingOffsetMs, () => 0);
  return [value, (ms) => void saveRecordingOffsetMs(ms)];
}

const { min, max } = RECORDING_OFFSET_RANGE_MS;

export function RecordingOffsetField() {
  const [offset, setOffset] = useRecordingOffset();
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const hintId = `${id}-hint`;
  const rangeId = `${id}-range`;

  const parsed = draft === null ? offset : draft.trim() === "" ? Number.NaN : Number(draft);
  const invalid = draft !== null && (!Number.isFinite(parsed) || parsed < min || parsed > max);

  // Clamped only on leaving the field, so typing 150 on the way to 50 never stores something the user did not mean.
  const commit = () => {
    if (draft === null) return;
    setOffset(Number.isFinite(parsed) ? clampRecordingOffsetMs(parsed) : offset);
    setDraft(null);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className={labelClass}>
          Recording offset
        </label>
        <input
          ref={input}
          id={id}
          type="number"
          min={min}
          max={max}
          step={1}
          inputMode="numeric"
          value={draft ?? String(offset)}
          aria-invalid={invalid || undefined}
          aria-describedby={`${hintId}${invalid ? ` ${rangeId}` : ""}`}
          onChange={(e) => {
            const text = e.target.value;
            setDraft(text);
            const n = Number(text);
            // A value in range is stored as it is typed; anything else waits for the field to be left.
            if (text.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) setOffset(n);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          className={`${inputClass} h-8 w-20 text-right tabular-nums`}
        />
        <span className={hintClass}>ms</span>
        {offset !== 0 && (
          <button
            type="button"
            onClick={() => {
              setOffset(0);
              setDraft(null);
              input.current?.focus();
            }}
            className={`text-sm underline-offset-2 hover:underline ${focusRing}`}
          >
            Reset
          </button>
        )}
      </div>
      {invalid && (
        <p id={rangeId} className={hintClass}>
          Between −200 and +200 ms
        </p>
      )}
      <p id={hintId} className={hintClass}>
        Applies to all tracks. If recordings land late, raise it; if early, lower it. Clap test: record a few claps on
        the beat with the metronome on, see how far each clap lands from the beat line, and enter that distance. Takes
        already recorded don&apos;t move.
      </p>
    </div>
  );
}
