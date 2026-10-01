import type { ReactNode } from "react";

export function MeasureRuler({
  measures,
  stepsPerMeasure,
  beatSteps,
  labelEvery = 1,
  showBeats = true,
  beatLabels = false,
  dimFrom,
  children,
}: {
  measures: number;
  stepsPerMeasure: number;
  beatSteps: number;
  // A fit-to-width overview can be too narrow to print every bar number.
  labelEvery?: number;
  showBeats?: boolean;
  // Prints bar.beat at each beat tick, for rulers that are zoomed in enough to read them.
  beatLabels?: boolean;
  // Bar numbers from this 0-based measure on read as secondary, for a region past the song's end.
  dimFrom?: number;
  // Lets a host lay an interactive overlay over the cells without the ruler knowing about it.
  children?: ReactNode;
}) {
  const beats = Math.floor(stepsPerMeasure / beatSteps);
  const thinned = labelEvery > 1;
  return (
    <div className="sticky top-0 z-30 flex h-7 border-b border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950">
      {Array.from({ length: measures }, (_, m) => {
        return (
        <div
          key={m}
          className={`relative ${thinned ? "border-r border-zinc-300 dark:border-zinc-700" : "border-r-2 border-zinc-500"}`}
          style={{ width: `calc(${stepsPerMeasure} * var(--cell-w))` }}
        >
          {m % labelEvery === 0 && (
            <span
              className={`absolute top-1 left-1.5 text-xs font-semibold ${dimFrom !== undefined && m >= dimFrom ? "text-zinc-500" : "text-zinc-700 dark:text-zinc-300"}`}
            >
              {m + 1}
            </span>
          )}
          {showBeats &&
            Array.from({ length: beats - 1 }, (_, b) => (
              <span
                key={b}
                aria-hidden="true"
                className="absolute bottom-0 h-1.5 w-px bg-zinc-400"
                style={{ left: `calc(${(b + 1) * beatSteps} * var(--cell-w))` }}
              >
                {beatLabels && (
                  <span className="absolute bottom-1.5 left-1 text-[10px] whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                    {m + 1}.{b + 2}
                  </span>
                )}
              </span>
            ))}
        </div>
        );
      })}
      {children}
    </div>
  );
}
