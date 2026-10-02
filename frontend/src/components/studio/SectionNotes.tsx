"use client";

import { useEffect, useId, useRef, useState } from "react";
import { hintClass, inputClass, labelClass } from "@/components/ui/classes";
import { SECTION_NOTES_MAX_CHARS, type Song } from "@/lib/song/types";
import { implicitIndex } from "@/lib/song/implicitSections";
import { capSectionNotes, sectionStarts, sectionsOf } from "@/lib/songSectionOps";
import { Menu, menuItemClass } from "./Menu";
import { SectionMenuItems, sectionMenuLabel, type SectionActions } from "./SectionMenu";
import { SECTION_PALETTE, sectionAccessibleName, sectionRange } from "./sectionPalette";

// Matches the lyrics notepad, so typing feels the same in both and a pause saves what was typed.
const SYNC_DELAY_MS = 300;
const NOTICE_MS = 4000;

const triggerClass =
  "inline-flex h-8 items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:focus-visible:outline-white";

const fmt = (n: number) => n.toLocaleString("en-US");

function NotesField({
  songId,
  sectionId,
  name,
  notes,
  onChange,
  registerFlush,
  textareaId,
}: {
  songId: string;
  sectionId: string;
  name: string;
  notes: string;
  onChange: (text: string, songId: string, sectionId: string) => void;
  registerFlush?: (flush: () => void) => () => void;
  textareaId: string;
}) {
  const [text, setText] = useState(notes);
  const [notice, setNotice] = useState(false);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const target = useRef({ songId, sectionId });
  useEffect(() => {
    onChangeRef.current = onChange;
    target.current = { songId, sectionId };
  });
  const countId = useId();
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    const flush = () => {
      clearTimeout(timer.current);
      if (pending.current === null) return;
      const value = pending.current;
      pending.current = null;
      onChangeRef.current(value, target.current.songId, target.current.sectionId);
    };
    flushRef.current = flush;
    const unregister = registerFlush?.(flush);
    return () => {
      unregister?.();
      flush();
      clearTimeout(noticeTimer.current);
    };
  }, [registerFlush]);

  const count = [...text].length;
  const atLimit = count >= SECTION_NOTES_MAX_CHARS;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <label htmlFor={textareaId} className={labelClass}>
        Notes
      </label>
      <textarea
        id={textareaId}
        aria-label={`Notes for ${name}`}
        value={text}
        placeholder="What happens here? e.g. the letter arrives; drums drop out"
        aria-describedby={countId}
        className={`${inputClass} h-auto min-h-32 w-full flex-1 resize-none py-2`}
        onChange={(e) => {
          // Native maxLength counts UTF-16 units, so a limit on code points is enforced here instead.
          const next = capSectionNotes(e.target.value);
          if (next !== e.target.value) {
            setNotice(true);
            clearTimeout(noticeTimer.current);
            noticeTimer.current = setTimeout(() => setNotice(false), NOTICE_MS);
          } else setNotice(false);
          setText(next);
          pending.current = next;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => flushRef.current(), SYNC_DELAY_MS);
        }}
        onBlur={() => flushRef.current()}
      />
      <div className="flex items-center justify-between gap-2">
        <p
          id={countId}
          className={`font-mono text-xs tabular-nums ${
            atLimit ? "font-semibold text-red-700 dark:text-red-400" : "text-zinc-600 dark:text-zinc-400"
          }`}
        >
          {fmt(count)} / {fmt(SECTION_NOTES_MAX_CHARS)} characters
        </p>
        <p role="status" className="text-xs font-semibold text-red-700 dark:text-red-400">
          {notice && `Notes limit reached (${fmt(SECTION_NOTES_MAX_CHARS)} characters). That edit wasn't added.`}
        </p>
      </div>
    </div>
  );
}

export function SectionNotes({
  song,
  selectedId,
  actions,
  onChange,
  registerFlush,
  fieldId,
  heading = false,
}: {
  song: Song | null;
  selectedId: string | null;
  actions: SectionActions;
  onChange: (text: string, songId: string, sectionId: string) => void;
  registerFlush?: (flush: () => void) => () => void;
  // Fixed by the host so a focus request finds this field and no other.
  fieldId: string;
  // The drawer has no tab to name the panel, so it shows its own header.
  heading?: boolean;
}) {
  const sections = song ? sectionsOf(song) : [];
  const starts = sectionStarts(sections);
  const index = sections.findIndex((s) => s.id === selectedId);
  const section = index >= 0 ? sections[index] : null;

  // Typing into the implicit section gives it a real id mid-keystroke; keeping the old key stops the field
  // from remounting and dropping focus and its own undo history.
  const [fieldKey, setFieldKey] = useState(section?.id ?? null);
  const [seenId, setSeenId] = useState(section?.id ?? null);
  if ((section?.id ?? null) !== seenId) {
    setSeenId(section?.id ?? null);
    if (seenId === null || implicitIndex(seenId) === null || section === null) setFieldKey(section?.id ?? null);
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-white dark:bg-zinc-950">
      {heading && (
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Section</h2>
        </div>
      )}
      {song && section ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              <span aria-hidden="true" className={`h-4 w-1 shrink-0 rounded-sm ${SECTION_PALETTE[section.kind].swatch}`} />
              <span className="truncate">{section.name}</span>
            </h2>
            <Menu
              label={sectionMenuLabel(section)}
              triggerLabel="Section actions"
              align="right"
              triggerClassName={triggerClass}
              trigger={<span>Actions</span>}
            >
              {(close) => (
                <SectionMenuItems
                  song={song}
                  section={section}
                  actions={actions}
                  close={close}
                  invoker={() => document.getElementById(fieldId)}
                />
              )}
            </Menu>
          </div>
          <p className={hintClass}>
            {section.name} · measures {sectionRange(section, starts[index])} · {section.measures}{" "}
            {section.measures === 1 ? "measure" : "measures"}
          </p>
          <NotesField
            key={fieldKey}
            songId={song.id}
            sectionId={section.id}
            name={section.name}
            notes={section.notes}
            onChange={onChange}
            registerFlush={registerFlush}
            textareaId={fieldId}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <h2 className="text-sm font-semibold">No section selected</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Select a section to write notes for it: what it&apos;s about, who plays what, ideas to try.
          </p>
          {song && (
            <ul className="flex flex-col gap-1">
              {sections.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-label={`Select ${sectionAccessibleName(s, starts[i])}`}
                    className={menuItemClass}
                    onClick={() => actions.toggle(s.id)}
                  >
                    <span aria-hidden="true" className={`h-4 w-1 shrink-0 rounded-sm ${SECTION_PALETTE[s.kind].swatch}`} />
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span aria-hidden="true" className="ml-auto shrink-0 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                      {sectionRange(s, starts[i])}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
