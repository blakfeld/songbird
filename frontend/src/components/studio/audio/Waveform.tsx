"use client";

import { useId, useMemo } from "react";
import type { AudioClip } from "@/generated/AudioClip";
import { peaksPath } from "@/lib/audio/waveformPath";
import { CLIP_GAIN_DB_RANGE } from "@/lib/song/audioTiming";
import type { LoopColour } from "../loopPalette";

// 0 dB sits two thirds of the way up, because the range runs 24 dB down and 12 dB up.
const gainY = (db: number) =>
  1 - (2 * (db - CLIP_GAIN_DB_RANGE.min)) / (CLIP_GAIN_DB_RANGE.max - CLIP_GAIN_DB_RANGE.min);

export const gainScale = (db: number) => 10 ** (db / 20);

// The clip's own audio as drawn on a lane: loop repeats reuse one path, and the viewBox crops the last partial repeat.
export function Waveform({
  clip,
  sampleId,
  overview,
  palette,
  className = "absolute inset-x-0 top-4 bottom-0.5 h-[calc(100%-1.125rem)] w-full",
  envelope = true,
}: {
  clip: Pick<
    AudioClip,
    "offset_samples" | "slice_samples" | "length_samples" | "loop" | "gain_db" | "fade_in_samples" | "fade_out_samples"
  >;
  sampleId: string;
  overview: Float32Array | null;
  palette: LoopColour;
  className?: string;
  envelope?: boolean;
}) {
  const id = useId();
  const length = clip.length_samples;
  const slice = clip.slice_samples;
  const fi = Math.min(clip.fade_in_samples, length);
  const fo = Math.min(clip.fade_out_samples, length - fi);
  const path = useMemo(
    () => (overview ? peaksPath(overview, clip.offset_samples, slice, sampleId) : ""),
    [overview, clip.offset_samples, slice, sampleId],
  );
  const repeats = clip.loop && length > slice ? Math.ceil(length / slice) - 1 : 0;
  const g = gainScale(clip.gain_db);
  const y = gainY(clip.gain_db);

  if (!overview)
    return (
      <svg aria-hidden="true" viewBox="0 -1 100 2" preserveAspectRatio="none" className={className}>
        <line x1="0" x2="100" y1="0" y2="0" className="stroke-current opacity-40 motion-safe:animate-pulse" vectorEffect="non-scaling-stroke" />
      </svg>
    );

  return (
    <svg aria-hidden="true" viewBox={`0 -1 ${length} 2`} preserveAspectRatio="none" className={className}>
      <defs>
        <clipPath id={`${id}-fade`}>
          <polygon points={`0,0 ${fi},-1 ${length - fo},-1 ${length},0 ${length - fo},1 ${fi},1`} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-fade)`}>
        <g data-testid="clip-wave" data-gain-scale={g.toFixed(3)} transform={`scale(1 ${g})`}>
          <path id={`${id}-slice`} d={path} className={palette.note} />
          {Array.from({ length: repeats }, (_, k) => (
            <use key={k} href={`#${id}-slice`} x={(k + 1) * slice} />
          ))}
        </g>
      </g>
      {repeats > 0 &&
        Array.from({ length: repeats }, (_, k) => (
          <line
            key={k}
            data-testid="repeat-mark"
            x1={(k + 1) * slice}
            x2={(k + 1) * slice}
            y1={-1}
            y2={1}
            className="stroke-zinc-900/40 dark:stroke-zinc-50/40"
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      {envelope && (
        <polyline
          data-testid="clip-envelope"
          points={`0,1 ${fi},${y} ${length - fo},${y} ${length},1`}
          className="fill-none stroke-zinc-900/70 dark:stroke-zinc-50/70"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
