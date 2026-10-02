"use client";

import { useId, useMemo } from "react";
import type { AudioClip } from "@/generated/AudioClip";
import type { Sample } from "@/generated/Sample";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { hintClass } from "@/components/ui/classes";
import { peaksPath } from "@/lib/audio/waveformPath";
import { useSampleOverview } from "@/lib/audio/useSampleLibrary";
import { formatBarsBeats, formatFade, formatLength, formatPosition, lastFrameTicks } from "@/lib/song/audioTime";
import { CLIP_GAIN_DB_RANGE, clipEndTicks, sampleMap } from "@/lib/song/audioTiming";
import type { Song, Track } from "@/lib/song/types";
import { DockCloseButton } from "../DockCloseButton";
import { Knob } from "../Knob";
import { LoopSwatch } from "../ClipMenu";
import { Menu } from "../Menu";
import { formatDb } from "../VolumeSlider";
import { focusRing } from "@/components/ui/classes";
import { loopColour } from "../loopPalette";
import type { AudioActions } from "../useAudioActions";
import { AudioClipMenuItems } from "./AudioClipMenu";
import { canDuplicate } from "./AudioClipLane";
import { TakesList } from "./TakesList";

const MAX_KNOB_FADE_S = 30;
const MIN_FADE_S = 0.001;

function EmptyAudioDock({
  track,
  actions,
  onShowSamples,
  onClose,
}: {
  track: Track;
  actions: AudioActions;
  onShowSamples: () => void;
  onClose: () => void;
}) {
  const none = (track.audio_clips ?? []).length === 0;
  return (
    <>
      <div className="flex shrink-0 justify-end px-2 py-1">
        <DockCloseButton onClose={onClose} />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <h2 className="text-sm font-semibold">{none ? `${track.name} has no clips yet` : `No clip selected on ${track.name}`}</h2>
        <p className={hintClass}>Drop an audio file on the lane, or drag a sample from Samples.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => actions.importHere(track.id, null)}>
            Import audio…
          </Button>
          <Button onClick={onShowSamples}>Show samples</Button>
        </div>
      </div>
    </>
  );
}

function Overview({ clip, sample, palette }: { clip: AudioClip; sample: Sample; palette: ReturnType<typeof loopColour> }) {
  const overview = useSampleOverview(sample.id);
  const all = useMemo(
    () => (overview && overview !== "missing" ? peaksPath(overview, 0, sample.length_samples, sample.id) : ""),
    [overview, sample.id, sample.length_samples],
  );
  const slice = useMemo(
    () => (overview && overview !== "missing" ? peaksPath(overview, clip.offset_samples, clip.slice_samples, sample.id) : ""),
    [overview, clip.offset_samples, clip.slice_samples, sample.id],
  );
  if (!overview || overview === "missing") return <div aria-hidden="true" className="h-16" />;
  return (
    <svg
      aria-hidden="true"
      data-testid="sample-overview"
      viewBox={`0 -1 ${sample.length_samples} 2`}
      preserveAspectRatio="none"
      className="h-16 w-full"
    >
      <path d={all} className="fill-zinc-400 dark:fill-zinc-600" />
      <g transform={`translate(${clip.offset_samples} 0)`}>
        <path d={slice} className={palette.note} />
      </g>
    </svg>
  );
}

export function AudioClipPanel({
  song,
  track,
  clip,
  actions,
  onShowSamples,
  onClose,
}: {
  song: Song;
  track: Track;
  clip: AudioClip | undefined;
  actions: AudioActions;
  onShowSamples: () => void;
  onClose: () => void;
}) {
  const sample = clip ? sampleMap(song.samples).get(clip.sample_id) : undefined;
  const overview = useSampleOverview(clip?.sample_id ?? "");
  const loopHint = useId();
  if (!clip || !sample) return <EmptyAudioDock track={track} actions={actions} onShowSamples={onShowSamples} onClose={onClose} />;

  const index = (song.samples ?? []).findIndex((s) => s.id === sample.id);
  const palette = loopColour(Math.max(0, index));
  const rate = sample.sample_rate;
  const end = clipEndTicks(clip, rate, song.tempo_bpm);
  const missing = overview === "missing";
  const overLoop = clip.loop && clip.length_samples > clip.slice_samples;
  const fadeMax = (other: number) =>
    Math.max(MIN_FADE_S * 2, Math.min((clip.length_samples - other) / rate, MAX_KNOB_FADE_S));
  const fadeFormat = (v: number) => (v <= MIN_FADE_S ? "Off" : formatFade(Math.round(v * rate), rate));
  const toSamples = (v: number) => (v <= MIN_FADE_S ? 0 : Math.round(v * rate));
  const invoker = () => document.querySelector<HTMLElement>('button[aria-label^="Clip actions for"]');

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div
        role="toolbar"
        aria-label="Audio clip"
        className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800"
      >
        <div className="flex min-w-0 items-center gap-2">
          <LoopSwatch index={Math.max(0, index)} />
          <span className="max-w-48 truncate text-sm font-semibold">{sample.name}</span>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {track.name} · {formatPosition(clip.start_ticks, song)} – {formatPosition(lastFrameTicks(clip, rate, song), song)} ·{" "}
            {formatBarsBeats(end - clip.start_ticks, song)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Menu
            label={`Clip actions for ${sample.name}`}
            align="right"
            panelClassName="w-64"
            triggerClassName={`inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-zinc-100 pointer-coarse:size-9 dark:hover:bg-zinc-800 ${focusRing}`}
            trigger={<span aria-hidden="true">⋯</span>}
          >
            {(close) => (
              <AudioClipMenuItems
                song={song}
                trackId={track.id}
                clip={clip}
                actions={actions}
                close={close}
                focusResult={false}
                canDuplicate={canDuplicate(song, track, clip)}
                invoker={invoker}
              />
            )}
          </Menu>
          <DockCloseButton onClose={onClose} />
        </div>
      </div>
      {missing && (
        <div className="p-3">
          <ErrorAlert
            message={`The audio for ${sample.name} isn't in this browser, so this clip is silent. Replace it with a library sample, or open the project bundle that includes it.`}
          />
        </div>
      )}
      <div className="px-2 pt-2">
        <Overview clip={clip} sample={sample} palette={palette} />
        <p className={`${hintClass} tabular-nums`}>
          {formatLength(clip.offset_samples, rate)} – {formatLength(clip.offset_samples + clip.slice_samples, rate)} of{" "}
          {formatLength(sample.length_samples, rate)} · {sample.channels > 1 ? "Stereo" : "Mono"}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-4 p-3">
        <div className="flex flex-col items-center gap-1">
          <Knob
            size="md"
            bipolar
            label="Gain"
            value={clip.gain_db}
            min={CLIP_GAIN_DB_RANGE.min}
            max={CLIP_GAIN_DB_RANGE.max}
            step={0.5}
            defaultValue={0}
            snap={{ value: 0, within: 0.5 }}
            format={formatDb}
            onChange={(v, o) => actions.gain(track.id, clip.id, v, o.transient)}
            onGestureStart={actions.beginGesture}
            onGestureEnd={actions.endGesture}
          />
          <span className={hintClass}>Gain</span>
          <span className="text-xs tabular-nums">{formatDb(clip.gain_db)}</span>
        </div>
        {(["fadeIn", "fadeOut"] as const).map((which) => {
          const samples = which === "fadeIn" ? clip.fade_in_samples : clip.fade_out_samples;
          const other = which === "fadeIn" ? clip.fade_out_samples : clip.fade_in_samples;
          const label = which === "fadeIn" ? "Fade in" : "Fade out";
          return (
            <div key={which} className="flex flex-col items-center gap-1">
              <Knob
                size="md"
                scale="log"
                label={label}
                value={Math.min(fadeMax(other), Math.max(MIN_FADE_S, samples / rate))}
                min={MIN_FADE_S}
                max={fadeMax(other)}
                defaultValue={MIN_FADE_S}
                format={fadeFormat}
                onChange={(v, o) => actions.fades(track.id, clip.id, { [which]: toSamples(v) }, o.transient)}
                onGestureStart={actions.beginGesture}
                onGestureEnd={actions.endGesture}
              />
              <span className={hintClass}>{label}</span>
              <span className="text-xs tabular-nums">{formatFade(samples, rate)}</span>
            </div>
          );
        })}
        <div className="flex flex-col gap-1">
          <Switch
            checked={clip.loop}
            label="Loop"
            describedBy={overLoop ? loopHint : undefined}
            onChange={(on) => actions.loop(track.id, clip.id, on)}
          />
          {overLoop && (
            <p id={loopHint} className={hintClass}>
              Off limits the clip to its slice
            </p>
          )}
        </div>
        <Button
          variant={missing ? "primary" : "secondary"}
          onClick={(e) => actions.requestReplace(track.id, clip.id, e.currentTarget)}
        >
          Replace sample…
        </Button>
      </div>
      <TakesList song={song} track={track} clip={clip} actions={actions} />
    </div>
  );
}
