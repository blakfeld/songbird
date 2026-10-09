import { describePosition, songSteps } from "@/lib/listen/position";
import type { OwnerComment } from "@/lib/share/shareApi";
import type { Song } from "@/lib/song/types";

// Drawn as children of the section ruler, so they share its step scale and sit above its section blocks.
export function CommentMarkers({
  song,
  comments,
  selectedId,
  onSelect,
}: {
  song: Song;
  comments: OwnerComment[];
  selectedId: string | null;
  onSelect: (comment: OwnerComment) => void;
}) {
  const end = songSteps(song);
  return (
    <>
      {comments
        .filter((c) => c.resolved_at === null)
        .map((c) => {
          // A section that moved is not guessed at: a stale position is clamped and flagged instead of being put on the wrong bars.
          const past = c.at_step > end;
          const step = Math.min(c.at_step, end);
          const selected = c.id === selectedId;
          return (
            <button
              key={c.id}
              type="button"
              data-comment-marker={c.id}
              aria-pressed={selected}
              aria-label={`Comment from ${c.name} ${describePosition(song, step, c.section_name)}${past ? ", no longer in the song" : ""}`}
              title={past ? `${c.name}: no longer in the song` : c.name}
              onClick={() => onSelect(c)}
              style={{ left: `calc(var(--cell-w) * ${step})` }}
              className={`absolute top-0.5 bottom-0.5 z-20 w-3 rounded-sm border-2 text-[9px] leading-none font-bold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-black dark:focus-visible:outline-white ${
                past ? "-translate-x-full border-dashed border-amber-700 bg-amber-300 text-amber-950 dark:border-amber-300" : "border-white bg-indigo-600 dark:border-zinc-950 dark:bg-indigo-400"
              } ${selected ? "ring-2 ring-zinc-900 dark:ring-zinc-50" : ""}`}
            >
              {past && <span aria-hidden="true">!</span>}
            </button>
          );
        })}
    </>
  );
}
