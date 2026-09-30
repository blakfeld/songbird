"use client";

import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Track } from "@/lib/song/types";
import { NoteOverview } from "./NoteOverview";
import { TrackHeader, type InstrumentLookup } from "./TrackHeader";
import type { TrackActions } from "./trackActions";

export function TrackLane({
  track,
  number,
  selected,
  audible,
  canDelete,
  instrument,
  totalSteps,
  stepsPerMeasure,
  actions,
  onSeek,
}: {
  track: Track;
  number: number;
  selected: boolean;
  audible: boolean;
  canDelete: boolean;
  instrument: InstrumentLookup;
  totalSteps: number;
  stepsPerMeasure: number;
  actions: TrackActions;
  onSeek: (trackId: string, measureIndex: number) => void;
}) {
  const info: InstrumentInfo | null = instrument.state === "ready" ? instrument.info : null;
  return (
    <div
      role="group"
      aria-label={`Track ${number}: ${track.name}${audible ? "" : ", not audible"}`}
      data-audible={audible ? "true" : "false"}
      data-selected={selected ? "true" : undefined}
      className={`grid h-20 grid-cols-[var(--gutter-w)_minmax(0,1fr)] border-b border-zinc-200 max-md:h-28 pointer-coarse:h-24 dark:border-zinc-800 ${
        selected ? "bg-indigo-50 dark:bg-indigo-950/40" : ""
      }`}
    >
      <TrackHeader
        track={track}
        number={number}
        selected={selected}
        canDelete={canDelete}
        instrument={instrument}
        actions={actions}
      />
      <NoteOverview
        name={track.name}
        notes={track.notes}
        rows={info?.rows ?? null}
        melodic={info?.kind === "melodic"}
        totalSteps={totalSteps}
        stepsPerMeasure={stepsPerMeasure}
        audible={audible}
        onSeek={(m) => onSeek(track.id, m)}
      />
    </div>
  );
}
