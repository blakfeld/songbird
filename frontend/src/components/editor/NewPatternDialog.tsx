"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { MeasureCount } from "@/generated/MeasureCount";
import type { TimeSignature } from "@/generated/TimeSignature";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { TIME_SIGNATURES } from "./PromptForm";

interface Props {
  instrument: InstrumentInfo | null;
  defaultMeasures: MeasureCount;
  defaultTimeSignature: TimeSignature;
  measureOptions: number[];
  onCreate: (measures: MeasureCount, timeSignature: TimeSignature) => void;
}

function NewPatternForm({
  instrument,
  defaultMeasures,
  defaultTimeSignature,
  measureOptions,
  onCreate,
  onClose,
}: Props & { onClose: () => void }) {
  const id = useId();
  const [measures, setMeasures] = useState<number>(defaultMeasures);
  const [ts, setTs] = useState<TimeSignature>(defaultTimeSignature);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!instrument) return;
        onCreate(measures as MeasureCount, ts);
        onClose();
      }}
      className="flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold">New empty pattern</h2>
      <Field label="Measures" htmlFor={`${id}-m`}>
        <Select id={`${id}-m`} autoFocus value={measures} onChange={(e) => setMeasures(Number(e.target.value))}>
          {measureOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Time signature" htmlFor={`${id}-ts`}>
        <Select id={`${id}-ts`} value={ts} onChange={(e) => setTs(e.target.value as TimeSignature)}>
          {TIME_SIGNATURES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!instrument}>
          {instrument ? "Create" : "Loading instrument…"}
        </Button>
      </div>
    </form>
  );
}

export function NewPatternDialog(props: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (dialog.showModal) dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (dialog.close) dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        New…
      </Button>
      <dialog
        ref={ref}
        aria-label="New empty pattern"
        onClose={() => setOpen(false)}
        className="m-auto w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-900 backdrop:bg-black/50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
      >
        {open && <NewPatternForm {...props} onClose={close} />}
      </dialog>
    </>
  );
}
