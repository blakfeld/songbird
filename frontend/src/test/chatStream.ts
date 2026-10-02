import { act } from "@testing-library/react";
import type { ChatEvent } from "@/generated/ChatEvent";
import type { ChatResponse } from "@/generated/ChatResponse";
import type { streamChat } from "@/lib/api";

type StreamChat = typeof streamChat;

// A stream that delivers only its final result, which is what a non-streaming reply looks like to useChat.
export const chatResult =
  (response: ChatResponse): StreamChat =>
  async (_body, { onEvent }) => {
    onEvent({ event: "result", data: response });
  };

// Lets a test decide when each event arrives, and honours the abort signal as a real fetch body does.
export function heldChat() {
  let onEvent: ((e: ChatEvent) => void) | undefined;
  let settle: { resolve: () => void; reject: (e: unknown) => void } | undefined;
  let signal: AbortSignal | undefined;
  const impl: StreamChat = (_body, options) =>
    new Promise<void>((resolve, reject) => {
      onEvent = options.onEvent;
      signal = options.signal;
      settle = { resolve, reject };
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  return {
    impl,
    get signal() {
      return signal;
    },
    emit: (event: ChatEvent) => act(async () => onEvent?.(event)),
    finish: (response: ChatResponse) =>
      act(async () => {
        onEvent?.({ event: "result", data: response });
        settle?.resolve();
      }),
    fail: (error: unknown) => act(async () => settle?.reject(error)),
  };
}
