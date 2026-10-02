"use client";

import { useId, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { TokenCounter } from "@/components/editor/TokenCounter";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing, inputClass } from "@/components/ui/classes";
import { getSongLimits } from "@/lib/api";
import { estimateTokens } from "@/lib/estimateTokens";
import { isSubmitEnter } from "@/lib/isSubmitEnter";
import { activeLoopRange, MAX_GENERATE_MEASURES } from "@/lib/song/songLoop";
import { MEASURE_RANGE, type Song, type Track } from "@/lib/song/types";
import { useApiResource } from "@/lib/useApiResource";

export interface GenerateRequest {
  prompt: string;
  // Omitted means the whole song, which the server accepts only for songs it can read in one go.
  range?: { start_measure: number; end_measure: number };
}

type Choice = "song" | "loop" | "custom";

const SHORT_SONG_MEASURES = 4;
const DEFAULT_NEW_SPAN = 8;

const numberOrNaN = (text: string) => (text.trim() === "" ? NaN : Number(text));

function GenerateForm({
  song,
  track,
  initialPrompt,
  initialError,
  onSubmit,
  onClose,
}: {
  song: Song;
  track: Track;
  initialPrompt: string;
  initialError: string | null;
  onSubmit: (request: GenerateRequest) => void;
  onClose: () => void;
}) {
  const id = useId();
  const limits = useApiResource(getSongLimits);
  const [prompt, setPrompt] = useState(initialPrompt);
  const loopRange = activeLoopRange(song);
  const wholeSongOffered = song.measures <= MAX_GENERATE_MEASURES;
  // A new song is one measure long, so "whole song" would generate a single bar; the span grows the song instead.
  const tiny = song.measures < SHORT_SONG_MEASURES;
  const [choice, setChoice] = useState<Choice>(
    loopRange ? "loop" : wholeSongOffered && !tiny ? "song" : "custom",
  );
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState(String(tiny ? DEFAULT_NEW_SPAN : SHORT_SONG_MEASURES));

  const max = limits.data?.max_input_tokens ?? null;
  const count = estimateTokens(prompt);
  const overLimit = max !== null && count > max;

  const startNumber = numberOrNaN(start);
  const endNumber = numberOrNaN(end);
  const customError =
    choice !== "custom"
      ? null
      : !Number.isInteger(startNumber) || !Number.isInteger(endNumber)
        ? "Enter whole measure numbers."
        : startNumber < 1 || endNumber > MEASURE_RANGE.max || startNumber > endNumber
          ? `Choose measures from 1 to ${MEASURE_RANGE.max}, with the end after the start.`
          : endNumber - startNumber + 1 > MAX_GENERATE_MEASURES
            ? `Generate at most ${MAX_GENERATE_MEASURES} measures at a time.`
            : null;

  const canSubmit =
    prompt.trim() !== "" && !overLimit && limits.status === "ready" && customError === null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const range =
      choice === "loop"
        ? (loopRange ?? undefined)
        : choice === "custom"
          ? { start_measure: startNumber, end_measure: endNumber }
          : undefined;
    onSubmit({ prompt: prompt.trim(), ...(range && { range }) });
    onClose();
  };

  const radio = (value: Choice, label: string, offered: boolean) =>
    offered && (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name={`${id}-range`}
          value={value}
          checked={choice === value}
          onChange={() => setChoice(value)}
          className={`size-4 ${focusRing}`}
        />
        {label}
      </label>
    );

  return (
    <form onSubmit={submit} aria-busy={limits.status === "loading"} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        Generate {track.name}
      </h2>
      {initialError && <ErrorAlert message={initialError} />}
      {limits.status === "error" && (
        <ErrorAlert message="Couldn't load generation limits." onRetry={limits.retry} />
      )}
      <Field label="Describe the part" htmlFor={`${id}-prompt`}>
        <textarea
          id={`${id}-prompt`}
          autoFocus
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. a walking bass that locks in with the kick"
          onKeyDown={(e) => {
            // Submitting through the form keeps the canSubmit guard in `submit` as the single decision point.
            if (isSubmitEnter(e)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          aria-describedby={`${id}-prompt-hint ${id}-token-count`}
          aria-invalid={overLimit}
          className={`${inputClass} h-auto w-full resize-y py-2`}
        />
      </Field>
      <p id={`${id}-prompt-hint`} className="text-xs text-zinc-600 dark:text-zinc-400">
        Enter to generate · Shift+Enter for a new line
      </p>
      <TokenCounter id={`${id}-token-count`} count={count} max={max} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Range</legend>
        {radio("song", `Whole song (${song.measures} ${song.measures === 1 ? "measure" : "measures"})`, wholeSongOffered)}
        {loopRange &&
          radio(
            "loop",
            `Loop range (measures ${loopRange.start_measure}–${loopRange.end_measure})`,
            true,
          )}
        {radio("custom", "Custom measures", true)}
        {choice === "custom" && (
          <div className="flex flex-wrap items-end gap-3 pl-6">
            <Field label="From measure" htmlFor={`${id}-start`}>
              <input
                id={`${id}-start`}
                type="number"
                inputMode="numeric"
                min={1}
                max={MEASURE_RANGE.max}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                aria-invalid={customError !== null}
                aria-describedby={customError ? `${id}-range-error` : undefined}
                className={`${inputClass} w-24`}
              />
            </Field>
            <Field label="To measure" htmlFor={`${id}-end`}>
              <input
                id={`${id}-end`}
                type="number"
                inputMode="numeric"
                min={1}
                max={MEASURE_RANGE.max}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                aria-invalid={customError !== null}
                aria-describedby={customError ? `${id}-range-error` : undefined}
                className={`${inputClass} w-24`}
              />
            </Field>
            {customError && (
              <p id={`${id}-range-error`} role="alert" className="basis-full text-xs text-red-700 dark:text-red-400">
                {customError}
              </p>
            )}
          </div>
        )}
      </fieldset>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Replaces what {track.name} plays in that range. A range past the end of the song makes it longer. Undo restores it.
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {limits.status === "loading" && <Spinner />}
          Generate
        </Button>
      </div>
    </form>
  );
}

export function TrackGenerateDialog({
  open,
  song,
  track,
  initialPrompt = "",
  initialError = null,
  onSubmit,
  onClose,
}: {
  open: boolean;
  song: Song;
  track: Track;
  initialPrompt?: string;
  initialError?: string | null;
  onSubmit: (request: GenerateRequest) => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog open={open} onClose={onClose} label={`Generate ${track.name}`} className="m-auto w-full max-w-lg rounded-2xl p-6">
      <GenerateForm
        song={song}
        track={track}
        initialPrompt={initialPrompt}
        initialError={initialError}
        onSubmit={onSubmit}
        onClose={onClose}
      />
    </ModalDialog>
  );
}
