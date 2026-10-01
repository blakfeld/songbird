"use client";

import { useCallback, useRef, useState } from "react";
import { sendChat } from "@/lib/api";
import { activeLoopRange } from "@/lib/song/songLoop";
import { CHAT_LIMIT, type SongStore } from "@/lib/song/songStore";

export function useChat(store: SongStore, announce: (message: string) => void) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref as well as state so a double submit in one tick cannot start two requests.
  const inFlight = useRef(false);

  // Resolves true once the reply is recorded, so the panel clears its input only for a message that was answered.
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const song = store.getState().song;
      const content = text.trim();
      if (!song || !content || inFlight.current) return false;
      inFlight.current = true;
      setSending(true);
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
        if (store.getState().loadEpoch !== epoch) return false;
        const refusal = store.getState().applyChatResult(content, response);
        if (refusal) {
          setError(refusal);
          return false;
        }
        announce(response.track ? `Added a ${response.track.name} track. Undo to remove it.` : "The assistant replied.");
        return true;
      } catch (err) {
        if (store.getState().loadEpoch !== epoch) return false;
        setError(`${err instanceof Error ? err.message : "Something went wrong."} The song is unchanged.`);
        return false;
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [store, announce],
  );

  return { sending, error, send, dismissError: () => setError(null) };
}

export type ChatController = ReturnType<typeof useChat>;
