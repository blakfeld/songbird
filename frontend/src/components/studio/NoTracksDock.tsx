import { hintClass } from "@/components/ui/classes";
import { DockCloseButton } from "./DockCloseButton";

export function NoTracksDock({ sectionId, onClose }: { sectionId: string; onClose: () => void }) {
  return (
    <section
      id={sectionId}
      tabIndex={-1}
      aria-label="Editor"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-zinc-200 bg-white max-md:h-[40dvh] dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex shrink-0 justify-end px-2 py-1">
        <DockCloseButton onClose={onClose} />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <h2 className="text-sm font-semibold">No track to edit</h2>
        <p className={hintClass}>Add a track, then add a clip to start writing a loop.</p>
      </div>
    </section>
  );
}
