import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lyricLines, resplitWord, syllabifyLine, syllabifyWord } from "./syllabify";

interface Case {
  name: string;
  line: string;
  syllables: string[];
  stressed: number[];
}

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../fixtures/syllables.json"), "utf8"),
);

describe("syllable fixture", () => {
  it("holds at least 150 cases", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(150);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const got = syllabifyLine(c.line);
    expect(got.map((s) => s.text)).toEqual(c.syllables);
    expect(got.flatMap((s, i) => (s.stressed ? [i] : []))).toEqual(c.stressed);
  });
});

describe("syllabifyLine", () => {
  it("splits the spec line", () => {
    expect(syllabifyLine("Beautiful morning, don't fade away").map((s) => s.text)).toEqual([
      "beau-", "ti-", "ful", "mor-", "ning", "don't", "fade", "a-", "way",
    ]);
  });

  it("gives every multi-syllable word exactly one stress", () => {
    for (const word of ["conversation", "beautiful", "everyone", "unbelievable", "resist"]) {
      const syllables = syllabifyWord(word);
      expect(syllables.length).toBeGreaterThan(1);
      expect(syllables.filter((s) => s.stressed)).toHaveLength(1);
    }
  });

  it("is deterministic", () => {
    expect(syllabifyLine("Hold on to the memories")).toEqual(syllabifyLine("Hold on to the memories"));
  });

  it("keeps punctuation out of syllables", () => {
    const text = syllabifyLine('"Hello," she said...').map((s) => s.text).join("");
    expect(text).toMatch(/^[a-z-]+$/);
  });

  it("returns nothing for a line without words", () => {
    expect(syllabifyLine("... -- !!")).toEqual([]);
  });

  it("keeps every syllable within the backend's 16 characters", () => {
    for (const s of syllabifyLine("1234567890123456789012345 supercalifragilisticexpialidocious")) {
      expect(Array.from(s.text).length).toBeLessThanOrEqual(16);
      expect(s.text).not.toBe("");
    }
  });
});

describe("lyricLines", () => {
  it("skips blank lines", () => {
    expect(lyricLines("first line\n\n  \nsecond line\n")).toEqual(["first line", "second line"]);
  });

  it("handles Windows line endings", () => {
    expect(lyricLines("a\r\n\r\nb")).toEqual(["a", "b"]);
  });
});

describe("resplitWord", () => {
  it("corrects a split", () => {
    expect(syllabifyWord("every").map((s) => s.text)).toEqual(["ev-", "er-", "y"]);
    expect(resplitWord("every", "ev-ery")?.map((s) => s.text)).toEqual(["ev-", "ery"]);
  });

  it("refuses a split that changes letters", () => {
    expect(resplitWord("every", "ev-ry")).toBeNull();
  });

  it("refuses empty segments and whitespace", () => {
    expect(resplitWord("every", "ev--ery")).toBeNull();
    expect(resplitWord("every", "-every")).toBeNull();
    expect(resplitWord("every", "ev- ery")).toBeNull();
  });

  it("ignores case when comparing letters", () => {
    expect(resplitWord("Every", "EV-ery")).not.toBeNull();
  });

  it("stresses exactly one syllable of a re-split word", () => {
    expect(resplitWord("every", "ev-ery")?.filter((s) => s.stressed)).toHaveLength(1);
  });
});
