import type { LyricChatSelection } from "@/generated/LyricChatSelection";
import type { StoredLyricSuggestion } from "@/generated/StoredLyricSuggestion";
import type { Section } from "../song/types";
import { lyricSections } from "./headings";
import { linkKey } from "./sectionLinks";

export interface ApplyInput {
  suggestion: StoredLyricSuggestion;
  // Belongs to the reply's entry rather than the suggestion, so it is passed alongside.
  selection?: LyricChatSelection;
  doc: string;
  cursor: number;
  // Before the first focus the cursor is just the default 0, which would put an insert at the top by accident.
  hasFocused: boolean;
  sections: Section[];
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface ApplyResult {
  change: TextChange;
  notice?: string;
  // Set when a missing heading was appended, so the card can say a section was added rather than replaced.
  added?: string;
}

const STALE_NOTICE = "The selected text has changed since you asked, so the suggestion was inserted at the cursor.";
const STALE_END_NOTICE = "The selected text has changed since you asked, so the suggestion was inserted at the end of the lyrics.";
const NO_SECTION_NOTICE = "That section could not be found, so the suggestion was inserted instead.";

// A heading must start its own line, or it would become part of the previous lyric line.
const lineBreakBefore = (doc: string) => (doc === "" || doc.endsWith("\n") ? "" : "\n");

function insertAtCursor({ suggestion, doc, cursor, hasFocused }: ApplyInput, notice?: string): ApplyResult {
  const at = hasFocused ? Math.min(Math.max(cursor, 0), doc.length) : doc.length;
  // Appended text would otherwise run on from the last lyric line.
  const prefix = hasFocused ? "" : lineBreakBefore(doc);
  return { change: { from: at, to: at, insert: prefix + suggestion.text }, ...(notice && { notice }) };
}

function replaceSection(input: ApplyInput): ApplyResult {
  const { suggestion, doc, sections } = input;
  // Id first so a rename after the reply still targets the right section; the stored name covers a section that is
  // gone or an implicit one whose id changed when it became real.
  const name = sections.find((s) => s.id === suggestion.section_id)?.name ?? suggestion.section_name;
  if (name === undefined || linkKey(name) === "") return insertAtCursor(input, NO_SECTION_NOTICE);

  const key = linkKey(name);
  const target = lyricSections(doc).find((h) => linkKey(h.name) === key);
  if (!target) {
    const insert = `${lineBreakBefore(doc)}[${name.trim()}]\n${suggestion.text}`;
    return { change: { from: doc.length, to: doc.length, insert }, added: name.trim() };
  }

  // bodyTo includes the newline before the next heading, so the old spacing is carried over to keep that heading on
  // its own line and any blank line the user left above it.
  const isLast = target.bodyTo === doc.length;
  const oldBody = doc.slice(target.bodyFrom, target.bodyTo);
  let trailing = /\s*$/.exec(oldBody)?.[0] ?? "";
  if (!isLast && !trailing.includes("\n")) trailing = "\n";
  // A heading that is the last line with no newline has nothing after it, so the body needs its own line break.
  const headingOpen = target.bodyFrom > 0 && doc[target.bodyFrom - 1] !== "\n";
  const insert = (headingOpen ? "\n" : "") + suggestion.text.trimEnd() + trailing;
  return { change: { from: target.bodyFrom, to: target.bodyTo, insert } };
}

export function applySuggestion(input: ApplyInput): ApplyResult {
  const { suggestion, selection, doc } = input;
  switch (suggestion.action) {
    case "replace_selection":
      // Offsets are not remapped through later edits: if the user rewrote the selected text, replacing blindly would
      // overwrite their new words.
      if (selection && selection.from !== selection.to && doc.slice(selection.from, selection.to) === selection.text)
        return { change: { from: selection.from, to: selection.to, insert: suggestion.text } };
      return insertAtCursor(input, input.hasFocused ? STALE_NOTICE : STALE_END_NOTICE);
    case "replace_section":
      return replaceSection(input);
    default:
      return insertAtCursor(input);
  }
}
