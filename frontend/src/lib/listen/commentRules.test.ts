import { describe, expect, it } from "vitest";
import { checkComment, commentLength, normalizeName } from "./commentRules";

describe("comment rules", () => {
  it("collapses whitespace in a name before counting", () => {
    expect(normalizeName("  Sam \t  Lee ")).toBe("Sam Lee");
    expect(checkComment("   ", "hi").name).toBeDefined();
  });

  it("counts code points, so an emoji is one character", () => {
    expect(commentLength("🎵")).toBe(1);
    expect(checkComment("🎵".repeat(40), "hi").name).toBeUndefined();
    expect(checkComment("🎵".repeat(41), "hi").name).toBeDefined();
    expect(checkComment("Sam", "🎵".repeat(2000)).body).toBeUndefined();
    expect(checkComment("Sam", "🎵".repeat(2001)).body).toBeDefined();
  });

  it("trims the body before checking it", () => {
    expect(checkComment("Sam", "  \n ").body).toBeDefined();
    expect(checkComment("Sam", `\n${"a".repeat(2000)}\n`).body).toBeUndefined();
  });

  it("allows at most 30 lines", () => {
    expect(checkComment("Sam", Array(30).fill("a").join("\n")).body).toBeUndefined();
    expect(checkComment("Sam", Array(31).fill("a").join("\n")).body).toBeDefined();
  });

  it("refuses control characters except line feeds in the body, and direction overrides anywhere", () => {
    expect(checkComment("Sam", "a\nb").body).toBeUndefined();
    expect(checkComment("Sam", "a\u0007b").body).toBeDefined();
    expect(checkComment("Sa‮m", "a").name).toBeDefined();
    expect(checkComment("Sam", "a⁦b").body).toBeDefined();
  });
});
