"use client";

import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Song, Track } from "@/lib/song/types";
import { ClipLane } from "./ClipLane";
import { TrackHeader, type InstrumentLookup } from "./TrackHeader";
import type { TrackActions } from "./trackActions";
import type { ClipActions } from "./useClipActions";

export function TrackLane({
  song,
  timeline,
  track,
  number,
  selected,
  audible,
  canDelete,
  instrument,
  selectedClipId,
  first,
  actions,
  clipActions,
  onSeek,
}: {
  song: Song;
  timeline: number;
  track: Track;
  number: number;
  selected: boolean;
  audible: boolean;
  canDelete: boolean;
  instrument: InstrumentLookup;
  selectedClipId: string | null;
  first: boolean;
  actions: TrackActions;
  clipActions: ClipActions;
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
        song={song}
        selectedClipId={selectedClipId}
        clipActions={clipActions}
      />
      <ClipLane
        song={song}
        timeline={timeline}
        track={track}
        rows={info?.rows ?? null}
        melodic={info?.kind === "melodic"}
        audible={audible}
        selectedClipId={selectedClipId}
        first={first}
        actions={clipActions}
        onSeek={(m) => onSeek(track.id, m)}
      />
    </div>
  );
}
