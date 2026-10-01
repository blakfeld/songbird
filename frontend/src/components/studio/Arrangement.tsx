"use client";

import { useEffect, useRef, useState } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Playback } from "@/lib/audio/types";
import type { LoopSetting } from "@/lib/loopRegion";
import { beatSteps } from "@/lib/pianoRoll";
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
import { PastEnd } from "./PastEnd";
import { CLIP_KEYS_HELP, CLIP_KEYS_HELP_ID } from "./ClipLane";
import type { ClipActions } from "./useClipActions";

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
  clipActions,
  onAddTrack,
  onSeek,
  sectionId,
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
  clipActions: ClipActions;
  onAddTrack: (instrument: InstrumentInfo) => void;
  onSeek: (trackId: string, measureIndex: number) => void;
  sectionId: string;
}) {
  const rulerCell = useRef<HTMLDivElement>(null);
  const laneWidth = useElementWidth(rulerCell);
  const steps = timeline * song.steps_per_measure;
  const measureWidth = laneWidth / timeline;
  const audible = new Set(audibleTracks(song).map((t) => t.id));
  // Container-relative units let the lanes reflow on any resize or length change without JS measuring on every change.
  const fit = { "--cell-w": `calc(100cqw / ${steps})` } as React.CSSProperties;

  const lookup = (instrument: string): InstrumentLookup => {
    if (instruments.status !== "ready") return { state: "loading" };
    const info = instruments.data.find((i) => i.id === instrument);
    return info ? { state: "ready", info } : { state: "missing" };
  };

  return (
    <section
      id={sectionId}
      tabIndex={-1}
      aria-label="Arrangement"
      className="relative min-h-0 overflow-x-hidden overflow-y-auto overscroll-x-contain border-t border-zinc-200 bg-white max-md:max-h-[50dvh] dark:border-zinc-800 dark:bg-zinc-950"
    >
      <p id={CLIP_KEYS_HELP_ID} className="sr-only">
        {CLIP_KEYS_HELP}
      </p>
      <p className="sr-only">
        Song length: {song.measures} {song.measures === 1 ? "measure" : "measures"}. Add clips after the end to
        lengthen it.
      </p>
      <div className="sticky top-0 z-40 grid grid-cols-[var(--gutter-w)_minmax(0,1fr)] bg-white dark:bg-zinc-950">
        <div className="flex h-7 items-center gap-2 border-r border-b border-zinc-300 px-2 dark:border-zinc-700">
          <AddTrackMenu
            instruments={instruments}
            onRetry={onRetryInstruments}
            trackCount={song.tracks.length}
            onAdd={onAddTrack}
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
      </div>
      <div className="relative">
        {song.tracks.map((track, i) => (
          <TrackLane
            song={song}
            timeline={timeline}
            key={track.id}
            track={track}
            number={i + 1}
            selected={track.id === selectedTrackId}
            audible={audible.has(track.id)}
            canDelete={song.tracks.length > 1}
            instrument={lookup(track.instrument)}
            selectedClipId={selectedClipId}
            first={i === 0}
            actions={actions}
            clipActions={clipActions}
            onSeek={onSeek}
          />
        ))}
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
