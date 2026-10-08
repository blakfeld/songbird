"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { ToplineSource } from "@/generated/ToplineSource";
import { isStale } from "@/lib/topline/toplineOps";

// Lyrics and notes can drift apart in two ways, by editing the text or by adding and removing notes, and each
// needs a different remedy, so both are offered where the topline loop is being edited.
export function ToplineStrip({
  topline,
  lyrics,
  onRegenerate,
  onReflow,
}: {
  topline: ToplineSource;
  lyrics: string;
  onRegenerate: () => void;
  // Returns how many syllables found no note, or null when nothing could be done.
  onReflow: () => number | null;
}) {
  const [result, setResult] = useState("");
  const stale = isStale(topline, lyrics);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 px-2 py-1 text-xs dark:border-zinc-800">
      {stale && (
        <>
          <p role="status" className="font-medium text-amber-800 dark:text-amber-300">
            The {topline.section_name} lyrics have changed since this topline was generated.
          </p>
          <Button className="!py-0.5 text-xs" onClick={onRegenerate}>
            Regenerate
          </Button>
        </>
      )}
      <Button
        className="!py-0.5 text-xs"
        onClick={() => {
          const unplaced = onReflow();
          if (unplaced === null) return;
          setResult(
            unplaced === 0
              ? "Lyrics re-flowed onto the notes."
              : `Lyrics re-flowed. ${unplaced} ${unplaced === 1 ? "syllable has" : "syllables have"} no note.`,
          );
        }}
      >
        Re-flow lyrics
      </Button>
      <p role="status" className="text-zinc-700 dark:text-zinc-300">
        {result}
      </p>
    </div>
  );
}
