import { describe, expect, it } from "vitest";
import { checkComment, commentLength } from "./commentRules";

describe("comment rules", () => {
  it("counts code points, so an emoji is one character", () => {
    expect(commentLength("🎵")).toBe(1);
    expect(checkComment("🎵".repeat(2000)).body).toBeUndefined();
    expect(checkComment("🎵".repeat(2001)).body).toBeDefined();
  });

  it("trims the body before checking it", () => {
    expect(checkComment("  \n ").body).toBeDefined();
    expect(checkComment(`\n${"a".repeat(2000)}\n`).body).toBeUndefined();
  });

  it("allows at most 30 lines", () => {
    expect(checkComment(Array(30).fill("a").join("\n")).body).toBeUndefined();
    expect(checkComment(Array(31).fill("a").join("\n")).body).toBeDefined();
  });

  it("refuses control characters except line feeds, and direction overrides", () => {
    expect(checkComment("a\nb").body).toBeUndefined();
    expect(checkComment("a\u0007b").body).toBeDefined();
    expect(checkComment("a⁦b").body).toBeDefined();
  });
});
