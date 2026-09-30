import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "./estimateTokens";

interface Case {
  name: string;
  prompt?: string;
  unit?: string;
  repeat?: number;
  prefix?: string;
  suffix?: string;
  expected: number;
}

const cases: Case[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../fixtures/token_estimate.json"), "utf8"),
);

const promptOf = (c: Case) =>
  c.prompt ?? `${c.prefix ?? ""}${(c.unit ?? "").repeat(c.repeat ?? 0)}${c.suffix ?? ""}`;

describe("estimateTokens", () => {
  it.each(cases)("$name", (c) => {
    expect(estimateTokens(promptOf(c))).toBe(c.expected);
  });
});
