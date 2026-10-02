"use client";

import { useRef, useState } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { Button } from "@/components/ui/Button";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { ApiError, exportSongMidi } from "@/lib/api";
import { saveBlob } from "@/lib/download";
import { projectFilename, readProjectFile, serializeProject } from "@/lib/song/projectFile";
import type { SongLibrary } from "@/lib/song/songLibrary";
import type { Song } from "@/lib/song/types";

const OPEN_FAILURE = "Couldn't open that project. Your songs are unchanged.";
const EXPORT_FAILURE = "Couldn't export MIDI. Try again.";

export function SongFileActions({
  song,
  library,
  instruments,
  onImported,
  onAnnounce,
}: {
  song: Song;
  library: SongLibrary;
  // Unknown until the instrument list loads; a project can't be checked without it.
  instruments: InstrumentInfo[] | null;
  onImported: (song: Song) => void;
  onAnnounce: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function downloadMidi() {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await exportSongMidi(song);
      saveBlob(blob, filename);
      onAnnounce(`Saved ${filename}.`);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : EXPORT_FAILURE);
    } finally {
      setBusy(false);
    }
  }

  function downloadProject() {
    setError(null);
    const filename = projectFilename(song);
    saveBlob(new Blob([serializeProject(song)], { type: "application/json" }), filename);
    onAnnounce(`Saved ${filename}.`);
  }

  async function openProject(file: File) {
    setError(null);
    if (!instruments) return;
    try {
      const parsed = await readProjectFile(file, instruments);
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      // The server assigns the id, so an imported file can never replace a song that already has its id.
      // A refused import is reported here with the server's reason, not as a failed autosave.
      const created = await library.create(parsed.ok, { reportFailure: false });
      onAnnounce(`Opened "${created.name}" as a new song.`);
      onImported(created);
    } catch (e) {
      // Only validation refusals carry a reason the user can act on.
      setError(e instanceof ApiError && e.status === 422 ? e.message : OPEN_FAILURE);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Button onClick={() => void downloadMidi()} disabled={busy || song.tracks.length === 0}>
          <span aria-hidden="true">⤓</span>
          {busy ? "Preparing MIDI…" : "Download MIDI"}
        </Button>
        <Button onClick={downloadProject}>Download project</Button>
        <Button disabled={!instruments} onClick={() => input.current?.click()}>
          Open project…
        </Button>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          aria-label="Project file"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            // Cleared so choosing the same file again after fixing it still fires a change.
            e.target.value = "";
            if (chosen) void openProject(chosen);
          }}
        />
      </div>
      {error && (
        <div className="w-full">
          <ErrorAlert message={error} onDismiss={() => setError(null)} />
        </div>
      )}
    </>
  );
}
