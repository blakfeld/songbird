import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { inputClass } from "@/components/ui/classes";

// Laid out now so later changes fill an existing column instead of reworking the page grid.
export function AssistantPanel({ className = "" }: { className?: string }) {
  const titleId = useId();
  const noteId = useId();
  return (
    <aside
      aria-labelledby={titleId}
      className={`flex min-h-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
    >
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 id={titleId} className="text-sm font-semibold">
          Assistant
        </h2>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
        <div className="max-w-60 text-center">
          <p className="text-sm font-medium">Your song assistant</p>
          <p id={noteId} className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Soon you&apos;ll be able to ask for a bass line, a new drum part, or lyrics here.
          </p>
        </div>
      </div>
      <div className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <textarea
          disabled
          rows={2}
          aria-label="Message the assistant"
          aria-describedby={noteId}
          placeholder="Chat isn't available yet"
          className={`${inputClass} h-auto flex-1 resize-none py-2`}
        />
        <Button variant="primary" disabled aria-label="Send message" className="self-end">
          <span aria-hidden="true">➤</span>
        </Button>
      </div>
    </aside>
  );
}
