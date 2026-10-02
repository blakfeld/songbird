"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AudioClip } from "@/generated/AudioClip";
import type { Sample } from "@/generated/Sample";
import { Button } from "@/components/ui/Button";
import { focusRing, hintClass } from "@/components/ui/classes";
import { SAMPLE_NAME_MAX } from "@/lib/audio/sampleLibrary";
import { useSampleLibrary } from "@/lib/audio/useSampleLibrary";
import { isUsed, takesOf, usesOf } from "@/lib/song/audioClipOps";
import { formatLength } from "@/lib/song/audioTime";
import { MAX_TAKES_PER_TRACK } from "@/lib/song/audioTiming";
import type { Song, Track } from "@/lib/song/types";
import { InlineNameInput } from "../InlineNameInput";
import { Menu, menuItemClass } from "../Menu";
import type { AudioActions } from "../useAudioActions";
import { listenForTakes } from "./takesIntent";

const badgeClass = "shrink-0 rounded bg-zinc-100 px-1 text-[11px] dark:bg-zinc-800";

export function useLibraryIds(): Set<string> {
  const { state } = useSampleLibrary();
  return new Set(state.status === "ready" ? state.entries.map((e) => e.id) : []);
}

const usedBy = ({ clips, pads }: { clips: number; pads: number }) => {
  const parts = [];
  if (clips) parts.push(`${clips} clip${clips === 1 ? "" : "s"}`);
  if (pads) parts.push(`${pads} pad${pads === 1 ? "" : "s"}`);
  return `Used by ${parts.join(" and ")}`;
};

export function TakesList({
  song,
  track,
  clip,
  actions,
}: {
  song: Song;
  track: Track;
  clip: AudioClip;
  actions: AudioActions;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [stop, setStop] = useState<string | null>(null);
  const inLibrary = useLibraryIds();
  const takes = takesOf(song, track.id);
  const unused = takes.filter((t) => !isUsed(song, t.id));
  // Looked up by id from refs rather than a selector, since a sample id comes from a song file and may hold any character.
  const mains = useRef(new Map<string, HTMLElement>());
  const rowOf = (id: string) => mains.current.get(id);

  useEffect(
    () =>
      listenForTakes((intent) => {
        if (intent.kind === "rename") setRenaming(intent.sampleId);
        else requestAnimationFrame(() => heading.current?.focus());
      }),
    [],
  );

  // The current take is the one the user is working with, and a long list would otherwise hide it.
  useEffect(() => {
    list.current?.querySelector("[aria-current]")?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const focusRow = (id: string | undefined) => {
    if (id) requestAnimationFrame(() => rowOf(id)?.focus());
  };

  const remove = (take: Sample) => {
    const index = takes.findIndex((t) => t.id === take.id);
    const next = takes[index + 1] ?? takes[index - 1];
    if (!actions.deleteTakes(track.id, [take.id])) return;
    focusRow(next?.id);
  };

  const onKeyDown = (e: React.KeyboardEvent, take: Sample, index: number) => {
    const move = (to: number) => {
      e.preventDefault();
      const target = takes[Math.min(takes.length - 1, Math.max(0, to))];
      if (target) {
        setStop(target.id);
        rowOf(target.id)?.focus();
      }
    };
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(takes.length - 1);
    else if (e.key === "F2") {
      e.preventDefault();
      setRenaming(take.id);
    } else if (e.key === "F10" && e.shiftKey) {
      e.preventDefault();
      e.currentTarget.closest("li")?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.click();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (isUsed(song, take.id)) actions.announce(`${take.name} can't be deleted. ${usedBy(usesOf(song, take.id))}.`);
      else remove(take);
    }
  };

  const roving = takes.some((t) => t.id === stop) ? stop : (takes.find((t) => t.id === clip.sample_id)?.id ?? takes[0]?.id);

  return (
    <section aria-labelledby={headingId} className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h3 id={headingId} ref={heading} tabIndex={-1} className={`rounded text-sm font-semibold ${focusRing}`}>
          Takes <span className={hintClass}>({takes.length})</span>
        </h3>
        {unused.length > 0 && (
          <Button className="!py-1" onClick={() => actions.deleteTakes(track.id, unused.map((t) => t.id))}>
            Delete unused ({unused.length})
          </Button>
        )}
      </div>
      {takes.length >= MAX_TAKES_PER_TRACK - 4 && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {takes.length} of {MAX_TAKES_PER_TRACK} takes. Delete unused takes to record more.
        </p>
      )}
      {takes.length === 0 ? (
        <p className={hintClass}>No takes on {track.name} yet. Select the track and press Record.</p>
      ) : (
        <ul ref={list} aria-label={`Takes on ${track.name}`}>
          {takes.map((take, index) => (
            <TakeRow
              key={take.id}
              take={take}
              index={index}
              current={take.id === clip.sample_id}
              uses={usesOf(song, take.id)}
              inLibrary={inLibrary.has(take.id)}
              tabbable={take.id === roving}
              renaming={renaming === take.id}
              onUse={() => actions.switchTake(track.id, clip.id, take.id)}
              onStartRename={() => setRenaming(take.id)}
              onRename={(name) => {
                actions.renameTake(take.id, name);
                setRenaming(null);
                focusRow(take.id);
              }}
              onCancelRename={() => {
                setRenaming(null);
                focusRow(take.id);
              }}
              onAdd={() => void actions.addTakeToLibrary(take.id)}
              onDelete={() => remove(take)}
              onKeyDown={(e) => onKeyDown(e, take, index)}
              onFocusRow={() => setStop(take.id)}
              mainRef={(el) => {
                if (el) mains.current.set(take.id, el);
                else mains.current.delete(take.id);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TakeRow({
  take,
  current,
  uses,
  inLibrary,
  tabbable,
  renaming,
  onUse,
  onStartRename,
  onRename,
  onCancelRename,
  onAdd,
  onDelete,
  onKeyDown,
  onFocusRow,
  mainRef,
}: {
  take: Sample;
  index: number;
  current: boolean;
  uses: { clips: number; pads: number };
  inLibrary: boolean;
  tabbable: boolean;
  renaming: boolean;
  onUse: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onAdd: () => void;
  onDelete: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onFocusRow: () => void;
  mainRef: (el: HTMLButtonElement | null) => void;
}) {
  const inUse = uses.clips + uses.pads > 0;
  const lengthId = useId();
  const hintId = useId();
  return (
    <li
      aria-current={current ? "true" : undefined}
      className="flex h-12 items-center gap-2 border-b border-zinc-200 px-2 dark:border-zinc-800"
    >
      {renaming ? (
        <InlineNameInput
          value={take.name}
          label={`Take name ${take.name}`}
          maxLength={SAMPLE_NAME_MAX}
          className="h-8 min-w-0 flex-1"
          onCommit={onRename}
          onCancel={onCancelRename}
        />
      ) : (
        <button
          type="button"
          ref={mainRef}
          aria-label={`Use ${take.name}`}
          aria-describedby={lengthId}
          aria-current={current ? "true" : undefined}
          aria-disabled={current}
          tabIndex={tabbable ? 0 : -1}
          onFocus={onFocusRow}
          onClick={() => {
            if (!current) onUse();
          }}
          onKeyDown={onKeyDown}
          className={`min-w-0 flex-1 rounded text-left ${focusRing}`}
        >
          <span className={`block truncate text-sm ${current ? "font-semibold" : ""}`}>{take.name}</span>
          <span id={lengthId} className={`${hintClass} block tabular-nums`}>
            {formatLength(take.length_samples, take.sample_rate)} · {take.channels > 1 ? "Stereo" : "Mono"}
          </span>
        </button>
      )}
      {current && <span className={badgeClass}>Current</span>}
      {!inUse && <span className={badgeClass}>Unused</span>}
      {inLibrary && <span className={badgeClass}>In library</span>}
      <Menu
        label={`Take actions for ${take.name}`}
        align="right"
        panelClassName="w-56"
        triggerClassName={`inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-zinc-100 pointer-coarse:size-9 dark:hover:bg-zinc-800 ${focusRing}`}
        trigger={<span aria-hidden="true">⋯</span>}
      >
        {(close) => (
          <>
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
              aria-disabled={inLibrary}
              className={menuItemClass}
              onClick={() => {
                if (inLibrary) return;
                close();
                onAdd();
              }}
            >
              {inLibrary ? "In library" : "Add to library"}
            </button>
            <button
              type="button"
              role="menuitem"
              aria-disabled={inUse}
              aria-describedby={inUse ? hintId : undefined}
              className={menuItemClass}
              onClick={() => {
                if (inUse) return;
                close();
                onDelete();
              }}
            >
              Delete take
            </button>
            {inUse && (
              <p id={hintId} className={`px-3 pb-2 ${hintClass}`}>
                {usedBy(uses)}
              </p>
            )}
          </>
        )}
      </Menu>
    </li>
  );
}
