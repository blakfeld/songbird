"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAiKeyGate } from "@/components/ai/AiKeyGate";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { inputClass } from "@/components/ui/classes";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { isSubmitEnter } from "@/lib/isSubmitEnter";
import type { Song, Track } from "@/lib/song/types";
import { trackLabel } from "./trackLabel";
import type { ChatController, ChatStage } from "./useChat";

// Within this distance of the end counts as following the conversation; further up means the user is rereading.
const STICK_TO_BOTTOM_PX = 32;

function addedLabel(track: Track, instruments: readonly InstrumentInfo[] | null): string {
  return `Added track: ${trackLabel(track.name, track.instrument, instruments)}`;
}

// The spoken form omits the ellipsis because some screen readers read it aloud as "dot dot dot".
function stepLabel(stage: ChatStage, instruments: readonly InstrumentInfo[] | null) {
  switch (stage.kind) {
    case "planning":
      return { visible: "Planning…", spoken: "Assistant is planning." };
    case "replanning":
      return { visible: "Planning again…", spoken: "Assistant is planning again." };
    case "writing": {
      const label = trackLabel(stage.name, stage.instrument, instruments, { idFallback: true });
      return { visible: `Writing ${label}…`, spoken: `Assistant is writing ${label}.` };
    }
  }
}

export function AssistantPanel({
  song,
  chat,
  instruments,
  heading = true,
  className = "",
}: {
  song: Song | null;
  instruments: readonly InstrumentInfo[] | null;
  chat: ChatController;
  // Inside the tabbed column the tab names the panel and the column supplies the frame.
  heading?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const noteId = useId();
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const messages = song?.chat ?? [];

  const following = useRef(true);
  const step = chat.sending ? stepLabel(chat.stage, instruments) : null;
  const stageKey = chat.stage.kind === "writing" ? `writing:${chat.stage.name}` : chat.stage.kind;

  useEffect(() => {
    // The user's own send always jumps to the end; later growth only follows a reader who is already there.
    if (chat.pending !== null) following.current = true;
  }, [chat.pending]);
  useEffect(() => {
    if (following.current) scroller.current?.scrollTo?.({ top: scroller.current.scrollHeight });
  }, [messages.length, chat.pending, chat.sending, chat.streamedReply, stageKey]);

  const submit = async () => {
    const text = draft;
    setDraft("");
    // A click on Send would otherwise leave focus on the button that just became disabled.
    input.current?.focus();
    const outcome = await chat.send(text);
    // Text typed while waiting is newer than the failed message, so it is never overwritten.
    if (outcome === "failed") setDraft((current) => (current === "" ? text : current));
  };
  const { blocked: noKey, noticeId, notice } = useAiKeyGate();
  const blocked = !song || chat.sending || noKey;
  const showLog = messages.length > 0 || chat.pending !== null;

  const Root = heading ? "aside" : "div";
  return (
    <Root
      aria-labelledby={heading ? titleId : undefined}
      className={`flex min-h-0 flex-col bg-white dark:bg-zinc-950 ${
        heading ? "border-l border-zinc-200 dark:border-zinc-800" : "flex-1"
      } ${className}`}
    >
      {heading && (
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 id={titleId} className="text-sm font-semibold">
            Assistant
          </h2>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX;
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
      >
        {!showLog ? (
          <div className="m-auto max-w-60 text-center">
            <p className="text-sm font-medium">Your song assistant</p>
            <p id={noteId} className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Ask for a part, like &ldquo;a piano that plays slow jazzy chords&rdquo;, and it is added as a new
              track.
            </p>
          </div>
        ) : (
          <ol role="log" aria-label="Conversation" className="flex flex-col gap-3">
            {messages.map((m, i) => {
              const track = m.track_id ? song?.tracks.find((t) => t.id === m.track_id) : undefined;
              return (
                <li
                  key={i}
                  className={`flex max-w-[90%] flex-col gap-1 rounded-lg px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "self-end bg-indigo-600 text-white dark:bg-indigo-400 dark:text-zinc-950"
                      : "self-start bg-zinc-100 dark:bg-zinc-900"
                  }`}
                >
                  <span className="sr-only">{m.role === "user" ? "You:" : "Assistant:"}</span>
                  <span className="whitespace-pre-wrap break-words">{m.content}</span>
                  {m.track_id && (
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">
                      {track ? addedLabel(track, instruments) : "Track removed"}
                    </span>
                  )}
                </li>
              );
            })}
            {chat.pending !== null && (
              <li className="flex max-w-[90%] flex-col gap-1 self-end rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white dark:bg-indigo-400 dark:text-zinc-950">
                <span className="sr-only">You:</span>
                <span className="whitespace-pre-wrap break-words">{chat.pending}</span>
              </li>
            )}
          </ol>
        )}
        {step && (
          <div className="mt-3 flex max-w-[90%] flex-col gap-1 self-start rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
            <span className="sr-only">Assistant:</span>
            {chat.streamedReply && (
              <p aria-live="off" className="whitespace-pre-wrap break-words">
                {chat.streamedReply}
              </p>
            )}
            <p aria-hidden="true" className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <Spinner />
              {step.visible}
            </p>
          </div>
        )}
        {/* Always mounted: a live region that appears together with its text is often not announced. */}
        <p role="status" data-testid="assistant-status" className="sr-only">
          {step?.spoken ?? ""}
        </p>
      </div>
      {notice && <div className="px-3 pb-2">{notice}</div>}
      {chat.error && (
        <div className="px-3 pb-2">
          <ErrorAlert message={chat.error} action={chat.errorAction} onDismiss={chat.dismissError} />
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked && draft.trim()) void submit();
        }}
        aria-busy={chat.sending}
        className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
      >
        <textarea
          ref={input}
          rows={2}
          value={draft}
          disabled={!song}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (isSubmitEnter(e)) {
              e.preventDefault();
              if (!chat.sending) e.currentTarget.form?.requestSubmit();
            }
          }}
          aria-label="Message the assistant"
          aria-describedby={[!showLog ? noteId : undefined, noticeId].filter(Boolean).join(" ") || undefined}
          placeholder="Describe a part to add"
          className={`${inputClass} h-auto flex-1 resize-none py-2`}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={blocked || draft.trim() === ""}
          aria-label="Send message"
          aria-describedby={noticeId}
          // Matches the textarea's height and corners so the pair reads as one
          // control; `!` is needed because Button's pill padding and radius
          // share these properties and would otherwise win by CSS order.
          className="w-12 shrink-0 self-stretch rounded-lg! px-0!"
        >
          <span aria-hidden="true">➤</span>
        </Button>
      </form>
    </Root>
  );
}
