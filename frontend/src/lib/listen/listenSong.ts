import { isSamplerId, samplerSampleIds } from "@/lib/song/sampler";
import type { Song, Track } from "@/lib/song/types";

const AUDIO_INSTRUMENT = "audio";

// Recordings and samples live only in the owner's browser, so a listener's copy has nothing to play for them.
export const hasLocalAudio = (track: Track) =>
  track.instrument === AUDIO_INSTRUMENT || (isSamplerId(track.instrument) && samplerSampleIds(track).length > 0);

export const unavailableTracks = (song: Song): Track[] => song.tracks.filter(hasLocalAudio);

// Dropping the sample list and the sampler assignments leaves the playback model nothing to look up, so those
// tracks fall silent through its existing "sample not in the song" path and no browser sample store is ever read.
export function playableSong(song: Song): Song {
  return {
    ...song,
    // The server strips section notes entirely, but the shared Song type says they are always present.
    ...(song.sections && { sections: song.sections.map((s) => ({ ...s, notes: s.notes ?? "" })) }),
    samples: [],
    tracks: song.tracks.map((t) => {
      if (!t.sampler) return t;
      const copy = { ...t };
      delete copy.sampler;
      return copy;
    }),
  };
}

// An audio track would render as silence anyway, but leaving it out also spares the renderer a lookup of audio it never has.
export function mixdownSong(song: Song): Song {
  const playable = playableSong(song);
  return { ...playable, tracks: playable.tracks.filter((t) => t.instrument !== AUDIO_INSTRUMENT) };
}
