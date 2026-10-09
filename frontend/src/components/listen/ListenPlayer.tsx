"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Playhead } from "@/components/editor/Playhead";
import { SectionRuler } from "@/components/studio/SectionRuler";
import { Button } from "@/components/ui/Button";
import { useSongPlayback } from "@/lib/audio/useSongPlayback";
import type { ListenResponse, PostedComment } from "@/lib/listen/api";
import { playableSong, unavailableTracks } from "@/lib/listen/listenSong";
import { readOwnComments, rememberComment, tokenPrefixOf } from "@/lib/listen/listenerStorage";
import { sectionNameAt, songSteps } from "@/lib/listen/position";
import { defaultLoop } from "@/lib/loopRegion";
import { songKey } from "@/lib/song/songOps";
import { createSongStore } from "@/lib/song/songStore";
import { CommentForm } from "./CommentForm";
import { ListenDownloads } from "./ListenDownloads";
import { OwnComments } from "./OwnComments";
import { ReadOnlyLyrics } from "./ReadOnlyLyrics";

export function ListenPlayer({ token, data }: { token: string; data: ListenResponse }) {
  const { share, instruments } = data;
  const song = useMemo(() => playableSong(data.song), [data.song]);
  const tokenPrefix = tokenPrefixOf(token);
  // Built once from the served song, then never written to: this page has no edit surface at all.
  const [store] = useState(() => createSongStore(song));
  const [loop] = useState(defaultLoop);
  const playback = useSongPlayback(store, instruments, loop);
  const unavailable = useMemo(() => new Set(unavailableTracks(data.song).map((t) => t.id)), [data.song]);

  const playhead = useRef(0);
  const [currentSection, setCurrentSection] = useState<string | null>(() => sectionNameAt(song, 0));
  // Null until the listener starts writing, so the comment lands where they were listening when they began.
  const [pin, setPin] = useState<number | null>(null);
  // Safe to read here: this component mounts only after the song has been fetched in the browser.
  const [own, setOwn] = useState<PostedComment[]>(() => readOwnComments(tokenPrefix));

  const { subscribePosition } = playback;
  useEffect(
    () =>
      subscribePosition((step) => {
        if (step === null) return;
        playhead.current = Math.floor(step);
        setCurrentSection(sectionNameAt(song, playhead.current));
      }),
    [subscribePosition, song],
  );

  const seek = useCallback(
    (step: number) => {
      playhead.current = step;
      setCurrentSection(sectionNameAt(song, step));
      setPin((p) => (p === null ? null : step));
      playback.seek?.(Math.floor(step / song.steps_per_measure) + 1);
    },
    [playback, song],
  );

  const steps = songSteps(song);
  const key = song.key ? songKey(song) : null;
  const lyrics = song.lyrics ?? "";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 text-zinc-900 sm:px-6 dark:text-zinc-50">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{song.name}</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {song.tempo_bpm} BPM · {song.time_signature}
          {key && ` · ${key.tonic} ${key.mode}`}
        </p>
      </header>

      <section aria-label="Player" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={playback.toggle} aria-pressed={playback.isPlaying}>
            <span aria-hidden="true">{playback.isPlaying ? "■" : "▶"}</span>
            {playback.isPlaying ? "Stop" : "Play"}
          </Button>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            Section: <span className="font-medium">{currentSection ?? "None"}</span>
          </p>
        </div>
        {playback.status === "error" && playback.error && <ErrorAlert message={playback.error} />}
        <div className="@container min-w-0 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div style={{ "--cell-w": `calc(100cqw / ${steps})` } as React.CSSProperties}>
            <SectionRuler song={song} selectedId={null} onSeek={seek}>
              <Playhead subscribePosition={playback.subscribePosition} />
            </SectionRuler>
          </div>
        </div>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">Select a part of the timeline to jump there.</p>
      </section>

      <section aria-labelledby="listen-tracks-heading" className="flex flex-col gap-2">
        <h2 id="listen-tracks-heading" className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Tracks
        </h2>
        <ul className="flex flex-col gap-1 text-sm">
          {song.tracks.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <span>{t.name}</span>
              {unavailable.has(t.id) && (
                <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                  Unavailable
                </span>
              )}
            </li>
          ))}
        </ul>
        {unavailable.size > 0 && (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
            Some audio tracks aren&apos;t included in this shared song.
          </p>
        )}
      </section>

      {share.allow_downloads && <ListenDownloads token={token} song={song} instruments={instruments} />}

      <ReadOnlyLyrics lyrics={lyrics} />

      {share.allow_comments && (
        <>
          <CommentForm
            token={token}
            tokenPrefix={tokenPrefix}
            song={song}
            pin={pin}
            onStartWriting={() => setPin(playhead.current)}
            onPosted={(comment) => {
              setOwn(rememberComment(tokenPrefix, comment));
              setPin(null);
            }}
          />
          <OwnComments song={song} comments={own} />
        </>
      )}
    </main>
  );
}
