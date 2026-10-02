"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAiKeyGate } from "@/components/ai/AiKeyGate";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { TokenCounter } from "@/components/editor/TokenCounter";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing, inputClass } from "@/components/ui/classes";
import type { LyricChatSelection } from "@/generated/LyricChatSelection";
import type { StoredLyricSuggestion } from "@/generated/StoredLyricSuggestion";
import { getSongLimits } from "@/lib/api";
import { estimateTokens } from "@/lib/estimateTokens";
import { isSubmitEnter } from "@/lib/isSubmitEnter";
import type { Song } from "@/lib/song/types";
import { sectionsOf } from "@/lib/songSectionOps";
import { useApiResource } from "@/lib/useApiResource";
import { SuggestionCard, type ApplyReport } from "./SuggestionCard";
import type { LyricChatController } from "./useLyricChat";

// Entries have no id and the list is trimmed from the front, so an index key would hand one entry's applied status to another.
const entryKeys = new WeakMap<object, number>();
let nextEntryKey = 0;
const entryKey = (entry: object) => {
  let key = entryKeys.get(entry);
  if (key === undefined) entryKeys.set(entry, (key = nextEntryKey++));
  return key;
};

const textButton = `rounded-sm px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50 ${focusRing}`;

export function LyricChatPanel({
  song,
  chat,
  onApply,
  onClear,
  headingLevel,
}: {
  song: Song | null;
  chat: LyricChatController;
  onApply: (suggestion: StoredLyricSuggestion, selection: LyricChatSelection | undefined) => ApplyReport;
  onClear: () => void;
  // The drawer already has an h2 for "Lyrics"; the tab has none, so the title is the first heading there.
  headingLevel: 2 | 3;
}) {
  const titleId = useId();
  const countId = useId();
  const { draft, setDraft } = chat;
  const [confirming, setConfirming] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const messages = song?.lyric_chat ?? [];
  const sections = song ? sectionsOf(song) : [];

  const limits = useApiResource(getSongLimits);
  const max = limits.data?.max_input_tokens ?? null;
  const count = estimateTokens(draft);
  const overLimit = max !== null && count > max;

  useEffect(() => {
    scroller.current?.scrollTo?.({ top: scroller.current.scrollHeight });
  }, [messages.length, chat.pending, chat.sending]);

  // Moving focus into the confirmation keeps a keyboard user from losing their place when the button swaps out.
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
  }, [confirming]);

  const { blocked: noKey, noticeId, notice } = useAiKeyGate();
  const blocked = !song || chat.sending || noKey || overLimit;
  const showLog = messages.length > 0 || chat.pending !== null;

  const submit = async () => {
    const text = draft;
    setDraft("");
    input.current?.focus();
    await chat.send(text);
  };

  const cancelClear = () => {
    setConfirming(false);
    requestAnimationFrame(() => clearButton.current?.focus());
  };
  const confirmClear = () => {
    setConfirming(false);
    onClear();
    requestAnimationFrame(() => input.current?.focus());
  };

  const Title = headingLevel === 2 ? "h2" : "h3";
  const describedBy = [countId, noticeId].filter(Boolean).join(" ");

  return (
    <section aria-labelledby={titleId} className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
        <Title id={titleId} className="text-sm font-semibold">
          Lyric assistant
        </Title>
        {confirming ? (
          <div
            role="group"
            aria-label="Confirm clearing the conversation"
            className="flex items-center gap-1"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Escape here backs out of the confirmation only; it must not also close the drawer around it.
                e.preventDefault();
                e.stopPropagation();
                cancelClear();
              }
            }}
          >
            <span className="text-xs">Clear {messages.length} messages?</span>
            <Button className="!py-1 text-xs" onClick={confirmClear}>
              Clear
            </Button>
            <button type="button" ref={cancelButton} className={textButton} onClick={cancelClear}>
              Cancel
            </button>
          </div>
        ) : (
          messages.length > 0 &&
          !chat.sending && (
            <button type="button" ref={clearButton} className={textButton} onClick={() => setConfirming(true)}>
              Clear conversation
            </button>
          )
        )}
      </div>
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {!showLog ? (
          <div className="m-auto max-w-60 text-center">
            <p className="text-sm font-medium">Your lyric assistant</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Ask for a rhyme, a chorus, or a rewrite. Select lines in the notepad first to work on just those.
            </p>
          </div>
        ) : (
          <ol role="log" aria-label="Lyric conversation" className="flex flex-col gap-3">
            {messages.map((m) => (
              <li
                key={entryKey(m)}
                className={`flex flex-col ${m.role === "user" ? "items-end" : "w-full max-w-full items-start"}`}
              >
                <div
                  className={`flex max-w-[90%] flex-col gap-1 rounded-lg px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "bg-indigo-600 text-white dark:bg-indigo-400 dark:text-zinc-950"
                      : "bg-zinc-100 dark:bg-zinc-900"
                  }`}
                >
                  <span className="sr-only">{m.role === "user" ? "You:" : "Assistant:"}</span>
                  <span className="whitespace-pre-wrap break-words">{m.content}</span>
                </div>
                {m.suggestions?.map((s) => (
                  <SuggestionCard
                    key={s.id}
                    suggestion={s}
                    sections={sections}
                    onApply={(suggestion) => onApply(suggestion, m.selection)}
                  />
                ))}
              </li>
            ))}
            {chat.pending !== null && (
              <li className="flex max-w-[90%] flex-col gap-1 self-end rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white dark:bg-indigo-400 dark:text-zinc-950">
                <span className="sr-only">You:</span>
                <span className="whitespace-pre-wrap break-words">{chat.pending}</span>
              </li>
            )}
          </ol>
        )}
        {chat.sending && (
          <p role="status" className="mt-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Spinner />
            Thinking…
          </p>
        )}
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
          aria-label="Message the lyric assistant"
          aria-describedby={describedBy}
          aria-invalid={overLimit || undefined}
          placeholder="Ask about your lyrics"
          className={`${inputClass} h-auto flex-1 resize-none py-2`}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={blocked || draft.trim() === ""}
          aria-label="Send message"
          aria-describedby={describedBy}
          className="w-12 shrink-0 self-stretch rounded-lg! px-0!"
        >
          <span aria-hidden="true">➤</span>
        </Button>
      </form>
      <div className="-mt-1 px-3 pb-2">
        <TokenCounter id={countId} count={count} max={max} hint="Shorten your message." />
      </div>
    </section>
  );
}
