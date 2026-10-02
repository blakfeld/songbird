"use client";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useId, useRef, useState } from "react";
import { isHeadingLine } from "@/lib/lyrics/headings";
import { LYRICS_MAX_CHARS } from "@/lib/song/types";

const COUNTER_FROM = 18_000;
const SYNC_DELAY_MS = 300;
const NOTICE_MS = 5_000;
const PLACEHOLDER =
  "Write your lyrics here. Put a section name in brackets, like [Chorus], on its own line to make a heading.";

// Marks changes that come from the store, which are already within the limit's rules and must not echo back.
const fromStore = Annotation.define<boolean>();

const codePoints = (text: string) => [...text].length;

const headingMark = Decoration.line({ class: "cm-lyric-heading" });

const headingPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      let last = -1;
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          if (line.from > last && isHeadingLine(line.text)) {
            builder.add(line.from, line.from, headingMark);
          }
          last = line.from;
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

// UTF-16 length bounds the code-point count from above, so the exact count is only needed past the counter threshold.
const overCounterFrom = (doc: { length: number; toString(): string }) => {
  if (doc.length <= COUNTER_FROM) return null;
  const count = codePoints(doc.toString());
  return count > COUNTER_FROM ? count : null;
};

interface EditorProps {
  songId: string;
  lyrics: string;
  onChange: (text: string, songId: string) => void;
  // Lets the page flush typing in flight before it switches songs, when blur may not have fired yet.
  registerFlush?: (flush: () => void) => () => void;
}

function Editor({
  songId,
  lyrics,
  onChange,
  registerFlush,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const pending = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  const lyricsRef = useRef(lyrics);
  const countId = useId();
  const [count, setCount] = useState<number | null>(() => overCounterFrom({ length: lyrics.length, toString: () => lyrics }));
  const [notice, setNotice] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
    lyricsRef.current = lyrics;
  });

  useEffect(() => {
    if (!host.current) return;
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    let noticeFrame: number | undefined;

    const flush = () => {
      clearTimeout(syncTimer);
      if (pending.current === null) return;
      const text = pending.current;
      pending.current = null;
      onChangeRef.current(text, songId);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };

    // Clearing first and setting on the next frame makes a repeat refusal announce again.
    const refuse = () => {
      setNotice(false);
      clearTimeout(noticeTimer);
      if (noticeFrame !== undefined) cancelAnimationFrame(noticeFrame);
      noticeFrame = requestAnimationFrame(() => {
        setNotice(true);
        noticeTimer = setTimeout(() => setNotice(false), NOTICE_MS);
      });
    };

    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: lyricsRef.current,
        extensions: [
          history(),
          // No indentWithTab: Tab has to leave the notepad so keyboard users are never trapped.
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of((v) => ({
            "aria-label": "Lyrics",
            ...(overCounterFrom(v.state.doc) !== null && { "aria-describedby": countId }),
          })),
          placeholder(PLACEHOLDER),
          headingPlugin,
          EditorState.changeFilter.of((tr) => {
            if (!tr.docChanged || tr.annotation(fromStore)) return true;
            if (tr.newDoc.length <= LYRICS_MAX_CHARS) return true;
            if (codePoints(tr.newDoc.toString()) <= LYRICS_MAX_CHARS) return true;
            refuse();
            return false;
          }),
          EditorView.domEventHandlers({ blur: () => void flush() }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            setCount(overCounterFrom(u.state.doc));
            if (u.transactions.some((tr) => tr.annotation(fromStore))) return;
            setNotice(false);
            pending.current = u.state.doc.toString();
            clearTimeout(syncTimer);
            syncTimer = setTimeout(flush, SYNC_DELAY_MS);
          }),
        ],
      }),
    });
    view.current = editor;
    document.addEventListener("visibilitychange", onVisibility);
    const unregister = registerFlush?.(flush);

    return () => {
      unregister?.();
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
      clearTimeout(noticeTimer);
      if (noticeFrame !== undefined) cancelAnimationFrame(noticeFrame);
      editor.destroy();
      view.current = null;
    };
  }, [songId, countId, registerFlush]);

  // Typing in flight wins until it has synced, so an outside change cannot erase the user's last few hundred ms of text.
  useEffect(() => {
    const editor = view.current;
    if (!editor || pending.current !== null) return;
    const current = editor.state.doc.toString();
    if (current === lyrics) return;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: lyrics },
      annotations: fromStore.of(true),
    });
  }, [lyrics]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={host}
        className="min-h-0 flex-1 overflow-y-auto font-sans text-sm leading-7 text-zinc-900 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-black dark:text-zinc-50 dark:focus-within:outline-white"
      />
      <div
        className={`flex items-center justify-between gap-2 ${
          count !== null || notice ? "border-t border-zinc-200 px-4 py-2 dark:border-zinc-800" : ""
        }`}
      >
        {count !== null && (
          <p id={countId} className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
            {count.toLocaleString("en-US")} / {LYRICS_MAX_CHARS.toLocaleString("en-US")} characters
          </p>
        )}
        <p role="status" className="text-xs font-semibold text-red-700 dark:text-red-400">
          {notice && `Lyrics limit reached (${LYRICS_MAX_CHARS.toLocaleString("en-US")} characters). That edit wasn't added.`}
        </p>
      </div>
    </div>
  );
}

// Keyed so opening another song starts a fresh editor, and with it a fresh undo history.
export default function LyricsEditor(props: EditorProps) {
  return <Editor key={props.songId} {...props} />;
}
