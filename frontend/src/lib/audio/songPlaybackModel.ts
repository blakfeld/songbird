import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { SongStore } from "@/lib/song/songStore";
import { resolveTrackNotes } from "@/lib/song/clipOps";
import { audibleTracks } from "@/lib/song/songOps";
import type { PlaybackModel, Voice } from "./types";

// The song is read on every call rather than captured, so live edits and mixer
// changes reach the scheduler.
export function createSongPlaybackModel(
  store: SongStore,
  initialInstruments: InstrumentInfo[] | null = null,
): PlaybackModel & { setInstruments(instruments: InstrumentInfo[] | null): void } {
  // Instruments arrive from the API after the engine exists, so they are swapped in rather than captured.
  let instruments = initialInstruments;
  return {
    setInstruments(next) {
      instruments = next;
    },
    getTiming() {
      const song = store.getState().song;
      if (!song) return null;
      return {
        tempo: song.tempo_bpm,
        swing: song.swing,
        stepsPerMeasure: song.steps_per_measure,
        measures: song.measures,
      };
    },
    getVoices() {
      const song = store.getState().song;
      const list = instruments;
      if (!song || !list) return [];
      const audible = new Set(audibleTracks(song).map((t) => t.id));
      // A track whose instrument is no longer listed has no rows, so it stays silent instead of failing playback.
      return song.tracks.flatMap((t): Voice[] => {
        const info = list.find((i) => i.id === t.instrument);
        if (!info) return [];
        return [
          {
            key: t.id,
            instrument: t.instrument,
            rows: info.rows,
            notes: resolveTrackNotes(song, t),
            volumeDb: t.volume_db,
            pan: t.pan,
            audible: audible.has(t.id),
          },
        ];
      });
    },
  };
}
