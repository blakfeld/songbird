"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { getShare, ListenError, UNAVAILABLE_MESSAGE, type ListenResponse } from "@/lib/listen/api";
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
      return <ListenPlayer token={token} data={state.data} />;
  }
}
