import { describe, expect, it } from "vitest";
import type { Loop } from "@/generated/Loop";
import type { Note } from "@/generated/Note";
import type { ToplineSource } from "@/generated/ToplineSource";
import { isStale, reflowLyrics, seedSyllables } from "./toplineOps";
import { resplitWord, syllabifyLine } from "./syllabify";

const rows = [
  { id: "C4", midi_note: 60 },
  { id: "D4", midi_note: 62 },
  { id: "E4", midi_note: 64 },
];

const n = (row_id: string, step: number, lyric?: string): Note => ({
  row_id,
  step,
  length_steps: 2,
  velocity: 100,
  ...(lyric !== undefined && { lyric }),
});

const syl = (text: string) => ({ text, stressed: true });

function source(...lines: string[]): ToplineSource {
  return {
    section_name: "Chorus",
    voice: "tenor",
    lines: lines.map((text) => ({ text, syllables: syllabifyLine(text) })),
  };
}

const loopOf = (notes: Note[], topline?: ToplineSource): Loop => ({
  id: "l1",
  name: "Chorus topline",
  measures: 4,
  notes,
  ...(topline && { topline }),
});

describe("reflowLyrics", () => {
  const holdMeClose: ToplineSource = {
    section_name: "Chorus",
    voice: "tenor",
    lines: [{ text: "hold me close", syllables: [syl("hold"), syl("me"), syl("close")] }],
  };

  it("re-flows after a note is deleted and another added", () => {
    const loop = loopOf([n("C4", 0, "hold"), n("D4", 4), n("E4", 8, "close")], holdMeClose);
    const { loop: out, unplaced } = reflowLyrics(loop, rows);
    expect(out.notes.map((x) => x.lyric)).toEqual(["hold", "me", "close"]);
    expect(unplaced).toBe(0);
  });

  it("leaves pitch, timing and velocity alone", () => {
    const loop = loopOf([n("C4", 0), n("E4", 4)], holdMeClose);
    const out = reflowLyrics(loop, rows).loop.notes;
    expect(out.map((x) => ({ ...x, lyric: undefined }))).toEqual(loop.notes.map((x) => ({ ...x, lyric: undefined })));
  });

  it("reports syllables left without a note", () => {
    const ten = {
      ...holdMeClose,
      lines: [{ text: "x", syllables: Array.from({ length: 10 }, (_, i) => syl(`s${i}`)) }],
    };
    const loop = loopOf(Array.from({ length: 8 }, (_, i) => n("C4", i * 2)), ten);
    const { loop: out, unplaced } = reflowLyrics(loop, rows);
    expect(out.notes.map((x) => x.lyric)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    expect(unplaced).toBe(2);
  });

  it("strips the lyric from notes left over after the last syllable", () => {
    const loop = loopOf([n("C4", 0), n("C4", 2), n("C4", 4), n("C4", 6, "stale")], holdMeClose);
    const out = reflowLyrics(loop, rows).loop.notes;
    expect(out.map((x) => x.lyric)).toEqual(["hold", "me", "close", undefined]);
    expect(out[3]).not.toHaveProperty("lyric");
  });

  it("gives only the highest of simultaneous notes a syllable", () => {
    const loop = loopOf([n("C4", 0), n("E4", 0), n("D4", 4)], holdMeClose);
    const out = reflowLyrics(loop, rows).loop.notes;
    expect(out.map((x) => x.lyric)).toEqual([undefined, "hold", "me"]);
  });

  it("returns the same loop when nothing changes", () => {
    const loop = loopOf([n("C4", 0, "hold"), n("D4", 4, "me"), n("E4", 8, "close")], holdMeClose);
    expect(reflowLyrics(loop, rows).loop).toBe(loop);
  });

  it("ignores a loop without a topline source", () => {
    const loop = loopOf([n("C4", 0, "keep")]);
    expect(reflowLyrics(loop, rows)).toEqual({ loop, unplaced: 0 });
  });
});

describe("isStale", () => {
  const lyrics = "[Verse]\nsomething else\n\n[Chorus]\nhold me close\nnever let go\n";

  it("is false while the section's lines are unchanged", () => {
    expect(isStale(source("hold me close", "never let go"), lyrics)).toBe(false);
  });

  it("ignores surrounding whitespace", () => {
    expect(isStale(source("hold me close", "never let go"), lyrics.replace("hold me close", "  hold me close  "))).toBe(
      false,
    );
  });

  it("flags a changed word", () => {
    expect(isStale(source("hold me close", "never let go"), lyrics.replace("never", "ever"))).toBe(true);
  });

  it("flags an added or removed line", () => {
    expect(isStale(source("hold me close"), lyrics)).toBe(true);
  });

  it("does not flag a song whose heading no longer exists", () => {
    expect(isStale(source("hold me close"), "[Bridge]\nother\n")).toBe(false);
  });

  it("matches the heading regardless of case", () => {
    expect(isStale(source("hold me close", "never let go"), lyrics.replace("[Chorus]", "[chorus]"))).toBe(false);
  });
});

describe("seedSyllables", () => {
  it("keeps the corrected syllables of an unchanged line and re-splits an edited one", () => {
    const corrected = resplitWord("every", "ev-ery")!;
    const earlier: ToplineSource = {
      section_name: "Chorus",
      voice: "tenor",
      lines: [
        { text: "every night", syllables: [...corrected, ...syllabifyLine("night")] },
        { text: "hold me close", syllables: syllabifyLine("hold me close") },
      ],
    };
    const seeded = seedSyllables(["every night", "hold me tight"], earlier);
    expect(seeded[0].syllables.map((s) => s.text)).toEqual(["ev-", "ery", "night"]);
    expect(seeded[1].syllables).toEqual(syllabifyLine("hold me tight"));
  });

  it("drops lines with no singable word", () => {
    expect(seedSyllables(["...", "la la"]).map((l) => l.text)).toEqual(["la la"]);
  });

  it("does not share syllable objects with the source", () => {
    const earlier = source("la la");
    const seeded = seedSyllables(["la la"], earlier);
    seeded[0].syllables[0].stressed = !seeded[0].syllables[0].stressed;
    expect(earlier.lines[0].syllables[0]).toEqual(syllabifyLine("la la")[0]);
  });
});
