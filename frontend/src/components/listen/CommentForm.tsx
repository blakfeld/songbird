"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Button, buttonClass } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { focusRing, hintClass } from "@/components/ui/classes";
import { ListenError, postComment, type PostedComment } from "@/lib/listen/api";
import { BODY_MAX, checkComment, commentLength, normalizeBody } from "@/lib/listen/commentRules";
import { describePosition } from "@/lib/listen/position";
import type { ListenSession } from "@/lib/listen/session";
import type { Song } from "@/lib/song/types";
import { SignInLink } from "./SignInLink";

const PROFILE_PATH = "/settings/profile";

const textareaClass = `min-h-24 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 aria-invalid:border-red-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:aria-invalid:border-red-400 ${focusRing}`;

function throttleMessage(error: ListenError): string {
  if (!error.retryAfterMs) return "Too many comments right now. Your text is kept; try again later.";
  const seconds = Math.ceil(error.retryAfterMs / 1000);
  const wait = seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : seconds >= 60 ? "a minute" : `${seconds} seconds`;
  return `Too many comments right now. Your text is kept; try again in about ${wait}.`;
}

export function CommentForm({
  token,
  song,
  pin,
  session,
  onSessionChange,
  onStartWriting,
  onPosted,
}: {
  token: string;
  song: Song;
  // Null until the listener starts writing, because the position they mean is where they were when they began.
  pin: number | null;
  session: ListenSession;
  onSessionChange: (session: ListenSession) => void;
  onStartWriting: () => void;
  onPosted: (comment: PostedComment) => void;
}) {
  const ids = { body: useId(), position: useId(), bodyError: useId() };
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || session.status !== "signedIn") return;
    const found = checkComment(body);
    setProblem(found.body);
    setFailure(null);
    setPosted(false);
    if (found.body || pin === null) return;
    setBusy(true);
    try {
      const comment = await postComment(token, { body: normalizeBody(body), at_step: pin });
      setBody("");
      setPosted(true);
      onPosted(comment);
    } catch (err) {
      // The text is left in the field on every failure, so a throttle, a blip or an expired session never costs the listener their words.
      if (err instanceof ListenError && err.status === 401) onSessionChange({ status: "signedOut" });
      else if (err instanceof ListenError && err.code === "username_required") onSessionChange({ status: "signedIn", username: null });
      else if (err instanceof ListenError) setFailure(err.status === 429 ? throttleMessage(err) : err.message);
      else setFailure("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (session.status === "checking") {
    return (
      <section aria-labelledby={`${ids.body}-heading`} aria-busy="true" className="flex flex-col gap-3">
        <h2 id={`${ids.body}-heading`} className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Leave a comment
        </h2>
        {/* Sized like the sign-in link, the likeliest outcome for a public link, so the page barely moves when the check returns. */}
        <div aria-hidden="true" className="h-9.5" />
      </section>
    );
  }

  const needsUsername = session.status === "signedIn" && session.username === null;

  // The username is chosen on the Profile page, so the listen page never needs a field of its own for it.
  const usernameNote = (
    <>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">Commenting needs a username. Song owners see it next to your comments.</p>
      <div>
        <Link href={PROFILE_PATH} className={buttonClass("secondary")}>
          Set a username in your profile
        </Link>
      </div>
    </>
  );

  if (needsUsername && body === "") {
    return (
      <section aria-labelledby={`${ids.body}-heading`} className="flex flex-col gap-3">
        <h2 id={`${ids.body}-heading`} className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Leave a comment
        </h2>
        {usernameNote}
      </section>
    );
  }

  // A signed-out visitor who already wrote something keeps the form, so an expired session never costs them the text.
  if (session.status === "signedOut" && body === "") {
    return (
      <section aria-labelledby={`${ids.body}-heading`} className="flex flex-col gap-3">
        <h2 id={`${ids.body}-heading`} className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Leave a comment
        </h2>
        <div>
          <SignInLink token={token}>Sign in to comment</SignInLink>
        </div>
      </section>
    );
  }

  const signedIn = session.status === "signedIn";
  const bodyLength = commentLength(body);

  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-label="Leave a comment" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Leave a comment</h2>
      {signedIn && !needsUsername && <p className={`${hintClass} break-words`}>Commenting as {session.username}</p>}
      {needsUsername && <div className="flex flex-col gap-3">{usernameNote}</div>}
      <Field
        label="Comment"
        htmlFor={ids.body}
        hint={problem ?? (bodyLength > BODY_MAX * 0.9 ? `${bodyLength} of ${BODY_MAX} characters` : undefined)}
        hintId={ids.bodyError}
      >
        <textarea
          id={ids.body}
          value={body}
          rows={3}
          aria-invalid={problem ? true : undefined}
          aria-describedby={[ids.position, problem ? ids.bodyError : null].filter(Boolean).join(" ")}
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
      <p className={hintClass}>Comments can be up to {BODY_MAX} characters. Only the song&apos;s owner can read them.</p>
      <div className="flex flex-wrap items-center gap-3">
        {needsUsername ? null : signedIn ? (
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Posting…" : "Post comment"}
          </Button>
        ) : (
          <SignInLink token={token}>Sign in to comment</SignInLink>
        )}
        {posted && <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">Comment posted.</p>}
      </div>
      {!signedIn && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          Your session has ended. Your text is kept; sign in to post it.
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {failure}
        </p>
      )}
    </form>
  );
}
