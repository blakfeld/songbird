import { SECTION_NAME_MAX } from "./types";

export const MAX_LYRIC_CHARS = 16;
export const MAX_TOPLINE_LINES = 32;
export const MAX_TOPLINE_LINE_CHARS = 200;
export const MAX_SYLLABLES_PER_LINE = 64;
export const MAX_TOPLINE_SYLLABLES = 256;

// Code points, like the server, so a syllable of emoji or non-Latin script gets the notepad's room.
export const isValidLyric = (text: unknown): boolean =>
  typeof text === "string" &&
  [...text].length >= 1 &&
  [...text].length <= MAX_LYRIC_CHARS &&
  !/[\n\r]/.test(text);

// Shared by the project-file check and the dialog's pre-flight so a request the dialog sends can always be saved
// and one the file loader accepts can always be sent; the server's validate_topline_lines is the reference.
export function toplineLimitProblem(
  sectionName: string,
  lines: { text: string; syllables: { text: string }[] }[],
): string | null {
  const name = sectionName.length;
  if (name < 1 || name > SECTION_NAME_MAX)
    return `the topline section name must be 1 to ${SECTION_NAME_MAX} characters`;
  if (lines.length < 1 || lines.length > MAX_TOPLINE_LINES)
    return `a topline holds 1 to ${MAX_TOPLINE_LINES} lines`;
  let total = 0;
  for (const line of lines) {
    if ([...line.text].length > MAX_TOPLINE_LINE_CHARS)
      return `a topline line holds at most ${MAX_TOPLINE_LINE_CHARS} characters`;
    if (line.syllables.length < 1 || line.syllables.length > MAX_SYLLABLES_PER_LINE)
      return `a topline line holds 1 to ${MAX_SYLLABLES_PER_LINE} syllables`;
    if (line.syllables.some((syl) => !isValidLyric(syl.text)))
      return `a syllable is 1 to ${MAX_LYRIC_CHARS} characters with no line breaks`;
    total += line.syllables.length;
  }
  if (total > MAX_TOPLINE_SYLLABLES) return `a topline holds at most ${MAX_TOPLINE_SYLLABLES} syllables in all`;
  return null;
}
