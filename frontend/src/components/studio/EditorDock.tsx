"use client";

import { useMemo, type Ref } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Note } from "@/generated/Note";
import type { Row } from "@/generated/Row";
import type { LoopRange, Playback } from "@/lib/audio/types";
import { moveGridNote, resizeGridNote, setGridVelocity, toggleGridNote, type NoteGrid } from "@/lib/patternOps";
import { trackGrid } from "@/lib/song/songOps";
import type { SongStore } from "@/lib/song/songStore";
import type { Song, Track } from "@/lib/song/types";
import type { ResourceState } from "@/lib/useApiResource";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { PianoRoll } from "@/components/editor/PianoRoll";
import { InstrumentIcon } from "./InstrumentIcon";

export function EditorDock({
  store,
  song,
  track,
  instruments,
  onRetryInstruments,
  loop,
  follow,
  isPlaying,
  onManualScroll,
  subscribePosition,
  onAudition,
  scrollerRef,
  sectionId,
}: {
  store: SongStore;
  song: Song;
  track: Track;
  instruments: ResourceState<InstrumentInfo[]>;
  onRetryInstruments: () => void;
  loop: LoopRange;
  follow: boolean;
  isPlaying: boolean;
  onManualScroll: () => void;
  subscribePosition: Playback["subscribePosition"];
  // Routed through the track's own channel by the caller so volume and pan apply.
  onAudition: (trackId: string, row: Row, velocity?: number) => void;
  scrollerRef: Ref<HTMLDivElement>;
  sectionId: string;
}) {
  const info = instruments.data?.find((i) => i.id === track.instrument);
  const rows = info?.rows;
  const grid = useMemo(() => (rows ? trackGrid(song, track, rows) : null), [song, track, rows]);
  const edit = (fn: (g: NoteGrid) => Note[]) => {
    if (rows) store.getState().editTrackNotes(track.id, rows, fn);
  };

  return (
    <section
      id={sectionId}
      tabIndex={-1}
      aria-label={`Editor: ${track.name}`}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-zinc-200 bg-white max-md:h-[70dvh] dark:border-zinc-800 dark:bg-zinc-950"
    >
      {instruments.status === "loading" && (
        <div aria-hidden="true" className="flex flex-col gap-2 p-4">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="h-6 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-900" />
          ))}
        </div>
      )}
      {instruments.status === "error" && (
        <div className="p-4">
          <ErrorAlert message="Couldn't load instruments." onRetry={onRetryInstruments} />
        </div>
      )}
      {instruments.status === "ready" && !info && (
        <div className="p-4">
          <ErrorAlert message="This track's instrument isn't available, so it can't be edited or played." />
        </div>
      )}
      {info && grid && (
        <PianoRoll
          key={track.id}
          instrumentName={info.name}
          kind={info.kind}
          sustained={info.sustained}
          onAudition={(row) => onAudition(track.id, row)}
          grid={grid}
          timeSignature={song.time_signature}
          stepsPerMeasure={song.steps_per_measure}
          resetKey={track.id}
          onToggleNote={(rowId, step, len) => edit((g) => toggleGridNote(g, rowId, step, len))}
          onSetVelocity={(rowId, step, v) => edit((g) => setGridVelocity(g, rowId, step, v))}
          onResizeNote={(rowId, step, len) => edit((g) => resizeGridNote(g, rowId, step, len))}
          onMoveNote={(rowId, step, to) => edit((g) => moveGridNote(g, rowId, step, to))}
          onPlaceNote={(row, velocity) => onAudition(track.id, row, velocity)}
          loop={loop}
          follow={follow}
          isPlaying={isPlaying}
          onManualScroll={onManualScroll}
          subscribePosition={subscribePosition}
          className="h-full min-h-0 scroll-pl-[var(--gutter-w)]"
          gutterClassName="w-[var(--gutter-w)]"
          beatLabels
          scrollerRef={scrollerRef}
          corner={
            <div className="flex h-full min-w-0 items-center gap-2 px-2">
              <InstrumentIcon instrumentId={track.instrument} kind={info.kind} className="size-6" />
              <div className="min-w-0">
                <p className="truncate text-sm leading-tight font-semibold">{track.name}</p>
                {info.name !== track.name && (
                  <p className="truncate text-xs leading-tight text-zinc-600 dark:text-zinc-400">{info.name}</p>
                )}
              </div>
            </div>
          }
        />
      )}
    </section>
  );
}
