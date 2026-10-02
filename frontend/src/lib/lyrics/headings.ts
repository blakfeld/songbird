// Kept as one pattern so the editor decoration and section linking agree on what a heading is.
const HEADING = /^\s*\[([^\]\n]+)\]\s*$/;

export const isHeadingLine = (line: string): boolean => HEADING.test(line);

// The name is returned as typed, because comparing names is the linker's job and the display should not be rewritten.
export const headingName = (line: string): string | null => HEADING.exec(line)?.[1] ?? null;

// Zero-based indexes into split("\n"), which is what section linking will walk the text with.
export const headingLines = (text: string): number[] =>
  text.split("\n").flatMap((line, i) => (isHeadingLine(line) ? [i] : []));

export interface LyricSection {
  name: string;
  headingFrom: number;
  // Starts after the heading's newline so a replacement never swallows the heading itself.
  bodyFrom: number;
  // Runs to the next heading's start, newline included, so replacing a body keeps the next heading on its own line.
  bodyTo: number;
}

// Offsets are string indices, which are CodeMirror positions, so callers can dispatch them without conversion.
export function lyricSections(text: string): LyricSection[] {
  const found: { name: string; headingFrom: number; lineEnd: number }[] = [];
  let from = 0;
  for (const line of text.split("\n")) {
    const name = headingName(line);
    if (name !== null) found.push({ name, headingFrom: from, lineEnd: from + line.length });
    from += line.length + 1;
  }
  return found.map((h, i) => ({
    name: h.name,
    headingFrom: h.headingFrom,
    bodyFrom: Math.min(h.lineEnd + 1, text.length),
    bodyTo: found[i + 1]?.headingFrom ?? text.length,
  }));
}
