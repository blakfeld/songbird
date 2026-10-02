"use client";

import { MEASURE_RANGE, type Section, type Song } from "@/lib/song/types";
import { sectionsOf } from "@/lib/songSectionOps";
import { menuItemClass } from "./Menu";

const hintClass = "px-3 pb-2 text-xs text-zinc-600 dark:text-zinc-400";
const separator = <div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />;
const kbd = "ml-auto font-sans text-xs text-zinc-600 dark:text-zinc-400";

// What every surface (ruler, context menu, notes panel) can ask the page to do, so they cannot disagree.
export interface SectionActions {
  // Selecting is a request to hear the section, so it also sets the loop; the page owns both.
  toggle: (sectionId: string) => void;
  clear: () => void;
  add: (invoker: HTMLElement | null) => void;
  insert: (sectionId: string, where: "before" | "after", invoker: HTMLElement | null) => void;
  edit: (sectionId: string, invoker: HTMLElement | null) => void;
  duplicate: (sectionId: string) => void;
  remove: (sectionId: string) => void;
  openNotes: (sectionId: string) => void;
}

export const sectionMenuLabel = (section: Pick<Section, "name">) => `Section actions for ${section.name}`;

const SONG_FULL = `The song is ${MEASURE_RANGE.max} measures, the most it can hold`;

// One item list for every surface that offers section actions, so they cannot drift apart.
export function SectionMenuItems({
  song,
  section,
  actions,
  close,
  invoker,
}: {
  song: Song;
  section: Section;
  actions: SectionActions;
  close: () => void;
  invoker: () => HTMLElement | null;
}) {
  const only = sectionsOf(song).length <= 1;
  const full = song.measures >= MEASURE_RANGE.max;
  const duplicateHint =
    song.measures + section.measures > MEASURE_RANGE.max
      ? `Duplicating would make the song longer than ${MEASURE_RANGE.max} measures`
      : null;
  const deleteHint = only ? "A song needs at least one section" : null;
  const insertHint = full ? SONG_FULL : null;
  const id = `section-menu-${section.id}`;

  const insert = (where: "before" | "after") => (
    <button
      type="button"
      role="menuitem"
      aria-disabled={insertHint !== null}
      aria-describedby={insertHint ? `${id}-insert` : undefined}
      className={menuItemClass}
      onClick={() => {
        if (insertHint) return;
        close();
        actions.insert(section.id, where, invoker());
      }}
    >
      Insert section {where}…
    </button>
  );

  return (
    <>
      <button
        type="button"
        role="menuitem"
        aria-keyshortcuts="F2"
        className={menuItemClass}
        onClick={() => {
          close();
          actions.edit(section.id, invoker());
        }}
      >
        Edit section…
        <kbd className={kbd}>F2</kbd>
      </button>
      {insert("before")}
      {insert("after")}
      {insertHint && (
        <p id={`${id}-insert`} className={hintClass}>
          {insertHint}
        </p>
      )}
      <button
        type="button"
        role="menuitem"
        aria-disabled={duplicateHint !== null}
        aria-describedby={duplicateHint ? `${id}-dup` : undefined}
        className={menuItemClass}
        onClick={() => {
          if (duplicateHint) return;
          close();
          actions.duplicate(section.id);
        }}
      >
        Duplicate
      </button>
      {duplicateHint && (
        <p id={`${id}-dup`} className={hintClass}>
          {duplicateHint}
        </p>
      )}
      <button
        type="button"
        role="menuitem"
        className={menuItemClass}
        onClick={() => {
          close();
          actions.openNotes(section.id);
        }}
      >
        Notes…
      </button>
      {separator}
      <button
        type="button"
        role="menuitem"
        aria-disabled={deleteHint !== null}
        aria-describedby={deleteHint ? `${id}-del` : undefined}
        className={menuItemClass}
        onClick={() => {
          if (deleteHint) return;
          close();
          actions.remove(section.id);
        }}
      >
        Delete section
      </button>
      {deleteHint && (
        <p id={`${id}-del`} className={hintClass}>
          {deleteHint}
        </p>
      )}
    </>
  );
}
