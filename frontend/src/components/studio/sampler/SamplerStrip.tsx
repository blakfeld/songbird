"use client";

import { useId, useRef } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { focusRing, hintClass, labelClass } from "@/components/ui/classes";
import { getSamplePreview } from "@/lib/audio/samplePreview";
import { useSampleMissing } from "@/lib/audio/useSampleMissing";
import { formatLength } from "@/lib/song/audioTime";
import { DEFAULT_ROOT_NOTE, noteName } from "@/lib/song/sampler";
import type { Song, Track } from "@/lib/song/types";
import { loopColour } from "../loopPalette";
import { usePreviewId } from "../samples/SamplesPanel";
import { useDragActive } from "../samples/useSampleDrop";
import type { SamplerActions, SamplerImporting } from "../useSamplerActions";
import { DragTip } from "./DragTip";
import { useSamplerDrop } from "./useSamplerDrop";

const ROOT_NOTES = Array.from({ length: 128 }, (_, midi) => midi);

const swatchClass = "size-3 shrink-0 rounded-sm";

export function SamplerStrip({
  song,
  track,
  actions,
  importing,
}: {
  song: Song;
  track: Track;
  actions: SamplerActions;
  importing: SamplerImporting | null;
}) {
  const keys = track.sampler?.keys;
  const sampleId = keys?.sample_id ?? null;
  const sample = sampleId ? (song.samples ?? []).find((s) => s.id === sampleId) : undefined;
  const colourIndex = sampleId ? (song.samples ?? []).findIndex((s) => s.id === sampleId) : -1;
  const missing = useSampleMissing(sampleId);
  const previewing = usePreviewId() === sampleId && sampleId !== null;
  const dragActive = useDragActive();
  const chooseButton = useRef<HTMLButtonElement>(null);
  const rootHint = useId();
  const oneShotHint = useId();
  const busy = importing !== null && importing.trackId === track.id;

  const { hover, props } = useSamplerDrop({
    single: true,
    onDrop: (payload) => {
      if (payload.kind === "sample") actions.chooseKeys(track.id, payload.entry);
      else actions.importDropped({ trackId: track.id, rowId: null }, payload.files);
    },
  });

  const name = sample?.name ?? "the sample";
  const oneShot = keys?.one_shot ?? false;
  const empty = sampleId === null;
  const unusable = empty || missing;

  const ring = hover
    ? hover.invalid
      ? "ring-2 ring-inset ring-red-700 dark:ring-red-400"
      : "ring-2 ring-inset ring-indigo-600 bg-indigo-50/60 dark:ring-indigo-400 dark:bg-indigo-950/40"
    : dragActive
      ? "ring-1 ring-inset ring-indigo-600/40 dark:ring-indigo-400/40"
      : "";
  const tip = hover
    ? hover.invalid
      ? `⊘ ${hover.invalid}`
      : hover.kind === "sample"
        ? `${hover.name ?? "Sample"} → ${track.name}`
        : `Import → ${track.name}`
    : null;

  const chooseLabel = empty ? "Choose sample" : `Sample ${name}${missing ? ", audio missing" : ""}. Choose sample`;

  return (
    <div
      role="group"
      aria-label="Sampler"
      aria-busy={busy || undefined}
      {...props}
      className={`relative flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800 ${ring}`}
    >
      <div className="flex items-center gap-1">
        <button
          ref={chooseButton}
          data-sampler-choose
          type="button"
          aria-label={chooseLabel}
          aria-haspopup="dialog"
          onClick={(e) => actions.requestPick({ trackId: track.id, rowId: null }, e.currentTarget)}
          className={`inline-flex h-8 items-center gap-2 rounded-md px-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${focusRing}`}
        >
          {busy ? (
            <>
              <Spinner />
              <span className="text-sm font-medium">Importing… {Math.round(importing.percent)}%</span>
            </>
          ) : (
            <>
              <span
                aria-hidden="true"
                className={
                  empty
                    ? `${swatchClass} border border-dashed border-zinc-400 dark:border-zinc-600`
                    : missing
                      ? `${swatchClass} border border-dashed border-red-700 dark:border-red-400`
                      : `${swatchClass} ${loopColour(Math.max(0, colourIndex)).swatch}`
                }
              />
              <span
                className={`max-w-48 truncate text-sm ${
                  empty ? "font-medium" : missing ? "font-semibold text-red-800 dark:text-red-300" : "font-semibold"
                }`}
              >
                {empty ? "Choose sample…" : missing ? `⚠ ${name}` : name}
              </span>
              <span aria-hidden="true">▾</span>
            </>
          )}
        </button>
        <button
          type="button"
          aria-label={sampleId ? `Preview ${name}` : "Preview sample"}
          aria-pressed={previewing}
          aria-disabled={unusable}
          title={missing ? "Audio missing" : undefined}
          onClick={() => {
            if (!unusable && sampleId) void getSamplePreview().toggle(sampleId);
          }}
          className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full border pointer-coarse:size-9 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${
            previewing
              ? "border-indigo-600 bg-indigo-600 text-white dark:border-indigo-400 dark:bg-indigo-400 dark:text-zinc-950"
              : "border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
          } ${focusRing}`}
        >
          <span aria-hidden="true">{previewing ? "■" : "▶"}</span>
        </button>
        <Button
          aria-label="Clear sample"
          aria-disabled={empty}
          className="!h-8 !px-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (empty) return;
            actions.clearKeys(track.id);
            requestAnimationFrame(() => chooseButton.current?.focus());
          }}
        >
          Clear
        </Button>
        {empty && !hover && <span className={`${hintClass} ml-1 max-sm:hidden`}>or drop a sample here</span>}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor={`${rootHint}-root`} className={`${labelClass} text-xs`}>
          Root
        </label>
        <Select
          id={`${rootHint}-root`}
          className="!h-8 w-20"
          aria-describedby={rootHint}
          value={keys?.root_note ?? DEFAULT_ROOT_NOTE}
          onChange={(e) => actions.setRoot(track.id, Number(e.target.value))}
        >
          {ROOT_NOTES.map((midi) => (
            <option key={midi} value={midi}>
              {noteName(midi)}
            </option>
          ))}
        </Select>
        <span id={rootHint} className="sr-only">
          The note that plays the sample at its original pitch.
        </span>
      </div>

      <div className="flex items-center">
        <span
          title={oneShot ? "Notes play the whole sample, whatever their length." : "Notes hold the sample for their length, then release."}
        >
          <Switch
            label="One-shot"
            checked={oneShot}
            describedBy={oneShotHint}
            onChange={(on) => actions.setOneShot(track.id, on)}
          />
        </span>
        <span id={oneShotHint} className="sr-only">
          {oneShot
            ? "Notes play the whole sample, whatever their length."
            : "Notes hold the sample for their length, then release."}
        </span>
      </div>

      {sample && !missing && (
        <p className={`${hintClass} ml-auto tabular-nums max-md:hidden`}>
          {formatLength(sample.length_samples, sample.sample_rate)} · {sample.channels > 1 ? "Stereo" : "Mono"}
        </p>
      )}
      {missing && (
        <div className="basis-full">
          <ErrorAlert
            message={`The audio for ${name} isn't in this browser, so this sampler is silent. Choose another sample, or open the project bundle that includes it.`}
          />
        </div>
      )}
      {tip && <DragTip text={tip} className="top-full left-2 mt-1" />}
    </div>
  );
}
