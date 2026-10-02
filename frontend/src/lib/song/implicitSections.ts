import { SECTION_MEASURE_RANGE, type Section } from "./types";

export const IMPLICIT_SECTION_ID = "implicit";

// A section holds at most 32 measures, so a longer unsectioned song has to be shown, and later saved, as several.
export const implicitId = (index: number) => (index === 0 ? IMPLICIT_SECTION_ID : `${IMPLICIT_SECTION_ID}-${index + 1}`);
export const implicitName = (index: number) => (index === 0 ? "Song" : `Song ${index + 1}`);

// Null for any id that belongs to a real section.
export function implicitIndex(id: string): number | null {
  if (id === IMPLICIT_SECTION_ID) return 0;
  const match = id.match(/^implicit-(\d+)$/);
  return match ? Number(match[1]) - 1 : null;
}

// Equal 32-measure chunks with the remainder last, so the first edit has nothing to decide about where to cut.
export function implicitSections(measures: number): Section[] {
  const chunk = SECTION_MEASURE_RANGE.max;
  const count = Math.max(1, Math.ceil(measures / chunk));
  return Array.from({ length: count }, (_, i) => ({
    id: implicitId(i),
    name: implicitName(i),
    kind: "other" as const,
    measures: Math.min(chunk, measures - i * chunk) || 1,
    notes: "",
  }));
}
