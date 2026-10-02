"use client";

import { useState } from "react";
import { MAX_TRACKS } from "@/lib/song/types";
import { InstrumentIcon } from "../InstrumentIcon";
import { dragKind, readDrop, type SampleDrop } from "./useSampleDrop";
import { TICKS_PER_SIXTEENTH } from "@/lib/song/audioTiming";
import type { Song } from "@/lib/song/types";

// Appears only mid-drag; the keyboard path to the same result is Add track, then Audio, then Enter in Samples.
export function NewTrackDropZone({ song, timeline, drop }: { song: Song; timeline: number; drop: SampleDrop }) {
  const [hover, setHover] = useState(false);
  const full = song.tracks.length >= MAX_TRACKS;
  const totalTicks = timeline * song.steps_per_measure * TICKS_PER_SIXTEENTH;

  return (
    <div
      aria-hidden="true"
      data-testid="new-track-drop"
      className={`grid h-20 grid-cols-[var(--gutter-w)_minmax(0,1fr)] border-2 border-dashed ${
        full
          ? "border-zinc-300 opacity-60 dark:border-zinc-700"
          : hover
            ? "border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/40"
            : "border-zinc-300 dark:border-zinc-700"
      }`}
      onDragOver={(e) => {
        if (!dragKind(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = full ? "none" : "copy";
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        if (!dragKind(e.dataTransfer)) return;
        e.preventDefault();
        setHover(false);
        if (full) return;
        const rect = e.currentTarget.lastElementChild?.getBoundingClientRect();
        const raw = rect && rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * totalTicks : 0;
        const at = Math.max(0, e.shiftKey ? Math.round(raw) : Math.round(raw / TICKS_PER_SIXTEENTH) * TICKS_PER_SIXTEENTH);
        void readDrop(e.dataTransfer).then((payload) => payload && drop.onDrop(null, at, e.shiftKey, payload));
      }}
    >
      <div className="flex items-center gap-2 px-3">
        <InstrumentIcon instrumentId="audio" kind={null} />
        <span className="text-sm font-medium">{full ? `${MAX_TRACKS} tracks · limit reached` : "New audio track"}</span>
      </div>
      <div data-testid="new-track-drop-lane" className="@container min-w-0" />
    </div>
  );
}
