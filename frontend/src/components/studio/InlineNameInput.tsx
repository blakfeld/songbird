"use client";

import { useEffect, useRef } from "react";
import { inputClass } from "@/components/ui/classes";

// Blur commits, so Escape has to win first or a cancelled edit would be saved by the blur that follows.
export function InlineNameInput({
  value,
  label,
  maxLength,
  onCommit,
  onCancel,
  className = "",
}: {
  value: string;
  label: string;
  maxLength: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = ref.current?.value.trim() ?? "";
    // An empty name is invalid, so the old one is kept instead of erroring.
    if (commit && next && next !== value) onCommit(next);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      autoFocus
      type="text"
      aria-label={label}
      maxLength={maxLength}
      defaultValue={value}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.stopPropagation();
          finish(false);
        }
      }}
      className={`${inputClass} min-w-0 ${className}`}
    />
  );
}
