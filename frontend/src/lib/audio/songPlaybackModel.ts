import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { beatSteps } from "@/lib/pianoRoll";
import type { SongStore } from "@/lib/song/songStore";
import { resolveTrackNotes } from "@/lib/song/clipOps";
import { audibleTracks } from "@/lib/song/songOps";
import { songLoop } from "@/lib/song/songLoop";
import type { Song, Track } from "@/lib/song/types";
import type { PlaybackClip, PlaybackModel, Voice } from "./types";
import { resolveSound } from "./voiceSound";

// The engine clamps loop ranges to the timing length, so a region past the song's end needs it
// widened; play-once and whole-song looping must keep stopping at the song's real end.
function loopingMeasures(song: Song): number {
  const loop = songLoop(song);
  return loop.enabled && loop.region ? Math.max(song.measures, loop.region.end) : song.measures;
}

const AUDIO_INSTRUMENT = "audio";

// Keyed on the clip array so an unchanged track hands the scheduler the same list each tick.
const clipCache = new WeakMap<object, { samples: Song["samples"]; clips: PlaybackClip[] }>();

// A clip whose sample is not in the song is dropped rather than failing, so a broken reference is silent.
function resolveClips(song: Song, track: Track): PlaybackClip[] {
  const source = track.audio_clips ?? [];
  const cached = clipCache.get(source);
  if (cached && cached.samples === song.samples) return cached.clips;
  const rates = new Map((song.samples ?? []).map((s) => [s.id, s.sample_rate]));
  const clips = source.flatMap((clip): PlaybackClip[] => {
    const sampleRate = rates.get(clip.sample_id);
    return sampleRate === undefined ? [] : [{ clip, sampleRate }];
  });
  clipCache.set(source, { samples: song.samples, clips });
  return clips;
}

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
        beatSteps: beatSteps(song.time_signature),
        stepsPerMeasure: song.steps_per_measure,
        measures: loopingMeasures(song),
      };
    },
    getVoices() {
      const song = store.getState().song;
      if (!song) return [];
      const audible = new Set(audibleTracks(song).map((t) => t.id));
      return song.tracks.flatMap((t): Voice[] => {
        if (t.instrument === AUDIO_INSTRUMENT) {
          return [
            {
              key: t.id,
              kind: "audio",
              instrument: t.instrument,
              rows: [],
              notes: [],
              clips: resolveClips(song, t),
              volumeDb: t.volume_db,
              pan: t.pan,
              audible: audible.has(t.id),
              sound: resolveSound(t.sound),
            },
          ];
        }
        const info = instruments?.find((i) => i.id === t.instrument);
        // A track whose instrument is no longer listed has no rows, so it stays silent instead of failing playback.
        if (!info) return [];
        return [
          {
            key: t.id,
            kind: "instrument",
            instrument: t.instrument,
            rows: info.rows,
            notes: resolveTrackNotes(song, t),
            volumeDb: t.volume_db,
            pan: t.pan,
            audible: audible.has(t.id),
            sound: resolveSound(t.sound),
          },
        ];
      });
    },
  };
}
