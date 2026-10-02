"use client";

import { useState } from "react";
import type { SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import { SAMPLE_LIST_HELP_ID, SampleRow } from "./SampleRow";

const HELP =
  "Up and Down move between samples. Enter places the sample at the playhead on the selected audio track. F2 renames. Delete removes it from the library.";

const CONTROLS = ["[data-sample-preview]", "[data-sample-main]", 'button[aria-haspopup="menu"]'];

export function SampleList({
  entries,
  mode,
  songSampleIds,
  currentSampleId,
  previewId,
  canPlace = true,
  onPreview,
  onActivate,
  onRename,
  onRemove,
}: {
  entries: SampleLibraryEntry[];
  mode: "library" | "pick";
  songSampleIds: ReadonlySet<string>;
  currentSampleId?: string;
  previewId: string | null;
  canPlace?: boolean;
  onPreview: (entry: SampleLibraryEntry) => void;
  onActivate: (entry: SampleLibraryEntry) => void;
  onRename?: (entry: SampleLibraryEntry, name: string) => void;
  onRemove?: (entry: SampleLibraryEntry) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const tabId = entries.some((e) => e.id === active) ? active : entries[0]?.id;

  // Arrows keep the same control under focus from row to row, so a column of previews can be walked without Tab.
  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-sample-row]");
    if (!row || target.tagName === "INPUT") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-sample-row]")];
    const controlIndex = CONTROLS.findIndex((s) => target.matches(s));
    if (controlIndex < 0) return;
    e.preventDefault();
    const at = rows.indexOf(row);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const next = controlIndex + (e.key === "ArrowLeft" ? -1 : 1);
      row.querySelectorAll<HTMLElement>(CONTROLS[Math.min(CONTROLS.length - 1, Math.max(0, next))]).forEach((el) => el.focus());
      return;
    }
    const to =
      e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowUp" ? -1 : 1)));
    rows[to]?.querySelector<HTMLElement>(CONTROLS[controlIndex])?.focus();
  };

  return (
    <>
      <p id={SAMPLE_LIST_HELP_ID} className="sr-only">
        {HELP}
      </p>
      <ul aria-label="Samples" onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {entries.map((entry) => (
          <SampleRow
            key={entry.id}
            entry={entry}
            mode={mode}
            inSong={songSampleIds.has(entry.id)}
            current={entry.id === currentSampleId}
            previewing={previewId === entry.id}
            renaming={renaming === entry.id}
            tabbable={entry.id === tabId}
            canPlace={canPlace}
            onFocusRow={() => setActive(entry.id)}
            onPreview={() => onPreview(entry)}
            onActivate={() => onActivate(entry)}
            onStartRename={() => setRenaming(entry.id)}
            onRename={(name) => {
              setRenaming(null);
              onRename?.(entry, name);
            }}
            onCancelRename={() => setRenaming(null)}
            onRemove={() => onRemove?.(entry)}
          />
        ))}
      </ul>
    </>
  );
}
