"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useAiKeys } from "@/components/ai/AiKeysProvider";
import { ApiError, sendChat } from "@/lib/api";
import { describeError, isKeyErrorCode, type DescribedError } from "@/lib/aiKeys/keyError";
import { activeLoopRange } from "@/lib/song/songLoop";
import { CHAT_LIMIT, type SongStore } from "@/lib/song/songStore";

// "stale" means the song changed under the request, so the text belongs to a conversation that is gone.
export type SendOutcome = "sent" | "failed" | "ignored" | "stale";

export function useChat(store: SongStore, announce: (message: string) => void) {
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const { refresh } = useAiKeys();
  // A ref as well as state so a double submit in one tick cannot start two requests.
  const inFlight = useRef(false);
  // Tells a request that was abandoned by a song change apart from the current one when it finally settles.
  const requestId = useRef(0);
  const loadEpoch = useStore(store, (s) => s.loadEpoch);

  const [seenEpoch, setSeenEpoch] = useState(loadEpoch);
  // Adjusted during render so the old song's bubble never paints against the new song.
  if (seenEpoch !== loadEpoch) {
    setSeenEpoch(loadEpoch);
    setPending(null);
    setSending(false);
    setError(null);
  }
  useEffect(() => {
    requestId.current++;
    inFlight.current = false;
  }, [loadEpoch]);

  // The outcome lets the panel put the text back after a failure, since it clears its input on submit.
  const send = useCallback(
    async (text: string): Promise<SendOutcome> => {
      const song = store.getState().song;
      const content = text.trim();
      if (!song || !content || inFlight.current) return "ignored";
      inFlight.current = true;
      const id = ++requestId.current;
      setSending(true);
      setPending(content);
      setError(null);
      const range = activeLoopRange(song);
      const epoch = store.getState().loadEpoch;
      try {
        const response = await sendChat({
          song,
          messages: [...(song.chat ?? []), { role: "user" as const, content }]
            .slice(-CHAT_LIMIT)
            .map(({ role, content }) => ({ role, content })),
          ...(range && { range }),
        });
        // A reply for a song that was closed or reloaded meanwhile would otherwise land in the wrong conversation.
        if (store.getState().loadEpoch !== epoch) return "stale";
        const refusal = store.getState().applyChatResult(content, response);
        if (refusal) {
          setError({ message: refusal });
          return "failed";
        }
        announce(response.track ? `Added a ${response.track.name} track. Undo to remove it.` : "The assistant replied.");
        return "sent";
      } catch (err) {
        if (store.getState().loadEpoch !== epoch) return "stale";
        // The gate must reflect a key that was removed or revoked elsewhere.
        if (err instanceof ApiError && isKeyErrorCode(err.code)) void refresh();
        const { message, action } = describeError(err);
        setError({ message: `${message} The song is unchanged.`, action });
        return "failed";
      } finally {
        if (requestId.current === id) {
          inFlight.current = false;
          setPending(null);
          setSending(false);
        }
      }
    },
    [store, announce, refresh],
  );

  return { sending, pending, error: error?.message ?? null, errorAction: error?.action, send, dismissError: () => setError(null) };
}

export type ChatController = ReturnType<typeof useChat>;
