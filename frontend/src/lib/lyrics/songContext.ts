import type { LyricsSongContext } from "@/generated/LyricsSongContext";
import type { Song } from "../song/types";
import { sectionsOf } from "../songSectionOps";

// Built from sectionsOf rather than song.sections because implicit sections exist only in the browser, and their ids
// are sent as they are so a suggestion's section_id resolves against the same view when it comes back.
export function songContext(song: Song): LyricsSongContext {
  return {
    name: song.name,
    ...(song.key && { key: song.key }),
    tempo_bpm: song.tempo_bpm,
    time_signature: song.time_signature,
    sections: sectionsOf(song).map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      measures: s.measures,
      notes: s.notes,
      // Chord data does not exist until the chord feature lands.
      chords: [],
    })),
  };
}
