"use client";

import Link from "next/link";
import { useId, useState, type Ref } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/Button";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Select } from "@/components/ui/Select";
import { focusRing, labelClass } from "@/components/ui/classes";
import { SwingSlider } from "@/components/editor/SwingSlider";
import { TempoField } from "@/components/editor/TempoField";
import type { SongLibrary } from "@/lib/song/songLibrary";
import { countTimeSignatureLosses, songKey } from "@/lib/song/songOps";
import { useSongStore, type SongStore } from "@/lib/song/songStore";
import { SONG_NAME_MAX, TONICS, type KeyMode, type Song, type Tonic } from "@/lib/song/types";
import { InlineNameInput } from "./InlineNameInput";
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
  onOpenSong,
  onSongCreated,
  onSongRemoved,
  onAnnounce,
  onToggleAssistant,
  assistantOpen,
  guardEdit = (edit) => edit(),
}: {
  store: SongStore;
  library: SongLibrary;
  song: Song;
  titleRef: Ref<HTMLHeadingElement>;
  onOpenSong: (id: string) => void;
  onSongCreated: (song: Song) => void;
  onSongRemoved: (wasCurrent: boolean) => void;
  onAnnounce: (message: string) => void;
  onToggleAssistant: () => void;
  assistantOpen: boolean;
  // Ends a running take before the history moves, so the take is committed and announced rather than cut off.
  guardEdit?: (edit: () => void) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const canUndo = useSongStore(
    store,
    // A take or drag in flight has no history entry yet, but undo still works because it commits that gesture first.
    (s) => s.past.length > 0 || (s.gestureBase !== null && s.gestureBase !== s.song),
  );
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
      <TimeSignatureField song={song} store={store} onAnnounce={onAnnounce} />
      <KeyField song={song} store={store} />
      <div className={`flex items-center gap-2 ${divider}`}>
        <Button
          aria-label="Undo"
          title="Undo (⌘Z / Ctrl+Z)"
          aria-keyshortcuts="Meta+Z Control+Z"
          disabled={!canUndo}
          onClick={() => guardEdit(() => actions().undo())}
        >
          <span aria-hidden="true">↶</span>
          <span className="max-sm:hidden">Undo</span>
        </Button>
        <Button
          aria-label="Redo"
          title="Redo (⇧⌘Z / Ctrl+Shift+Z)"
          aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z"
          disabled={!canRedo}
          onClick={() => guardEdit(() => actions().redo())}
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

const TIME_SIGNATURES: TimeSignature[] = ["4/4", "3/4", "6/8"];

const plural = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;

function TimeSignatureField({
  song,
  store,
  onAnnounce,
}: {
  song: Song;
  store: SongStore;
  onAnnounce: (message: string) => void;
}) {
  const id = useId();
  // The select stays controlled by the song, so a cancelled lossy change needs no reset.
  const [pending, setPending] = useState<{ ts: TimeSignature; losses: number } | null>(null);

  const apply = (ts: TimeSignature, losses: number) => {
    store.getState().setTimeSignature(ts);
    onAnnounce(`Time signature changed to ${ts}.${losses > 0 ? ` ${plural(losses)} removed.` : ""}`);
  };

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className={labelClass}>
        Time signature
      </label>
      <Select
        id={id}
        value={song.time_signature}
        className="w-20 font-mono tabular-nums"
        onChange={(e) => {
          const ts = e.target.value as TimeSignature;
          const losses = countTimeSignatureLosses(song, ts);
          if (losses === 0) apply(ts, 0);
          else setPending({ ts, losses });
        }}
      >
        {TIME_SIGNATURES.map((ts) => (
          <option key={ts} value={ts}>
            {ts}
          </option>
        ))}
      </Select>
      <ModalDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        role="alertdialog"
        label={pending ? `Change to ${pending.ts}?` : "Change time signature"}
      >
        {pending && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">
              Change to {pending.ts} and remove {plural(pending.losses)}?
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              A {pending.ts} measure is shorter than a {song.time_signature} measure. {plural(pending.losses)} in the
              last quarter note of a measure won&apos;t fit and will be removed. Every other note keeps its place in
              its measure. You can undo this.
            </p>
            <div className="flex justify-end gap-2">
              <Button autoFocus onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                className="!border-transparent !bg-red-600 !text-white hover:!bg-red-700"
                onClick={() => {
                  const { ts, losses } = pending;
                  setPending(null);
                  apply(ts, losses);
                }}
              >
                Change to {pending.ts}
              </Button>
            </div>
          </div>
        )}
      </ModalDialog>
    </div>
  );
}

// Sharps first with the enharmonic flat so flat-key writers can find their key.
const TONIC_LABELS: Record<Tonic, string> = {
  C: "C",
  "C#": "C♯/D♭",
  D: "D",
  "D#": "D♯/E♭",
  E: "E",
  F: "F",
  "F#": "F♯/G♭",
  G: "G",
  "G#": "G♯/A♭",
  A: "A",
  "A#": "A♯/B♭",
  B: "B",
};

function KeyField({ song, store }: { song: Song; store: SongStore }) {
  const labelId = useId();
  const key = songKey(song);
  return (
    <div role="group" aria-labelledby={labelId} className="flex items-center gap-2">
      <span id={labelId} className={labelClass}>
        Key
      </span>
      <div className="flex items-center gap-1.5">
        <Select
          aria-label="Key tonic"
          className="w-24"
          value={key.tonic}
          onChange={(e) => store.getState().setKey({ ...key, tonic: e.target.value as Tonic })}
        >
          {TONICS.map((t) => (
            <option key={t} value={t}>
              {TONIC_LABELS[t]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Key mode"
          className="w-24"
          value={key.mode}
          onChange={(e) => store.getState().setKey({ ...key, mode: e.target.value as KeyMode })}
        >
          <option value="major">Major</option>
          <option value="minor" title="Natural minor">
            Minor
          </option>
        </Select>
      </div>
    </div>
  );
}
