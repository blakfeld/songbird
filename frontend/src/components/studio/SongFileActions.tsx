"use client";

import { useRef, useState } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { Button } from "@/components/ui/Button";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { exportSongMidi } from "@/lib/api";
import { saveBlob } from "@/lib/download";
import { songWavFilename } from "@/lib/midiFilename";
import { projectFilename, readProjectFile, serializeProject } from "@/lib/song/projectFile";
import { bundleFilename, createProjectBundle, isBundleFile, readProjectBundle, usedSamples } from "@/lib/song/projectBundle";
import type { SongLibrary } from "@/lib/song/songLibrary";
import { newId, type Song } from "@/lib/song/types";

const OPEN_FAILURE = "Couldn't open that project. Your songs are unchanged.";
const EXPORT_FAILURE = "Couldn't export MIDI. Try again.";
const BUNDLE_FAILURE = "Couldn't save the project bundle. Try again.";
const WAV_FAILURE = "Couldn't render the WAV. Try again.";
const LOW_STORAGE_WARNING =
  "Browser storage is running low (under 200 MB free). Remove samples you no longer use to make room.";
const CLIP_WARNING = "The mix clipped: it reaches full scale, so it may sound distorted. Lower a track's volume and download again.";

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
  // Null when no render is running; the controller is what Cancel aborts.
  const [render, setRender] = useState<{ progress: number; controller: AbortController } | null>(null);
  // A warning that follows a finished action, so it does not stop the file from being saved or opened.
  const [notice, setNotice] = useState<string | null>(null);

  async function downloadWav() {
    if (!instruments) return;
    const controller = new AbortController();
    setRender({ progress: 0, controller });
    setError(null);
    setNotice(null);
    try {
      // Loaded on demand so Tone stays out of the page until someone asks for a mixdown.
      const { renderMixdown, isMixdownCancelled } = await import("@/lib/audio/mixdown");
      try {
        const { wav, clipped } = await renderMixdown(
          song,
          (progress) => setRender({ progress, controller }),
          controller.signal,
          { instruments },
        );
        const filename = songWavFilename(song);
        saveBlob(wav, filename);
        onAnnounce(`Saved ${filename}.`);
        // Shown after the download so the file is not withheld over a mix the user may have meant.
        if (clipped) setNotice(CLIP_WARNING);
      } catch (e) {
        if (isMixdownCancelled(e)) onAnnounce("WAV render cancelled.");
        else throw e;
      }
    } catch {
      setError(WAV_FAILURE);
    } finally {
      setRender(null);
    }
  }

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

  async function downloadProject() {
    setError(null);
    // Audio is not part of the song document, so a song with samples needs the bundle to survive a move.
    if (usedSamples(song).length > 0) {
      try {
        const filename = bundleFilename(song);
        saveBlob(await createProjectBundle(song), filename);
        onAnnounce(`Saved ${filename}.`);
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : BUNDLE_FAILURE);
      }
      return;
    }
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
    setNotice(null);
    if (!instruments) return;
    try {
      const parsed = (await isBundleFile(file))
        ? await readProjectBundle(file, instruments, () => setNotice(LOW_STORAGE_WARNING))
        : await readProjectFile(file, instruments);
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
        <Button onClick={() => void downloadMidi()} disabled={busy || song.tracks.length === 0}>
          <span aria-hidden="true">⤓</span>
          {busy ? "Preparing MIDI…" : "Download MIDI"}
        </Button>
        {render ? (
          <>
            <progress
              aria-label="Rendering WAV"
              className="h-2 w-24"
              max={1}
              value={render.progress}
            />
            <Button onClick={() => render.controller.abort()}>Cancel render</Button>
          </>
        ) : (
          <Button
            onClick={() => void downloadWav()}
            disabled={!instruments || song.tracks.length === 0}
          >
            Download WAV
          </Button>
        )}
        <Button onClick={() => void downloadProject()}>Download project</Button>
        <Button disabled={!instruments} onClick={() => input.current?.click()}>
          Open project…
        </Button>
        <input
          ref={input}
          type="file"
          accept=".json,.zip,application/json,application/zip"
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
      {notice && (
        <p role="status" className="w-full text-sm text-amber-700 dark:text-amber-400">
          {notice}
        </p>
      )}
      {error && (
        <div className="w-full">
          <ErrorAlert message={error} onDismiss={() => setError(null)} />
        </div>
      )}
    </>
  );
}
