"use client";

import { useRef, useState, type ReactNode } from "react";
import { focusRing } from "@/components/ui/classes";
import type { Song } from "@/lib/song/types";
import { sectionStarts, sectionsOf } from "@/lib/songSectionOps";
import { ContextMenu } from "./ContextMenu";
import { SectionMenuItems, sectionMenuLabel, type SectionActions } from "./SectionMenu";
import { SECTION_PALETTE, sectionAccessibleName, sectionRange } from "./sectionPalette";

export const SECTION_KEYS_HELP_ID = "section-keys-help";
export const SECTION_KEYS_HELP =
  "Left and Right arrows move between sections. Enter selects a section and loops it; press again or Escape to clear. F2 edits it. Shift F10 opens more actions.";

export function SectionRuler({
  song,
  selectedId,
  actions,
  children,
}: {
  song: Song;
  selectedId: string | null;
  actions: SectionActions;
  // Drawn behind the blocks, so the song's end reads the same in every ruler row.
  children?: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: { x: number; y: number } } | null>(null);
  const sections = sectionsOf(song);
  const starts = sectionStarts(sections);
  const spm = song.steps_per_measure;
  const stopId = sections.some((s) => s.id === selectedId) ? selectedId : sections[0].id;
  const menuIndex = menu ? sections.findIndex((s) => s.id === menu.id) : -1;
  const menuSection = menuIndex >= 0 ? sections[menuIndex] : null;

  const labelOf = (id: string) =>
    row.current?.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(id)}"]`) ?? null;

  function focusSibling(current: HTMLElement, target: "prev" | "next" | "first" | "last") {
    const all = [...(row.current?.querySelectorAll<HTMLElement>("[data-section-id]") ?? [])];
    const at = all.indexOf(current);
    ({ prev: all[at - 1], next: all[at + 1], first: all[0], last: all.at(-1) })[target]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, id: string) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.currentTarget;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      focusSibling(el, e.key === "ArrowLeft" ? "prev" : "next");
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focusSibling(el, e.key === "Home" ? "first" : "last");
    } else if (e.key === "Escape") {
      // Left alone when nothing is selected so a surrounding dialog or menu still sees it.
      if (selectedId === null) return;
      e.preventDefault();
      e.stopPropagation();
      actions.clear();
    } else if (e.key === "F2") {
      e.preventDefault();
      actions.edit(id, el);
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setMenu({ id, anchor: { x: rect.left, y: rect.bottom } });
    }
  }

  return (
    <div
      ref={row}
      role="group"
      aria-label="Sections"
      aria-describedby={SECTION_KEYS_HELP_ID}
      data-section-ruler
      className="relative h-8 border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950"
    >
      {children}
      {sections.map((s, i) => {
        const start = starts[i];
        const selected = s.id === selectedId;
        const colour = SECTION_PALETTE[s.kind];
        const name = sectionAccessibleName(s, start);
        return (
          <div
            key={s.id}
            className="@container/section absolute inset-y-0 min-w-[3px]"
            style={{
              left: `calc(var(--cell-w) * ${(start - 1) * spm})`,
              width: `calc(var(--cell-w) * ${s.measures * spm} - 1px)`,
            }}
          >
            <button
              type="button"
              data-section-id={s.id}
              aria-pressed={selected}
              aria-label={name}
              title={`${s.name} · ${s.kind} · measures ${sectionRange(s, start)} · ${s.measures} ${s.measures === 1 ? "measure" : "measures"}`}
              tabIndex={s.id === stopId ? 0 : -1}
              className={`absolute inset-0 flex items-center overflow-hidden rounded-sm border-l-4 text-left text-xs font-medium text-zinc-900 hover:brightness-95 motion-safe:transition-colors dark:text-zinc-50 dark:hover:brightness-110 ${focusRing} focus-visible:-outline-offset-2 ${
                selected ? `${colour.selected} ring-2 ring-zinc-900 ring-inset dark:ring-zinc-50` : colour.block
              }`}
              onClick={() => actions.toggle(s.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: s.id, anchor: { x: e.clientX, y: e.clientY } });
              }}
              onKeyDown={(e) => onKeyDown(e, s.id)}
            >
              <span className="min-w-0 truncate px-1.5 pr-7 @max-[1.5rem]/section:hidden @max-[4rem]/section:pr-1.5">
                <span className={selected ? "font-semibold" : ""}>{s.name}</span>
                <span className="hidden font-normal text-zinc-600 @min-[8rem]/section:inline dark:text-zinc-400">
                  {" "}
                  · {s.measures} {s.measures === 1 ? "measure" : "measures"}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={sectionMenuLabel(s)}
              aria-haspopup="menu"
              tabIndex={-1}
              className={`absolute inset-y-0 right-0 w-6 text-zinc-700 hover:bg-zinc-900/10 @max-[4rem]/section:hidden dark:text-zinc-300 dark:hover:bg-white/10 ${focusRing} focus-visible:-outline-offset-2`}
              onClick={() => {
                const rect = labelOf(s.id)?.getBoundingClientRect();
                setMenu({ id: s.id, anchor: { x: rect?.left ?? 0, y: rect?.bottom ?? 0 } });
              }}
            >
              <span aria-hidden="true">⋯</span>
            </button>
          </div>
        );
      })}
      {menuSection && menu && (
        <ContextMenu
          open
          anchor={menu.anchor}
          label={sectionMenuLabel(menuSection)}
          onClose={() => setMenu(null)}
          returnFocusTo={() => labelOf(menuSection.id)}
        >
          {(close) => (
            <SectionMenuItems
              song={song}
              section={menuSection}
              actions={actions}
              close={close}
              invoker={() => labelOf(menuSection.id)}
            />
          )}
        </ContextMenu>
      )}
    </div>
  );
}
