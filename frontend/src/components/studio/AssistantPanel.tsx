"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { inputClass } from "@/components/ui/classes";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Song, Track } from "@/lib/song/types";
import type { ChatController } from "./useChat";

// The instrument is named so the user can see what the assistant chose; it is dropped when the track name already says it.
function addedLabel(track: Track, instruments: readonly InstrumentInfo[] | null): string {
  const instrument = instruments?.find((i) => i.id === track.instrument)?.name;
  return instrument && instrument !== track.name
    ? `Added track: ${track.name} (${instrument})`
    : `Added track: ${track.name}`;
}

export function AssistantPanel({
  song,
  chat,
  instruments,
  className = "",
}: {
  song: Song | null;
  instruments: readonly InstrumentInfo[] | null;
  chat: ChatController;
  className?: string;
}) {
  const titleId = useId();
  const noteId = useId();
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLOListElement>(null);
  const messages = song?.chat ?? [];

  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [messages.length, chat.sending]);

  const submit = async () => {
    const text = draft;
    // The draft stays until the reply is recorded, so a failed request can be retried without retyping.
    if (await chat.send(text)) setDraft("");
  };
  const disabled = !song || chat.sending;

  return (
    <aside
      aria-labelledby={titleId}
      className={`flex min-h-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
    >
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 id={titleId} className="text-sm font-semibold">
          Assistant
        </h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="m-auto max-w-60 text-center">
            <p className="text-sm font-medium">Your song assistant</p>
            <p id={noteId} className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Ask for a part, like &ldquo;a piano that plays slow jazzy chords&rdquo;, and it is added as a new
              track.
            </p>
          </div>
        ) : (
          <ol ref={log} role="log" aria-label="Conversation" className="flex flex-col gap-3">
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
          </ol>
        )}
        {chat.sending && (
          <p role="status" className="mt-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Spinner />
            Thinking…
          </p>
        )}
      </div>
      {chat.error && (
        <div className="px-3 pb-2">
          <ErrorAlert message={chat.error} onDismiss={chat.dismissError} />
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled && draft.trim()) void submit();
        }}
        aria-busy={chat.sending}
        className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
      >
        <textarea
          rows={2}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          aria-label="Message the assistant"
          aria-describedby={messages.length === 0 ? noteId : undefined}
          placeholder="Describe a part to add"
          className={`${inputClass} h-auto flex-1 resize-none py-2`}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={disabled || draft.trim() === ""}
          aria-label="Send message"
          className="self-end"
        >
          <span aria-hidden="true">➤</span>
        </Button>
      </form>
    </aside>
  );
}
