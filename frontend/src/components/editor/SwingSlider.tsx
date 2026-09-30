"use client";

import { useId, useRef, useState } from "react";
import { focusRing } from "@/components/ui/classes";

export function SwingSlider({ value, onCommit }: { value: number; onCommit: (swing: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  // The ref is authoritative so a release right after the last input event never commits a stale value.
  const draftRef = useRef<number | null>(null);
  const percent = draft ?? Math.round(value * 100);

  // Preview locally so one drag is one undo step rather than dozens.
  function commit() {
    const d = draftRef.current;
    draftRef.current = null;
    if (d !== null && d !== Math.round(value * 100)) onCommit(d / 100);
    setDraft(null);
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Swing
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={75}
        step={1}
        value={percent}
        aria-valuetext={`${percent} percent`}
        onChange={(e) => {
          draftRef.current = Number(e.target.value);
          setDraft(draftRef.current);
        }}
        // Capture keeps the release event on the slider even when the pointer ends outside it.
        onPointerDown={(e) => e.currentTarget.setPointerCapture?.(e.pointerId)}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className={`w-32 accent-indigo-600 ${focusRing}`}
      />
      <span className="w-10 font-mono text-sm tabular-nums text-zinc-600 dark:text-zinc-400">{percent}%</span>
    </div>
  );
}
