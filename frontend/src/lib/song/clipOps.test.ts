import { describe, expect, it } from "vitest";
import { note } from "@/test/fixtures";
import * as clips from "./clipOps";
import { MAX_CLIPS, MAX_LOOPS, newSong, type Clip, type Loop, type Song } from "./types";

const SPM = 16;

// Loop and clip ids are readable so assertions can name them.
const loop = (id: string, measures: number, notes = [note("kick", 0)], name = id): Loop => ({
  id,
  name,
  measures,
  notes,
});
const clip = (id: string, loop_id: string, start_measure: number, measures: number): Clip => ({
  id,
  loop_id,
  start_measure,
  measures,
});

function songWith(loops: Loop[], clipList: Clip[], measures = 16): Song {
  const base = newSong();
  return {
    ...base,
    measures,
    tracks: [{ ...base.tracks[0], id: "t", name: "Bass", loops, clips: clipList }, base.tracks[1]],
  };
}

const track = (song: Song) => song.tracks[0];
const ok = (r: clips.ClipOpResult) => {
  expect(r.song).not.toBeNull();
  return r as { song: Song; clipId: string | null };
};
const reason = (r: clips.ClipOpResult) => (r.song === null ? r.reason : undefined);

describe("resolveTrackNotes", () => {
  it("repeats a loop for the length of a longer clip", () => {
    const song = songWith([loop("a", 2)], [clip("c", "a", 3, 6)]);
    const steps = clips.resolveTrackNotes(song, track(song)).map((n) => n.step);
    expect(steps).toEqual([2, 4, 6].map((m) => m * SPM));
  });

  it("plays only the start of the loop in a short clip", () => {
    const song = songWith(
      [loop("a", 4, [note("kick", 0), note("kick", SPM), note("kick", 2 * SPM)])],
      [clip("c", "a", 1, 1)],
    );
    expect(clips.resolveTrackNotes(song, track(song)).map((n) => n.step)).toEqual([0]);
  });

  it("cuts a note at the clip end", () => {
    const song = songWith(
      [loop("a", 4, [note("c4", 3 * SPM, 2 * SPM)])],
      [clip("c", "a", 5, 4), clip("d", "a", 10, 1)],
    );
    const notes = clips.resolveTrackNotes(song, track(song));
    expect(notes[0]).toMatchObject({ step: 7 * SPM, length_steps: SPM });
    expect(notes).toHaveLength(1);
  });

  it("is silent between clips", () => {
    const song = songWith([loop("a", 1)], [clip("c", "a", 1, 1), clip("d", "a", 5, 1)]);
    expect(clips.resolveTrackNotes(song, track(song)).map((n) => n.step)).toEqual([0, 4 * SPM]);
  });

  it("recomputes when the steps per measure change", () => {
    const song = songWith([loop("a", 1)], [clip("c", "a", 2, 1)]);
    const first = clips.resolveTrackNotes(song, track(song));
    const other = clips.resolveTrackNotes({ ...song, steps_per_measure: 12 }, track(song));
    expect(other).not.toBe(first);
    expect(other[0].step).toBe(12);
  });

  it("recomputes when clips is a new array but loops is reused", () => {
    const song = songWith([loop("a", 1)], [clip("c", "a", 1, 1)]);
    const first = clips.resolveTrackNotes(song, track(song));
    const moved = { ...track(song), clips: [clip("c", "a", 3, 1)] };
    const next = clips.resolveTrackNotes(song, moved);
    expect(next).not.toBe(first);
    expect(next[0].step).toBe(2 * SPM);
    expect(clips.resolveTrackNotes(song, track(song))).toBe(first);
  });

  it("memoizes by loops and clips reference", () => {
    const song = songWith([loop("a", 1)], [clip("c", "a", 1, 1)]);
    const first = clips.resolveTrackNotes(song, track(song));
    expect(clips.resolveTrackNotes({ ...song, tempo_bpm: 99 }, { ...track(song) })).toBe(first);
    const edited = { ...track(song), loops: [loop("a", 1, [note("snare", 0)])] };
    expect(clips.resolveTrackNotes(song, edited)).not.toBe(first);
  });
});

describe("freeSpanAt", () => {
  const song = songWith([loop("a", 2)], [clip("c", "a", 3, 2)], 10);
  it("measures to the next clip or song end, and 0 when taken", () => {
    expect(clips.freeSpanAt(track(song), 1, song)).toBe(2);
    expect(clips.freeSpanAt(track(song), 4, song)).toBe(0);
    expect(clips.freeSpanAt(track(song), 5, song)).toBe(6);
    expect(clips.freeSpanAt(track(song), 11, song)).toBe(0);
  });
});

describe("free measure search", () => {
  const song = songWith([loop("a", 2)], [clip("c", "a", 3, 2), clip("d", "a", 6, 3)], 10);
  it("finds the first free measure at or after a start", () => {
    expect(clips.nextFreeMeasure(track(song), song)).toBe(1);
    expect(clips.nextFreeMeasure(track(song), song, 3)).toBe(5);
    expect(clips.nextFreeMeasure(track(song), song, 6)).toBe(9);
  });
  it("is null when nothing is free", () => {
    const full = songWith([loop("a", 2)], [clip("c", "a", 1, 4)], 4);
    expect(clips.nextFreeMeasure(track(full), full)).toBeNull();
    expect(clips.nearestFreeMeasure(track(full), full, 2)).toBeNull();
  });
  it("snaps an occupied target to the nearest free measure", () => {
    expect(clips.nearestFreeMeasure(track(song), song, 4)).toBe(5);
    expect(clips.nearestFreeMeasure(track(song), song, 8)).toBe(9);
    expect(clips.nearestFreeMeasure(track(song), song, 5)).toBe(5);
  });
});

describe("newClip", () => {
  it("creates a 4-measure loop and clip on an empty lane", () => {
    const song = songWith([], [], 16);
    const r = ok(clips.newClip(song, "t", 5));
    expect(track(r.song).loops).toMatchObject([{ name: "Bass 1", measures: 4, notes: [] }]);
    expect(track(r.song).clips).toMatchObject([{ id: r.clipId, start_measure: 5, measures: 4 }]);
  });

  it("is shortened by a neighbour or the song end", () => {
    const song = songWith([loop("a", 1)], [clip("c", "a", 7, 1)], 16);
    expect(track(ok(clips.newClip(song, "t", 5)).song).clips[0]).toMatchObject({ start_measure: 5, measures: 2 });
    expect(track(ok(clips.newClip(songWith([], [], 16), "t", 15)).song).loops[0].measures).toBe(2);
  });

  it("uses the smallest unused number and fits the name limit", () => {
    const song = songWith([loop("a", 1, [], "Bass 1"), loop("b", 1, [], "Bass 3")], []);
    expect(track(ok(clips.newClip(song, "t", 1)).song).loops.at(-1)?.name).toBe("Bass 2");
    const long = { ...song, tracks: [{ ...track(song), name: "x".repeat(40), loops: [] }, song.tracks[1]] };
    expect(track(ok(clips.newClip(long, "t", 1)).song).loops[0].name).toHaveLength(40);
  });

  it("refuses an occupied measure, and both limits", () => {
    const song = songWith([loop("a", 1)], [clip("c", "a", 1, 2)]);
    expect(reason(clips.newClip(song, "t", 2))).toBe("no-room");
    const manyLoops = songWith(
      Array.from({ length: MAX_LOOPS }, (_, i) => loop(`l${i}`, 1)),
      [],
    );
    expect(reason(clips.newClip(manyLoops, "t", 1))).toBe("loop-limit");
    expect(reason(clips.newClip(song, "nope", 1))).toBe("not-found");
  });
});

describe("placeLoop", () => {
  const song = songWith([loop("a", 4)], [clip("c", "a", 8, 2)]);
  it("places at the loop's length, shortened by a neighbour", () => {
    expect(track(ok(clips.placeLoop(song, "t", "a", 1)).song).clips[0]).toMatchObject({ start_measure: 1, measures: 4 });
    expect(track(ok(clips.placeLoop(song, "t", "a", 6)).song).clips[0]).toMatchObject({ start_measure: 6, measures: 2 });
  });
  it("honours an explicit length and keeps clips sorted", () => {
    const r = ok(clips.placeLoop(song, "t", "a", 1, 2));
    expect(track(r.song).clips.map((c) => [c.start_measure, c.measures])).toEqual([[1, 2], [8, 2]]);
  });
  it("refuses an occupied measure, an unknown loop and the clip limit", () => {
    expect(reason(clips.placeLoop(song, "t", "a", 9))).toBe("no-room");
    expect(reason(clips.placeLoop(song, "t", "zzz", 1))).toBe("not-found");
    const full = songWith(
      [loop("a", 1)],
      Array.from({ length: MAX_CLIPS }, (_, i) => clip(`c${i}`, "a", 1, 1)),
      128,
    );
    expect(reason(clips.placeLoop(full, "t", "a", 100))).toBe("clip-limit");
  });
});

describe("duplicateClip", () => {
  it("places a linked copy directly after and selects it", () => {
    const song = songWith([loop("a", 2)], [clip("c", "a", 1, 2)]);
    const r = ok(clips.duplicateClip(song, "t", "c"));
    expect(track(r.song).clips).toHaveLength(2);
    const copy = track(r.song).clips.find((c) => c.id === r.clipId);
    expect(copy).toMatchObject({ loop_id: "a", start_measure: 3, measures: 2 });
  });
  it("adds nothing when there is no room", () => {
    const song = songWith([loop("a", 2)], [clip("c", "a", 1, 2), clip("d", "a", 3, 1)]);
    expect(reason(clips.duplicateClip(song, "t", "c"))).toBe("no-room");
  });
  it("refuses at the clip limit", () => {
    // The limit exceeds what fits in 128 measures, so the fixture stacks clips; ops must refuse before checking room.
    const list = Array.from({ length: MAX_CLIPS }, (_, i) => clip(`c${i}`, "a", (i % 128) + 1, 1));
    const song = songWith([loop("a", 1)], list, 128);
    expect(reason(clips.duplicateClip(song, "t", "c0"))).toBe("clip-limit");
  });
});

describe("moveClip", () => {
  const song = songWith([loop("a", 2)], [clip("c", "a", 1, 2), clip("d", "a", 5, 2)]);
  const starts = (s: Song) => track(s).clips.map((c) => c.start_measure);
  it("stops at a neighbour", () => {
    expect(starts(ok(clips.moveClip(song, "t", "c", 4)).song)).toEqual([3, 5]);
  });
  it("stops at the song edges", () => {
    expect(starts(ok(clips.moveClip(song, "t", "d", 99)).song)).toEqual([1, 15]);
    expect(starts(ok(clips.moveClip(song, "t", "d", -5)).song)).toEqual([1, 3]);
  });
  it("returns the same song when nothing moves", () => {
    expect(ok(clips.moveClip(song, "t", "c", 1)).song).toBe(song);
  });
  it("does not change the loop", () => {
    expect(track(ok(clips.moveClip(song, "t", "c", 3)).song).loops).toBe(track(song).loops);
  });
});

describe("resizeClip", () => {
  const song = songWith([loop("a", 2)], [clip("c", "a", 1, 2), clip("d", "a", 6, 2)], 10);
  it("lengthens up to the neighbour and shortens to at least 1", () => {
    expect(track(ok(clips.resizeClip(song, "t", "c", 20)).song).clips[0].measures).toBe(5);
    expect(track(ok(clips.resizeClip(song, "t", "c", 0)).song).clips[0].measures).toBe(1);
  });
  it("stops at the song end", () => {
    expect(track(ok(clips.resizeClip(song, "t", "d", 20)).song).clips[1].measures).toBe(5);
  });
  it("lengthening past the loop leaves the loop alone", () => {
    const r = ok(clips.resizeClip(songWith([loop("a", 2)], [clip("c", "a", 1, 2)], 8), "t", "c", 8));
    expect(track(r.song).clips[0].measures).toBe(8);
    expect(track(r.song).loops[0].measures).toBe(2);
  });
});

describe("deleteClip", () => {
  it("keeps the loop", () => {
    const song = songWith([loop("a", 2, [], "Chorus keys")], [clip("c", "a", 1, 2)]);
    const r = ok(clips.deleteClip(song, "t", "c"));
    expect(track(r.song).clips).toEqual([]);
    expect(track(r.song).loops).toHaveLength(1);
  });
});

describe("makeUnique", () => {
  const song = songWith(
    [loop("a", 2, [note("kick", 0)], "Groove A")],
    [clip("c1", "a", 1, 2), clip("c2", "a", 3, 2), clip("c3", "a", 5, 2)],
  );
  it("gives one clip its own copy and leaves the others linked", () => {
    const next = track(ok(clips.makeUnique(song, "t", "c3")).song);
    expect(next.loops.map((l) => l.name)).toEqual(["Groove A", "Groove A (copy)"]);
    expect(next.clips.map((c) => c.loop_id)).toEqual(["a", "a", next.loops[1].id]);
    expect(next.loops[1].notes).toEqual(track(song).loops[0].notes);
    expect(next.loops[1].notes).not.toBe(track(song).loops[0].notes);
  });
  it("is refused for an unshared loop", () => {
    const single = songWith([loop("a", 1)], [clip("c", "a", 1, 1)]);
    expect(reason(clips.makeUnique(single, "t", "c"))).toBe("not-shared");
  });
  it("respects the name limit and the loop limit", () => {
    const long = songWith([loop("a", 1, [], "y".repeat(40))], [clip("c", "a", 1, 1), clip("d", "a", 2, 1)]);
    expect(track(ok(clips.makeUnique(long, "t", "c")).song).loops[1].name).toHaveLength(40);
    const many = songWith(
      [loop("a", 1), ...Array.from({ length: MAX_LOOPS - 1 }, (_, i) => loop(`l${i}`, 1))],
      [clip("c", "a", 1, 1), clip("d", "a", 2, 1)],
    );
    expect(reason(clips.makeUnique(many, "t", "c"))).toBe("loop-limit");
  });
  it("editing the copy leaves the original", () => {
    const next = ok(clips.makeUnique(song, "t", "c3")).song;
    const copyId = track(next).loops[1].id;
    const edited = clips.editLoopNotes(next, "t", copyId, []);
    expect(track(edited).loops[0].notes).toHaveLength(1);
    expect(track(edited).loops[1].notes).toHaveLength(0);
  });
});

describe("renameLoop / deleteLoop / setLoopLength", () => {
  const song = songWith(
    [loop("a", 4, [note("kick", 0), note("kick", 3 * SPM), note("c4", 3 * SPM + 8, 8)], "Fill"), loop("b", 1)],
    [clip("c1", "a", 1, 4), clip("c2", "a", 5, 4), clip("c3", "a", 9, 4), clip("c4", "b", 13, 1)],
  );
  it("renames for every clip, trimming and limiting the name", () => {
    expect(track(ok(clips.renameLoop(song, "t", "a", "  Verse ")).song).loops[0].name).toBe("Verse");
    expect(track(ok(clips.renameLoop(song, "t", "a", "z".repeat(60))).song).loops[0].name).toHaveLength(40);
    expect(ok(clips.renameLoop(song, "t", "a", "  ")).song).toBe(song);
  });
  it("deletes a loop with all its clips", () => {
    const next = track(ok(clips.deleteLoop(song, "t", "a")).song);
    expect(next.loops.map((l) => l.id)).toEqual(["b"]);
    expect(next.clips.map((c) => c.id)).toEqual(["c4"]);
  });
  it("shortening drops and truncates notes without touching clips", () => {
    const r = ok(clips.setLoopLength(song, "t", "a", 2));
    expect(track(r.song).loops[0]).toMatchObject({ measures: 2, notes: [note("kick", 0)] });
    expect(track(r.song).clips).toBe(track(song).clips);
    expect(ok(clips.setLoopLength(song, "t", "a", 4)).song).toBe(song);
    const trunc = ok(clips.setLoopLength(songWith([loop("a", 4, [note("c4", SPM + 8, 24)])], []), "t", "a", 2));
    expect(track(trunc.song).loops[0].notes).toEqual([note("c4", SPM + 8, 8)]);
  });
  it("lengthening appends empty measures and clamps to 1-128", () => {
    const r = ok(clips.setLoopLength(song, "t", "a", 200));
    expect(track(r.song).loops[0].measures).toBe(128);
    expect(track(r.song).loops[0].notes).toBe(track(song).loops[0].notes);
    expect(track(ok(clips.setLoopLength(song, "t", "a", 0)).song).loops[0].measures).toBe(1);
  });
});

describe("loopGrid", () => {
  it("is loop-local", () => {
    const l = loop("a", 2);
    expect(clips.loopGrid(l, [], SPM)).toEqual({ notes: l.notes, rows: [], totalSteps: 2 * SPM });
  });
});
