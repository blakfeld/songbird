"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { Pattern } from "@/generated/Pattern";
import { Button } from "@/components/ui/Button";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing, hintClass } from "@/components/ui/classes";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { getSongLibrary, type SongIndexEntry, type SongLibrary } from "@/lib/song/songLibrary";
import { addTrackFromPattern } from "@/lib/song/songOps";
import { MAX_TRACKS, newSong, SONG_NAME_MAX, type Song } from "@/lib/song/types";
import { ErrorAlert } from "./ErrorAlert";

const NEW = "new";

// A new song holds only the sent track, not the default Drums and Piano, so the result is what the user sent.
function songFromPattern(pattern: Pattern): Song {
  return {
    ...newSong(pattern.time_signature, pattern.tempo_bpm),
    name: pattern.name.trim().slice(0, SONG_NAME_MAX) || "Untitled song",
    swing: pattern.swing,
    measures: pattern.measures,
    tracks: [],
  };
}

function SendForm({
  pattern,
  library,
  onClose,
}: {
  pattern: Pattern;
  library: SongLibrary;
  onClose: () => void;
}) {
  const id = useId();
  const [entries, setEntries] = useState<SongIndexEntry[] | null>(null);
  // Entries written before track_count existed are counted by loading the song, so "Full" is never guessed.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [choice, setChoice] = useState(NEW);
  const [selected, setSelected] = useState<Song | null>(null);
  const [phase, setPhase] = useState<"choose" | "sending" | "done">("choose");
  const [loadFailed, setLoadFailed] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [result, setResult] = useState<{ song: Song; trackNumber: number } | null>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await library.list();
      if (cancelled) return;
      const failed = library.readStatus.getState().failed;
      setLoadFailed(failed);
      if (failed) return;
      const matching = list.filter((e) => e.time_signature === pattern.time_signature);
      setEntries(matching);
      for (const entry of matching) {
        if (entry.track_count !== undefined) continue;
        const loaded = await library.peek(entry.id);
        if (!cancelled && loaded) {
          setCounts((c) => ({ ...c, [entry.id]: loaded.tracks.length }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [library, pattern.time_signature, attempt]);

  useEffect(() => {
    if (choice === NEW) return;
    let cancelled = false;
    void library.peek(choice).then((song) => {
      if (!cancelled) setSelected(song);
    });
    return () => {
      cancelled = true;
    };
  }, [choice, library]);

  useEffect(() => {
    if (phase === "done") confirmation.current?.focus();
  }, [phase]);

  const trackCount = (e: SongIndexEntry) => e.track_count ?? counts[e.id];
  const full = (e: SongIndexEntry) => (trackCount(e) ?? 0) >= MAX_TRACKS;

  async function send() {
    setPhase("sending");
    setSendFailed(false);
    try {
      const base = choice === NEW ? songFromPattern(pattern) : await library.peek(choice);
      if (!base) throw new Error("missing");
      const next = addTrackFromPattern(base, pattern);
      if (next === base) throw new Error("rejected");
      await library.put(next);
      // put() swallows storage errors into the status store, so success is confirmed from there.
      if (!library.status.getState().ok) throw new Error("storage");
      setResult({ song: next, trackNumber: next.tracks.length });
      setPhase("done");
    } catch {
      setSendFailed(true);
      setPhase("choose");
    }
  }

  const heading = (
    <h2 id={`${id}-title`} className="text-lg font-semibold">
      Send &quot;{pattern.name}&quot; to a song
    </h2>
  );

  if (phase === "done" && result) {
    return (
      <div className="flex flex-col gap-4">
        {heading}
        <div ref={confirmation} tabIndex={-1} role="status" className="text-sm outline-none">
          Added &quot;{pattern.name}&quot; to &quot;{result.song.name}&quot; as track {result.trackNumber}.
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Done</Button>
          <Link
            href={`/studio?song=${result.song.id}`}
            className={`inline-flex items-center justify-center rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 ${focusRing}`}
          >
            Open in Studio
          </Link>
        </div>
      </div>
    );
  }

  const measureNote =
    choice !== NEW && selected?.id === choice && selected.measures < pattern.measures
      ? `"${selected.name}" will be lengthened from ${selected.measures} to ${pattern.measures} bars.`
      : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className="flex flex-col gap-4"
    >
      {heading}
      {loadFailed && (
        <ErrorAlert
          message="Couldn't load your songs."
          onRetry={() => setAttempt((a) => a + 1)}
        />
      )}
      {sendFailed && (
        <ErrorAlert
          message="Couldn't send the pattern. Your songs weren't changed."
          onRetry={() => void send()}
        />
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Song</legend>
        <label className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900">
          <input
            type="radio"
            name={`${id}-song`}
            checked={choice === NEW}
            onChange={() => setChoice(NEW)}
            className="mt-1 accent-indigo-600"
          />
          <span className="flex flex-col">
            <span className="font-medium">New song</span>
            <span className={hintClass}>
              {pattern.tempo_bpm} BPM · {pattern.time_signature} · {pattern.measures} bars
            </span>
          </span>
        </label>
        {entries === null && !loadFailed && (
          <p role="status" className="flex items-center gap-2 px-2 py-1.5 text-sm">
            <Spinner />
            Loading songs…
          </p>
        )}
        {entries?.map((entry) => {
          const isFull = full(entry);
          return (
            <label
              key={entry.id}
              className={`flex items-start gap-3 rounded-md px-2 py-1.5 ${isFull ? "opacity-60" : "hover:bg-zinc-50 dark:hover:bg-zinc-900"}`}
            >
              <input
                type="radio"
                name={`${id}-song`}
                disabled={isFull}
                checked={choice === entry.id}
                onChange={() => setChoice(entry.id)}
                className="mt-1 accent-indigo-600"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{entry.name}</span>
                <span className={hintClass}>
                  {isFull
                    ? `Full: ${MAX_TRACKS} tracks`
                    : `Edited ${formatRelativeTime(entry.updated_at)}`}
                </span>
              </span>
            </label>
          );
        })}
        {measureNote && (
          <p role="status" className={hintClass}>
            {measureNote}
          </p>
        )}
        <p className={`${hintClass} mt-1`}>
          {entries && entries.length === 0
            ? `No ${pattern.time_signature} songs yet.`
            : `Only ${pattern.time_signature} songs are listed, because a song's time signature can't change.`}
        </p>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={phase === "sending"}>
          {phase === "sending" ? (
            <>
              <Spinner />
              Sending…
            </>
          ) : (
            "Send"
          )}
        </Button>
      </div>
    </form>
  );
}

export function SendToSongButton({
  pattern,
  library,
}: {
  pattern: Pattern;
  library?: SongLibrary;
}) {
  const [open, setOpen] = useState(false);
  const resolved = library ?? getSongLibrary();
  return (
    <>
      <Button aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Send to song…
      </Button>
      <ModalDialog
        open={open}
        onClose={() => setOpen(false)}
        label={`Send "${pattern.name}" to a song`}
        className="m-auto w-full max-w-md rounded-2xl p-6"
      >
        <SendForm pattern={pattern} library={resolved} onClose={() => setOpen(false)} />
      </ModalDialog>
    </>
  );
}
