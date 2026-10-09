"use client";

import { useEffect, useId, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { hintClass } from "@/components/ui/classes";
import { describePosition, songSteps } from "@/lib/listen/position";
import type { OwnerComment } from "@/lib/share/shareApi";
import type { Song } from "@/lib/song/types";

const ACTION_FAILURE = "Couldn't update that comment. Try again.";

export const commentElementId = (id: string) => `owner-comment-${id}`;

// Unresolved first, then by position in the song, so the list reads along the timeline.
function ordered(comments: OwnerComment[]): OwnerComment[] {
  return [...comments].sort(
    (a, b) =>
      Number(a.resolved_at !== null) - Number(b.resolved_at !== null) ||
      a.at_step - b.at_step ||
      a.created_at - b.created_at,
  );
}

export const isPastEnd = (song: Song, comment: OwnerComment) => comment.at_step > songSteps(song);

export function CommentsPanel({
  song,
  comments,
  loading,
  failed,
  unresolved,
  selectedId,
  onRefresh,
  onJump,
  onResolve,
  onDelete,
  heading = false,
}: {
  song: Song;
  comments: OwnerComment[];
  loading: boolean;
  failed: boolean;
  unresolved: number;
  selectedId: string | null;
  onRefresh: () => void;
  onJump: (comment: OwnerComment) => void;
  onResolve: (comment: OwnerComment, resolved: boolean) => Promise<void>;
  onDelete: (comment: OwnerComment) => Promise<void>;
  // The drawer has no tab to name the panel, so it shows its own header.
  heading?: boolean;
}) {
  const showResolvedId = useId();
  const [showResolved, setShowResolved] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId) document.getElementById(commentElementId(selectedId))?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  const visible = ordered(comments).filter((c) => showResolved || c.resolved_at === null);

  async function act(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch {
      setError(ACTION_FAILURE);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      {heading && <h2 className="text-lg font-semibold">Comments</h2>}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onRefresh} disabled={loading}>
          Refresh
        </Button>
        <label htmlFor={showResolvedId} className="flex items-center gap-2 text-sm">
          <input
            id={showResolvedId}
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>
      <p role="status" className={hintClass}>
        {loading ? "Loading comments…" : `${unresolved} unresolved ${unresolved === 1 ? "comment" : "comments"}`}
      </p>
      {failed && <ErrorAlert message="Couldn't load comments." onRetry={onRefresh} />}
      {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}
      {!loading && !failed && visible.length === 0 && (
        <p className={hintClass}>
          {comments.length === 0
            ? "No comments yet. Comments from listeners with a share link appear here."
            : "No unresolved comments."}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {visible.map((c) => {
          const resolved = c.resolved_at !== null;
          const selected = c.id === selectedId;
          return (
            <li
              key={c.id}
              id={commentElementId(c.id)}
              tabIndex={-1}
              aria-current={selected ? "true" : undefined}
              className={`flex flex-col gap-2 rounded-xl border p-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-black dark:focus-visible:outline-white ${
                selected
                  ? "border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/30"
                  : "border-zinc-200 dark:border-zinc-800"
              } ${resolved ? "opacity-70" : ""}`}
            >
              <p className={hintClass}>
                <span className="font-semibold text-zinc-900 dark:text-zinc-50">{c.name}</span>{" "}
                {describePosition(song, Math.min(c.at_step, songSteps(song)), c.section_name)}
                {resolved && " · Resolved"}
              </p>
              {isPastEnd(song, c) && (
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">This position is no longer in the song.</p>
              )}
              <p className="break-words whitespace-pre-wrap">{c.body}</p>
              <p className={hintClass}>{c.share_label || `Link ${c.token_prefix}…`}</p>
              {confirming === c.id ? (
                <div role="group" aria-label="Confirm delete" className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 basis-40">Delete this comment for good?</p>
                  <Button autoFocus onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                  <Button
                    className="!border-transparent !bg-red-600 !text-white hover:!bg-red-700"
                    onClick={() =>
                      void act(async () => {
                        await onDelete(c);
                        setConfirming(null);
                      })
                    }
                  >
                    Confirm delete
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button aria-label={`Jump to comment from ${c.name}`} onClick={() => onJump(c)}>
                    Jump
                  </Button>
                  <Button
                    aria-label={`${resolved ? "Reopen" : "Resolve"} comment from ${c.name}`}
                    onClick={() => void act(() => onResolve(c, !resolved))}
                  >
                    {resolved ? "Reopen" : "Resolve"}
                  </Button>
                  <Button aria-label={`Delete comment from ${c.name}`} onClick={() => setConfirming(c.id)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
