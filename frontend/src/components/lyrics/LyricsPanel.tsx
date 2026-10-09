"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { HeightHandle } from "@/components/editor/HeightHandle";
import { Button } from "@/components/ui/Button";
import type { LyricChatSelection } from "@/generated/LyricChatSelection";
import type { StoredLyricSuggestion } from "@/generated/StoredLyricSuggestion";
import { applySuggestion } from "@/lib/lyrics/applySuggestion";
import { linkKey, missingHeadings } from "@/lib/lyrics/sectionLinks";
import type { SongStore } from "@/lib/song/songStore";
import type { Song } from "@/lib/song/types";
import { sectionsOf } from "@/lib/songSectionOps";
import { useStoredHeight } from "@/lib/useStoredHeight";
import { LyricChatPanel } from "./LyricChatPanel";
import type { LyricsEditorHandle } from "./LyricsEditor";
import type { ApplyReport } from "./SuggestionCard";
import type { LyricChatController } from "./useLyricChat";

// CodeMirror needs the DOM, and loading it here keeps it out of the bundle until the panel first opens.
const LyricsEditor = dynamic(() => import("./LyricsEditor"), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-zinc-600 dark:text-zinc-400">Loading lyrics…</p>,
});

const CHAT_HEIGHT_KEY = "songbird.lyrics.chatHeight";
// Below the minimum the chat could not show a reply and its form together, and the notepad could not show a few lines.
const MIN_CHAT_PX = 224;
const MIN_NOTEPAD_PX = 160;
const HANDLE_PX = 8;
const DEFAULT_CHAT_SHARE = 0.45;

export function LyricsPanel({
  song,
  store,
  chat,
  editorRef,
  focusedSongs,
  onChange,
  registerFlush,
  onPendingChange,
  onGenerateTopline,
  heading = false,
}: {
  song: Song | null;
  store: SongStore;
  // The controller and the editor handle belong to the page, because this panel unmounts on a tab switch and an
  // in-flight request, its error, and the editor's focus history must outlive that.
  chat: LyricChatController;
  editorRef: RefObject<LyricsEditorHandle | null>;
  focusedSongs: Set<string>;
  onChange: (text: string, songId: string) => void;
  registerFlush?: (flush: () => void) => () => void;
  onPendingChange?: (pending: boolean) => void;
  onGenerateTopline?: (headingName: string) => void;
  // The drawer has no tab to name the panel, so it shows its own header.
  heading?: boolean;
}) {
  const [ready, setReady] = useState(false);
  // Stable, because a new callback would make the editor re-register on every render.
  const registerEditor = useCallback(
    (handle: LyricsEditorHandle) => {
      editorRef.current = handle;
      setReady(true);
      return () => {
        if (editorRef.current === handle) editorRef.current = null;
        setReady(false);
      };
    },
    [editorRef],
  );

  const sections = useMemo(() => (song ? sectionsOf(song) : []), [song]);
  const keys = useMemo(() => [...new Set(sections.map((s) => linkKey(s.name)))], [sections]);
  const hasAllHeadings = missingHeadings(song?.lyrics ?? "", sections) === "";
  const noteId = useId();
  const reason = ready ? "Every section already has a heading." : "The notepad is still loading.";
  const [added, setAdded] = useState("");

  const addHeadings = () => {
    const handle = editorRef.current;
    if (!handle || !ready) return;
    // Decided on what the editor holds, because the store can lag typing.
    const { doc } = handle.snapshot();
    const insert = missingHeadings(doc, sections);
    if (insert === "" || !handle.apply({ from: doc.length, to: doc.length, insert })) return;
    const n = insert.split("\n").filter((line) => line !== "").length;
    setAdded(`Added ${n} ${n === 1 ? "heading" : "headings"}.`);
  };

  const applyStored = (
    suggestion: StoredLyricSuggestion,
    selection: LyricChatSelection | undefined,
  ): ApplyReport => {
    const handle = editorRef.current;
    if (!handle) return { message: "The notepad is not ready yet.", failed: true };
    const snap = handle.snapshot();
    const result = applySuggestion({
      suggestion,
      selection,
      doc: snap.doc,
      cursor: snap.cursor,
      hasFocused: snap.hasFocused,
      sections,
    });
    if (!handle.apply(result.change)) {
      return { message: "Lyrics limit reached. Nothing was changed.", failed: true };
    }
    if (result.notice) return { message: result.notice, failed: false };
    if (result.added) return { message: `✓ Added [${result.added}] at the end.`, failed: false };
    if (suggestion.action === "insert") {
      return { message: snap.hasFocused ? "✓ Inserted." : "✓ Inserted at the end.", failed: false };
    }
    return { message: "✓ Replaced.", failed: false };
  };

  const stack = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState(0);
  useEffect(() => {
    const el = stack.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setSpace(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [storedChat, setStoredChat] = useStoredHeight(CHAT_HEIGHT_KEY);
  const roomy = space >= MIN_CHAT_PX + MIN_NOTEPAD_PX + HANDLE_PX;
  const maxChat = Math.max(MIN_CHAT_PX, space - MIN_NOTEPAD_PX - HANDLE_PX);
  // Clamped at render and never written back, so a stored height survives a visit to a smaller window.
  const chatHeight = !roomy
    ? MIN_CHAT_PX
    : Math.min(maxChat, Math.max(MIN_CHAT_PX, storedChat ?? Math.round(space * DEFAULT_CHAT_SHARE)));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-white dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        {heading && <h2 className="text-sm font-semibold">Lyrics</h2>}
        <Button
          className="ml-auto !py-1 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          disabled={!song}
          // aria-disabled rather than disabled, so the button keeps focus after the click that completes the scaffold.
          aria-disabled={song && (!ready || hasAllHeadings) ? true : undefined}
          aria-describedby={song && (!ready || hasAllHeadings) ? noteId : undefined}
          title={song && (!ready || hasAllHeadings) ? reason : undefined}
          onClick={addHeadings}
        >
          Add section headings
        </Button>
        <span id={noteId} className="sr-only">
          {reason}
        </span>
        <span role="status" className="sr-only">
          {added}
        </span>
      </div>
      <div ref={stack} className="flex min-h-0 flex-1 flex-col">
        <div className={`flex min-h-0 flex-1 flex-col ${roomy ? "" : "min-h-24"}`}>
          {song && (
            <LyricsEditor
              songId={song.id}
              lyrics={song.lyrics ?? ""}
              onChange={onChange}
              registerFlush={registerFlush}
              onPendingChange={onPendingChange}
              registerEditor={registerEditor}
              focusedSongs={focusedSongs}
              sectionKeys={keys}
              onGenerateTopline={onGenerateTopline}
            />
          )}
        </div>
        {roomy && (
          <HeightHandle
            label="Resize lyric assistant"
            value={chatHeight}
            min={MIN_CHAT_PX}
            max={maxChat}
            grows="up"
            onChange={setStoredChat}
            onReset={() => setStoredChat(null)}
            className="pointer-coarse:h-4"
          />
        )}
        <div className="shrink-0" style={{ height: chatHeight }}>
          <LyricChatPanel
            key={song?.id}
            song={song}
            chat={chat}
            onApply={applyStored}
            onClear={() => store.getState().clearLyricChat()}
            headingLevel={heading ? 3 : 2}
          />
        </div>
      </div>
    </div>
  );
}
