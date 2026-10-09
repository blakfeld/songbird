import { describePosition } from "@/lib/listen/position";
import type { PostedComment } from "@/lib/listen/api";
import type { Song } from "@/lib/song/types";

// Kept in this browser only: the listen API has no endpoint that returns comments, so nobody else's can appear here.
export function OwnComments({ song, comments }: { song: Song; comments: PostedComment[] }) {
  if (comments.length === 0) return null;
  return (
    <section aria-labelledby="own-comments-heading" className="flex flex-col gap-2">
      <h2 id="own-comments-heading" className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        Your comments
      </h2>
      <ul className="flex flex-col gap-2">
        {comments.map((c) => (
          <li key={c.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-900 dark:text-zinc-50">{c.name}</span>{" "}
              {describePosition(song, c.at_step, c.section_name)}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words">{c.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
