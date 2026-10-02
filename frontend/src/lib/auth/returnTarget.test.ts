import { describe, expect, it } from "vitest";
import { safeReturnTarget } from "./returnTarget";

const ORIGIN = "http://localhost:3000";
const resolve = (next: string | null) => safeReturnTarget(next, ORIGIN);

describe("safeReturnTarget", () => {
  it("defaults to the home page", () => {
    expect(resolve(null)).toBe("/");
    expect(resolve("")).toBe("/");
  });

  it("keeps the path, query and fragment", () => {
    expect(resolve("/studio?song=1#mixer")).toBe("/studio?song=1#mixer");
  });

  it.each([
    ["an absolute off-site URL", "https://evil.example"],
    ["a protocol-relative URL", "//evil.example"],
    ["a backslash host", "/\\evil.example"],
    ["a tab-smuggled host", "/\t/evil.example"],
    ["a newline-smuggled host", "/\n/evil.example"],
    ["a script URL", "javascript:alert(1)"],
    ["a dot-segment protocol-relative path", "/.//evil.example"],
    ["a parent-segment protocol-relative path", "/x/..//evil.example"],
    ["an encoded-dot protocol-relative path", "/%2e//evil.example"],
    ["a same-origin URL with a protocol-relative path", `${ORIGIN}//evil.example`],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
  ])("sends %s to the home page", (_, next) => {
    expect(resolve(next)).toBe("/");
  });

  it.each(["/%5Cevil.example", "/%09/evil.example"])("keeps %s on this site", (next) => {
    const target = resolve(next);
    expect(new URL(target, ORIGIN).origin).toBe(ORIGIN);
    expect(target.startsWith("//")).toBe(false);
  });

  it("does not return to the login page", () => {
    expect(resolve("/login?next=/studio")).toBe("/");
  });
});
