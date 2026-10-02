import { describe, expect, it } from "vitest";
import { lyricSections } from "./headings";
import { linkKey, linkedSections, missingHeadings } from "./sectionLinks";
import { newSong, type Section, type Song } from "../song/types";
import { sectionsOf } from "../songSectionOps";

const sec = (name: string, id = name): Section => ({ id, name, kind: "other", measures: 8, notes: "" });
const songWith = (sections: Section[] | undefined, measures = 8): Song => ({ ...newSong(), measures, sections });

describe("lyricSections", () => {
  it("returns offsets that slice out each heading and body", () => {
    const text = "[A]\nla\nla\n[B]\n\n[C]";
    const [a, b, c] = lyricSections(text);
    expect(text.slice(a.headingFrom, a.bodyFrom)).toBe("[A]\n");
    expect(text.slice(a.bodyFrom, a.bodyTo)).toBe("la\nla\n");
    expect(text.slice(b.bodyFrom, b.bodyTo)).toBe("\n");
    expect(c).toMatchObject({ name: "C", bodyFrom: text.length, bodyTo: text.length });
  });

  it("ignores text before the first heading and brackets inside lyrics", () => {
    expect(lyricSections("intro\nI said [softly] goodbye")).toEqual([]);
  });
});

describe("linkedSections", () => {
  it("links ignoring case and whitespace", () => {
    const [h] = linkedSections("[ chorus ]\nhey", sectionsOf(songWith([sec("Chorus")])));
    expect(linkKey(" Chorus ")).toBe("chorus");
    expect(h.linked.map((s) => s.name)).toEqual(["Chorus"]);
  });

  it("leaves an unknown heading unlinked", () => {
    const [h] = linkedSections("[Hook]", sectionsOf(songWith([sec("Chorus")])));
    expect(h.linked).toEqual([]);
  });

  it("relinks after a rename without touching the text", () => {
    const text = "[Hook]\nla";
    expect(linkedSections(text, [sec("Chorus", "c")])[0].linked).toEqual([]);
    expect(linkedSections(text, [sec("Hook", "c")])[0].linked).toHaveLength(1);
  });

  it("shares one heading between sections with the same name", () => {
    const [h] = linkedSections("[Chorus]", [sec("Chorus", "1"), sec("Verse"), sec("chorus", "2")]);
    expect(h.linked.map((s) => s.id)).toEqual(["1", "2"]);
  });

  it("keeps a [Song] heading linked once the implicit section becomes real", () => {
    const text = "[Song]";
    expect(linkedSections(text, sectionsOf(songWith(undefined)))[0].linked).toHaveLength(1);
    expect(linkedSections(text, sectionsOf(songWith([sec("Song", "new-id")])))[0].linked).toHaveLength(1);
  });
});

describe("missingHeadings", () => {
  const three = [sec("Intro"), sec("Verse 1"), sec("Chorus")];

  it("appends only absent headings in song order and keeps the existing text", () => {
    const text = "[Verse 1]\nla";
    const add = missingHeadings(text, three);
    expect(add).toBe("\n[Intro]\n[Chorus]");
    expect(text + add).toBe("[Verse 1]\nla\n[Intro]\n[Chorus]");
  });

  it("does not add a blank line when the text already ends in a newline", () => {
    expect(missingHeadings("[Intro]\n", three)).toBe("[Verse 1]\n[Chorus]");
  });

  it("scaffolds a 40-measure unsectioned song as [Song] and [Song 2]", () => {
    const song = songWith(undefined, 40);
    expect(missingHeadings("", sectionsOf(song))).toBe("[Song]\n[Song 2]");
    expect(song.sections).toBeUndefined();
  });

  it("dedupes duplicate names by key", () => {
    expect(missingHeadings("", [sec("Chorus", "1"), sec(" chorus ", "2")])).toBe("[Chorus]");
  });

  it("returns an empty string when every section has a heading", () => {
    expect(missingHeadings("[intro]\n[verse 1]\n[ Chorus ]", three)).toBe("");
  });
});
