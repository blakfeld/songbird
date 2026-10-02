"use client";

import { useId, useState } from "react";
import type { GenerationLimits } from "@/generated/GenerationLimits";
import type { Pattern } from "@/generated/Pattern";
import type { TimeSignature } from "@/generated/TimeSignature";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { inputClass } from "@/components/ui/classes";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { generatePattern } from "@/lib/api";
import { estimateTokens } from "@/lib/estimateTokens";
import { getPatternStore, usePatternStore } from "@/lib/patternStore";
import { TEMPO_RANGE } from "@/lib/patternOps";
import { ErrorAlert } from "./ErrorAlert";
import { TokenCounter } from "./TokenCounter";

export const TIME_SIGNATURES: TimeSignature[] = ["4/4", "3/4", "6/8"];

interface Props {
  instrumentId: string;
  limits: GenerationLimits | null;
  limitsState: "loading" | "ready" | "error";
  onRetryLimits: () => void;
  onGenerated: (pattern: Pattern, hadPrevious: boolean) => void;
  // Lifted so the empty state's "blank grid" button uses the same choices as Generate.
  measures: number;
  onMeasuresChange: (m: number) => void;
  timeSignature: TimeSignature;
  onTimeSignatureChange: (ts: TimeSignature) => void;
}

export function PromptForm({
  instrumentId,
  limits,
  limitsState,
  onRetryLimits,
  onGenerated,
  measures,
  onMeasuresChange,
  timeSignature,
  onTimeSignatureChange,
}: Props) {
  const id = useId();
  const prompt = usePatternStore(instrumentId, (s) => s.prompt);
  const [tempo, setTempo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = estimateTokens(prompt);
  const max = limits?.max_input_tokens ?? null;
  const overLimit = max !== null && count > max;
  const [tempoBadInput, setTempoBadInput] = useState(false);
  const tempoNumber = tempo.trim() === "" ? null : Number(tempo);
  // The server rejects fractional tempos, and a number input reports unparseable text as an empty value.
  const tempoInvalid =
    tempoBadInput ||
    (tempoNumber !== null &&
      (!Number.isInteger(tempoNumber) ||
        tempoNumber < TEMPO_RANGE.min ||
        tempoNumber > TEMPO_RANGE.max));
  const canSubmit =
    prompt.trim() !== "" && !overLimit && limits !== null && !tempoInvalid && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      const pattern = await generatePattern({
        instrument: instrumentId,
        prompt: prompt.trim(),
        measures,
        time_signature: timeSignature,
        ...(tempoNumber !== null && { tempo_bpm: tempoNumber }),
      });
      const store = getPatternStore(instrumentId);
      const hadPrevious = store.getState().pattern !== null;
      store.getState().setPattern(pattern);
      onGenerated(pattern, hadPrevious);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(`${message} Your current pattern is unchanged.`);
    } finally {
      setBusy(false);
    }
  }

  // Options are the server's to define; until they load the select only shows its current value.
  const options = limits?.measure_options ?? [measures];

  return (
    <form
      aria-label="Generate a pattern"
      aria-busy={busy}
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <Field label="Describe your groove" htmlFor={`${id}-prompt`}>
        <textarea
          id={`${id}-prompt`}
          rows={3}
          value={prompt}
          onChange={(e) => getPatternStore(instrumentId).getState().setPrompt(e.target.value)}
          placeholder="e.g. laid-back boom bap with ghost-note snares and an open hat on the 'and' of 4"
          aria-describedby={`${id}-hint ${id}-token-count`}
          aria-invalid={overLimit}
          className={`${inputClass} h-auto w-full resize-y py-2`}
        />
      </Field>
      <div className="flex justify-between gap-4">
        <p id={`${id}-hint`} className="text-xs text-zinc-600 dark:text-zinc-400">
          Rhythm, feel, genre, fills…
        </p>
        <TokenCounter id={`${id}-token-count`} count={count} max={max} />
      </div>
      <div className="grid grid-cols-3 items-end gap-3 sm:flex sm:flex-wrap sm:gap-4">
        <Field label="Measures" htmlFor={`${id}-measures`}>
          <Select
            id={`${id}-measures`}
            value={measures}
            disabled={limits === null}
            onChange={(e) => onMeasuresChange(Number(e.target.value))}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Tempo (BPM)"
          htmlFor={`${id}-tempo`}
          hint={
            tempoInvalid ? (
              <span role="alert" className="text-red-700 dark:text-red-400">
                Tempo must be a whole number from 40 to 240 BPM.
              </span>
            ) : (
              "Leave blank to let the AI choose."
            )
          }
        >
          <input
            id={`${id}-tempo`}
            type="number"
            inputMode="numeric"
            min={TEMPO_RANGE.min}
            max={TEMPO_RANGE.max}
            placeholder="Auto"
            value={tempo}
            aria-invalid={tempoInvalid}
            onChange={(e) => {
              setTempo(e.target.value);
              setTempoBadInput(e.target.validity.badInput);
            }}
            className={`${inputClass} w-24 font-mono tabular-nums`}
          />
        </Field>
        <Field label="Time signature" htmlFor={`${id}-ts`}>
          <Select
            id={`${id}-ts`}
            value={timeSignature}
            onChange={(e) => onTimeSignatureChange(e.target.value as TimeSignature)}
          >
            {TIME_SIGNATURES.map((ts) => (
              <option key={ts} value={ts}>
                {ts}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabled={!canSubmit}
          className="col-span-3 w-full sm:ml-auto sm:w-auto"
        >
          {busy && <Spinner />}
          {busy ? "Generating…" : "Generate"}
        </Button>
      </div>
      {limitsState === "error" && (
        <ErrorAlert message="Couldn't load generation settings." onRetry={onRetryLimits} />
      )}
      {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}
    </form>
  );
}
