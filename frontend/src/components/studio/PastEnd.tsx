import type { Song } from "@/lib/song/types";

// Shade, hatch, and a dashed line together mark the end, so no single cue carries it alone.
export function PastEnd({ song, timeline }: { song: Song; timeline: number }) {
  if (song.measures >= timeline) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="past-end"
      className="pointer-events-none absolute inset-y-0 right-0 border-l-2 border-dashed border-zinc-500 bg-zinc-100/70 bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(0_0_0/0.05)_6px_7px)] dark:bg-zinc-900/60 dark:bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(255_255_255/0.05)_6px_7px)]"
      style={{ left: `calc(var(--cell-w) * ${song.measures * song.steps_per_measure})` }}
    />
  );
}
