// Kept as one pattern so the editor decoration and any later section linking agree on what a heading is.
const HEADING = /^\s*\[[^\]\n]+\]\s*$/;

export const isHeadingLine = (line: string): boolean => HEADING.test(line);

// Zero-based indexes into split("\n"), which is what section linking will walk the text with.
export const headingLines = (text: string): number[] =>
  text.split("\n").flatMap((line, i) => (isHeadingLine(line) ? [i] : []));
