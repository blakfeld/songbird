"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { me } from "@/lib/auth/client";
import { getShare, ListenError, UNAVAILABLE_MESSAGE, type ListenResponse } from "@/lib/listen/api";
import type { ListenSession } from "@/lib/listen/session";
import { ListenPlayer } from "./ListenPlayer";

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: ListenResponse }
  | { kind: "unavailable" }
  | { kind: "limited" }
  | { kind: "failed" };

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center text-zinc-900 dark:text-zinc-50">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export function ListenPage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<ListenSession>({ status: "checking" });
  const share = state.kind === "ready" ? state.data.share : null;
  // Probed only where it can matter, so a link with neither feature never learns who is looking.
  const needsSession = share !== null && (share.allow_comments || share.allow_remix);

  useEffect(() => {
    const controller = new AbortController();
    getShare(token, controller.signal).then(
      (data) => setState({ kind: "ready", data }),
      (e: unknown) => {
        if (controller.signal.aborted) return;
        if (e instanceof ListenError && e.status === 404) setState({ kind: "unavailable" });
        else if (e instanceof ListenError && e.status === 429) setState({ kind: "limited" });
        else setState({ kind: "failed" });
      },
    );
    return () => controller.abort();
  }, [token, attempt]);

  useEffect(() => {
    if (!needsSession) return;
    let cancelled = false;
    // Quiet on a 401 because this page borrows the session and must never end it. Every failure reads as signed
    // out, since the sign-in link is the safe thing to offer when the state is unknown.
    me({ signOutOnUnauthenticated: false }).then(
      (user) => !cancelled && setSession({ status: "signedIn", username: user.username }),
      () => !cancelled && setSession({ status: "signedOut" }),
    );
    return () => {
      cancelled = true;
    };
  }, [needsSession, token]);

  const retry = () => {
    setState({ kind: "loading" });
    setAttempt((a) => a + 1);
  };

  switch (state.kind) {
    case "loading":
      return (
        <main className="flex flex-1 items-center justify-center p-6 text-zinc-900 dark:text-zinc-50">
          <p role="status">Loading…</p>
        </main>
      );
    case "unavailable":
      // Nothing more is said: the server answers the same for a link that never existed, so the page must too.
      return <Notice title={UNAVAILABLE_MESSAGE} />;
    case "limited":
      return (
        <Notice title="Please try again shortly">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Too many people are opening this link right now.</p>
          <Button onClick={retry}>Try again</Button>
        </Notice>
      );
    case "failed":
      return (
        <Notice title="Couldn't load this song">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Check your connection and try again.</p>
          <Button onClick={retry}>Try again</Button>
        </Notice>
      );
    case "ready":
      return <ListenPlayer token={token} data={state.data} session={session} onSessionChange={setSession} />;
  }
}
