"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { focusRing } from "@/components/ui/classes";

export type RightTab = "assistant" | "lyrics" | "section";
const TABS: { id: RightTab; label: string }[] = [
  { id: "assistant", label: "Assistant" },
  { id: "lyrics", label: "Lyrics" },
  { id: "section", label: "Section" },
];

export const RIGHT_TAB_KEY = "songbird.studio.rightTab";
export const parseTab = (raw: string): RightTab | null =>
  raw === "lyrics" || raw === "assistant" || raw === "section" ? raw : null;

export function RightColumnTabs({
  assistant,
  lyrics,
  section,
  tab,
  onTabChange: setTab,
  className = "",
}: {
  assistant: ReactNode;
  lyrics: ReactNode;
  section: ReactNode;
  // Controlled because a section's Notes action has to bring this tab forward from outside.
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  className?: string;
}) {
  const buttons = useRef<Record<RightTab, HTMLButtonElement | null>>({ assistant: null, lyrics: null, section: null });

  const select = (next: RightTab) => {
    setTab(next);
    buttons.current[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const at = TABS.findIndex((t) => t.id === tab);
    const to =
      e.key === "ArrowRight" ? (at + 1) % TABS.length
      : e.key === "ArrowLeft" ? (at - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : null;
    if (to === null) return;
    e.preventDefault();
    select(TABS[to].id);
  };

  return (
    <aside
      aria-label="Assistant, lyrics, and section"
      className={`flex min-h-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
    >
      <div
        role="tablist"
        aria-label="Side panel"
        onKeyDown={onKeyDown}
        className="flex border-b border-zinc-200 px-2 dark:border-zinc-800"
      >
        {TABS.map(({ id, label }) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              ref={(el) => {
                buttons.current[id] = el;
              }}
              type="button"
              role="tab"
              id={`rt-tab-${id}`}
              aria-selected={selected}
              aria-controls={selected ? `rt-panel-${id}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-3 text-sm font-semibold ${focusRing} ${
                selected
                  ? "border-black text-zinc-900 dark:border-white dark:text-zinc-50"
                  : "border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`rt-panel-${tab}`}
        aria-labelledby={`rt-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === "lyrics" ? lyrics : tab === "section" ? section : assistant}
      </div>
    </aside>
  );
}
