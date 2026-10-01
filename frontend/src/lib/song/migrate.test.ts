import { describe, expect, it } from "vitest";
import { newSongWithTracks } from "./testFixtures";
import { note } from "@/test/fixtures";
import { resolveTrackNotes } from "./clipOps";
import { migrateSong } from "./migrate";
import { songLoop } from "./songLoop";

const v2 = () => {
  const song = newSongWithTracks();
  const track = {
    ...song.tracks[0],
    loops: [{ id: "l", name: "L", measures: 2, notes: [note("kick", 0)] }],
    clips: [{ id: "c", loop_id: "l", start_measure: 1, measures: 8 }],
  };
  return { ...song, measures: 8, tracks: [track, song.tracks[1]] };
};

const withTrack0 = (patch: Record<string, unknown>) => {
  const song = v2();
  return { ...song, tracks: [{ ...song.tracks[0], ...patch }, song.tracks[1]] };
};

const v1 = (notes: unknown) => {
  const song = newSongWithTracks();
  const { key: _key, ...withoutKey } = song;
  void _key;
  return {
    ...withoutKey,
    measures: 8,
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

  it("opens a song saved before keys existed in C major with its notes unchanged", () => {
    const { key: _key, ...old } = v2();
    void _key;
    const opened = migrateSong(old)!;
    expect(opened.key).toEqual({ tonic: "C", mode: "major" });
    expect(opened.tracks).toBe(old.tracks);
  });

  it("replaces an invalid stored key with C major and keeps a valid one", () => {
    expect(migrateSong({ ...v2(), key: { tonic: "H", mode: "major" } })!.key).toEqual({ tonic: "C", mode: "major" });
    const minor = { tonic: "E", mode: "minor" };
    expect(migrateSong({ ...v2(), key: minor })!.key).toEqual(minor);
  });

  it("corrects a stale stored length in either direction", () => {
    expect(migrateSong({ ...v2(), measures: 20 })!.measures).toBe(8);
    expect(migrateSong({ ...v2(), measures: 2 })!.measures).toBe(8);
  });

  it("opens an empty song as 1 measure", () => {
    const song = { ...v2(), tracks: v2().tracks.map((t) => ({ ...t, clips: [] })) };
    expect(migrateSong(song)!.measures).toBe(1);
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
    const total = 8 * newSongWithTracks().steps_per_measure;
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

describe("loop region on load", () => {
  const R = (start: number, end: number, enabled = true) => ({
    region: { start_measure: start, end_measure: end },
    enabled,
  });

  it("opens a version 2 song without the field with no region and looping off", () => {
    const song = migrateSong(v2())!;
    expect(song.loop_region).toBeUndefined();
    expect(songLoop(song)).toEqual({ region: null, enabled: false });
  });

  it("opens a migrated version 1 song with no region", () => {
    expect(songLoop(migrateSong(v1([note("kick", 0)]))!)).toEqual({ region: null, enabled: false });
  });

  it("keeps a stored region and looping on with no region", () => {
    expect(migrateSong({ ...v2(), loop_region: R(3, 4, false) })!.loop_region).toEqual(R(3, 4, false));
    const none = { region: null, enabled: true };
    expect(migrateSong({ ...v2(), loop_region: none })!.loop_region).toEqual(none);
  });

  it("keeps a stored region inside the timeline and clamps one past it", () => {
    expect(migrateSong({ ...v2(), loop_region: R(5, 12) })!.loop_region).toEqual(R(5, 12));
    expect(migrateSong({ ...v2(), loop_region: R(5, 40) })!.loop_region).toEqual(R(5, 16));
  });

  it("reads null, malformed and the flat shape as the default", () => {
    for (const bad of [null, "x", { region: { start_measure: "a" }, enabled: true }, { start_measure: 2, end_measure: 3, enabled: true }]) {
      const song = migrateSong({ ...v2(), loop_region: bad })!;
      expect(songLoop(song)).toEqual({ region: null, enabled: false });
    }
  });
});
