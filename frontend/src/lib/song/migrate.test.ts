import { describe, expect, it } from "vitest";
import { note } from "@/test/fixtures";
import { resolveTrackNotes } from "./clipOps";
import { migrateSong } from "./migrate";
import { newSong } from "./types";

const v2 = () => {
  const song = newSong();
  const track = {
    ...song.tracks[0],
    loops: [{ id: "l", name: "L", measures: 2, notes: [note("kick", 0)] }],
    clips: [{ id: "c", loop_id: "l", start_measure: 1, measures: 2 }],
  };
  return { ...song, tracks: [track, song.tracks[1]] };
};

const withTrack0 = (patch: Record<string, unknown>) => {
  const song = v2();
  return { ...song, tracks: [{ ...song.tracks[0], ...patch }, song.tracks[1]] };
};

const v1 = (notes: unknown) => {
  const song = newSong();
  return {
    ...song,
    version: 1,
    tracks: song.tracks.map((t, i) => {
      const rest: Record<string, unknown> = { ...t };
      delete rest.loops;
      delete rest.clips;
      return { ...rest, notes: i === 0 ? notes : [] };
    }),
  };
};

describe("migrateSong", () => {
  it("accepts a valid version 2 song unchanged", () => {
    const song = v2();
    expect(migrateSong(song)).toBe(song);
  });

  it.each([
    ["a null loop", { loops: [null] }],
    ["a non-object clip", { clips: ["x"] }],
    ["a clip without a loop id", { clips: [{ id: "c", start_measure: 1, measures: 1 }] }],
    ["a clip with a bad position", { clips: [{ id: "c", loop_id: "l", start_measure: "1", measures: 1 }] }],
    ["a loop whose notes are not an array", { loops: [{ id: "l", name: "L", measures: 2, notes: 5 }] }],
    ["a null note", { loops: [{ id: "l", name: "L", measures: 2, notes: [null] }] }],
    ["a note past the loop", { loops: [{ id: "l", name: "L", measures: 1, notes: [note("kick", 99)] }] }],
    ["loops that are not an array", { loops: "nope" }],
    ["overlapping clips", { clips: [{ id: "c", loop_id: "l", start_measure: 1, measures: 3 }, { id: "d", loop_id: "l", start_measure: 3, measures: 1 }] }],
  ])("refuses %s without throwing", (_, patch) => {
    expect(migrateSong(withTrack0(patch))).toBeNull();
  });

  it.each([null, 5, "x", [], { version: 3 }, { version: 2 }, { ...v2(), tracks: [null] }, { ...v2(), tracks: "x" }])(
    "refuses a malformed document %#",
    (raw) => {
      expect(migrateSong(raw)).toBeNull();
    },
  );

  it("coerces version 1 notes that overlap or overrun so the result is openable", () => {
    const song = newSong();
    const total = song.measures * song.steps_per_measure;
    const migrated = migrateSong(
      v1([note("kick", 0, 8), note("kick", 4, 8), note("kick", total - 2, 10), note("kick", total + 5), note("kick", 20, 0)]),
    )!;
    expect(migrated).not.toBeNull();
    expect(migrateSong(migrated)).not.toBeNull();
    const notes = resolveTrackNotes(migrated, migrated.tracks[0]);
    expect(notes.find((n) => n.step === 0)!.length_steps).toBe(4);
    expect(notes.every((n) => n.step + n.length_steps <= total && n.length_steps >= 1)).toBe(true);
    expect(notes.some((n) => n.step === total + 5)).toBe(false);
  });

  it("drops version 1 notes of an unusable shape rather than failing", () => {
    const migrated = migrateSong(v1([null, { row_id: 5 }, note("kick", 0)]))!;
    expect(resolveTrackNotes(migrated, migrated.tracks[0])).toEqual([note("kick", 0)]);
  });

  it("refuses a version 1 song that is not a song", () => {
    expect(migrateSong({ version: 1, tracks: "x" })).toBeNull();
    expect(migrateSong({ ...v1([]), tracks: [null] })).toBeNull();
  });
});
