import { describe, expect, it } from "vitest";
import { headingLines, headingName, isHeadingLine } from "./headings";

describe("isHeadingLine", () => {
  it.each(["[Chorus]", "  [Verse 1]  ", "[a]"])("treats %j as a heading", (line) => {
    expect(isHeadingLine(line)).toBe(true);
  });

  it.each(["I said [softly] goodbye", "[]", "[a]b", "x[a]", "", "[a][b]"])(
    "treats %j as a lyric line",
    (line) => {
      expect(isHeadingLine(line)).toBe(false);
    },
  );
});

describe("headingLines", () => {
  it("returns the indexes of heading lines only", () => {
    expect(headingLines("[Verse]\nla la\n\n[Chorus]\nI said [softly]")).toEqual([0, 3]);
  });

  it("handles carriage returns as trailing whitespace", () => {
    expect(headingLines("[Verse]\r\nla")).toEqual([0]);
  });
});

describe("headingName", () => {
  it("returns the bracketed name as typed", () => {
    expect(headingName("  [ Verse 1 ]  ")).toBe(" Verse 1 ");
  });

  it("returns null for a lyric line", () => {
    expect(headingName("I said [softly] goodbye")).toBeNull();
  });
});
