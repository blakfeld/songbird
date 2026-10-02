"use client";

import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { hintClass } from "@/components/ui/classes";
import type { PadSettings as PadDoc } from "@/generated/PadSettings";
import type { Row } from "@/generated/Row";
import type { Sample } from "@/generated/Sample";
import { formatLength } from "@/lib/song/audioTime";
import { PAD_GAIN_DB_RANGE, PAD_PITCH_RANGE } from "@/lib/song/sampler";
import { Knob } from "../Knob";
import { menuItemClass } from "../Menu";
import { decibels, semitones, spokenDecibels, spokenSemitones } from "../TrackSoundPanel";
import type { SamplerActions } from "../useSamplerActions";

export function PadSettingsPanel({
  trackId,
  row,
  pad,
  sample,
  missing,
  actions,
  onChoose,
  onClear,
  onClose,
}: {
  trackId: string;
  row: Row;
  pad: PadDoc | undefined;
  sample: Sample | undefined;
  missing: boolean;
  actions: SamplerActions;
  onChoose: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const empty = pad === undefined;
  const name = sample?.name ?? "the sample";
  return (
    <>
      <p className="truncate px-3 pt-2 text-sm font-semibold">
        {row.name} · {empty ? "empty" : name}
      </p>
      {sample && !missing && (
        <p className={`${hintClass} px-3 tabular-nums`}>
          {formatLength(sample.length_samples, sample.sample_rate)} · {sample.channels > 1 ? "Stereo" : "Mono"}
        </p>
      )}
      {missing && (
        <div className="px-2 pt-1">
          <ErrorAlert message={`${name}'s audio isn't in this browser, so this pad is silent.`} />
        </div>
      )}
      <div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
      <button type="button" className={menuItemClass} onClick={onChoose}>
        Choose sample…
      </button>
      {/* Auditions through the track, not raw, because this panel exists to tune the pad and its knobs must be heard. */}
      <button
        type="button"
        aria-label={`Preview ${row.name}`}
        aria-disabled={empty || missing}
        title={missing ? "Audio missing" : undefined}
        className={menuItemClass}
        onClick={() => {
          if (!empty && !missing) actions.audition(trackId, row);
        }}
      >
        <span aria-hidden="true">▶</span> Preview
      </button>
      <button
        type="button"
        aria-disabled={empty}
        className={menuItemClass}
        onClick={() => {
          if (empty) return;
          onClear();
          onClose();
        }}
      >
        Clear pad
      </button>
      <div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
      {pad ? (
        <div className="flex justify-around p-2">
          <div className="flex flex-col items-center gap-1">
            <Knob
              size="md"
              bipolar
              label={`${row.name} gain`}
              value={pad.gain_db}
              min={PAD_GAIN_DB_RANGE.min}
              max={PAD_GAIN_DB_RANGE.max}
              step={0.5}
              defaultValue={0}
              snap={{ value: 0, within: 0.5 }}
              format={spokenDecibels}
              formatReadout={decibels}
              onChange={(v, o) => actions.padGain(trackId, row.id, v, o.transient)}
              onGestureStart={actions.beginGesture}
              onGestureEnd={actions.endGesture}
            />
            <span aria-hidden="true" className={`${hintClass} tabular-nums`}>
              Gain {decibels(pad.gain_db)}
            </span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Knob
              size="md"
              bipolar
              label={`${row.name} pitch`}
              value={pad.pitch_semitones}
              min={PAD_PITCH_RANGE.min}
              max={PAD_PITCH_RANGE.max}
              step={1}
              defaultValue={0}
              snap={{ value: 0, within: 0.5 }}
              format={spokenSemitones}
              formatReadout={semitones}
              onChange={(v, o) => actions.padPitch(trackId, row.id, v, o.transient)}
              onGestureStart={actions.beginGesture}
              onGestureEnd={actions.endGesture}
            />
            <span aria-hidden="true" className={`${hintClass} tabular-nums`}>
              Pitch {semitones(pad.pitch_semitones)}
            </span>
          </div>
        </div>
      ) : (
        <p className={`${hintClass} px-3 pb-2`}>Choose or drop a sample to set gain and pitch.</p>
      )}
    </>
  );
}
