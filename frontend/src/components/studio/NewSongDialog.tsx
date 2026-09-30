"use client";

import { useId, useState } from "react";
import type { TimeSignature } from "@/generated/TimeSignature";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { inputClass } from "@/components/ui/classes";
import { TIME_SIGNATURES } from "@/components/editor/PromptForm";
import { SONG_NAME_MAX } from "@/lib/song/types";

function NewSongForm({
  onCreate,
  onClose,
}: {
  onCreate: (name: string, timeSignature: TimeSignature) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("Untitled song");
  const [ts, setTs] = useState<TimeSignature>("4/4");
  const valid = name.trim().length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onCreate(name.trim(), ts);
        onClose();
      }}
      className="flex flex-col gap-4"
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        New song
      </h2>
      <Field label="Name" htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          autoFocus
          value={name}
          maxLength={SONG_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field
        label="Time signature"
        htmlFor={`${id}-ts`}
        hint="Can't be changed after the song is created."
        hintId={`${id}-ts-hint`}
      >
        <Select
          id={`${id}-ts`}
          aria-describedby={`${id}-ts-hint`}
          value={ts}
          onChange={(e) => setTs(e.target.value as TimeSignature)}
        >
          {TIME_SIGNATURES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          Create
        </Button>
      </div>
    </form>
  );
}

export function NewSongDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, timeSignature: TimeSignature) => void;
}) {
  return (
    <ModalDialog open={open} onClose={onClose} label="New song">
      <NewSongForm onCreate={onCreate} onClose={onClose} />
    </ModalDialog>
  );
}
