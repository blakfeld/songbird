"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { hintClass } from "@/components/ui/classes";
import { navigateTo } from "@/lib/auth/navigation";
import { ListenError, remixShare } from "@/lib/listen/api";
import type { ListenSession } from "@/lib/listen/session";
import { SignInLink } from "./SignInLink";

export const AUDIO_NOTICE = "Audio tracks will be copied without their audio. You can add your own recordings afterwards.";

const MESSAGES = {
  project_limit: "You've reached your limit for stored songs. Delete a song in the Studio and try again.",
  throttled: "Try again shortly.",
  unavailable: "Remixing isn't available for this link.",
  failed: "Something went wrong. Please try again.",
} as const;

function failureMessage(err: unknown): string {
  if (!(err instanceof ListenError)) return MESSAGES.failed;
  if (err.code === "project_limit") return MESSAGES.project_limit;
  if (err.status === 429) return MESSAGES.throttled;
  if (err.status === 404) return MESSAGES.unavailable;
  return MESSAGES.failed;
}

export function RemixControl({
  token,
  session,
  audioWarning,
  onSessionChange,
}: {
  token: string;
  session: ListenSession;
  audioWarning: boolean;
  onSessionChange: (session: ListenSession) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function remix() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const id = await remixShare(token);
      // A full load, so the Studio starts with a real session check and per-user storage for this account,
      // neither of which this page set up.
      navigateTo(`/?song=${encodeURIComponent(id)}`);
      // Stays busy on success on purpose: the page is about to be replaced, and re-enabling the button would invite a second remix.
    } catch (err) {
      if (err instanceof ListenError && err.status === 401) onSessionChange({ status: "signedOut" });
      else setFailure(failureMessage(err));
      setBusy(false);
    }
  }

  const checking = session.status === "checking";

  return (
    <section aria-labelledby="listen-remix-heading" aria-busy={checking} className="flex flex-col gap-2">
      <h2 id="listen-remix-heading" className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        Remix
      </h2>
      {/* Shown before sign-in too, so a visitor knows what signing in would get them. */}
      <p className={hintClass}>Save your own copy of this song to edit in the Studio.</p>
      {checking ? (
        // Holds the button's height while the session is unknown, so the lyrics below don't jump when it resolves.
        <div aria-hidden="true" className="h-9.5" />
      ) : session.status === "signedOut" ? (
        <div>
          <SignInLink token={token}>Sign in to remix</SignInLink>
        </div>
      ) : (
        <>
          {audioWarning && (
            <p role="note" className="text-sm text-amber-700 dark:text-amber-400">
              {AUDIO_NOTICE}
            </p>
          )}
          <div>
            {/* Primary because remixing is the action a signed-in listener most likely came here to take. */}
            <Button variant="primary" onClick={() => void remix()} disabled={busy}>
              {busy && <Spinner />}
              {busy ? "Remixing…" : "Remix"}
            </Button>
          </div>
        </>
      )}
      {failure && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {failure}
        </p>
      )}
    </section>
  );
}
