import type { LoopSetting } from "@/lib/loopRegion";

export function LoopShade({
  loop,
  measures,
  stepsPerMeasure,
}: {
  loop: LoopSetting;
  measures: number;
  stepsPerMeasure: number;
}) {
  // A disabled loop plays everything, so shading would wrongly suggest the rest is skipped.
  const { region } = loop;
  if (!loop.enabled || !region || (region.start === 1 && region.end === measures)) return null;
  const shade =
    "pointer-events-none absolute top-0 bottom-0 z-[12] bg-zinc-50/60 dark:bg-black/50";
  const unit = `calc(${stepsPerMeasure} * var(--cell-w))`;
  return (
    <>
      <div
        aria-hidden="true"
        data-testid="loop-shade"
        className={`${shade} left-0`}
        style={{ width: `calc(${region.start - 1} * ${unit})` }}
      />
      <div
        aria-hidden="true"
        data-testid="loop-shade"
        className={`${shade} right-0`}
        style={{ width: `calc(${measures - region.end} * ${unit})` }}
      />
    </>
  );
}
