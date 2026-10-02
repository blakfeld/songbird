"use client";

import type { AudioClip } from "@/generated/AudioClip";
import { menuItemClass } from "../Menu";
import type { AudioActions } from "../useAudioActions";

const hintClass = "px-3 pb-2 text-xs text-zinc-600 dark:text-zinc-400";
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// Shared by right-click, Shift+F10 and the dock's actions button so they offer the same things.
export function AudioClipMenuItems({
  trackId,
  clip,
  actions,
  close,
  invoker,
  focusResult,
  canDuplicate = true,
}: {
  trackId: string;
  clip: AudioClip;
  actions: AudioActions;
  close: () => void;
  invoker: () => HTMLElement | null;
  focusResult: boolean;
  canDuplicate?: boolean;
}) {
  const hintId = `audio-menu-${clip.id}`;
  return (
    <>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={clip.loop}
        className={menuItemClass}
        onClick={() => {
          close();
          actions.loop(trackId, clip.id, !clip.loop);
        }}
      >
        Loop
        <span aria-hidden="true" className="ml-auto">
          {clip.loop ? "✓" : ""}
        </span>
      </button>
      <div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
      <button
        type="button"
        role="menuitem"
        className={menuItemClass}
        onClick={() => {
          close();
          actions.requestReplace(trackId, clip.id, invoker());
        }}
      >
        Replace sample…
      </button>
      <button
        type="button"
        role="menuitem"
        aria-disabled={!canDuplicate}
        aria-describedby={canDuplicate ? undefined : hintId}
        aria-keyshortcuts="Meta+D Control+D"
        className={menuItemClass}
        onClick={() => {
          if (!canDuplicate) return;
          close();
          actions.duplicate(trackId, clip.id, { focus: focusResult });
        }}
      >
        Duplicate
        <kbd className="ml-auto font-sans text-xs text-zinc-600 dark:text-zinc-400">{isMac() ? "⌘D" : "Ctrl+D"}</kbd>
      </button>
      {!canDuplicate && (
        <p id={hintId} className={hintClass}>
          No room after this clip
        </p>
      )}
      <button
        type="button"
        role="menuitem"
        aria-keyshortcuts="Delete"
        className={menuItemClass}
        onClick={() => {
          close();
          actions.remove(trackId, clip.id, { focus: focusResult });
        }}
      >
        Delete
        <kbd className="ml-auto font-sans text-xs text-zinc-600 dark:text-zinc-400">Del</kbd>
      </button>
    </>
  );
}
