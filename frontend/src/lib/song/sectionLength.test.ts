import { describe, expect, it } from "vitest";
import { note } from "@/test/fixtures";
import { newSongWithTracks } from "./testFixtures";
import * as clips from "./clipOps";
import { migrateSong } from "./migrate";
import { clipBound, normalizeSong } from "./songOps";
import { createSongStore } from "./songStore";
import type { Clip, Section, SectionKind, Song } from "./types";

const section = (id: string, name: string, measures: number, kind: SectionKind = "other"): Section => ({
  id,
  name,
  kind,
  measures,
  notes: "",
});

function songWith(clipList: Clip[], sections?: Section[], measures?: number): Song {
  const base = newSongWithTracks();
  return {
    ...base,
    measures: measures ?? sections?.reduce((n, s) => n + s.measures, 0) ?? 1,
    tracks: [
      {
        ...base.tracks[0],
        id: "t",
        loops: [{ id: "l", name: "L", measures: 1, notes: [note("kick", 0)] }],
        clips: clipList,
      },
      base.tracks[1],
    ],
    ...(sections && { sections }),
  };
}
const clip = (id: string, start_measure: number, measures: number): Clip => ({ id, loop_id: "l", start_measure, measures });
const lengths = (song: Song) => song.sections!.map((s) => s.measures);

describe("normalizeSong with sections", () => {
  it("lengthens the last section to cover a clip past it", () => {
    const song = songWith([clip("c", 14, 1)], [section("v", "Verse", 8), section("o", "Outro", 4)], 12);
    const next = normalizeSong(song);
    expect(lengths(next)).toEqual([8, 6]);
    expect(next.measures).toBe(14);
  });

  it("keeps the section lengths when clips are deleted", () => {
    const song = songWith([clip("c", 2, 3)], [section("v", "Verse", 8), section("o", "Outro", 4)]);
    const result = clips.deleteClip(song, "t", "c");
    const next = result.song!;
    expect(lengths(next)).toEqual([8, 4]);
    expect(next.measures).toBe(12);
  });

  it("still lets an unsectioned song follow its clips", () => {
    const song = normalizeSong(songWith([clip("c", 1, 5)]));
    expect(song.measures).toBe(5);
    const shrunk = clips.deleteClip(song, "t", "c").song!;
    expect(shrunk.measures).toBe(1);
    expect(shrunk.sections).toBeUndefined();
  });

  it("returns the same song when it is already consistent", () => {
    const song = songWith([clip("c", 2, 3)], [section("v", "Verse", 8)]);
    expect(normalizeSong(song)).toBe(song);
  });
});

describe("clip bound with sections", () => {
  const atLimit = () => songWith([clip("c", 30, 9)], [section("a", "Intro", 8), section("b", "Last", 30)]);

  it("is the timeline for a short last section and the section reach for a long one", () => {
    expect(clipBound(songWith([], [section("a", "A", 8)]))).toBe(16);
    expect(clipBound(atLimit())).toBe(40);
  });

  it("stops a resize at the furthest measure the last section can reach", () => {
    const next = clips.resizeClip(atLimit(), "t", "c", 15).song!;
    expect(next.tracks[0].clips[0].measures).toBe(11);
    expect(lengths(next)).toEqual([8, 32]);
    expect(next.measures).toBe(40);
  });

  it("stops a move at the same limit", () => {
    const next = clips.moveClip(atLimit(), "t", "c", 60).song!;
    expect(next.tracks[0].clips[0].start_measure).toBe(32);
    expect(next.measures).toBe(40);
  });

  it("refuses a new clip, a placed loop and a duplicate past it", () => {
    const song = atLimit();
    expect(clips.newClip(song, "t", 41)).toMatchObject({ song: null, reason: "section-limit" });
    expect(clips.placeLoop(song, "t", "l", 41)).toMatchObject({ song: null, reason: "section-limit" });
    expect(clips.duplicateClip(song, "t", "c")).toMatchObject({ song: null, reason: "section-limit" });
  });

  it("refuses a new clip that starts inside the reach but would end past it, rather than shortening it", () => {
    expect(clips.newClipWithNotes(atLimit(), "t", 40, 2, [])).toMatchObject({ song: null, reason: "section-limit" });
    expect(clips.newClipWithNotes(atLimit(), "t", 39, 2, []).song).not.toBeNull();
  });

  it("does not report a section limit while the timeline is the binding bound", () => {
    const song = songWith([], [section("a", "A", 8)]);
    expect(clips.newClip(song, "t", 17)).toMatchObject({ song: null, reason: "no-room" });
  });
});

describe("a clip past the last section in the store", () => {
  it("lengthens the last section in the same undo step as the clip", () => {
    const store = createSongStore(songWith([], [section("v", "Verse", 8), section("o", "Outro", 4)]));
    const before = store.getState().song!;
    expect(store.getState().newClip("t", 14)).toBeNull();
    expect(lengths(store.getState().song!)).toEqual([8, 6]);
    expect(store.getState().song!.measures).toBe(14);
    store.getState().undo();
    expect(store.getState().song).toEqual(before);
  });

  it("tells the user to add a section when the new clip is past the limit", () => {
    const store = createSongStore(songWith([], [section("a", "Last", 32)]));
    expect(store.getState().newClip("t", 33)).toBe("section-limit");
    expect(store.getState().past).toHaveLength(0);
  });
});

describe("migrateSong with sections", () => {
  const stored = (over: Partial<Song> = {}): Song => ({
    ...songWith([clip("c", 14, 1)], [section("v", "Verse", 8), section("o", "Outro", 4)], 12),
    ...over,
  });

  it("corrects a last section that ends before the last clip", () => {
    const opened = migrateSong(stored())!;
    expect(lengths(opened)).toEqual([8, 6]);
    expect(opened.measures).toBe(14);
  });

  it("corrects a stale stored length from the sections", () => {
    expect(migrateSong(stored({ measures: 40 }))!.measures).toBe(14);
  });

  it("opens the same song with and without sections", () => {
    const { sections: _sections, ...plain } = stored();
    void _sections;
    expect(migrateSong(plain)!.sections).toBeUndefined();
    expect(migrateSong(plain)!.measures).toBe(14);
    expect(migrateSong(stored())!.sections).toHaveLength(2);
  });

  it("opens an explicitly empty list", () => {
    expect(migrateSong(stored({ sections: [] }))).not.toBeNull();
  });

  it("refuses a malformed section instead of throwing", () => {
    expect(migrateSong(stored({ sections: [{ name: "Verse" }] as unknown as Section[] }))).toBeNull();
    expect(migrateSong(stored({ sections: [section("a", "A", 40)] }))).toBeNull();
  });
});
