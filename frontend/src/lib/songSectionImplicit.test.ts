import { describe, expect, it } from "vitest";
import { drums, note } from "@/test/fixtures";
import { migrateSong } from "./song/migrate";
import { parseProjectFile, serializeProject } from "./song/projectFile";
import { createSongStore } from "./song/songStore";
import { normalizeSong } from "./song/songOps";
import { newSongWithTracks } from "./song/testFixtures";
import type { Song } from "./song/types";
import * as ops from "./songSectionOps";

function longSong(measures: number): Song {
  const base = newSongWithTracks();
  const track = {
    ...base.tracks[0],
    id: "t",
    loops: [{ id: "l", name: "L", measures: 1, notes: [note("kick", 0)] }],
    clips: [{ id: "c", loop_id: "l", start_measure: 1, measures }],
  };
  return normalizeSong({ ...base, tracks: [track] });
}

describe("a long old song is split into implicit sections", () => {
  it("shows 32-measure chunks with the remainder last", () => {
    const sections = ops.sectionsOf(longSong(70));
    expect(sections.map((s) => [s.id, s.name, s.measures])).toEqual([
      ["implicit", "Song", 32],
      ["implicit-2", "Song 2", 32],
      ["implicit-3", "Song 3", 6],
    ]);
    expect(ops.sectionsOf(longSong(32))).toHaveLength(1);
    expect(ops.sectionsOf(longSong(33)).map((s) => s.measures)).toEqual([32, 1]);
  });

  it("materializes every chunk on the first edit and the result is a valid document", () => {
    const song = longSong(70);
    const next = ops.setSectionNotes(song, "implicit-2", "second half").song!;
    expect(next.sections!.map((s) => [s.name, s.measures, s.notes])).toEqual([
      ["Song", 32, ""],
      ["Song 2", 32, "second half"],
      ["Song 3", 6, ""],
    ]);
    expect(next.sections!.every((s) => !s.id.startsWith("implicit"))).toBe(true);
    expect(next.measures).toBe(70);
    const stored = JSON.parse(JSON.stringify(next));
    expect(migrateSong(stored)).not.toBeNull();
    const parsed = parseProjectFile(serializeProject(next), [drums]);
    expect("ok" in parsed && parsed.ok.sections).toHaveLength(3);
  });

  it("inserts before the second chunk of a 64-measure song and shifts its clips", () => {
    const song = longSong(64);
    const next = ops.insertSection(song, { kind: "intro", measures: 4 }, "implicit-2", "before").song!;
    expect(next.sections!.map((s) => [s.name, s.measures])).toEqual([
      ["Song", 32],
      ["Intro", 4],
      ["Song 2", 32],
    ]);
    expect(next.measures).toBe(68);
    expect(next.tracks[0].clips.map((c) => [c.start_measure, c.measures])).toEqual([
      [1, 32],
      [37, 32],
    ]);
  });

  it("keeps notes through undo after a real section was added beside the implicit one", () => {
    const store = createSongStore(longSong(16));
    store.getState().addSection({ kind: "verse", measures: 4 });
    const song = store.getState().song!;
    store.getState().setSectionNotes(song.sections![0].id, "idea");
    store.getState().undo();
    const after = store.getState().song!;
    expect(after.sections?.map((s) => s.notes)).toEqual(["idea"]);
    expect(after.sections![0].id).not.toMatch(/^implicit/);
  });

  it("keeps notes typed into a later chunk when the snapshot has the chunk too", () => {
    const store = createSongStore(longSong(40));
    store.getState().addSection({ kind: "verse", measures: 4 });
    const id = store.getState().song!.sections![1].id;
    store.getState().setSectionNotes(id, "second");
    store.getState().undo();
    expect(store.getState().song!.sections!.map((s) => s.notes)).toEqual(["", "second"]);
  });

  it("refuses an implicit id past the last chunk", () => {
    expect(ops.renameSection(longSong(16), "implicit-3", "x")).toMatchObject({ song: null, reason: "not-found" });
    expect(ops.deleteSection(longSong(70), "implicit-9")).toMatchObject({ song: null, reason: "not-found" });
  });

  it("deletes a chunk of an unsectioned song", () => {
    const next = ops.deleteSection(longSong(64), "implicit-2").song!;
    expect(next.sections).toHaveLength(1);
    expect(next.measures).toBe(32);
  });

  it("keeps notes typed into a chunk through undo back to the unsectioned song", () => {
    const store = createSongStore(longSong(40));
    store.getState().newClip("t", 41);
    store.getState().setSectionNotes("implicit-2", "idea");
    store.getState().newClip("t", 45);
    while (store.getState().past.length > 0) store.getState().undo();
    const song = store.getState().song!;
    expect(song.sections!.map((s) => s.notes)).toEqual(["", "idea"]);
    expect(song.sections!.reduce((n, s) => n + s.measures, 0)).toBe(song.measures);
  });
});
