import { focusRing } from "./classes";

// The labelled track is wired through aria-labelledby by the caller, so the switch needs no text of its own.
export function Switch({
  checked,
  onChange,
  label,
  describedBy,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  describedBy?: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 rounded-full px-1 py-0.5 text-sm font-medium pointer-coarse:py-1.5 ${focusRing}`}
    >
      <span
        aria-hidden="true"
        className={`relative h-4 w-7 rounded-full motion-safe:transition-colors ${checked ? "bg-indigo-600 dark:bg-indigo-400" : "bg-zinc-300 dark:bg-zinc-700"}`}
      >
        <span className={`absolute top-0.5 size-3 rounded-full bg-white shadow-sm ${checked ? "left-3.5" : "left-0.5"}`} />
      </span>
      {label}
    </button>
  );
}
