import { linkKey } from "@/lib/lyrics/sectionLinks";
import type { MeasureSpan } from "@/lib/song/toplineApply";
import type { Section, Song } from "@/lib/song/types";
import { sectionStarts, sectionsOf } from "@/lib/songSectionOps";
import { sectionLines } from "./toplineOps";

export interface ToplineTarget {
  lines: string[];
  section: Section;
  range: MeasureSpan;
  // Other same-named sections of the same length, which can share the melody as linked clips.
  others: { section: Section; range: MeasureSpan }[];
}

// The first linked section in song order is the target, as the spec says when a heading links to several.
export function toplineTarget(song: Song, sectionName: string): ToplineTarget | null {
  const lines = sectionLines(song.lyrics ?? "", sectionName);
  if (lines === null) return null;
  const sections = sectionsOf(song);
  const starts = sectionStarts(sections);
  const linked = sections
    .map((section, i) => ({
      section,
      range: { start_measure: starts[i], end_measure: starts[i] + section.measures - 1 },
    }))
    .filter((s) => linkKey(s.section.name) === linkKey(sectionName));
  if (linked.length === 0) return null;
  const [first, ...rest] = linked;
  return {
    lines,
    section: first.section,
    range: first.range,
    others: rest.filter((s) => s.section.measures === first.section.measures),
  };
}

export const hasLinkedHeading = (song: Song, sectionName: string): boolean =>
  toplineTarget(song, sectionName) !== null;
