"use client";

import { useId, useState } from "react";
import { inputClass } from "@/components/ui/classes";
import { MEASURE_RANGE } from "@/lib/song/types";

// Typed rather than picked from 128 options; committed on blur so "32" is not three undo steps.
export function LengthField({ value, onCommit }: { value: number; onCommit: (measures: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const n = Number(shown);
  const invalid =
    shown.trim() === "" || !Number.isInteger(n) || n < MEASURE_RANGE.min || n > MEASURE_RANGE.max;

  function commit() {
    if (draft !== null && !invalid && n !== value) onCommit(n);
    setDraft(null);
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Length
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={MEASURE_RANGE.min}
        max={MEASURE_RANGE.max}
        value={shown}
        aria-invalid={draft !== null && invalid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
        className={`${inputClass} w-20 font-mono tabular-nums`}
      />
      <span className="text-sm text-zinc-600 dark:text-zinc-400">bars</span>
    </div>
  );
}
