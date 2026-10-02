import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXCLUDED_IDB_DATABASES,
  KEPT_PER_USER_IDB_PREFIXES,
  LOCAL_STORAGE_PREFIX,
  PER_USER_IDB_DATABASES,
} from "./perUserStores";

const SRC = join(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "generated" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

// The first string-ish argument, whether quoted or a template; interpolations are cut so only the static prefix is judged.
const LITERAL = String.raw`\s*[\`"']([^\`"'$]*)`;
// Keys are often built by a small arrow function, so the literal may follow its parameter list.
const KEY_CONSTANT = String.raw`\b(?:[A-Z][A-Z0-9_]*_KEY|\w*[sS]torageKey)\s*=\s*(?:\([^)]*\)\s*(?::\s*\w+\s*)?=>)?`;

function matches(pattern: RegExp): { path: string; literal: string }[] {
  return files.flatMap(({ path, text }) =>
    [...text.matchAll(pattern)].map((m) => ({ path: path.replace(SRC, "src"), literal: m[1] })),
  );
}

describe("per-user storage registry", () => {
  it("finds the keys it is meant to police", () => {
    const keys = matches(new RegExp(String.raw`localStorage\.\w+Item\(${LITERAL}`, "g"));
    const constants = matches(new RegExp(`${KEY_CONSTANT}${LITERAL}`, "g"));
    expect(keys.length + constants.length).toBeGreaterThan(0);
  });

  it("keeps every localStorage key literal under the songbird. prefix", () => {
    const literals = [
      ...matches(new RegExp(String.raw`localStorage\.\w+Item\(${LITERAL}`, "g")),
      // Keys usually travel as named constants or props into useStoredValue and friends.
      ...matches(new RegExp(`${KEY_CONSTANT}${LITERAL}`, "g")),
      ...matches(new RegExp(String.raw`storageKey=\{?${LITERAL}`, "g")),
      ...matches(new RegExp(String.raw`persist[\s\S]{0,200}?name:${LITERAL}`, "g")),
    ];
    const outside = literals.filter((l) => !l.literal.startsWith(LOCAL_STORAGE_PREFIX));
    expect(outside).toEqual([]);
  });

  it("registers every IndexedDB database name", () => {
    const known = new Set([...PER_USER_IDB_DATABASES, ...EXCLUDED_IDB_DATABASES]);
    const names = [
      ...matches(new RegExp(String.raw`\bcreateStore\(${LITERAL}`, "g")),
      ...matches(new RegExp(String.raw`indexedDB\.open\(${LITERAL}`, "g")),
    ];
    const isKept = (literal: string) => KEPT_PER_USER_IDB_PREFIXES.includes(literal);
    expect(names.filter((n) => !known.has(n.literal) && !isKept(n.literal))).toEqual([]);
  });
});
