"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AudioClip } from "@/generated/AudioClip";
import { hintClass } from "@/components/ui/classes";
import { isUsed, takesOf } from "@/lib/song/audioClipOps";
import type { Song } from "@/lib/song/types";
import { menuItemClass } from "../Menu";
import type { AudioActions } from "../useAudioActions";
import { useLibraryIds } from "./TakesList";
import { requestTakes } from "./takesIntent";

const separator = <div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />;

// A drill-in inside the same panel rather than a flyout, which would need its own positioning and collision code and
// fails on phones; the panel's existing viewport clamping and scrolling already cover a longer list.
export function TakesMenuItems({
  song,
  trackId,
  clip,
  actions,
  close,
}: {
  song: Song;
  trackId: string;
  clip: AudioClip;
  actions: AudioActions;
  close: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const inLibrary = useLibraryIds();
  const takes = takesOf(song, trackId);
  const unused = takes.filter((t) => !isUsed(song, t.id));
  const current = takes.find((t) => t.id === clip.sample_id);
  const focusAfterSwap = useRef<"back" | "takes" | null>(null);

  // The items swap in place, so the focused one is destroyed; focus has to be put back by hand after the render.
  useEffect(() => {
    const target = focusAfterSwap.current;
    if (!target) return;
    focusAfterSwap.current = null;
    const el =
      target === "takes"
        ? root.current?.querySelector<HTMLElement>("[data-takes-open]")
        : (root.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
          root.current?.querySelector<HTMLElement>('[role="menuitemradio"]'));
    el?.focus();
  }, [open]);

  if (takes.length === 0) return null;

  const swap = (to: boolean) => {
    focusAfterSwap.current = to ? "back" : "takes";
    setOpen(to);
  };

  if (!open) {
    return (
      <div ref={root}>
        <button
          type="button"
          role="menuitem"
          data-takes-open
          aria-haspopup="menu"
          aria-expanded={false}
          className={menuItemClass}
          onClick={() => swap(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              swap(true);
            }
          }}
        >
          Takes ({takes.length})
          <span aria-hidden="true" className="ml-auto">
            ›
          </span>
        </button>
      </div>
    );
  }

  return (
    <div ref={root}>
      <button type="button" role="menuitem" className={menuItemClass} onClick={() => swap(false)}>
        <span aria-hidden="true">‹</span> Back
      </button>
      {separator}
      <div role="presentation" className="px-3 py-1 text-[11px] font-medium tracking-wide text-zinc-600 uppercase dark:text-zinc-400">
        Takes
      </div>
      {takes.map((take) => (
        <button
          key={take.id}
          type="button"
          role="menuitemradio"
          aria-checked={take.id === clip.sample_id}
          className={menuItemClass}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              swap(false);
            }
          }}
          onClick={() => {
            close();
            if (take.id !== clip.sample_id) actions.switchTake(trackId, clip.id, take.id);
          }}
        >
          <span aria-hidden="true" className="w-4">
            {take.id === clip.sample_id ? "✓" : ""}
          </span>
          <span className="min-w-0 flex-1 truncate">{take.name}</span>
          {!isUsed(song, take.id) && <span className="text-xs text-zinc-600 dark:text-zinc-400">Unused</span>}
        </button>
      ))}
      {separator}
      <button
        type="button"
        role="menuitem"
        aria-disabled={!current}
        aria-describedby={current ? undefined : hintId}
        className={menuItemClass}
        onClick={() => {
          if (!current) return;
          close();
          actions.openDock();
          requestTakes({ kind: "rename", sampleId: current.id });
        }}
      >
        Rename current take…
      </button>
      <button
        type="button"
        role="menuitem"
        aria-disabled={!current || inLibrary.has(current.id)}
        aria-describedby={current ? undefined : hintId}
        className={menuItemClass}
        onClick={() => {
          if (!current || inLibrary.has(current.id)) return;
          close();
          void actions.addTakeToLibrary(current.id);
        }}
      >
        {current && inLibrary.has(current.id) ? "Current take is in library" : "Add current take to library"}
      </button>
      {!current && (
        <p id={hintId} className={`px-3 pb-2 ${hintClass}`}>
          This clip doesn&apos;t play a take
        </p>
      )}
      {unused.length > 0 && (
        <button
          type="button"
          role="menuitem"
          className={menuItemClass}
          onClick={() => {
            close();
            actions.deleteTakes(trackId, unused.map((t) => t.id));
          }}
        >
          Delete unused takes ({unused.length})
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className={menuItemClass}
        onClick={() => {
          close();
          actions.openDock();
          requestTakes({ kind: "heading" });
        }}
      >
        All takes…
      </button>
    </div>
  );
}
