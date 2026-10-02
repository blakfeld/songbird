import { describe, expect, it } from "vitest";
import { note } from "@/test/fixtures";
import { newSongWithTracks } from "./song/testFixtures";
import { resolveTrackNotes } from "./song/clipOps";
import { normalizeSong } from "./song/songOps";
import { MAX_CLIPS, MAX_LOOPS, type Clip, type Loop, type Section, type SectionKind, type Song } from "./song/types";
import * as ops from "./songSectionOps";

const loop = (id: string, measures: number, notes = [note("kick", 0)]): Loop => ({ id, name: id, measures, notes });
const clip = (id: string, loop_id: string, start_measure: number, measures: number): Clip => ({
  id,
  loop_id,
  start_measure,
  measures,
});
const section = (id: string, name: string, measures: number, kind: SectionKind = "other"): Section => ({
  id,
  name,
  kind,
  measures,
  notes: "",
});

function songWith(
  loops: Loop[],
  clips: Clip[],
  sections?: Section[],
  timeSignature: "4/4" | "3/4" | "6/8" = "4/4",
): Song {
  const base = newSongWithTracks(timeSignature);
  const song: Song = {
    ...base,
    tracks: [{ ...base.tracks[0], id: "t", name: "Bass", loops, clips }, base.tracks[1]],
    ...(sections && { sections }),
  };
  return normalizeSong(sections ? { ...song, measures: sections.reduce((n, s) => n + s.measures, 0) } : song);
}

const ok = (r: ops.SectionOpResult | ops.MeasureOpResult) => {
  expect(r.song).not.toBeNull();
  return r.song as Song;
};
const clipsOf = (song: Song, track = 0) =>
  song.tracks[track].clips.map((c) => [c.id, c.loop_id, c.start_measure, c.measures] as const);
const spans = (song: Song) => {
  const sections = ops.sectionsOf(song);
  const starts = ops.sectionStarts(sections);
  return sections.map((s, i) => [s.name, starts[i], starts[i] + s.measures - 1]);
};

// The length invariant every operation must keep.
const consistent = (song: Song) => {
  expect(song.measures).toBe(ops.sectionsOf(song).reduce((n, s) => n + s.measures, 0));
};

describe("sectionsOf and sectionStarts", () => {
  it("shows an unsectioned song as one implicit section", () => {
    const song = songWith([loop("a", 4)], [clip("c", "a", 1, 16)]);
    expect(ops.sectionsOf(song)).toEqual([{ id: "implicit", name: "Song", kind: "other", measures: 16, notes: "" }]);
  });

  it("treats an empty list like no sections", () => {
    const song = { ...songWith([], []), sections: [] };
    expect(ops.sectionsOf(song)).toHaveLength(1);
  });

  it("tiles sections from measure 1", () => {
    const song = songWith([], [], [section("a", "Intro", 4), section("b", "Verse", 8), section("c", "Chorus", 8)]);
    expect(song.measures).toBe(20);
    expect(spans(song)).toEqual([
      ["Intro", 1, 4],
      ["Verse", 5, 12],
      ["Chorus", 13, 20],
    ]);
  });
});

describe("insertMeasures", () => {
  it("shifts later clips and splits a clip that crosses the insertion point", () => {
    const song = songWith([loop("a", 1)], [clip("c1", "a", 1, 2), clip("c2", "a", 4, 2), clip("c3", "a", 8, 1)]);
    const next = ok(ops.insertMeasures(song, 5, 3));
    expect(clipsOf(next).map((c) => [c[2], c[3]])).toEqual([
      [1, 2],
      [4, 1],
      [8, 1],
      [11, 1],
    ]);
  });

  it("keeps the loop when the tail starts on a repeat", () => {
    const song = songWith([loop("a", 4)], [clip("c", "a", 1, 16)]);
    const next = ok(ops.insertMeasures(song, 9, 4));
    expect(next.tracks[0].loops).toHaveLength(1);
    expect(clipsOf(next).map((c) => [c[1], c[2], c[3]])).toEqual([
      ["a", 1, 8],
      ["a", 13, 8],
    ]);
  });

  it("bakes a (cont.) loop whose notes equal the original tail's", () => {
    const song = songWith([loop("a", 4, [note("kick", 0), note("snare", 20, 3)])], [clip("c", "a", 1, 16)]);
    const before = resolveTrackNotes(song, song.tracks[0]);
    const next = ok(ops.insertMeasures(song, 7, 2));
    const tail = next.tracks[0].clips[1];
    expect(tail.start_measure).toBe(9);
    expect(next.tracks[0].loops.find((l) => l.id === tail.loop_id)!.name).toBe("a (cont.)");
    const after = resolveTrackNotes(next, next.tracks[0]);
    const tailBefore = before.filter((n) => n.step >= 6 * 16).map((n) => ({ ...n, step: n.step + 2 * 16 }));
    expect(after.filter((n) => n.step >= 8 * 16)).toEqual(tailBefore);
  });

  it("copies the clips of a source span as linked clips of the same loops", () => {
    const song = songWith([loop("a", 2)], [clip("c1", "a", 3, 2), clip("c2", "a", 5, 2)]);
    const next = ok(ops.insertMeasures(song, 5, 4, { start: 3, end: 4 }));
    expect(clipsOf(next).map((c) => [c[1], c[2], c[3]])).toEqual([
      ["a", 3, 2],
      ["a", 5, 2],
      ["a", 9, 2],
    ]);
  });

  it("refuses when a split would pass 64 loops, naming the track", () => {
    const loops = Array.from({ length: MAX_LOOPS }, (_, i) => loop(`l${i}`, 4));
    const song = songWith(loops, [clip("c", "l0", 1, 6)]);
    expect(ops.insertMeasures(song, 6, 1)).toMatchObject({ song: null, reason: "loop-limit", track: "Bass" });
  });

  it("refuses when a split would pass 256 clips", () => {
    const clips = Array.from({ length: MAX_CLIPS - 1 }, (_, i) => clip(`c${i}`, "a", i + 1, 1));
    clips.push(clip("wide", "a", MAX_CLIPS, 2));
    const song = songWith([loop("a", 1)], clips);
    const result = ops.insertMeasures(song, MAX_CLIPS + 1, 1);
    expect(result).toMatchObject({ song: null, reason: "clip-limit", track: "Bass" });
    expect(ops.describeRefusal(result as ops.Refusal)).toContain("Bass");
  });
});

describe("removeMeasures", () => {
  it("deletes clips inside, splits crossing clips, and shifts later clips", () => {
    const song = songWith(
      [loop("a", 1)],
      [clip("c1", "a", 1, 4), clip("c2", "a", 5, 1), clip("c3", "a", 6, 4), clip("c4", "a", 12, 2)],
    );
    const next = ok(ops.removeMeasures(song, 3, 4));
    expect(clipsOf(next).map((c) => [c[2], c[3]])).toEqual([
      [1, 2],
      [3, 3],
      [8, 2],
    ]);
  });

  it("bakes a tail in 3/4 so it sounds as it did", () => {
    const song = songWith([loop("a", 4, [note("kick", 3), note("kick", 14)])], [clip("c", "a", 1, 12)], undefined, "3/4");
    const spm = song.steps_per_measure;
    expect(spm).toBe(12);
    const before = resolveTrackNotes(song, song.tracks[0]);
    const next = ok(ops.removeMeasures(song, 2, 2));
    expect(next.tracks[0].clips.map((c) => c.start_measure)).toEqual([1, 2]);
    expect(next.tracks[0].loops).toHaveLength(2);
    const after = resolveTrackNotes(next, next.tracks[0]);
    expect(after.filter((n) => n.step >= spm).map((n) => n.step + 2 * spm)).toEqual(
      before.filter((n) => n.step >= 3 * spm).map((n) => n.step),
    );
  });

  it("bakes a tail in 6/8 so it sounds as it did", () => {
    const song = songWith([loop("a", 3, [note("kick", 0), note("snare", 20)])], [clip("c", "a", 1, 9)], undefined, "6/8");
    const spm = song.steps_per_measure;
    const before = resolveTrackNotes(song, song.tracks[0]);
    const next = ok(ops.insertMeasures(song, 5, 1));
    expect(next.tracks[0].loops).toHaveLength(2);
    const after = resolveTrackNotes(next, next.tracks[0]);
    expect(after.filter((n) => n.step >= 5 * spm).map((n) => n.step - spm)).toEqual(
      before.filter((n) => n.step >= 4 * spm).map((n) => n.step),
    );
  });

  it("leaves every loop's notes alone", () => {
    const song = songWith([loop("a", 4, [note("kick", 0), note("kick", 40)])], [clip("c", "a", 1, 16)]);
    const next = ok(ops.removeMeasures(song, 3, 4));
    expect(next.tracks[0].loops.find((l) => l.id === "a")!.notes).toEqual(song.tracks[0].loops[0].notes);
  });
});

describe("section operations", () => {
  const verseChorus = () =>
    songWith([loop("a", 1)], [clip("c", "a", 9, 1)], [section("v", "Verse", 8, "verse"), section("ch", "Chorus", 8, "chorus")]);

  it("insert shifts later material", () => {
    const next = ok(ops.insertSection(verseChorus(), { kind: "pre-chorus", measures: 4 }, "v", "after"));
    expect(spans(next)).toEqual([
      ["Verse", 1, 8],
      ["Pre-chorus", 9, 12],
      ["Chorus", 13, 20],
    ]);
    expect(clipsOf(next)[0].slice(1)).toEqual(["a", 13, 1]);
    expect(next.tracks[0].loops).toEqual(verseChorus().tracks[0].loops);
    consistent(next);
  });

  it("inserts before a section", () => {
    const next = ok(ops.insertSection(verseChorus(), { kind: "intro", measures: 2 }, "v", "before"));
    expect(spans(next)[0]).toEqual(["Intro", 1, 2]);
    expect(clipsOf(next)[0].slice(2)).toEqual([11, 1]);
  });

  it("adds at the end without moving anything", () => {
    const next = ok(ops.addSection(verseChorus(), { kind: "outro" }));
    expect(spans(next).at(-1)).toEqual(["Outro", 17, 24]);
    expect(clipsOf(next)).toEqual(clipsOf(verseChorus()));
    consistent(next);
  });

  it("names a repeated kind with a number", () => {
    const next = ok(ops.addSection(verseChorus(), { kind: "verse" }));
    expect(ops.sectionsOf(next).at(-1)!.name).toBe("Verse 2");
    const third = ok(ops.addSection(next, { kind: "verse" }));
    expect(ops.sectionsOf(third).at(-1)!.name).toBe("Verse 3");
  });

  it("uses a typed name and defaults the length to 8", () => {
    const next = ok(ops.addSection(verseChorus(), { kind: "bridge", name: "  Break  " }));
    expect(ops.sectionsOf(next).at(-1)).toMatchObject({ name: "Break", measures: 8 });
  });

  it("materializes the implicit section on the first edit", () => {
    const song = songWith([loop("a", 1)], [clip("c", "a", 1, 16)]);
    const next = ok(ops.insertSection(song, { kind: "intro", measures: 4 }, ops.IMPLICIT_SECTION_ID, "before"));
    expect(next.sections).toHaveLength(2);
    expect(spans(next)).toEqual([
      ["Intro", 1, 4],
      ["Song", 5, 20],
    ]);
    expect(next.measures).toBe(20);
    expect(next.sections![1].id).not.toBe("implicit");
  });

  it("leaves an old song untouched by reads and by no-op edits", () => {
    const song = songWith([loop("a", 1)], [clip("c", "a", 1, 16)]);
    ops.sectionsOf(song);
    expect(ops.renameSection(song, ops.IMPLICIT_SECTION_ID, "Song").song).toBe(song);
    expect(song.sections).toBeUndefined();
  });

  it("enforces the song cap", () => {
    const song = songWith([], [], [section("a", "A", 32), section("b", "B", 32), section("c", "C", 32), section("d", "D", 28)]);
    expect(song.measures).toBe(124);
    const result = ops.addSection(song, { kind: "verse", measures: 8 });
    expect(result).toMatchObject({ song: null, reason: "song-limit" });
    expect(ops.describeRefusal(result as ops.Refusal)).toMatch(/128/);
  });

  it("enforces 1 to 32 per section", () => {
    expect(ops.addSection(verseChorus(), { kind: "verse", measures: 33 })).toMatchObject({ reason: "length-range" });
    expect(ops.resizeSection(verseChorus(), "v", 0)).toMatchObject({ reason: "length-range" });
    expect(ops.resizeSection(verseChorus(), "v", 33)).toMatchObject({ reason: "length-range" });
  });

  it("renames and changes kind without touching clips or loops", () => {
    const song = verseChorus();
    const renamed = ok(ops.renameSection(song, "ch", "Hook"));
    const kinded = ok(ops.setSectionKind(renamed, "ch", "bridge"));
    expect(ops.sectionsOf(kinded)[1]).toMatchObject({ name: "Hook", kind: "bridge" });
    expect(kinded.tracks).toBe(song.tracks);
    expect(ops.renameSection(song, "ch", "   ").song).toBe(song);
  });

  it("lengthens a verse and moves the chorus's clips", () => {
    const next = ok(ops.resizeSection(verseChorus(), "v", 12));
    expect(spans(next)).toEqual([
      ["Verse", 1, 12],
      ["Chorus", 13, 20],
    ]);
    expect(clipsOf(next)[0].slice(2)).toEqual([13, 1]);
    consistent(next);
  });

  it("keeps a linked loop untouched when the first section shrinks", () => {
    const song = songWith(
      [loop("groove", 4, [note("kick", 0), note("snare", 8)])],
      [clip("c1", "groove", 1, 4), clip("c2", "groove", 13, 4)],
      [section("a", "A", 8), section("b", "B", 12)],
    );
    const next = ok(ops.resizeSection(song, "a", 6));
    expect(next.tracks[0].loops).toEqual(song.tracks[0].loops);
    expect(clipsOf(next).map((c) => [c[2], c[3]])).toEqual([
      [1, 4],
      [11, 4],
    ]);
  });

  it("shortens a section, cutting a note at its new end", () => {
    const base = newSongWithTracks();
    const song = normalizeSong({
      ...base,
      measures: 12,
      tracks: [
        { ...base.tracks[0], id: "t", name: "Bass", loops: [loop("one", 1)], clips: [clip("x", "one", 8, 1)] },
        {
          ...base.tracks[1],
          loops: [loop("long", 8, [note("C4", 5 * 16, 3 * 16)])],
          clips: [clip("y", "long", 1, 8)],
        },
      ],
      sections: [section("s", "S", 8), section("n", "N", 4)],
    });
    const next = ok(ops.resizeSection(song, "s", 6));
    expect(next.tracks[0].clips).toEqual([]);
    expect(next.tracks[1].clips.map((c) => [c.start_measure, c.measures])).toEqual([[1, 6]]);
    expect(resolveTrackNotes(next, next.tracks[1])[0].length_steps).toBe(16);
    expect(next.tracks[1].loops[0].notes).toEqual(song.tracks[1].loops[0].notes);
    expect(spans(next)).toEqual([
      ["S", 1, 6],
      ["N", 7, 10],
    ]);
  });

  it("repeats a chorus with linked clips at the same offsets", () => {
    const song = songWith(
      [loop("a", 2, [note("kick", 0), note("kick", 20)])],
      [clip("c1", "a", 9, 2), clip("c2", "a", 11, 2)],
      [section("v", "Verse", 8), section("ch", "Chorus", 8, "chorus"), section("o", "Outro", 4)],
    );
    const next = ok(ops.duplicateSection(song, "ch"));
    expect(spans(next)).toEqual([
      ["Verse", 1, 8],
      ["Chorus", 9, 16],
      ["Chorus 2", 17, 24],
      ["Outro", 25, 28],
    ]);
    expect(clipsOf(next).map((c) => [c[1], c[2], c[3]])).toEqual([
      ["a", 9, 2],
      ["a", 11, 2],
      ["a", 17, 2],
      ["a", 19, 2],
    ]);
    const notes = resolveTrackNotes(next, next.tracks[0]);
    const original = notes.filter((n) => n.step < 16 * 16).map((n) => n.step + 8 * 16);
    expect(notes.filter((n) => n.step >= 16 * 16).map((n) => n.step)).toEqual(original);
    expect(ops.sectionsOf(next)[2]).toMatchObject({ kind: "chorus", measures: 8 });
    consistent(next);
  });

  it("copies notes and numbers past an existing copy", () => {
    const base = songWith([], [], [section("ch", "Chorus", 4, "chorus")]);
    const withNotes = ok(ops.setSectionNotes(base, "ch", "call and response"));
    const once = ok(ops.duplicateSection(withNotes, "ch"));
    const twice = ok(ops.duplicateSection(once, "ch"));
    expect(ops.sectionsOf(twice).map((s) => s.name)).toEqual(["Chorus", "Chorus 3", "Chorus 2"]);
    expect(ops.sectionsOf(twice)[1].notes).toBe("call and response");
  });

  it("cuts a note sustaining out of the duplicated section at the copy's end", () => {
    const song = songWith(
      [loop("a", 2, [note("kick", 16, 40)])],
      [clip("c", "a", 1, 2)],
      [section("s", "S", 2), section("t", "T", 2)],
    );
    const next = ok(ops.duplicateSection(song, "s"));
    const notes = resolveTrackNotes(next, next.tracks[0]);
    expect(notes.map((n) => [n.step, n.length_steps])).toEqual([
      [16, 16],
      [48, 16],
    ]);
  });

  it("deletes a bridge and shifts later clips earlier", () => {
    const song = songWith(
      [loop("a", 1)],
      [clip("in", "a", 17, 4), clip("late", "a", 21, 8)],
      [section("v", "Verse", 16), section("b", "Bridge", 4, "bridge"), section("o", "Outro", 8)],
    );
    const next = ok(ops.deleteSection(song, "b"));
    expect(next.measures).toBe(24);
    expect(clipsOf(next).map((c) => [c[0], c[2]])).toEqual([["late", 17]]);
    consistent(next);
  });

  it("cannot delete the only section", () => {
    const song = songWith([loop("a", 1)], [clip("c", "a", 1, 4)]);
    expect(ops.deleteSection(song, ops.IMPLICIT_SECTION_ID)).toMatchObject({ reason: "last-section" });
    const single = ok(ops.renameSection(song, ops.IMPLICIT_SECTION_ID, "Only"));
    expect(ops.deleteSection(single, single.sections![0].id)).toMatchObject({ reason: "last-section" });
  });

  it("refuses an unknown section", () => {
    expect(ops.deleteSection(verseChorus(), "nope")).toMatchObject({ reason: "not-found" });
    expect(ops.resizeSection(verseChorus(), "nope", 4)).toMatchObject({ reason: "not-found" });
  });

  it("caps section notes at 5000 code points", () => {
    const next = ok(ops.setSectionNotes(verseChorus(), "v", "♪".repeat(5001)));
    expect([...ops.sectionsOf(next)[0].notes]).toHaveLength(5000);
  });

  it("keeps the original loop's notes across every structural operation", () => {
    const song = songWith(
      [loop("a", 3, [note("kick", 0), note("snare", 30, 9)])],
      [clip("c", "a", 1, 20)],
      [section("x", "X", 10), section("y", "Y", 10)],
    );
    const loops = song.tracks[0].loops;
    for (const next of [
      ops.resizeSection(song, "x", 14),
      ops.resizeSection(song, "x", 7),
      ops.insertSection(song, { kind: "verse", measures: 5 }, "y", "before"),
      ops.duplicateSection(song, "y"),
      ops.deleteSection(song, "x"),
    ]) {
      expect(ok(next).tracks[0].loops.slice(0, 1)).toEqual(loops);
    }
  });
});
