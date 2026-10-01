"use client";

import { useRef, useState } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { Button } from "@/components/ui/Button";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { exportSongMidi } from "@/lib/api";
import { saveBlob } from "@/lib/download";
import { projectFilename, readProjectFile, serializeProject } from "@/lib/song/projectFile";
import type { SongLibrary } from "@/lib/song/songLibrary";
import { newId, type Song } from "@/lib/song/types";

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

  // Reads can fail quietly (they return empty results), and an id that can't be ruled out as taken
  // must be regenerated, because saving under it would overwrite whatever is stored there.
  async function idIsTaken(id: string): Promise<boolean> {
    const { readStatus } = library;
    const indexed = (await library.list()).some((e) => e.id === id);
    if (indexed || readStatus.getState().failed) return true;
    const stored = await library.peek(id);
    const { failed, invalid } = readStatus.getState();
    return stored !== null || failed || invalid;
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
      // Saves are debounced, so the index is only complete once pending writes land.
      await library.flush();
      const imported = (await idIsTaken(parsed.ok.id)) ? { ...parsed.ok, id: newId() } : parsed.ok;
      await library.create(imported);
      onAnnounce(`Opened "${imported.name}" as a new song.`);
      onImported(imported);
    } catch {
      setError(OPEN_FAILURE);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Button onClick={() => void downloadMidi()} disabled={busy}>
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
