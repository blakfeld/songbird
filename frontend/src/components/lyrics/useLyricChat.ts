"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useStore } from "zustand";
import { useAiKeys } from "@/components/ai/AiKeysProvider";
import { ApiError, assistLyrics } from "@/lib/api";
import { describeError, isKeyErrorCode, type DescribedError } from "@/lib/aiKeys/keyError";
import { songContext } from "@/lib/lyrics/songContext";
import { CHAT_LIMIT, type SongStore } from "@/lib/song/songStore";
import { sectionsOf } from "@/lib/songSectionOps";
import type { LyricsEditorHandle } from "./LyricsEditor";

// "stale" means the song changed under the request, so the text belongs to a conversation that is gone.
export type LyricSendOutcome = "sent" | "failed" | "ignored" | "stale";

export function useLyricChat(
  store: SongStore,
  editor: RefObject<LyricsEditorHandle | null>,
  announce: (message: string) => void,
) {
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  // Held here rather than in the panel because the panel unmounts on a tab switch, and a failure that lands after
  // that must still give the user's text back.
  const [draft, setDraft] = useState("");
  const { refresh } = useAiKeys();
  // A ref as well as state so a double submit in one tick cannot start two requests.
  const inFlight = useRef(false);
  const requestId = useRef(0);
  const loadEpoch = useStore(store, (s) => s.loadEpoch);

  const [seenEpoch, setSeenEpoch] = useState(loadEpoch);
  // Adjusted during render so the old song's bubble never paints against the new song.
  if (seenEpoch !== loadEpoch) {
    setSeenEpoch(loadEpoch);
    setPending(null);
    setSending(false);
    setError(null);
    setDraft("");
  }
  useEffect(() => {
    requestId.current++;
    inFlight.current = false;
  }, [loadEpoch]);

  const send = useCallback(
    async (text: string): Promise<LyricSendOutcome> => {
      const song = store.getState().song;
      const content = text.trim();
      if (!song || !content || inFlight.current) return "ignored";
      inFlight.current = true;
      const id = ++requestId.current;
      setSending(true);
      setPending(content);
      setError(null);
      const epoch = store.getState().loadEpoch;
      // Read from the editor because the store lags typing by the sync delay, and the selection offsets must match the text sent.
      const snapshot = editor.current?.snapshot() ?? null;
      try {
        const response = await assistLyrics({
          song_context: songContext(song),
          lyrics: snapshot?.doc ?? song.lyrics ?? "",
          ...(snapshot?.selection && { selection: { from: snapshot.selection.from, to: snapshot.selection.to } }),
          messages: [...(song.lyric_chat ?? []), { role: "user" as const, content }]
            .slice(-CHAT_LIMIT)
            .map(({ role, content }) => ({ role, content })),
        });
        // A reply for a song that was closed or reloaded meanwhile would otherwise land in the wrong conversation.
        if (store.getState().loadEpoch !== epoch) return "stale";
        // Names are read now, not at send time, so a rename while waiting is what gets stored.
        const names = Object.fromEntries(
          sectionsOf(store.getState().song ?? song).map((s) => [s.id, s.name]),
        );
        store.getState().applyLyricReply(content, snapshot?.selection ?? null, response, names);
        announce("The lyric assistant replied.");
        return "sent";
      } catch (err) {
        if (store.getState().loadEpoch !== epoch) return "stale";
        if (err instanceof ApiError && isKeyErrorCode(err.code)) void refresh();
        const { message, action } = describeError(err);
        setError({ message: `${message} Your lyrics and the conversation are unchanged.`, action });
        // Text typed while waiting is newer than the failed message, so it is never overwritten.
        setDraft((current) => (current === "" ? text : current));
        return "failed";
      } finally {
        if (requestId.current === id) {
          inFlight.current = false;
          setPending(null);
          setSending(false);
        }
      }
    },
    [store, editor, announce, refresh],
  );

  return {
    sending,
    pending,
    error: error?.message ?? null,
    errorAction: error?.action,
    send,
    draft,
    setDraft,
    dismissError: () => setError(null),
  };
}

export type LyricChatController = ReturnType<typeof useLyricChat>;
