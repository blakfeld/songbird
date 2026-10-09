"use client";

import { useState } from "react";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { saveBlob } from "@/lib/download";
import { getMidi } from "@/lib/listen/api";
import { mixdownSong } from "@/lib/listen/listenSong";
import { songMidiFilename, songWavFilename } from "@/lib/midiFilename";
import type { Song } from "@/lib/song/types";

const MIDI_FAILURE = "Couldn't download the MIDI file. Try again.";
const WAV_FAILURE = "Couldn't render the WAV. Try again.";

export function ListenDownloads({
  token,
  song,
  instruments,
}: {
  token: string;
  song: Song;
  instruments: InstrumentInfo[];
}) {
  const [busy, setBusy] = useState(false);
  const [render, setRender] = useState<{ progress: number; controller: AbortController } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  async function downloadMidi() {
    setBusy(true);
    setError(null);
    try {
      const filename = songMidiFilename(song);
      saveBlob(await getMidi(token), filename);
      setNotice(`Saved ${filename}.`);
    } catch {
      setError(MIDI_FAILURE);
    } finally {
      setBusy(false);
    }
  }

  async function downloadWav() {
    const controller = new AbortController();
    setRender({ progress: 0, controller });
    setError(null);
    try {
      // Loaded on demand so Tone stays out of the page until someone asks for a mixdown.
      const { renderMixdown, isMixdownCancelled } = await import("@/lib/audio/mixdown");
      try {
        const { wav } = await renderMixdown(
          mixdownSong(song),
          (progress) => setRender({ progress, controller }),
          controller.signal,
          { instruments },
        );
        const filename = songWavFilename(song);
        saveBlob(wav, filename);
        setNotice(`Saved ${filename}.`);
      } catch (e) {
        if (isMixdownCancelled(e)) setNotice("WAV render cancelled.");
        else throw e;
      }
    } catch {
      setError(WAV_FAILURE);
    } finally {
      setRender(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void downloadMidi()} disabled={busy}>
          <span aria-hidden="true">⤓</span>
          {busy ? "Preparing MIDI…" : "Download MIDI"}
        </Button>
        {render ? (
          <>
            <progress aria-label="Rendering WAV" className="h-2 w-24" max={1} value={render.progress} />
            <Button onClick={() => render.controller.abort()}>Cancel render</Button>
          </>
        ) : (
          <Button onClick={() => void downloadWav()}>Download WAV</Button>
        )}
      </div>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}
    </div>
  );
}
