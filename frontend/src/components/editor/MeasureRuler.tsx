import type { LoopRange } from "@/lib/audio/types";

export function MeasureRuler({
  measures,
  stepsPerMeasure,
  beatSteps,
  loop,
}: {
  measures: number;
  stepsPerMeasure: number;
  beatSteps: number;
  loop: LoopRange;
}) {
  const partial = !(loop.start === 1 && loop.end === measures);
  const beats = Math.floor(stepsPerMeasure / beatSteps);
  return (
    <div className="sticky top-0 z-30 flex h-7 border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950">
      {Array.from({ length: measures }, (_, m) => {
        const inLoop = partial && m + 1 >= loop.start && m + 1 <= loop.end;
        const isStart = partial && m + 1 === loop.start;
        const isEnd = partial && m + 1 === loop.end;
        return (
        <div
          key={m}
          data-in-loop={inLoop ? "true" : undefined}
          data-loop-start={isStart ? "true" : undefined}
          data-loop-end={isEnd ? "true" : undefined}
          className={`relative border-r-2 border-zinc-500 ${inLoop ? "bg-zinc-200 dark:bg-zinc-800" : ""} ${isStart ? "border-l-2 border-l-zinc-700 dark:border-l-zinc-300" : ""} ${isEnd ? "border-r-zinc-700 dark:border-r-zinc-300" : ""}`}
          style={{ width: `calc(${stepsPerMeasure} * var(--cell-w))` }}
        >
          <span className="absolute top-1 left-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
            {m + 1}
          </span>
          {Array.from({ length: beats - 1 }, (_, b) => (
            <span
              key={b}
              aria-hidden="true"
              className="absolute bottom-0 h-1.5 w-px bg-zinc-400"
              style={{ left: `calc(${(b + 1) * beatSteps} * var(--cell-w))` }}
            />
          ))}
        </div>
        );
      })}
    </div>
  );
}
