export interface LoopColour {
  block: string;
  note: string;
  swatch: string;
}

// Literal class strings so Tailwind's scanner can see every colour. Neighbouring entries alternate
// warm and cool so a track's first few loops are the most distinct from each other.
export const LOOP_PALETTE: readonly LoopColour[] = [
  {
    block: "bg-indigo-500/15 border-indigo-600 dark:bg-indigo-400/15 dark:border-indigo-400",
    note: "fill-indigo-700 stroke-indigo-700 dark:fill-indigo-300 dark:stroke-indigo-300",
    swatch: "bg-indigo-600 dark:bg-indigo-400",
  },
  {
    block: "bg-amber-500/15 border-amber-600 dark:bg-amber-400/15 dark:border-amber-400",
    note: "fill-amber-700 stroke-amber-700 dark:fill-amber-300 dark:stroke-amber-300",
    swatch: "bg-amber-600 dark:bg-amber-400",
  },
  {
    block: "bg-teal-500/15 border-teal-600 dark:bg-teal-400/15 dark:border-teal-400",
    note: "fill-teal-700 stroke-teal-700 dark:fill-teal-300 dark:stroke-teal-300",
    swatch: "bg-teal-600 dark:bg-teal-400",
  },
  {
    block: "bg-rose-500/15 border-rose-600 dark:bg-rose-400/15 dark:border-rose-400",
    note: "fill-rose-700 stroke-rose-700 dark:fill-rose-300 dark:stroke-rose-300",
    swatch: "bg-rose-600 dark:bg-rose-400",
  },
  {
    block: "bg-sky-500/15 border-sky-600 dark:bg-sky-400/15 dark:border-sky-400",
    note: "fill-sky-700 stroke-sky-700 dark:fill-sky-300 dark:stroke-sky-300",
    swatch: "bg-sky-600 dark:bg-sky-400",
  },
  {
    // lime-600 is only about 3.0:1 on white, so the light border and swatch use -700.
    block: "bg-lime-500/15 border-lime-700 dark:bg-lime-400/15 dark:border-lime-400",
    note: "fill-lime-800 stroke-lime-800 dark:fill-lime-300 dark:stroke-lime-300",
    swatch: "bg-lime-700 dark:bg-lime-400",
  },
  {
    block: "bg-fuchsia-500/15 border-fuchsia-600 dark:bg-fuchsia-400/15 dark:border-fuchsia-400",
    note: "fill-fuchsia-700 stroke-fuchsia-700 dark:fill-fuchsia-300 dark:stroke-fuchsia-300",
    swatch: "bg-fuchsia-600 dark:bg-fuchsia-400",
  },
  {
    block: "bg-orange-500/15 border-orange-600 dark:bg-orange-400/15 dark:border-orange-400",
    note: "fill-orange-700 stroke-orange-700 dark:fill-orange-300 dark:stroke-orange-300",
    swatch: "bg-orange-600 dark:bg-orange-400",
  },
];

export const loopColour = (loopIndex: number) => LOOP_PALETTE[loopIndex % LOOP_PALETTE.length];
