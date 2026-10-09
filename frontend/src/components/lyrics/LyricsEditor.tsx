"use client";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, Compartment, EditorState, Facet, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useId, useRef, useState } from "react";
import type { LyricChatSelection } from "@/generated/LyricChatSelection";
import type { TextChange } from "@/lib/lyrics/applySuggestion";
import { headingName, isHeadingLine } from "@/lib/lyrics/headings";
import { linkKey } from "@/lib/lyrics/sectionLinks";
import { LYRICS_MAX_CHARS } from "@/lib/song/types";

const COUNTER_FROM = 18_000;
const SYNC_DELAY_MS = 300;
const NOTICE_MS = 5_000;
const PLACEHOLDER =
  "Write your lyrics here. Put a section name in brackets, like [Chorus], on its own line to make a heading.";

// Marks changes that come from the store, which are already within the limit's rules and must not echo back.
const fromStore = Annotation.define<boolean>();

const codePoints = (text: string) => [...text].length;

const LIMIT_NOTICE = `Lyrics limit reached (${LYRICS_MAX_CHARS.toLocaleString("en-US")} characters). That edit wasn't added.`;

const headingMark = Decoration.line({ class: "cm-lyric-heading" });

// The explanation is on the line and the badge both, because a generated pseudo-element is unreliable for screen readers.
const unlinkedTitle = (name: string) => `No song section named "${name}". Rename a section or this heading to link them.`;
const unlinkedMark = (name: string) =>
  Decoration.line({
    class: "cm-lyric-heading cm-lyric-heading-unlinked",
    attributes: { title: unlinkedTitle(name) },
  });

class UnlinkedBadge extends WidgetType {
  constructor(readonly name: string) {
    super();
  }
  eq(other: UnlinkedBadge) {
    return other.name === this.name;
  }
  toDOM() {
    const badge = document.createElement("span");
    badge.className = "cm-lyric-unlinked-badge";
    badge.textContent = "no matching section";
    badge.title = unlinkedTitle(this.name);
    return badge;
  }
}

// Headings are the one place the topline action is offered from the notepad, so the action lives on the heading line.
const toplineAction = Facet.define<(name: string) => void, ((name: string) => void) | null>({
  combine: (values) => values.at(-1) ?? null,
});

class ToplineButton extends WidgetType {
  constructor(readonly name: string) {
    super();
  }
  eq(other: ToplineButton) {
    return other.name === this.name;
  }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-lyric-topline";
    // Drawn by CSS so the button adds no text to the line, which tests and copy-paste read as lyrics.
    button.dataset.label = "Generate topline";
    button.setAttribute("aria-label", `Generate topline for ${this.name}`);
    button.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
    button.addEventListener("click", () => view.state.facet(toplineAction)?.(this.name));
    return button;
  }
  // Without this the editor treats a click on the button as a click in the text and steals focus from it.
  ignoreEvent() {
    return true;
  }
}

// A shortcut as well as the heading button, because the button only exists for headings in the rendered viewport
// and a keyboard user should not have to scroll a long notepad to reach it. It does not edit the document.
function generateToplineAtCursor(view: EditorView): boolean {
  const action = view.state.facet(toplineAction);
  const keys = view.state.facet(sectionKeys);
  if (!action || !keys) return false;
  const { doc } = view.state;
  for (let n = doc.lineAt(view.state.selection.main.head).number; n >= 1; n--) {
    const text = doc.line(n).text;
    if (!isHeadingLine(text)) continue;
    const name = (headingName(text) ?? "").trim();
    if (!keys.has(linkKey(name))) return false;
    action(name);
    return true;
  }
  return false;
}

// Null means the section names are not known, so no heading is flagged rather than every one.
const sectionKeys = Facet.define<Set<string> | null, Set<string> | null>({
  combine: (values) => values.at(-1) ?? null,
});
const sectionKeyCompartment = new Compartment();
const keyExtension = (keys: readonly string[] | undefined) => sectionKeys.of(keys ? new Set(keys) : null);

export interface LyricsEditorSnapshot {
  doc: string;
  // Null for an empty selection, which the server also treats as none.
  selection: LyricChatSelection | null;
  cursor: number;
  hasFocused: boolean;
}

export interface LyricsEditorHandle {
  // Read from the editor, not the store, because the debounced sync can lag typing and offsets must match the text sent.
  snapshot: () => LyricsEditorSnapshot;
  // Returns false when the length limit refused the change. A notice is shown for a refusal or for the given message.
  apply: (change: TextChange, notice?: string) => boolean;
}

const headingPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      const keysChanged = u.startState.facet(sectionKeys) !== u.state.facet(sectionKeys);
      if (u.docChanged || u.viewportChanged || keysChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const keys = view.state.facet(sectionKeys);
      const offersTopline = view.state.facet(toplineAction) !== null;
      let last = -1;
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          if (line.from > last && isHeadingLine(line.text)) {
            const linked = !keys || keys.has(linkKey(headingName(line.text) ?? ""));
            const name = (headingName(line.text) ?? "").trim();
            // The builder needs ranges in position order, so the badge at the line end comes after the line mark.
            builder.add(line.from, line.from, linked ? headingMark : unlinkedMark(name));
            if (!linked) builder.add(line.to, line.to, Decoration.widget({ widget: new UnlinkedBadge(name), side: 1 }));
            else if (offersTopline && keys)
              builder.add(line.to, line.to, Decoration.widget({ widget: new ToplineButton(name), side: 1 }));
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
  // Lets the page keep "Saved" from showing while typing has not reached the store, which the library cannot see.
  onPendingChange?: (pending: boolean) => void;
  // Must be stable: it registers in its own effect so that a new callback never rebuilds the editor and its undo history.
  registerEditor?: (handle: LyricsEditorHandle) => () => void;
  // Changing it reconfigures a compartment, so a rename relinks headings without rebuilding the editor and losing undo history.
  sectionKeys?: readonly string[];
  // Owned by the page because the editor remounts on a tab switch, which must not make an insert jump back to the end.
  focusedSongs?: Set<string>;
  // Must be stable for the same reason as registerEditor; whether it is given is fixed when the editor is built.
  onGenerateTopline?: (headingName: string) => void;
}

function Editor({
  songId,
  lyrics,
  onChange,
  registerFlush,
  onPendingChange,
  registerEditor,
  sectionKeys: keys,
  focusedSongs: focusedSongsProp,
  onGenerateTopline,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const pending = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  const onPendingRef = useRef(onPendingChange);
  const lyricsRef = useRef(lyrics);
  const toplineRef = useRef(onGenerateTopline);
  const offersTopline = onGenerateTopline !== undefined;
  const keysRef = useRef(keys);
  const [ownFocused] = useState(() => new Set<string>());
  const focused = focusedSongsProp ?? ownFocused;
  const refused = useRef(false);
  const showNotice = useRef<(message: string) => void>(() => {});
  const countId = useId();
  const [count, setCount] = useState<number | null>(() => overCounterFrom({ length: lyrics.length, toString: () => lyrics }));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
    onPendingRef.current = onPendingChange;
    toplineRef.current = onGenerateTopline;
    lyricsRef.current = lyrics;
    keysRef.current = keys;
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
      onPendingRef.current?.(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };

    // Clearing first and setting on the next frame makes a repeat refusal announce again.
    const announce = (message: string) => {
      setNotice(null);
      clearTimeout(noticeTimer);
      if (noticeFrame !== undefined) cancelAnimationFrame(noticeFrame);
      noticeFrame = requestAnimationFrame(() => {
        setNotice(message);
        noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
      });
    };
    showNotice.current = announce;
    const refuse = () => {
      refused.current = true;
      announce(LIMIT_NOTICE);
    };

    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: lyricsRef.current,
        extensions: [
          history(),
          // No indentWithTab: Tab has to leave the notepad so keyboard users are never trapped.
          // Listed first so it wins over the default Mod-Enter (insert a blank line) only when the page offers the action.
          keymap.of([{ key: "Mod-Enter", run: generateToplineAtCursor }, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of((v) => ({
            "aria-label": "Lyrics",
            ...(overCounterFrom(v.state.doc) !== null && { "aria-describedby": countId }),
          })),
          placeholder(PLACEHOLDER),
          sectionKeyCompartment.of(keyExtension(keysRef.current)),
          headingPlugin,
          ...(offersTopline ? [toplineAction.of((name) => toplineRef.current?.(name))] : []),
          EditorState.changeFilter.of((tr) => {
            if (!tr.docChanged || tr.annotation(fromStore)) return true;
            if (tr.newDoc.length <= LYRICS_MAX_CHARS) return true;
            if (codePoints(tr.newDoc.toString()) <= LYRICS_MAX_CHARS) return true;
            refuse();
            return false;
          }),
          EditorView.domEventHandlers({
            blur: () => void flush(),
            focus: () => {
              focused.add(songId);
            },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            setCount(overCounterFrom(u.state.doc));
            if (u.transactions.some((tr) => tr.annotation(fromStore))) return;
            setNotice(null);
            pending.current = u.state.doc.toString();
            onPendingRef.current?.(true);
            clearTimeout(syncTimer);
            syncTimer = setTimeout(flush, SYNC_DELAY_MS);
          }),
        ],
      }),
    });
    view.current = editor;
    document.addEventListener("visibilitychange", onVisibility);
    // Best effort only: a reload can skip blur and the page cannot finish a save while unloading, so the page's
    // beforeunload prompt is what actually protects typing in flight.
    window.addEventListener("pagehide", flush);
    const unregister = registerFlush?.(flush);

    return () => {
      unregister?.();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
      clearTimeout(noticeTimer);
      if (noticeFrame !== undefined) cancelAnimationFrame(noticeFrame);
      editor.destroy();
      view.current = null;
    };
  }, [songId, countId, registerFlush, focused, offersTopline]);

  const keySignature = keys ? JSON.stringify(keys) : null;
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({ effects: sectionKeyCompartment.reconfigure(keyExtension(keysRef.current)) });
  }, [keySignature]);

  useEffect(() => {
    if (!registerEditor) return;
    return registerEditor({
      snapshot: () => {
        const editor = view.current!;
        const { from, to, head } = editor.state.selection.main;
        return {
          doc: editor.state.doc.toString(),
          selection: from === to ? null : { from, to, text: editor.state.sliceDoc(from, to) },
          cursor: head,
          hasFocused: focused.has(songId),
        };
      },
      apply: (change, message) => {
        const editor = view.current;
        if (!editor) return false;
        refused.current = false;
        editor.dispatch({
          changes: change,
          selection: { anchor: change.from + change.insert.length },
          scrollIntoView: true,
          userEvent: "input.suggestion",
        });
        if (refused.current) return false;
        if (message) showNotice.current(message);
        return true;
      },
    });
  }, [registerEditor, focused, songId]);

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
          count !== null || notice !== null ? "border-t border-zinc-200 px-4 py-2 dark:border-zinc-800" : ""
        }`}
      >
        {count !== null && (
          <p id={countId} className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
            {count.toLocaleString("en-US")} / {LYRICS_MAX_CHARS.toLocaleString("en-US")} characters
          </p>
        )}
        <p role="status" className="text-xs font-semibold text-red-700 dark:text-red-400">
          {notice}
        </p>
      </div>
    </div>
  );
}

// Keyed so opening another song starts a fresh editor, and with it a fresh undo history.
export default function LyricsEditor(props: EditorProps) {
  return <Editor key={props.songId} {...props} />;
}
