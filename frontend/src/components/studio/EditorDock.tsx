"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Note } from "@/generated/Note";
import type { Row } from "@/generated/Row";
import type { Playback } from "@/lib/audio/types";
import { keyHighlight } from "@/lib/music/key";
import { songKey } from "@/lib/song/songOps";
import { resizeGridNote, setGridVelocity, toggleGridNote, type NoteGrid } from "@/lib/patternOps";
import { NEW_CLIP_MEASURES, freeSpanAt, loopGrid, loopUseCount, nextFreeMeasure } from "@/lib/song/clipOps";
import { useSongStore, type SongStore } from "@/lib/song/songStore";
import { LOOP_NAME_MAX, MAX_CLIPS, MAX_LOOPS, type Song, type Track } from "@/lib/song/types";
import type { ResourceState } from "@/lib/useApiResource";
import { Button } from "@/components/ui/Button";
import { focusRing, hintClass } from "@/components/ui/classes";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { PianoRoll } from "@/components/editor/PianoRoll";
import { ClipMenuItems, LinkGlyph, LoopSwatch, clipMenuLabel } from "./ClipMenu";
import { InlineNameInput } from "./InlineNameInput";
import { InstrumentIcon } from "./InstrumentIcon";
import { LoopsDialog } from "./LoopsDialog";
import { Menu } from "./Menu";
import type { ClipActions } from "./useClipActions";

function EmptyState({
  song,
  track,
  actions,
}: {
  song: Song;
  track: Track;
  actions: ClipActions;
}) {
  const hintId = useId();
  const measure = nextFreeMeasure(track, song, 1);
  const loopLimit = track.loops.length >= MAX_LOOPS;
  const span = measure === null ? 0 : Math.min(NEW_CLIP_MEASURES, freeSpanAt(track, measure, song));
  const clipLimit = track.clips.length >= MAX_CLIPS;
  const blocked = measure === null || loopLimit || clipLimit;
  const hint = clipLimit
    ? `This track has ${MAX_CLIPS} clips, the most it can hold`
    : loopLimit
    ? `This track has ${MAX_LOOPS} loops, the most it can hold`
    : measure === null
      ? "No empty measures on this track"
      : span === 1
        ? `Adds measure ${measure}`
        : `Adds measures ${measure}–${measure + span - 1}`;
  const none = track.clips.length === 0;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <h2 className="text-sm font-semibold">
        {none ? `${track.name} has no clips yet` : `No clip selected on ${track.name}`}
      </h2>
      <p className={hintClass}>
        {none ? "Add a clip to start writing a loop." : "Select a clip in the lane, or add a new one."}
      </p>
      <Button
        variant="primary"
        disabled={blocked}
        aria-describedby={hintId}
        onClick={() => {
          if (measure === null) return;
          actions.create(track.id, measure);
          actions.focusRoll();
        }}
      >
        New clip
      </Button>
      <p id={hintId} className={hintClass}>
        {hint}
      </p>
    </div>
  );
}

export function EditorDock({
  store,
  song,
  track,
  instruments,
  onRetryInstruments,
  follow,
  isPlaying,
  onManualScroll,
  subscribePosition,
  onAudition,
  sectionId,
  clipActions,
  renamingLoopId,
  onRenameDone,
  onAnnounce,
}: {
  store: SongStore;
  song: Song;
  track: Track;
  instruments: ResourceState<InstrumentInfo[]>;
  onRetryInstruments: () => void;
  follow: boolean;
  isPlaying: boolean;
  onManualScroll: () => void;
  subscribePosition: Playback["subscribePosition"];
  // Routed through the track's own channel by the caller so volume and pan apply.
  onAudition: (trackId: string, row: Row, velocity?: number) => void;
  sectionId: string;
  clipActions: ClipActions;
  renamingLoopId: string | null;
  onRenameDone: () => void;
  onAnnounce: (message: string) => void;
}) {
  const info = instruments.data?.find((i) => i.id === track.instrument);
  const rows = info?.rows;
  const selectedClipId = useSongStore(store, (s) => s.selectedClipId);
  const clip = track.clips.find((c) => c.id === selectedClipId);
  const loopDoc = clip ? track.loops.find((l) => l.id === clip.loop_id) : undefined;
  const contextId = useId();
  const section = useRef<HTMLElement>(null);
  const [loopsOpen, setLoopsOpen] = useState(false);
  const [inspectorSlot, setInspectorSlot] = useState<HTMLDivElement | null>(null);
  const spm = song.steps_per_measure;

  const { tonic, mode } = songKey(song);
  const highlight = useMemo(() => keyHighlight({ tonic, mode }), [tonic, mode]);

  const grid = useMemo(
    () => (rows && loopDoc ? loopGrid(loopDoc, rows, spm) : null),
    [spm, loopDoc, rows],
  );
  // The roll shows one loop, so song positions are folded into it and hidden outside the selected clip.
  const clipStart = clip ? (clip.start_measure - 1) * spm : 0;
  const clipSteps = clip ? clip.measures * spm : 0;
  const loopSteps = loopDoc ? loopDoc.measures * spm : 1;
  const loopPosition = useMemo<Playback["subscribePosition"]>(
    () => (cb) =>
      subscribePosition((position) => {
        if (position === null || position < clipStart || position >= clipStart + clipSteps) cb(null);
        else cb((position - clipStart) % loopSteps);
      }),
    [subscribePosition, clipStart, clipSteps, loopSteps],
  );

  const edit = (fn: (g: NoteGrid) => Note[], options?: { transient?: boolean }) => {
    if (rows && loopDoc) store.getState().editLoopNotes(track.id, loopDoc.id, rows, fn, options);
  };

  const uses = loopDoc ? loopUseCount(track, loopDoc.id) : 0;
  const linked = uses > 1;
  const invoker = () =>
    section.current?.querySelector<HTMLElement>('button[aria-label^="Clip actions for"]') ?? null;
  const loopIndex = loopDoc ? track.loops.indexOf(loopDoc) : 0;
  const renaming = loopDoc !== undefined && renamingLoopId === loopDoc.id;
  const showRoll = info && grid && loopDoc && clip;

  return (
    <section
      ref={section}
      id={sectionId}
      tabIndex={-1}
      aria-label={loopDoc ? `Editor: ${loopDoc.name} on ${track.name}` : `Editor: ${track.name}`}
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
      {info && !showRoll && <EmptyState song={song} track={track} actions={clipActions} />}
      {showRoll && (
        <>
          <div
            role="toolbar"
            aria-label="Loop"
            className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800"
          >
            <div className="flex min-w-0 items-center gap-2">
              {renaming ? (
                <InlineNameInput
                  value={loopDoc.name}
                  label={`Loop name ${loopDoc.name}`}
                  maxLength={LOOP_NAME_MAX}
                  className="h-8 w-48"
                  onCommit={(name) => {
                    clipActions.renameLoop(track.id, loopDoc.id, name);
                    onRenameDone();
                  }}
                  onCancel={onRenameDone}
                />
              ) : (
                <button
                  type="button"
                  aria-label={`Loop ${loopDoc.name}. Show all loops on ${track.name}`}
                  aria-haspopup="dialog"
                  onClick={() => setLoopsOpen(true)}
                  className={`inline-flex h-8 items-center gap-2 rounded-md px-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${focusRing}`}
                >
                  <LoopSwatch index={loopIndex} />
                  <span className="max-w-48 truncate text-sm font-semibold">{loopDoc.name}</span>
                  <span aria-hidden="true">▾</span>
                </button>
              )}
              <p
                id={contextId}
                className={`flex items-center gap-1 text-xs ${linked ? "font-medium text-zinc-900 dark:text-zinc-50" : "text-zinc-600 dark:text-zinc-400"}`}
              >
                {linked && <LinkGlyph />}
                {track.name} · used by {uses} {uses === 1 ? "clip" : "clips"}
              </p>
            </div>
            <div ref={setInspectorSlot} className="min-w-0 max-md:basis-full" />
            <div className="ml-auto">
              <Menu
                label={clipMenuLabel(track, clip)}
                align="right"
                panelClassName="w-64"
                triggerClassName={`inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-zinc-100 pointer-coarse:size-9 dark:hover:bg-zinc-800 ${focusRing}`}
                trigger={<span aria-hidden="true">⋯</span>}
              >
                {(close) => (
                  <ClipMenuItems
                    track={track}
                    song={song}
                    clip={clip}
                    actions={clipActions}
                    close={close}
                    focusResult={false}
                    invoker={invoker}
                  />
                )}
              </Menu>
            </div>
          </div>
          <PianoRoll
            key={track.id}
            instrumentName={info.name}
            kind={info.kind}
            sustained={info.sustained}
            onAudition={(row) => onAudition(track.id, row)}
            grid={grid}
            timeSignature={song.time_signature}
            stepsPerMeasure={spm}
            resetKey={loopDoc.id}
            onToggleNote={(rowId, step, len) => edit((g) => toggleGridNote(g, rowId, step, len))}
            onSetVelocity={(rowId, step, v) => edit((g) => setGridVelocity(g, rowId, step, v))}
            onResizeNote={(rowId, step, len) => edit((g) => resizeGridNote(g, rowId, step, len))}
            onEditNotes={edit}
            onBeginGesture={() => store.getState().beginGesture()}
            onEndGesture={() => store.getState().endGesture()}
            onCancelGesture={() => store.getState().cancelGesture()}
            inspectorTarget={inspectorSlot}
            inspectorCompact
            onAnnounce={onAnnounce}
            onPlaceNote={(row, velocity) => onAudition(track.id, row, velocity)}
            follow={follow}
            isPlaying={isPlaying}
            onManualScroll={onManualScroll}
            subscribePosition={loopPosition}
            className="h-full min-h-0 scroll-pl-[var(--gutter-w)]"
            gutterClassName="w-[var(--gutter-w)]"
            beatLabels
            keyHighlight={info.kind === "melodic" ? highlight : undefined}
            describedBy={linked ? contextId : undefined}
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
        </>
      )}
      <LoopsDialog
        open={loopsOpen}
        onClose={() => {
          setLoopsOpen(false);
          requestAnimationFrame(() =>
            (section.current?.querySelector<HTMLElement>('button[aria-haspopup="dialog"]') ??
              document.querySelector<HTMLElement>(`[data-track-select="${track.id}"]`))?.focus(),
          );
        }}
        track={track}
        currentLoopId={loopDoc?.id ?? null}
        actions={clipActions}
      />
    </section>
  );
}
