import { describe, expect, it } from "vitest";
import type { StoredLyricSuggestion } from "@/generated/StoredLyricSuggestion";
import type { Section } from "../song/types";
import { applySuggestion, type ApplyInput } from "./applySuggestion";

const sec = (id: string, name: string): Section => ({ id, name, kind: "other", measures: 8, notes: "" });

const run = (doc: string, partial: Partial<ApplyInput> & { suggestion: StoredLyricSuggestion }) => {
  const { change, notice } = applySuggestion({ doc, cursor: 0, hasFocused: true, sections: [], ...partial });
  return { out: doc.slice(0, change.from) + change.insert + doc.slice(change.to), notice };
};
const sug = (over: Partial<StoredLyricSuggestion>): StoredLyricSuggestion => ({
  id: "1",
  label: "L",
  text: "NEW",
  action: "insert",
  ...over,
});

describe("insert", () => {
  it("goes at the cursor", () => {
    expect(run("abcd", { cursor: 2, suggestion: sug({}) }).out).toBe("abNEWcd");
  });

  it("goes at the end on its own line before the editor has had focus", () => {
    expect(run("abcd", { hasFocused: false, suggestion: sug({}) }).out).toBe("abcd\nNEW");
    expect(run("abcd\n", { hasFocused: false, suggestion: sug({}) }).out).toBe("abcd\nNEW");
    expect(run("", { hasFocused: false, suggestion: sug({}) }).out).toBe("NEW");
  });
});

describe("replace_selection", () => {
  const selection = { from: 4, to: 7, text: "old" };
  const suggestion = sug({ action: "replace_selection" });

  it("replaces the selected text", () => {
    expect(run("one old two", { selection, suggestion }).out).toBe("one NEW two");
  });

  it("inserts at the cursor with a notice when the text has changed", () => {
    const r = run("one new two", { selection, suggestion, cursor: 0 });
    expect(r.out).toBe("NEWone new two");
    expect(r.notice).toMatch(/inserted at the cursor/);
  });

  it("says it went to the end when the editor has never had focus", () => {
    const r = run("one new two", { selection, suggestion, hasFocused: false });
    expect(r.out).toBe("one new two\nNEW");
    expect(r.notice).toMatch(/at the end of the lyrics/);
  });
});

describe("replace_section", () => {
  const suggestion = sug({ action: "replace_section", section_id: "c", section_name: "Chorus", text: "x\ny" });
  const sections = [sec("c", "Chorus")];

  it("replaces the body and keeps the heading", () => {
    expect(run("[Chorus]\nla\nla", { suggestion, sections }).out).toBe("[Chorus]\nx\ny");
  });

  it("keeps the next heading on its own line and the blank line above it", () => {
    expect(run("[Chorus]\nla\nla\n\n[Verse]\nv", { suggestion, sections }).out).toBe("[Chorus]\nx\ny\n\n[Verse]\nv");
    expect(run("[Chorus]\n[Verse]\nv", { suggestion, sections }).out).toBe("[Chorus]\nx\ny\n[Verse]\nv");
  });

  it("fills a heading that is the last line", () => {
    expect(run("[Chorus]", { suggestion, sections }).out).toBe("[Chorus]\nx\ny");
    expect(run("[Chorus]\n", { suggestion, sections }).out).toBe("[Chorus]\nx\ny");
  });

  it("uses the section's current name after a rename", () => {
    const renamed = [sec("c", "Hook")];
    expect(run("[Chorus]\nla\n[Hook]\nold", { suggestion, sections: renamed }).out).toBe("[Chorus]\nla\n[Hook]\nx\ny");
  });

  it("uses the stored name when the section is gone", () => {
    expect(run("[ chorus ]\nla", { suggestion, sections: [] }).out).toBe("[ chorus ]\nx\ny");
  });

  it("uses the first of several matching headings", () => {
    expect(run("[Chorus]\na\n[Verse]\nb\n[Chorus]\nc", { suggestion, sections }).out).toBe(
      "[Chorus]\nx\ny\n[Verse]\nb\n[Chorus]\nc",
    );
  });

  it("appends the heading and text when no heading matches", () => {
    expect(run("[Verse]\nla", { suggestion, sections }).out).toBe("[Verse]\nla\n[Chorus]\nx\ny");
    expect(run("", { suggestion, sections }).out).toBe("[Chorus]\nx\ny");
    expect(run("la\n", { suggestion, sections }).out).toBe("la\n[Chorus]\nx\ny");
  });

  it("finds an implicit section that became real, through its kept name", () => {
    const implicit = sug({ action: "replace_section", section_id: "implicit", section_name: "Song" });
    const nowReal = [sec("intro-id", "Intro"), sec("new-id", "Song")];
    expect(run("[Song]\nold", { suggestion: implicit, sections: nowReal }).out).toBe("[Song]\nNEW");
    expect(run("[Song]\nold", { suggestion: implicit, sections: [sec("intro-id", "Intro")] }).out).toBe("[Song]\nNEW");
  });

  it("falls back to an insert with a notice when no name is known", () => {
    const r = run("la", { suggestion: sug({ action: "replace_section", section_id: "gone" }), cursor: 2 });
    expect(r.out).toBe("laNEW");
    expect(r.notice).toMatch(/could not be found/);
  });
});
