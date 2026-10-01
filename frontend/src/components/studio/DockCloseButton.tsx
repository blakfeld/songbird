import { focusRing } from "@/components/ui/classes";

export function DockCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close piano roll"
      title="Close piano roll"
      onClick={onClose}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-zinc-100 pointer-coarse:size-9 dark:hover:bg-zinc-800 ${focusRing}`}
    >
      <span aria-hidden="true">✕</span>
    </button>
  );
}
