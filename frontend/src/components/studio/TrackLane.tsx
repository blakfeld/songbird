"use client";

import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Song, Track } from "@/lib/song/types";
import { ClipLane } from "./ClipLane";
import { AudioClipLane } from "./audio/AudioClipLane";
import type { SampleDrop } from "./samples/useSampleDrop";
import type { AudioActions } from "./useAudioActions";
import { TrackHeader, type InstrumentLookup } from "./TrackHeader";
import type { TrackActions } from "./trackActions";
import type { GripHandlers } from "./useTrackDrag";
import type { ClipActions } from "./useClipActions";

export function TrackLane({
  song,
  timeline,
  track,
  number,
  selected,
  audible,
  instrument,
  selectedClipId,
  first,
  count,
  onMove,
  grip,
  dragging,
  actions,
  soundOpen,
  onSoundOpen,
  clipActions,
  audioActions,
  drop,
  generatingTrackId,
  onSeek,
}: {
  song: Song;
  timeline: number;
  track: Track;
  number: number;
  selected: boolean;
  audible: boolean;
  instrument: InstrumentLookup;
  selectedClipId: string | null;
  first: boolean;
  count: number;
  grip: GripHandlers;
  dragging: boolean;
  onMove: (toIndex: number, options?: { restoreFocus?: boolean }) => void;
  actions: TrackActions;
  soundOpen: boolean;
  onSoundOpen: (open: boolean) => void;
  clipActions: ClipActions;
  audioActions: AudioActions;
  drop: SampleDrop;
  generatingTrackId: string | null;
  onSeek: (trackId: string, measureIndex: number) => void;
}) {
  const generating = generatingTrackId === track.id;
  const info: InstrumentInfo | null = instrument.state === "ready" ? instrument.info : null;
  return (
    <div
      role="group"
      aria-label={`Track ${number}: ${track.name}${audible ? "" : ", not audible"}`}
      data-track-lane={track.id}
      data-dragging={dragging ? "true" : undefined}
      data-audible={audible ? "true" : "false"}
      data-selected={selected ? "true" : undefined}
      className={`grid h-20 grid-cols-[var(--gutter-w)_minmax(0,1fr)] border-b border-zinc-200 max-md:h-28 pointer-coarse:h-24 dark:border-zinc-800 data-[dragging]:relative data-[dragging]:z-30 data-[dragging]:opacity-60 data-[dragging]:shadow-lg data-[dragging]:ring-2 data-[dragging]:ring-inset data-[dragging]:ring-zinc-900 dark:data-[dragging]:ring-zinc-50 ${
        selected ? "bg-indigo-50 dark:bg-indigo-950/40" : ""
      }`}
    >
      <TrackHeader
        track={track}
        number={number}
        count={count}
        grip={grip}
        dragging={dragging}
        onMove={onMove}
        selected={selected}
        instrument={instrument}
        actions={actions}
        soundOpen={soundOpen}
        onSoundOpen={onSoundOpen}
        song={song}
        selectedClipId={selectedClipId}
        clipActions={clipActions}
        audioActions={audioActions}
        generating={generating}
        generateBlocked={generatingTrackId !== null && !generating}
      />
      {/* Inert rather than disabled so the lane keeps its layout while its clips cannot be touched. */}
      <div inert={generating} aria-busy={generating} className="grid min-w-0">
      {instrument.state === "audio" ? (
        <AudioClipLane
          song={song}
          timeline={timeline}
          track={track}
          audible={audible}
          selectedClipId={selectedClipId}
          first={first}
          actions={audioActions}
          drop={drop}
          onSeek={(m) => onSeek(track.id, m)}
        />
      ) : (
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
      )}
      </div>
    </div>
  );
}
