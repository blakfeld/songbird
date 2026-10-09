"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Playback } from "@/lib/audio/types";
import type { LoopSetting } from "@/lib/loopRegion";
import { beatSteps } from "@/lib/pianoRoll";
import { SAMPLER_INFOS } from "@/lib/song/sampler";
import { audibleTracks } from "@/lib/song/songOps";
import type { Song } from "@/lib/song/types";
import type { ResourceState } from "@/lib/useApiResource";
import { LoopShade } from "@/components/editor/LoopShade";
import { LoopRegion } from "@/components/editor/LoopRegion";
import { MeasureRuler } from "@/components/editor/MeasureRuler";
import { Playhead } from "@/components/editor/Playhead";
import { AddTrackMenu } from "./AddTrackMenu";
import { TrackLane } from "./TrackLane";
import type { InstrumentLookup } from "./TrackHeader";
import type { TrackActions } from "./trackActions";
import { useTrackDrag } from "./useTrackDrag";
import { PastEnd } from "./PastEnd";
import { CLIP_KEYS_HELP, CLIP_KEYS_HELP_ID } from "./ClipLane";
import type { ClipActions } from "./useClipActions";
import type { AudioActions } from "./useAudioActions";
import { AUDIO_CLIP_KEYS_HELP, AUDIO_CLIP_KEYS_HELP_ID } from "./audio/AudioClipLane";
import { SectionRuler, SECTION_KEYS_HELP, SECTION_KEYS_HELP_ID } from "./SectionRuler";
import type { SectionActions } from "./SectionMenu";
import { sectionsOf } from "@/lib/songSectionOps";
import { MEASURE_RANGE } from "@/lib/song/types";
import { focusRing } from "@/components/ui/classes";
import { NewTrackDropZone } from "./samples/NewTrackDropZone";
import { useDragActive, type SampleDrop } from "./samples/useSampleDrop";

// Wide enough that two neighbouring bar numbers never touch.
const MIN_LABEL_GAP_PX = 32;
// Below this a beat tick is finer than a pixel grid can show.
const MIN_MEASURE_FOR_BEATS_PX = 48;
const LABEL_STEPS = [1, 2, 4, 8, 16];

export function labelEveryFor(laneWidth: number, measures: number) {
  if (laneWidth <= 0) return 1;
  const gap = laneWidth / measures;
  return LABEL_STEPS.find((n) => gap * n >= MIN_LABEL_GAP_PX) ?? LABEL_STEPS.at(-1)!;
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Recomputed only on resize, so the ruler never measures during playback.
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function Arrangement({
  song,
  timeline,
  selectedTrackId,
  selectedClipId,
  instruments,
  onRetryInstruments,
  loop,
  onLoopChange,
  subscribePosition,
  actions,
  soundTrackId,
  onSoundTrack,
  clipActions,
  audioActions,
  onSampleDrop,
  generatingTrackId,
  onAddTrack,
  onAddAudio,
  onAddSampler,
  onSeek,
  sectionId,
  selectedSectionId,
  sectionActions,
  commentMarkers,
}: {
  song: Song;
  timeline: number;
  selectedTrackId: string | null;
  selectedClipId: string | null;
  instruments: ResourceState<InstrumentInfo[]>;
  onRetryInstruments: () => void;
  loop: LoopSetting;
  onLoopChange: (loop: LoopSetting) => void;
  subscribePosition: Playback["subscribePosition"];
  actions: TrackActions;
  soundTrackId: string | null;
  onSoundTrack: (trackId: string | null) => void;
  clipActions: ClipActions;
  audioActions: AudioActions;
  onSampleDrop: SampleDrop["onDrop"];
  generatingTrackId: string | null;
  onAddTrack: (instrument: InstrumentInfo) => void;
  onAddAudio: () => void;
  onAddSampler: (kind: "keys" | "pads") => void;
  onSeek: (trackId: string, measureIndex: number) => void;
  sectionId: string;
  selectedSectionId: string | null;
  sectionActions: SectionActions;
  commentMarkers?: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const rulerCell = useRef<HTMLDivElement>(null);
  const laneWidth = useElementWidth(rulerCell);
  const steps = timeline * song.steps_per_measure;
  const measureWidth = laneWidth / timeline;
  const audible = new Set(audibleTracks(song).map((t) => t.id));
  // Container-relative units let the lanes reflow on any resize or length change without JS measuring on every change.
  const fit = { "--cell-w": `calc(100cqw / ${steps})` } as React.CSSProperties;

  // A fresh node per announcement, because a live region stays silent when its text is replaced with the same words.
  const [announcement, setAnnouncement] = useState({ text: "", seq: 0 });
  const lanesRef = useRef<HTMLDivElement>(null);
  const focusAfterMove = useRef<string | null>(null);

  // A reordered node can lose focus when React moves it, so focus is restored once the new order has rendered.
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = null;
    sectionRef.current?.querySelector<HTMLElement>(`[data-track-select="${CSS.escape(id)}"]`)?.focus();
  }, [song.tracks]);

  const moveTrack = (trackId: string, toIndex: number, options?: { restoreFocus?: boolean }) => {
    const from = song.tracks.findIndex((t) => t.id === trackId);
    if (from < 0) return;
    const to = Math.min(Math.max(toIndex, 0), song.tracks.length - 1);
    if (to === from) return;
    if (options?.restoreFocus) focusAfterMove.current = trackId;
    actions.move(trackId, to);
    setAnnouncement((a) => ({
      text: `${song.tracks[from].name} moved to position ${to + 1} of ${song.tracks.length}`,
      seq: a.seq + 1,
    }));
  };

  const trackDrag = useTrackDrag({
    order: song.tracks.map((t) => t.id).join("\n"),
    lanes: lanesRef,
    scroller: sectionRef,
    onDrop: (trackId, toIndex) => moveTrack(trackId, toIndex, { restoreFocus: true }),
  });

  const dragActive = useDragActive();
  const drop: SampleDrop = { active: dragActive, onDrop: onSampleDrop };

  const lookup = (instrument: string): InstrumentLookup => {
    if (instrument === "audio") return { state: "audio" };
    // Checked before the request status, because the samplers are built in and need nothing from the server.
    const builtIn = SAMPLER_INFOS.find((i) => i.id === instrument);
    if (builtIn) return { state: "ready", info: builtIn };
    if (instruments.status !== "ready") return { state: "loading" };
    const info = instruments.data.find((i) => i.id === instrument);
    return info ? { state: "ready", info } : { state: "missing" };
  };

  return (
    <section
      ref={sectionRef}
      id={sectionId}
      tabIndex={-1}
      aria-label="Arrangement"
      className="relative min-h-0 overflow-x-hidden overflow-y-auto overscroll-x-contain border-t border-zinc-200 bg-white max-md:max-h-[50dvh] dark:border-zinc-800 dark:bg-zinc-950"
    >
      <p id={CLIP_KEYS_HELP_ID} className="sr-only">
        {CLIP_KEYS_HELP}
      </p>
      <p id={AUDIO_CLIP_KEYS_HELP_ID} className="sr-only">
        {AUDIO_CLIP_KEYS_HELP}
      </p>
      <p id={SECTION_KEYS_HELP_ID} className="sr-only">
        {SECTION_KEYS_HELP}
      </p>
      <p className="sr-only">
        {song.sections && song.sections.length > 0
          ? `Song length: ${song.measures} ${song.measures === 1 ? "measure" : "measures"} in ${sectionsOf(song).length} ${sectionsOf(song).length === 1 ? "section" : "sections"}. Change a section's length or add a section to lengthen it.`
          : `Song length: ${song.measures} ${song.measures === 1 ? "measure" : "measures"}. Add clips after the end to lengthen it.`}
      </p>
      <p id="add-section-full" className="sr-only">
        The song is {MEASURE_RANGE.max} measures, the most it can hold
      </p>
      <div aria-live="polite" className="sr-only">
        <p key={announcement.seq}>{announcement.text}</p>
      </div>
      <div className="sticky top-0 z-40 grid grid-cols-[var(--gutter-w)_minmax(0,1fr)] bg-white dark:bg-zinc-950">
        <div className="flex h-12 items-center gap-2 border-r border-b border-zinc-300 px-3 py-2 max-sm:px-2 dark:border-zinc-700">
          <AddTrackMenu
            instruments={instruments}
            onRetry={onRetryInstruments}
            trackCount={song.tracks.length}
            onAdd={onAddTrack}
            onAddAudio={onAddAudio}
            onAddSampler={onAddSampler}
          />
        </div>
        <div ref={rulerCell} className="@container min-w-0">
          <div style={fit}>
            <MeasureRuler
              measures={timeline}
              stepsPerMeasure={song.steps_per_measure}
              beatSteps={beatSteps(song.time_signature)}
              labelEvery={labelEveryFor(laneWidth, timeline)}
              showBeats={measureWidth >= MIN_MEASURE_FOR_BEATS_PX}
              dimFrom={song.measures}
              heightClass="h-12"
            >
              <PastEnd song={song} timeline={timeline} />
              <LoopRegion
                loop={loop}
                measures={timeline}
                stepsPerMeasure={song.steps_per_measure}
                measurePx={measureWidth}
                onChange={onLoopChange}
              />
            </MeasureRuler>
          </div>
        </div>
        <div className="flex h-8 items-center justify-between gap-2 border-r border-b border-zinc-300 px-3 max-sm:px-2 dark:border-zinc-700">
          <span className="text-xs font-semibold text-zinc-600 max-sm:sr-only dark:text-zinc-400">Sections</span>
          <button
            type="button"
            aria-label="Add section"
            aria-disabled={song.measures >= MEASURE_RANGE.max}
            aria-describedby={song.measures >= MEASURE_RANGE.max ? "add-section-full" : undefined}
            title={song.measures >= MEASURE_RANGE.max ? `The song is ${MEASURE_RANGE.max} measures, the most it can hold` : undefined}
            onClick={(e) => sectionActions.add(e.currentTarget)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-900 hover:bg-zinc-100 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 max-sm:px-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900 ${focusRing}`}
          >
            <span aria-hidden="true">+</span>
            <span className="max-sm:hidden">Add section</span>
          </button>
        </div>
        <div className="@container min-w-0">
          <div style={fit}>
            <SectionRuler song={song} selectedId={selectedSectionId} actions={sectionActions}>
              <PastEnd song={song} timeline={timeline} />
              {commentMarkers}
            </SectionRuler>
          </div>
        </div>
      </div>
      {song.tracks.length === 0 && !dragActive && (
        <div className="relative flex flex-col items-center gap-1 px-6 py-10 text-center">
          <h2 className="text-sm font-semibold">This song has no tracks yet</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Add a track, or describe a part in the chat.
          </p>
        </div>
      )}
      <div ref={lanesRef} className="relative">
        {song.tracks.map((track, i) => (
          <TrackLane
            song={song}
            timeline={timeline}
            key={track.id}
            track={track}
            number={i + 1}
            selected={track.id === selectedTrackId}
            audible={audible.has(track.id)}
            instrument={lookup(track.instrument)}
            selectedClipId={selectedClipId}
            first={i === 0}
            count={song.tracks.length}
            grip={trackDrag.gripProps(track.id, i)}
            dragging={trackDrag.draggingId === track.id}
            onMove={(to, options) => moveTrack(track.id, to, options)}
            actions={actions}
            soundOpen={track.id === soundTrackId}
            onSoundOpen={(open) => onSoundTrack(open ? track.id : null)}
            clipActions={clipActions}
            audioActions={audioActions}
            drop={drop}
            generatingTrackId={generatingTrackId}
            onSeek={onSeek}
          />
        ))}
        {dragActive && <NewTrackDropZone song={song} timeline={timeline} drop={drop} />}
        {trackDrag.indicatorTop !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-indigo-600 dark:bg-indigo-400"
            style={{ top: trackDrag.indicatorTop }}
          />
        )}
        {/* One playhead and loop shade span every lane at the lanes' own scale. */}
        <div
          aria-hidden="true"
          className="@container pointer-events-none absolute inset-y-0 right-0 left-[var(--gutter-w)]"
        >
          <div className="relative h-full" style={fit}>
            <LoopShade loop={loop} measures={timeline} stepsPerMeasure={song.steps_per_measure} />
            <Playhead subscribePosition={subscribePosition} />
          </div>
        </div>
      </div>
    </section>
  );
}
