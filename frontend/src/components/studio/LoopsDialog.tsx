"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { focusRing } from "@/components/ui/classes";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { loopUseCount } from "@/lib/song/clipOps";
import { LOOP_NAME_MAX, type Track } from "@/lib/song/types";
import { LoopSwatch } from "./ClipMenu";
import { InlineNameInput } from "./InlineNameInput";
import type { ClipActions } from "./useClipActions";

const iconButton = `inline-flex size-8 shrink-0 items-center justify-center rounded-md text-sm hover:bg-zinc-100 pointer-coarse:size-10 dark:hover:bg-zinc-800 ${focusRing}`;

const countText = (n: number) => (n === 0 ? "Not placed" : n === 1 ? "1 clip" : `${n} clips`);

// A dialog rather than a menu because each loop needs its own Rename and Delete, and buttons inside menu items are not valid ARIA.
export function LoopsDialog({
  open,
  onClose,
  track,
  currentLoopId,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  track: Track;
  currentLoopId: string | null;
  actions: ClipActions;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const focusRow = (loopId: string | undefined) => {
    requestAnimationFrame(() => {
      const target = loopId
        ? root.current?.querySelector<HTMLElement>(`[data-loop-row="${loopId}"]`)
        : root.current?.querySelector<HTMLElement>("[data-close]");
      target?.focus();
    });
  };

  return (
    <ModalDialog
      open={open}
      onClose={() => {
        setRenaming(null);
        onClose();
      }}
      label={`Loops on ${track.name}`}
      className="m-auto w-full max-w-md rounded-2xl p-6"
    >
      <div ref={root}>
        <h2 className="text-lg font-semibold">Loops on {track.name}</h2>
        {track.loops.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">No loops yet.</p>
        ) : (
          <ul className="mt-3 max-h-80 overflow-y-auto">
            {track.loops.map((loop, i) => {
              const uses = loopUseCount(track, loop.id);
              const current = loop.id === currentLoopId;
              const earliest = track.clips.find((c) => c.loop_id === loop.id);
              const content = (
                <>
                  <LoopSwatch index={i} />
                  <span className="min-w-0 flex-1 truncate font-medium">{loop.name}</span>
                  {current && (
                    <span className="shrink-0 rounded bg-zinc-100 px-1.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      Current
                    </span>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                    {countText(uses)}
                  </span>
                </>
              );
              return (
                <li key={loop.id} className="flex items-center gap-2 py-1">
                  {renaming === loop.id ? (
                    <InlineNameInput
                      value={loop.name}
                      label={`Loop name ${loop.name}`}
                      maxLength={LOOP_NAME_MAX}
                      className="h-8 flex-1"
                      onCommit={(name) => {
                        actions.renameLoop(track.id, loop.id, name);
                        setRenaming(null);
                        focusRow(loop.id);
                      }}
                      onCancel={() => {
                        setRenaming(null);
                        focusRow(loop.id);
                      }}
                    />
                  ) : earliest ? (
                    <button
                      type="button"
                      data-loop-row={loop.id}
                      aria-current={current ? "true" : undefined}
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 ${focusRing}`}
                      onClick={() => {
                        actions.select(track.id, earliest.id);
                        onClose();
                      }}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm">{content}</div>
                  )}
                  <button
                    type="button"
                    aria-label={`Rename ${loop.name}`}
                    data-loop-row={earliest ? undefined : loop.id}
                    className={iconButton}
                    onClick={() => setRenaming(loop.id)}
                  >
                    <span aria-hidden="true">✎</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${loop.name}`}
                    className={iconButton}
                    onClick={() => {
                      const next = track.loops[i + 1] ?? track.loops[i - 1];
                      actions.deleteLoop(track.id, loop.id);
                      focusRow(next?.id);
                    }}
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <Button data-close onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}
