import type { Ref } from "react";
import type { Row } from "@/generated/Row";

export function RowLabels({ rows, ref }: { rows: Row[]; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="sticky left-0 z-30 w-28 max-sm:w-20">
      {rows.map((row) => (
        <div
          key={row.id}
          title={row.name}
          style={{ height: "var(--row-h)" }}
          className="flex items-center border-r border-b border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-700 max-sm:px-2 max-sm:text-xs dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
        >
          <span className="line-clamp-2 sm:truncate">{row.name}</span>
        </div>
      ))}
    </div>
  );
}
