import type { Song } from "@/lib/song/types";
import { sectionStarts, sectionsOf } from "@/lib/songSectionOps";
import { stepToSeconds } from "@/lib/timing";

// Swing is left out because a comment is anchored to a step, and the clock only has to read plausibly beside it.
export function formatClock(step: number, song: Pick<Song, "tempo_bpm">): string {
  const seconds = Math.max(0, Math.floor(stepToSeconds(step, song.tempo_bpm, 0)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function songSteps(song: Pick<Song, "measures" | "steps_per_measure">): number {
  return song.measures * song.steps_per_measure;
}

export function sectionNameAt(song: Song, step: number): string | null {
  const sections = sectionsOf(song);
  const starts = sectionStarts(sections);
  const measure = Math.floor(step / song.steps_per_measure) + 1;
  const at = sections.findIndex((s, i) => measure >= starts[i] && measure < starts[i] + s.measures);
  // The inclusive end step is a valid comment position and belongs to the last section, as the server assigns it.
  if (at < 0) return step === songSteps(song) ? (sections.at(-1)?.name ?? null) : null;
  return sections[at].name;
}

// A stored section name wins over the song's current sections, because the owner may since have renamed or removed it.
export function describePosition(song: Song, step: number, storedSection?: string | null): string {
  const section = storedSection === undefined ? sectionNameAt(song, step) : storedSection;
  return `at ${formatClock(step, song)}${section ? ` in ${section}` : ""}`;
}
