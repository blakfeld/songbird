import type { Section, SectionKind } from "@/lib/song/types";
import { SECTION_KIND_LABELS } from "@/lib/songSectionOps";

const measureSpan = (start: number, measures: number) =>
  measures === 1 ? `measure ${start}` : `measures ${start} to ${start + measures - 1}`;

// The name is spoken as written when it is just the kind, and with the kind in brackets otherwise, so the kind
// is never lost to colour alone.
export function sectionAccessibleName(s: Pick<Section, "name" | "kind" | "measures">, start: number): string {
  const named = s.name === SECTION_KIND_LABELS[s.kind] ? s.name : `${s.name} (${s.kind})`;
  return `${named}, ${measureSpan(start, s.measures)}`;
}

export const sectionRange = (s: Pick<Section, "measures">, start: number) =>
  s.measures === 1 ? `${start}` : `${start}–${start + s.measures - 1}`;

export interface SectionColour {
  // Stripe and fill together, so the two never drift apart per kind.
  block: string;
  selected: string;
  swatch: string;
}

// Literal class strings so Tailwind's scanner can see every colour. Kind is also in every accessible name,
// so colour is never the only carrier.
export const SECTION_PALETTE: Record<SectionKind, SectionColour> = {
  intro: {
    block: "border-sky-600 bg-sky-500/10 dark:border-sky-400 dark:bg-sky-400/15",
    selected: "border-sky-600 bg-sky-500/25 dark:border-sky-400 dark:bg-sky-400/30",
    swatch: "bg-sky-600 dark:bg-sky-400",
  },
  verse: {
    block: "border-indigo-600 bg-indigo-500/10 dark:border-indigo-400 dark:bg-indigo-400/15",
    selected: "border-indigo-600 bg-indigo-500/25 dark:border-indigo-400 dark:bg-indigo-400/30",
    swatch: "bg-indigo-600 dark:bg-indigo-400",
  },
  "pre-chorus": {
    block: "border-violet-600 bg-violet-500/10 dark:border-violet-400 dark:bg-violet-400/15",
    selected: "border-violet-600 bg-violet-500/25 dark:border-violet-400 dark:bg-violet-400/30",
    swatch: "bg-violet-600 dark:bg-violet-400",
  },
  chorus: {
    block: "border-amber-600 bg-amber-500/10 dark:border-amber-400 dark:bg-amber-400/15",
    selected: "border-amber-600 bg-amber-500/25 dark:border-amber-400 dark:bg-amber-400/30",
    swatch: "bg-amber-600 dark:bg-amber-400",
  },
  bridge: {
    block: "border-emerald-600 bg-emerald-500/10 dark:border-emerald-400 dark:bg-emerald-400/15",
    selected: "border-emerald-600 bg-emerald-500/25 dark:border-emerald-400 dark:bg-emerald-400/30",
    swatch: "bg-emerald-600 dark:bg-emerald-400",
  },
  outro: {
    block: "border-rose-600 bg-rose-500/10 dark:border-rose-400 dark:bg-rose-400/15",
    selected: "border-rose-600 bg-rose-500/25 dark:border-rose-400 dark:bg-rose-400/30",
    swatch: "bg-rose-600 dark:bg-rose-400",
  },
  other: {
    block: "border-zinc-500 bg-zinc-500/10 dark:border-zinc-400 dark:bg-zinc-400/15",
    selected: "border-zinc-500 bg-zinc-500/25 dark:border-zinc-400 dark:bg-zinc-400/30",
    swatch: "bg-zinc-500 dark:bg-zinc-400",
  },
};
