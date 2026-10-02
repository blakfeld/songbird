"use client";

import type { AudioClip } from "@/generated/AudioClip";
import { focusRing } from "@/components/ui/classes";
import { Waveform } from "./Waveform";
import { LoopGlyph } from "./LoopGlyph";
import type { LoopColour } from "../loopPalette";
import { CLIP_GAIN_DB_RANGE } from "@/lib/song/audioTiming";

const handleBase = "absolute z-20 touch-none";
const gripClass = (shown: boolean) =>
  `h-3 w-0.5 rounded-full bg-zinc-900/60 group-hover/clip:visible dark:bg-zinc-50/60 ${shown ? "visible" : "invisible"}`;
const fadeKnob = (shown: boolean) =>
  `size-2.5 rounded-sm border border-zinc-900 bg-white group-hover/clip:visible dark:border-zinc-50 dark:bg-zinc-950 ${shown ? "visible" : "invisible"}`;

// Missing audio swaps the palette for dashes and a hatch, so the state never rests on colour alone.
const missingClass =
  "border-dashed border-red-700 bg-zinc-100/70 bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(0_0_0/0.05)_6px_7px)] dark:border-red-400 dark:bg-zinc-900/60";

export function AudioClipBlock({
  clip,
  name,
  overview,
  palette,
  label,
  title,
  selected,
  audible,
  dragging,
  tabIndex,
  style,
  describedBy,
  handlers,
}: {
  clip: AudioClip;
  name: string;
  overview: Float32Array | null | "missing";
  palette: LoopColour;
  label: string;
  title: string;
  selected: boolean;
  audible: boolean;
  dragging: boolean;
  tabIndex: number;
  style: React.CSSProperties;
  describedBy: string;
  handlers: React.ComponentProps<"button">;
}) {
  const missing = overview === "missing";
  const shown = selected || dragging;
  const length = Math.max(1, clip.length_samples);
  const fi = Math.min(clip.fade_in_samples, length);
  const fo = Math.min(clip.fade_out_samples, length - fi);
  // The gain band follows the envelope line, which maps the gain range onto the waveform's height.
  const gainTop = `${((1 - (clip.gain_db - CLIP_GAIN_DB_RANGE.min) / (CLIP_GAIN_DB_RANGE.max - CLIP_GAIN_DB_RANGE.min)) * 100).toFixed(1)}%`;

  return (
    <button
      type="button"
      aria-roledescription="audio clip"
      aria-label={label}
      aria-describedby={describedBy}
      aria-keyshortcuts="Enter ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Delete Meta+D Control+D Shift+F10"
      aria-current={selected ? "true" : undefined}
      data-audio-clip-id={clip.id}
      data-selected={selected ? "true" : undefined}
      title={title}
      tabIndex={tabIndex}
      style={style}
      className={`group/clip @container/clip absolute top-1 bottom-1 min-w-[3px] cursor-grab touch-pan-y overflow-hidden rounded-md border text-left select-none hover:brightness-95 dark:hover:brightness-110 ${
        missing ? missingClass : palette.block
      } ${selected ? "shadow-sm ring-2 ring-zinc-900 dark:ring-zinc-50" : ""} ${dragging ? "z-20 cursor-grabbing shadow-md" : ""} ${
        audible ? "" : "opacity-40"
      } ${focusRing}`}
      {...handlers}
    >
      <span className="absolute inset-x-0 top-0 flex h-4 items-center gap-1 pr-3 pl-3 text-[11px] leading-4 font-medium text-zinc-900 @max-[2rem]/clip:hidden dark:text-zinc-50">
        <span className={`truncate ${selected ? "font-semibold" : ""}`}>{name}</span>
        {clip.loop && <LoopGlyph />}
      </span>
      {missing ? (
        <span className="absolute inset-x-0 top-4 bottom-0.5 flex items-center justify-center text-[11px] font-medium text-red-800 @max-[5rem]/clip:hidden dark:text-red-300">
          ⚠ Audio missing
        </span>
      ) : (
        <Waveform clip={clip} sampleId={clip.sample_id} overview={overview} palette={palette} />
      )}
      <span
        aria-hidden="true"
        data-handle="trim-start"
        className={`${handleBase} inset-y-0 left-0 flex w-2 cursor-ew-resize items-center justify-center @max-[2rem]/clip:hidden pointer-coarse:w-4`}
      >
        <span className={gripClass(shown)} />
      </span>
      <span
        aria-hidden="true"
        data-handle="trim-end"
        className={`${handleBase} inset-y-0 right-0 flex w-2 cursor-ew-resize items-center justify-center @max-[1.5rem]/clip:hidden pointer-coarse:w-4`}
      >
        <span className={gripClass(shown)} />
      </span>
      {!missing && (
        <>
          <span
            aria-hidden="true"
            data-handle="fade-in"
            style={{ left: `calc(${(fi / length) * 100}% - 0.375rem)` }}
            className={`${handleBase} top-0 flex size-3 cursor-ew-resize items-center justify-center @max-[3rem]/clip:hidden pointer-coarse:size-5`}
          >
            <span className={fadeKnob(shown)} />
          </span>
          <span
            aria-hidden="true"
            data-handle="fade-out"
            style={{ right: `calc(${(fo / length) * 100}% - 0.375rem)` }}
            className={`${handleBase} top-0 flex size-3 cursor-ew-resize items-center justify-center @max-[3rem]/clip:hidden pointer-coarse:size-5`}
          >
            <span className={fadeKnob(shown)} />
          </span>
          <span
            aria-hidden="true"
            data-handle="gain"
            style={{ top: `calc(1rem + (100% - 1.125rem) * ${parseFloat(gainTop) / 100} - 0.25rem)` }}
            className="absolute inset-x-3 z-10 h-2 cursor-ns-resize touch-none @max-[2rem]/clip:hidden pointer-coarse:h-4"
          />
        </>
      )}
    </button>
  );
}
