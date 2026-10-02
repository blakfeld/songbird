"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing } from "@/components/ui/classes";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import type { SongIndexEntry, SongLibrary } from "@/lib/song/songLibrary";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { newSong, SONG_NAME_MAX, uniqueUntitledName, type Song } from "@/lib/song/types";
import { InlineNameInput } from "./InlineNameInput";

const iconButton = `inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 ${focusRing}`;

export function SongLibraryMenu({
  library,
  currentId,
  onOpen,
  onCreated,
  onRenameCurrent,
  onRemoved,
  onAnnounce,
}: {
  library: SongLibrary;
  currentId: string;
  onOpen: (id: string) => void;
  onCreated: (song: Song) => void;
  onRenameCurrent: (name: string) => void;
  // Called after the current song is deleted so the page can open another.
  onRemoved: (wasCurrent: boolean) => void;
  onAnnounce: (message: string) => void;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // State updates lag a double click, so a ref is what actually blocks the second create.
  const creatingRef = useRef(false);
  const [entries, setEntries] = useState<SongIndexEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SongIndexEntry | null>(null);

  const refresh = useCallback(async () => {
    const list = await library.list();
    setFailed(library.readStatus.getState().failed);
    setEntries(list);
  }, [library]);

  useEffect(() => {
    if (!open) return;
    // Saves are debounced, so the current song is flushed first or the list would miss it.
    void library.flush().then(refresh);
  }, [open, library, refresh]);

  return (
    <>
      <Button aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Songs <span aria-hidden="true">▾</span>
      </Button>
      <ModalDialog
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={titleId}
        className="m-auto w-full max-w-md rounded-2xl p-6"
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <h2 id={titleId} className="text-lg font-semibold">
              Songs
            </h2>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                if (creatingRef.current) return;
                creatingRef.current = true;
                setBusy(true);
                try {
                  // Saves are debounced and the shown list may be stale, so names come from a fresh flushed read.
                  await library.flush();
                  const names = (await library.list()).map((e) => e.name);
                  const song = { ...newSong(), name: uniqueUntitledName(names) };
                  await library.create(song);
                  setOpen(false);
                  onCreated(song);
                } finally {
                  creatingRef.current = false;
                  setBusy(false);
                }
              }}
            >
              New song
            </Button>
          </div>
          {failed && (
            <ErrorAlert message="Couldn't load your songs." onRetry={() => void refresh()} />
          )}
          {entries === null && !failed && (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Spinner />
              Loading songs…
            </p>
          )}
          {entries && (
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {entries.map((entry) => {
                const current = entry.id === currentId;
                return (
                  <li key={entry.id} className="flex items-center gap-1">
                    {renaming === entry.id ? (
                      <InlineNameInput
                        value={entry.name}
                        label={`Song name ${entry.name}`}
                        maxLength={SONG_NAME_MAX}
                        className="h-9 flex-1"
                        onCancel={() => setRenaming(null)}
                        onCommit={async (name) => {
                          setRenaming(null);
                          if (current) onRenameCurrent(name);
                          else await library.rename(entry.id, name);
                          setEntries((list) =>
                            list?.map((e) => (e.id === entry.id ? { ...e, name } : e)) ?? null,
                          );
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        aria-current={current ? "true" : undefined}
                        onClick={() => {
                          setOpen(false);
                          if (!current) onOpen(entry.id);
                        }}
                        className={`flex min-w-0 flex-1 flex-col rounded-md px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900 ${focusRing}`}
                      >
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">{entry.name}</span>
                          {current && (
                            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
                              Current
                            </span>
                          )}
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-zinc-800">
                            {entry.time_signature}
                          </span>
                        </span>
                        <time
                          dateTime={new Date(entry.updated_at).toISOString()}
                          title={new Date(entry.updated_at).toLocaleString()}
                          className="text-xs text-zinc-600 dark:text-zinc-400"
                        >
                          Edited {formatRelativeTime(entry.updated_at)}
                        </time>
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Rename ${entry.name}`}
                      className={iconButton}
                      onClick={() => setRenaming(entry.id)}
                    >
                      <span aria-hidden="true">✎</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Duplicate ${entry.name}`}
                      className={iconButton}
                      onClick={async () => {
                        const copy = await library.duplicate(entry.id);
                        if (copy) onAnnounce(`Duplicated as "${copy.name}".`);
                        await refresh();
                      }}
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${entry.name}`}
                      className={iconButton}
                      onClick={() => setDeleting(entry)}
                    >
                      <span aria-hidden="true">🗑</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex justify-end">
            <Button onClick={() => setOpen(false)}>Close</Button>
          </div>
        </div>
        <ModalDialog
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          role="alertdialog"
          label={deleting ? `Delete "${deleting.name}"?` : "Delete song"}
        >
          {deleting && (
            <div className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">Delete &quot;{deleting.name}&quot;?</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">This can&apos;t be undone.</p>
              <div className="flex justify-end gap-2">
                <Button autoFocus onClick={() => setDeleting(null)}>
                  Cancel
                </Button>
                <Button
                  className="!border-transparent !bg-red-600 !text-white hover:!bg-red-700"
                  onClick={async () => {
                    const target = deleting;
                    setDeleting(null);
                    await library.remove(target.id);
                    onRemoved(target.id === currentId);
                    await refresh();
                  }}
                >
                  Delete song
                </Button>
              </div>
            </div>
          )}
        </ModalDialog>
      </ModalDialog>
    </>
  );
}
