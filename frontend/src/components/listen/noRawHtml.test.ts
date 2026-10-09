import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

// Anything a stranger can type ends up in these directories' output, so none of them may bypass React's escaping.
const DIRECTORIES = ["app/listen", "components/listen", "components/share", "lib/listen", "lib/share"];

describe("comment and listen surfaces", () => {
  const files = DIRECTORIES.flatMap((d) => sourceFiles(join(SRC, d)));

  it("scans the directories it is meant to police", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("never uses dangerouslySetInnerHTML or writes HTML directly", () => {
    const offenders = files.filter((path) => /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/.test(readFileSync(path, "utf8")));
    expect(offenders.map((p) => p.replace(SRC, "src"))).toEqual([]);
  });
});
