"use client";

import type { SampleLibraryEntry } from "@/lib/audio/sampleLibrary";
import { SAMPLE_NAME_MAX } from "@/lib/audio/sampleLibrary";
import { useSampleOverview } from "@/lib/audio/useSampleLibrary";
import { formatLength } from "@/lib/song/audioTime";
import { focusRing, hintClass } from "@/components/ui/classes";
import { InlineNameInput } from "../InlineNameInput";
import { Menu, menuItemClass } from "../Menu";
import { Waveform } from "../audio/Waveform";
import { loopColour } from "../loopPalette";
import { beginSampleDrag, endSampleDrag } from "./useSampleDrop";

export const SAMPLE_LIST_HELP_ID = "sample-list-help";

const spokenSeconds = (entry: SampleLibraryEntry) => {
  const seconds = entry.length / entry.sampleRate;
  return `${seconds.toFixed(1)} seconds`;
};

function Thumb({ entry }: { entry: SampleLibraryEntry }) {
  const overview = useSampleOverview(entry.id);
  return (
    <Waveform
      className="h-5 w-16 shrink-0"
      envelope={false}
      sampleId={entry.id}
      overview={overview === "missing" ? null : overview}
      palette={loopColour(0)}
      clip={{
        offset_samples: 0,
        slice_samples: entry.length,
        length_samples: entry.length,
        loop: false,
        gain_db: 0,
        fade_in_samples: 0,
        fade_out_samples: 0,
      }}
    />
  );
}

export function SampleRow({
  entry,
  mode,
  inSong,
  current,
  previewing,
  renaming,
  tabbable,
  canPlace,
  onPreview,
  onActivate,
  onStartRename,
  onRename,
  onCancelRename,
  onRemove,
  onFocusRow,
}: {
  entry: SampleLibraryEntry;
  mode: "library" | "pick";
  inSong: boolean;
  current: boolean;
  previewing: boolean;
  renaming: boolean;
  tabbable: boolean;
  canPlace: boolean;
  onPreview: () => void;
  onActivate: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onRemove: () => void;
  onFocusRow: () => void;
}) {
  const stereo = entry.channels > 1 ? "stereo" : "mono";
  const label = `${entry.name}, ${spokenSeconds(entry)}, ${stereo}${inSong ? ", in this song" : ""}`;
  const disabled = mode === "pick" ? current : !canPlace;
  return (
    <li
      data-sample-row={entry.id}
      className="flex h-14 items-center gap-2 border-b border-zinc-200 px-2 dark:border-zinc-800"
      aria-current={current ? "true" : undefined}
    >
      <button
        type="button"
        data-sample-preview
        aria-label={`Preview ${entry.name}`}
        aria-pressed={previewing}
        tabIndex={-1}
        onClick={onPreview}
        onFocus={onFocusRow}
        className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full border pointer-coarse:size-9 ${
          previewing
            ? "border-indigo-600 bg-indigo-600 text-white dark:border-indigo-400 dark:bg-indigo-400 dark:text-zinc-950"
            : "border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
        } ${focusRing}`}
      >
        <span aria-hidden="true">{previewing ? "■" : "▶"}</span>
      </button>
      {renaming ? (
        <InlineNameInput
          value={entry.name}
          label={`Sample name ${entry.name}`}
          maxLength={SAMPLE_NAME_MAX}
          className="h-8 min-w-0 flex-1"
          onCommit={onRename}
          onCancel={onCancelRename}
        />
      ) : (
        <button
          type="button"
          data-sample-main
          draggable
          aria-label={label}
          aria-describedby={SAMPLE_LIST_HELP_ID}
          aria-disabled={disabled}
          aria-current={current ? "true" : undefined}
          tabIndex={tabbable ? 0 : -1}
          title="Drag onto an audio lane, or press Enter to place at the playhead"
          onFocus={onFocusRow}
          // In library mode a refused press still reaches the page, which says why nothing was placed.
          onClick={() => {
            if (mode === "pick" && current) return;
            onActivate();
          }}
          onDragStart={(e) => beginSampleDrag(e, entry)}
          onDragEnd={endSampleDrag}
          onKeyDown={(e) => {
            if (e.key === "F2") {
              e.preventDefault();
              onStartRename();
            } else if ((e.key === "Delete" || e.key === "Backspace") && mode === "library") {
              e.preventDefault();
              onRemove();
            }
          }}
          className={`group/sample flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded text-left ${focusRing}`}
        >
          <span aria-hidden="true" className="text-zinc-400 group-hover/sample:text-zinc-700 dark:group-hover/sample:text-zinc-200">
            ⠿
          </span>
          <Thumb entry={entry} />
          <span className="min-w-0">
            <span className="block truncate text-sm">{entry.name}</span>
            <span className={`${hintClass} block tabular-nums`}>
              {formatLength(entry.length, entry.sampleRate)} · {stereo === "stereo" ? "Stereo" : "Mono"}
            </span>
          </span>
        </button>
      )}
      {current && (
        <span className="shrink-0 rounded bg-zinc-100 px-1 text-[11px] dark:bg-zinc-800">Current</span>
      )}
      {inSong && !current && (
        <span aria-hidden="true" className="shrink-0 rounded bg-zinc-100 px-1 text-[11px] dark:bg-zinc-800">
          In song
        </span>
      )}
      {mode === "library" && (
        <Menu
          label={`Sample actions for ${entry.name}`}
          align="right"
          panelClassName="w-52"
          triggerClassName={`inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-zinc-100 pointer-coarse:size-9 dark:hover:bg-zinc-800 ${focusRing}`}
          trigger={<span aria-hidden="true">⋯</span>}
        >
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                aria-disabled={!canPlace}
                className={menuItemClass}
                onClick={() => {
                  close();
                  onActivate();
                }}
              >
                Place at playhead
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  close();
                  onStartRename();
                }}
              >
                Rename…
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  close();
                  onRemove();
                }}
              >
                Remove from library…
              </button>
            </>
          )}
        </Menu>
      )}
    </li>
  );
}
