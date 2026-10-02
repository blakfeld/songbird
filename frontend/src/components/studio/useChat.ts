"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useAiKeys } from "@/components/ai/AiKeysProvider";
import type { ChatEvent } from "@/generated/ChatEvent";
import { ApiError, streamChat } from "@/lib/api";
import { describeError, isKeyErrorCode, type DescribedError } from "@/lib/aiKeys/keyError";
import { activeLoopRange } from "@/lib/song/songLoop";
import { CHAT_LIMIT, type SongStore } from "@/lib/song/songStore";

// "stale" means the song changed under the request, so the text belongs to a conversation that is gone.
export type SendOutcome = "sent" | "failed" | "ignored" | "stale";

// "replanning" follows a reply_reset, so the streamed text vanishing reads as a retry rather than a glitch.
export type ChatStage =
  | { kind: "planning" | "replanning" }
  | { kind: "writing"; name: string; instrument: string };

const PLANNING: ChatStage = { kind: "planning" };

export function useChat(store: SongStore, announce: (message: string) => void) {
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [stage, setStage] = useState<ChatStage>(PLANNING);
  const [streamedReply, setStreamedReply] = useState("");
  const [error, setError] = useState<DescribedError | null>(null);
  const { refresh } = useAiKeys();
  // A ref as well as state so a double submit in one tick cannot start two requests.
  const inFlight = useRef(false);
  // Tells a request that was abandoned by a song change apart from the current one when it finally settles.
  const requestId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const loadEpoch = useStore(store, (s) => s.loadEpoch);

  const [seenEpoch, setSeenEpoch] = useState(loadEpoch);
  // Adjusted during render so the old song's bubble never paints against the new song.
  if (seenEpoch !== loadEpoch) {
    setSeenEpoch(loadEpoch);
    setPending(null);
    setStreamedReply("");
    setSending(false);
    setError(null);
  }
  // The cleanup runs on a song change and on unmount, the two times a reply has nowhere to land.
  useEffect(
    () => () => {
      abort.current?.abort();
      requestId.current++;
      inFlight.current = false;
    },
    [loadEpoch],
  );

  // The outcome lets the panel put the text back after a failure, since it clears its input on submit.
  const send = useCallback(
    async (text: string): Promise<SendOutcome> => {
      const song = store.getState().song;
      const content = text.trim();
      if (!song || !content || inFlight.current) return "ignored";
      inFlight.current = true;
      const id = ++requestId.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setSending(true);
      setPending(content);
      setStage(PLANNING);
      setStreamedReply("");
      setError(null);
      const range = activeLoopRange(song);
      const epoch = store.getState().loadEpoch;
      let outcome: SendOutcome = "failed";
      // A late event for an abandoned request or a closed song would land in the wrong conversation.
      const current = () => requestId.current === id && store.getState().loadEpoch === epoch;
      const settle = () => {
        if (requestId.current !== id) return;
        inFlight.current = false;
        setPending(null);
        setStreamedReply("");
        setSending(false);
      };
      const onEvent = (event: ChatEvent) => {
        if (!current()) return;
        switch (event.event) {
          case "progress": {
            const data = event.data;
            setStage((prev) =>
              data.stage === "writing"
                ? { kind: "writing", name: data.name, instrument: data.instrument }
                : prev.kind === "replanning"
                  ? prev
                  : PLANNING,
            );
            break;
          }
          case "reply_delta":
            setStreamedReply((prev) => prev + event.data.text);
            break;
          case "reply_reset":
            setStreamedReply("");
            setStage({ kind: "replanning" });
            break;
          case "result": {
            const response = event.data;
            const refusal = store.getState().applyChatResult(content, response);
            if (refusal) {
              setError({ message: refusal });
            } else {
              announce(
                response.track ? `Added a ${response.track.name} track. Undo to remove it.` : "The assistant replied.",
              );
              outcome = "sent";
            }
            // Same tick as the song update, so no frame shows the pending bubble beside the final message.
            settle();
            break;
          }
          case "error":
            // streamChat turns error events into a rejection, so none reaches this handler.
            break;
        }
      };
      try {
        await streamChat(
          {
            song,
            messages: [...(song.chat ?? []), { role: "user" as const, content }]
              .slice(-CHAT_LIMIT)
              .map(({ role, content }) => ({ role, content })),
            ...(range && { range }),
          },
          { signal: controller.signal, onEvent },
        );
        return current() ? outcome : "stale";
      } catch (err) {
        // An abort is the app's own decision (new send, song change, unmount), never a failure to report.
        if (controller.signal.aborted || !current()) return "stale";
        // The gate must reflect a key that was removed or revoked elsewhere.
        if (err instanceof ApiError && isKeyErrorCode(err.code)) void refresh();
        const { message, action } = describeError(err);
        setError({ message: `${message} The song is unchanged.`, action });
        return "failed";
      } finally {
        settle();
      }
    },
    [store, announce, refresh],
  );

  return {
    sending,
    pending,
    stage,
    streamedReply,
    error: error?.message ?? null,
    errorAction: error?.action,
    send,
    dismissError: () => setError(null),
  };
}

export type ChatController = ReturnType<typeof useChat>;
