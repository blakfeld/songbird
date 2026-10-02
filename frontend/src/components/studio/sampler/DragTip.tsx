// Same chrome as the arrangement's drag tooltips, so a drop onto a sampler reads like a drop onto a lane.
export function DragTip({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute z-50 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-zinc-900 ${className}`}
    >
      {text}
    </div>
  );
}
