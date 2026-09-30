"use client";

import Link from "next/link";
import { useState, type Ref } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/Button";
import { focusRing } from "@/components/ui/classes";
import { SwingSlider } from "@/components/editor/SwingSlider";
import { TempoField } from "@/components/editor/TempoField";
import type { SongLibrary } from "@/lib/song/songLibrary";
import { useSongStore, type SongStore } from "@/lib/song/songStore";
import { SONG_NAME_MAX, type Song } from "@/lib/song/types";
import { InlineNameInput } from "./InlineNameInput";
import { LengthField } from "./LengthField";
import { SongLibraryMenu } from "./SongLibraryMenu";
import type { TimeSignature } from "@/generated/TimeSignature";

const divider = "sm:border-l sm:border-zinc-200 sm:pl-6 dark:sm:border-zinc-800";

function SaveStatus({ library }: { library: SongLibrary }) {
  const { ok, saving } = useStore(library.status);
  if (!ok) {
    return (
      <span className="text-xs text-red-700 dark:text-red-300">
        <span aria-hidden="true">⚠ </span>Not saved
      </span>
    );
  }
  return (
    <span className="text-xs text-zinc-600 dark:text-zinc-400">{saving ? "Saving…" : "Saved"}</span>
  );
}

export function SongHeader({
  store,
  library,
  song,
  titleRef,
  onSetLength,
  onOpenSong,
  onSongCreated,
  onSongRemoved,
  onAnnounce,
  onToggleAssistant,
  assistantOpen,
}: {
  store: SongStore;
  library: SongLibrary;
  song: Song;
  titleRef: Ref<HTMLHeadingElement>;
  onSetLength: (measures: number) => void;
  onOpenSong: (id: string) => void;
  onSongCreated: (song: Song) => void;
  onSongRemoved: (wasCurrent: boolean) => void;
  onAnnounce: (message: string) => void;
  onToggleAssistant: () => void;
  assistantOpen: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const canUndo = useSongStore(store, (s) => s.past.length > 0);
  const canRedo = useSongStore(store, (s) => s.future.length > 0);
  const actions = () => store.getState();

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <nav aria-label="Breadcrumb" className="text-sm text-zinc-600 dark:text-zinc-400">
          <Link href="/" className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-black dark:focus-visible:outline-white">
            Songbird
          </Link>{" "}
          <span aria-hidden="true">›</span>
        </nav>
        <h1 ref={titleRef} tabIndex={-1} className="min-w-0 text-lg font-semibold outline-none">
          {renaming ? (
            <InlineNameInput
              value={song.name}
              label="Song name"
              maxLength={SONG_NAME_MAX}
              onCommit={(name) => {
                actions().renameSong(name);
                setRenaming(false);
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <button
              type="button"
              aria-label={`Rename song ${song.name}`}
              onClick={() => setRenaming(true)}
              className={`max-w-[16rem] truncate rounded px-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900 ${focusRing}`}
            >
              {song.name}
              <span aria-hidden="true" className="ml-1.5 text-sm font-normal text-zinc-500">✎</span>
            </button>
          )}
        </h1>
      </div>
      <SongLibraryMenu
        library={library}
        currentId={song.id}
        onOpen={onOpenSong}
        onCreated={onSongCreated}
        onRenameCurrent={(name) => actions().renameSong(name)}
        onRemoved={onSongRemoved}
        onAnnounce={onAnnounce}
      />
      <TempoField value={song.tempo_bpm} onCommit={(bpm) => actions().setTempo(bpm)} />
      <SwingSlider value={song.swing} onCommit={(s) => actions().setSwing(s)} />
      <LengthField value={song.measures} onCommit={onSetLength} />
      <TimeSignaturePill value={song.time_signature} />
      <div className={`flex items-center gap-2 ${divider}`}>
        <Button
          aria-label="Undo"
          title="Undo (⌘Z / Ctrl+Z)"
          aria-keyshortcuts="Meta+Z Control+Z"
          disabled={!canUndo}
          onClick={() => actions().undo()}
        >
          <span aria-hidden="true">↶</span>
          <span className="max-sm:hidden">Undo</span>
        </Button>
        <Button
          aria-label="Redo"
          title="Redo (⇧⌘Z / Ctrl+Shift+Z)"
          aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z"
          disabled={!canRedo}
          onClick={() => actions().redo()}
        >
          <span aria-hidden="true">↷</span>
          <span className="max-sm:hidden">Redo</span>
        </Button>
        <SaveStatus library={library} />
      </div>
      <Button
        className="lg:hidden"
        aria-expanded={assistantOpen}
        aria-haspopup="dialog"
        onClick={onToggleAssistant}
      >
        Assistant
      </Button>
    </header>
  );
}

function TimeSignaturePill({ value }: { value: TimeSignature }) {
  return (
    <span
      title="Chosen when the song was created"
      className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-zinc-800"
    >
      <span className="sr-only">Time signature </span>
      {value}
    </span>
  );
}
