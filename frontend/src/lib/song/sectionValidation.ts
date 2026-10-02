import {
  MEASURE_RANGE,
  SECTION_KINDS,
  SECTION_MEASURE_RANGE,
  SECTION_NAME_MAX,
  SECTION_NOTES_MAX_CHARS,
} from "./types";

export type SectionErrorKind =
  | "malformed"
  | "duplicate_section_id"
  | "section_name"
  | "section_length"
  | "section_notes"
  | "section_total";

export interface SectionProblem {
  kind: SectionErrorKind;
  message: string;
}
const problem = (kind: SectionErrorKind, message: string): SectionProblem => ({ kind, message });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Mirrors the server's check order, whose shape errors all precede its rule errors, so the shared fixture
// agrees on which kind a doubly-broken song reports. The total is skipped for stored songs because
// normalizeSong repairs a stale one on load, whereas a project file is refused rather than silently rewritten.
export function sectionProblem(
  sections: unknown,
  songMeasures: number,
  options: { checkTotal: boolean },
): SectionProblem | null {
  if (sections === undefined) return null;
  if (!Array.isArray(sections)) return problem("malformed", "the sections are not a list");
  for (const s of sections) {
    if (
      !isObject(s) ||
      typeof s.id !== "string" ||
      typeof s.name !== "string" ||
      typeof s.notes !== "string" ||
      !Number.isInteger(s.measures) ||
      !SECTION_KINDS.includes(s.kind as never)
    )
      return problem("malformed", "a section is missing its id, name, kind, length, or notes");
  }
  const ids = new Set<string>();
  let total = 0;
  for (const s of sections as { id: string; name: string; notes: string; measures: number }[]) {
    if (ids.has(s.id)) return problem("duplicate_section_id", `section id "${s.id}" is used more than once`);
    ids.add(s.id);
    // UTF-16 units, as for loop and track names.
    if (s.name.length < 1 || s.name.length > SECTION_NAME_MAX)
      return problem("section_name", `section names must be 1 to ${SECTION_NAME_MAX} characters`);
    if (s.measures < SECTION_MEASURE_RANGE.min || s.measures > SECTION_MEASURE_RANGE.max)
      return problem(
        "section_length",
        `section "${s.name}" must be ${SECTION_MEASURE_RANGE.min} to ${SECTION_MEASURE_RANGE.max} measures`,
      );
    if ([...s.notes].length > SECTION_NOTES_MAX_CHARS)
      return problem(
        "section_notes",
        `section "${s.name}" notes must be at most ${SECTION_NOTES_MAX_CHARS.toLocaleString("en-US")} characters`,
      );
    total += s.measures;
  }
  if (sections.length === 0) return null;
  if (options.checkTotal && total !== songMeasures)
    return problem("section_total", `section lengths total ${total} measures but the song has ${songMeasures}`);
  if (total > MEASURE_RANGE.max)
    return problem("section_total", `sections total ${total} measures, over the ${MEASURE_RANGE.max} limit`);
  return null;
}
