"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { focusRing, hintClass, inputClass } from "@/components/ui/classes";
import { ListenError, postComment, type PostedComment } from "@/lib/listen/api";
import { BODY_MAX, NAME_MAX, checkComment, commentLength, normalizeBody, normalizeName } from "@/lib/listen/commentRules";
import { readName, writeName } from "@/lib/listen/listenerStorage";
import { describePosition } from "@/lib/listen/position";
import type { Song } from "@/lib/song/types";

const textareaClass = `min-h-24 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 aria-invalid:border-red-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:aria-invalid:border-red-400 ${focusRing}`;

function throttleMessage(error: ListenError): string {
  if (!error.retryAfterMs) return "Too many comments right now. Your text is kept; try again later.";
  const seconds = Math.ceil(error.retryAfterMs / 1000);
  const wait = seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : seconds >= 60 ? "a minute" : `${seconds} seconds`;
  return `Too many comments right now. Your text is kept; try again in about ${wait}.`;
}

export function CommentForm({
  token,
  tokenPrefix,
  song,
  pin,
  onStartWriting,
  onPosted,
}: {
  token: string;
  tokenPrefix: string;
  song: Song;
  // Null until the listener starts writing, because the position they mean is where they were when they began.
  pin: number | null;
  onStartWriting: () => void;
  onPosted: (comment: PostedComment) => void;
}) {
  const ids = { name: useId(), body: useId(), position: useId(), nameError: useId(), bodyError: useId(), trap: useId() };
  const [name, setName] = useState(() => readName(tokenPrefix));
  const [body, setBody] = useState("");
  const [website, setWebsite] = useState("");
  const [problems, setProblems] = useState<{ name?: string; body?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found = checkComment(name, body);
    setProblems(found);
    setFailure(null);
    setPosted(false);
    if (found.name || found.body || pin === null) return;
    setBusy(true);
    try {
      const comment = await postComment(token, { name: normalizeName(name), body: normalizeBody(body), at_step: pin, website });
      writeName(tokenPrefix, comment.name);
      setBody("");
      setPosted(true);
      onPosted(comment);
    } catch (err) {
      // The text is left in the field on every failure, so a throttle or a blip never costs the listener their words.
      if (err instanceof ListenError) setFailure(err.status === 429 ? throttleMessage(err) : err.message);
      else setFailure("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const bodyLength = commentLength(body);

  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-label="Leave a comment" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Leave a comment</h2>
      {/* Off-screen rather than display:none, because bots skip fields that are plainly hidden. Its name has no autofill meaning, so a password manager never fills it for a real listener. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input
            type="text"
            id={ids.trap}
            name="listen-extra-note"
            value={website}
            tabIndex={-1}
            // Chrome ignores "off" on fields it thinks it recognises; an unknown token is respected more reliably.
            autoComplete="one-time-code"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            data-form-type="other"
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>
      <Field label="Your name" htmlFor={ids.name} hint={problems.name} hintId={ids.nameError}>
        <input
          id={ids.name}
          value={name}
          autoComplete="nickname"
          aria-invalid={problems.name ? true : undefined}
          aria-describedby={problems.name ? ids.nameError : undefined}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field
        label="Comment"
        htmlFor={ids.body}
        hint={
          problems.body ??
          (bodyLength > BODY_MAX * 0.9 ? `${bodyLength} of ${BODY_MAX} characters` : undefined)
        }
        hintId={ids.bodyError}
      >
        <textarea
          id={ids.body}
          value={body}
          rows={3}
          aria-invalid={problems.body ? true : undefined}
          aria-describedby={[ids.position, problems.body ? ids.bodyError : null].filter(Boolean).join(" ")}
          onChange={(e) => {
            if (pin === null) onStartWriting();
            setBody(e.target.value);
          }}
          className={textareaClass}
        />
      </Field>
      <p id={ids.position} className={hintClass}>
        {pin === null
          ? "Start writing to pin your comment to the playhead, or click the timeline to choose a moment."
          : `Your comment is pinned ${describePosition(song, pin)}. Click the timeline to move it.`}
      </p>
      <p className={hintClass}>
        Names up to {NAME_MAX} characters and comments up to {BODY_MAX} characters. Only the song&apos;s owner can read them.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Posting…" : "Post comment"}
        </Button>
        {posted && <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">Comment posted.</p>}
      </div>
      {failure && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {failure}
        </p>
      )}
    </form>
  );
}
