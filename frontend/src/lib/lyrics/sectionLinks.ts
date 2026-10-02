import type { Section } from "../song/types";
import { lyricSections, type LyricSection } from "./headings";

// Linking is by name, not id, because materializing implicit sections changes ids but keeps names.
export const linkKey = (name: string): string => name.trim().toLowerCase();

export interface LinkedLyricSection extends LyricSection {
  // Several song sections can share a name, and they share one heading the way a repeated chorus is written once.
  linked: Section[];
}

export function linkedSections(text: string, sections: Section[]): LinkedLyricSection[] {
  return lyricSections(text).map((h) => ({
    ...h,
    linked: sections.filter((s) => linkKey(s.name) === linkKey(h.name)),
  }));
}

// Returns text for one append at the end of the document, so the caller can apply it as a single undo step.
// The empty string means there is nothing to add.
export function missingHeadings(text: string, sections: Section[]): string {
  const seen = new Set(lyricSections(text).map((h) => linkKey(h.name)));
  const lines: string[] = [];
  for (const section of sections) {
    const key = linkKey(section.name);
    // A name with brackets or a newline could not be read back as a heading, so adding it would never link.
    if (!key || /[[\]\n]/.test(section.name) || seen.has(key)) continue;
    seen.add(key);
    lines.push(`[${section.name.trim()}]`);
  }
  if (lines.length === 0) return "";
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  return separator + lines.join("\n");
}
