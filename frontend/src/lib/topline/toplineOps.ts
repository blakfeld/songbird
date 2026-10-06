import type { Loop } from "@/generated/Loop";
import type { Note } from "@/generated/Note";
import type { Row } from "@/generated/Row";
import type { ToplineLine } from "@/generated/ToplineLine";
import type { ToplineSource } from "@/generated/ToplineSource";
import { lyricSections } from "@/lib/lyrics/headings";
import { linkKey } from "@/lib/lyrics/sectionLinks";
import { lyricLines, syllabifyLine } from "./syllabify";

export interface ReflowResult {
  loop: Loop;
  // Syllables left over after the last note, so the caller can tell the user what did not fit.
  unplaced: number;
}

// Lines with no singable word are dropped because the server requires every line to hold a syllable.
const singable = (lines: string[]) => lines.filter((line) => syllabifyLine(line).length > 0);

// Only the highest of several simultaneous notes gets a syllable, because the singer can sing one pitch at a time.
export function reflowLyrics(loop: Loop, rows: Pick<Row, "id" | "midi_note">[]): ReflowResult {
  if (!loop.topline) return { loop, unplaced: 0 };
  const midi = new Map(rows.map((r) => [r.id, r.midi_note]));
  const pitch = (n: Note) => midi.get(n.row_id) ?? -1;
  const syllables = loop.topline.lines.flatMap((l) => l.syllables);

  const singers = new Map<number, Note>();
  for (const n of loop.notes) {
    const held = singers.get(n.step);
    if (!held || pitch(n) > pitch(held)) singers.set(n.step, n);
  }
  const order = [...singers.values()].sort((a, b) => a.step - b.step);
  const assigned = new Map<Note, string>();
  order.forEach((n, i) => {
    if (i < syllables.length) assigned.set(n, syllables[i].text);
  });

  const notes = loop.notes.map((n) => {
    const text = assigned.get(n);
    if ((n.lyric ?? null) === (text ?? null)) return n;
    const { lyric: _previous, ...rest } = n;
    void _previous;
    return text === undefined ? rest : { ...rest, lyric: text };
  });
  const changed = notes.some((n, i) => n !== loop.notes[i]);
  return {
    loop: changed ? { ...loop, notes } : loop,
    unplaced: Math.max(0, syllables.length - order.length),
  };
}

// The first heading with the source's name is used, matching how a repeated heading is linked.
export function sectionLines(lyrics: string, sectionName: string): string[] | null {
  const heading = lyricSections(lyrics).find((h) => linkKey(h.name) === linkKey(sectionName));
  if (!heading) return null;
  return singable(lyricLines(lyrics.slice(heading.bodyFrom, heading.bodyTo)));
}

// A missing heading is not stale: the lyrics were moved or renamed, and there is nothing to compare against.
export function isStale(topline: ToplineSource, lyrics: string): boolean {
  const current = sectionLines(lyrics, topline.section_name);
  if (current === null) return false;
  const was = topline.lines.map((l) => l.text.trim());
  return current.length !== was.length || current.some((line, i) => line.trim() !== was[i]);
}

// Reuses the earlier syllables of an unchanged line so the user's corrections survive a regenerate.
export function seedSyllables(lines: string[], source?: ToplineSource): ToplineLine[] {
  const earlier = new Map<string, ToplineLine>();
  for (const line of source?.lines ?? []) earlier.set(line.text.trim(), line);
  return singable(lines.map((l) => l.trim())).map((text) => {
    const kept = earlier.get(text);
    return {
      text,
      syllables: (kept?.syllables ?? syllabifyLine(text)).map((s) => ({ ...s })),
    };
  });
}
