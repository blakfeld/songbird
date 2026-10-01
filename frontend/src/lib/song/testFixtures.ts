import type { TimeSignature } from "@/generated/TimeSignature";
import { newSong, newTrack, type Song } from "./types";

// Tests need tracks to edit, but new songs start empty, so they build the old Drums + Piano pair explicitly.
export function newSongWithTracks(timeSignature: TimeSignature = "4/4", tempoBpm = 120): Song {
  const song = newSong(timeSignature, tempoBpm);
  return { ...song, tracks: [newTrack("drums", "Drums"), newTrack("piano", "Piano")] };
}
