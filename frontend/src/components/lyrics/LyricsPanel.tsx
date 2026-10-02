"use client";

import dynamic from "next/dynamic";
import type { Song } from "@/lib/song/types";

// CodeMirror needs the DOM, and loading it here keeps it out of the bundle until the panel first opens.
const LyricsEditor = dynamic(() => import("./LyricsEditor"), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-zinc-600 dark:text-zinc-400">Loading lyrics…</p>,
});

export function LyricsPanel({
  song,
  onChange,
  registerFlush,
  heading = false,
}: {
  song: Song | null;
  onChange: (text: string, songId: string) => void;
  registerFlush?: (flush: () => void) => () => void;
  // The drawer has no tab to name the panel, so it shows its own header.
  heading?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-white dark:bg-zinc-950">
      {heading && (
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Lyrics</h2>
        </div>
      )}
      {song && <LyricsEditor songId={song.id} lyrics={song.lyrics ?? ""} onChange={onChange} registerFlush={registerFlush} />}
    </div>
  );
}
