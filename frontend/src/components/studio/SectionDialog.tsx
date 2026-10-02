"use client";

import { useId, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Select } from "@/components/ui/Select";
import { inputClass } from "@/components/ui/classes";
import {
  MEASURE_RANGE,
  SECTION_KINDS,
  SECTION_MEASURE_RANGE,
  SECTION_NAME_MAX,
  type SectionKind,
  type Song,
} from "@/lib/song/types";
import {
  DEFAULT_SECTION_MEASURES,
  SECTION_KIND_LABELS,
  defaultSectionName,
  sectionStarts,
  sectionsOf,
} from "@/lib/songSectionOps";

export type SectionDialogRequest =
  | { mode: "add" }
  | { mode: "insert"; sectionId: string; where: "before" | "after" }
  | { mode: "edit"; sectionId: string };

export interface SectionDialogValues {
  kind: SectionKind;
  name: string;
  measures: number;
}

const plural = (n: number) => `${n} ${n === 1 ? "measure" : "measures"}`;

function titleOf(request: SectionDialogRequest, name: string | undefined) {
  if (request.mode === "add") return "Add section";
  if (request.mode === "insert") return `Insert section ${request.where} ${name ?? "section"}`;
  return `Edit ${name ?? "section"}`;
}

function SectionForm({
  song,
  request,
  title,
  onSubmit,
  onClose,
}: {
  song: Song;
  request: SectionDialogRequest;
  title: string;
  // Returns the sentence to show when the edit was refused, or null once it has been applied.
  onSubmit: (values: SectionDialogValues) => string | null;
  onClose: () => void;
}) {
  const id = useId();
  const sections = sectionsOf(song);
  const starts = sectionStarts(sections);
  const anchorIndex = request.mode === "add" ? -1 : sections.findIndex((s) => s.id === request.sectionId);
  const anchor = anchorIndex >= 0 ? sections[anchorIndex] : null;
  const editing = request.mode === "edit" ? anchor : null;
  const sectionStart = anchor ? starts[anchorIndex] : 1;
  const start =
    request.mode === "add"
      ? song.measures + 1
      : request.mode === "insert" && request.where === "after"
        ? sectionStart + (anchor?.measures ?? 0)
        : sectionStart;

  const max = Math.min(
    SECTION_MEASURE_RANGE.max,
    MEASURE_RANGE.max - (song.measures - (editing?.measures ?? 0)),
  );
  const initialKind: SectionKind = editing?.kind ?? "verse";
  const [kind, setKind] = useState<SectionKind>(initialKind);
  const [name, setName] = useState(editing?.name ?? defaultSectionName(song, initialKind));
  const [nameTouched, setNameTouched] = useState(false);
  const [measures, setMeasures] = useState(editing?.measures ?? Math.min(DEFAULT_SECTION_MEASURES, max));
  const [refusal, setRefusal] = useState<string | null>(null);
  const [nameError, setNameError] = useState(false);
  const hintId = `${id}-length-hint`;
  const changeId = `${id}-change`;

  const changeKind = (next: SectionKind) => {
    setKind(next);
    // An edit starts from a name the user already chose, so only a new section's default follows the kind.
    if (!nameTouched && !editing) setName(defaultSectionName(song, next));
  };

  const change = (() => {
    if (!editing || measures === editing.measures) return null;
    const end = sectionStart + editing.measures - 1;
    if (measures < editing.measures)
      return `Removes measures ${sectionStart + measures}–${end} from every track. Undo restores them.`;
    return `Adds ${measures - editing.measures} empty ${measures - editing.measures === 1 ? "measure" : "measures"} after measure ${end} in every track. Later sections move later.`;
  })();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setNameError(true);
      return;
    }
    setRefusal(onSubmit({ kind, name: name.trim(), measures }));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {refusal && <ErrorAlert message={refusal} />}
      <Field label="Kind" htmlFor={`${id}-kind`}>
        <Select id={`${id}-kind`} autoFocus value={kind} onChange={(e) => changeKind(e.target.value as SectionKind)}>
          {SECTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {SECTION_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Name" htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          type="text"
          maxLength={SECTION_NAME_MAX}
          value={name}
          aria-invalid={nameError}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
            setNameError(false);
          }}
          className={`${inputClass} w-full`}
        />
        {nameError && (
          <p id={`${id}-name-error`} role="alert" className="text-xs text-red-700 dark:text-red-400">
            Enter a name.
          </p>
        )}
      </Field>
      <Field
        label="Length"
        htmlFor={`${id}-length`}
        hint={
          max < SECTION_MEASURE_RANGE.max
            ? `Up to ${max} measures here, because a song can be at most ${MEASURE_RANGE.max} measures.`
            : undefined
        }
        hintId={hintId}
      >
        <Select
          id={`${id}-length`}
          value={measures}
          aria-describedby={[max < SECTION_MEASURE_RANGE.max ? hintId : null, change ? changeId : null]
            .filter(Boolean)
            .join(" ") || undefined}
          onChange={(e) => setMeasures(Number(e.target.value))}
        >
          {Array.from({ length: SECTION_MEASURE_RANGE.max }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n} disabled={n > max}>
              {plural(n)}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">Starts at measure {start}.</p>
      {change && (
        <p id={changeId} className="text-xs text-zinc-600 dark:text-zinc-400">
          {change}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary">
          {request.mode === "add" ? "Add section" : request.mode === "insert" ? "Insert section" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function SectionDialog({
  request,
  song,
  onSubmit,
  onClose,
}: {
  request: SectionDialogRequest | null;
  song: Song;
  onSubmit: (request: SectionDialogRequest, values: SectionDialogValues) => string | null;
  onClose: () => void;
}) {
  const anchor =
    request && request.mode !== "add" ? sectionsOf(song).find((s) => s.id === request.sectionId) : undefined;
  const title = request ? titleOf(request, anchor?.name) : "Section";
  return (
    <ModalDialog open={request !== null} onClose={onClose} label={title}>
      {request && (
        <SectionForm
          song={song}
          request={request}
          title={title}
          onSubmit={(values) => onSubmit(request, values)}
          onClose={onClose}
        />
      )}
    </ModalDialog>
  );
}
