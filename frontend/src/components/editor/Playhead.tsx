"use client";

import { useEffect, useRef } from "react";
import type { Playback } from "@/lib/audio/types";

// Positioned through the DOM rather than state so 60 fps updates never re-render the grid.
export function Playhead({ subscribePosition }: { subscribePosition: Playback["subscribePosition"] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let last: number | null | undefined;
    return subscribePosition((position) => {
      // Fractional positions would rewrite the transform every frame for no visible change.
      const step = position === null ? null : Math.floor(position);
      const el = ref.current;
      if (!el || step === last) return;
      last = step;
      el.style.display = step === null ? "none" : "";
      if (step !== null) el.style.transform = `translateX(calc(${step} * var(--cell-w)))`;
    });
  }, [subscribePosition]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="playhead"
      style={{ display: "none" }}
      className="pointer-events-none absolute top-0 bottom-0 left-0 z-[15] w-[var(--cell-w)] border-l-2 border-amber-600 bg-amber-500/15 dark:border-amber-400 dark:bg-amber-400/15"
    />
  );
}
