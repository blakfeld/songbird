"use client";

import { useId, useState } from "react";
import { inputClass } from "@/components/ui/classes";
import { TEMPO_RANGE } from "@/lib/patternOps";

// Committing per keystroke would make typing "120" three undo steps.
export function TempoField({ value, onCommit }: { value: number; onCommit: (bpm: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const n = Number(shown);
  const invalid = shown.trim() === "" || !Number.isFinite(n) || n < TEMPO_RANGE.min || n > TEMPO_RANGE.max;

  function commit() {
    if (draft !== null && !invalid && Math.round(n) !== value) onCommit(Math.round(n));
    setDraft(null);
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Tempo
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={TEMPO_RANGE.min}
        max={TEMPO_RANGE.max}
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
      <span className="text-sm text-zinc-600 dark:text-zinc-400">BPM</span>
    </div>
  );
}
