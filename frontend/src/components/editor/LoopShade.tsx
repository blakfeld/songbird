import type { LoopRange } from "@/lib/audio/types";

export function LoopShade({
  loop,
  measures,
  stepsPerMeasure,
}: {
  loop: LoopRange;
  measures: number;
  stepsPerMeasure: number;
}) {
  if (loop.start === 1 && loop.end === measures) return null;
  const shade =
    "pointer-events-none absolute top-0 bottom-0 z-[12] bg-zinc-50/60 dark:bg-black/50";
  const unit = `calc(${stepsPerMeasure} * var(--cell-w))`;
  return (
    <>
      <div
        aria-hidden="true"
        data-testid="loop-shade"
        className={`${shade} left-0`}
        style={{ width: `calc(${loop.start - 1} * ${unit})` }}
      />
      <div
        aria-hidden="true"
        data-testid="loop-shade"
        className={`${shade} right-0`}
        style={{ width: `calc(${measures - loop.end} * ${unit})` }}
      />
    </>
  );
}
