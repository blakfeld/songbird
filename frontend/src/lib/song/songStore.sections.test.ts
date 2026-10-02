import { describe, expect, it } from "vitest";
import { note } from "@/test/fixtures";
import { newSongWithTracks } from "./testFixtures";
import { createSongStore } from "./songStore";
import { normalizeSong } from "./songOps";
import type { Section, SectionKind, Song } from "./types";

const section = (id: string, name: string, measures: number, kind: SectionKind = "other"): Section => ({
  id,
  name,
  kind,
  measures,
  notes: "",
});

// A 14-measure clip of a 5-measure loop runs through the middle section, so deleting it bakes the tail.
function sectioned(): Song {
  const base = newSongWithTracks();
  return normalizeSong({
    ...base,
    measures: 16,
    tracks: [
      {
        ...base.tracks[0],
        id: "t",
        loops: [{ id: "l", name: "L", measures: 5, notes: [note("kick", 0)] }],
        clips: [
          { id: "c1", loop_id: "l", start_measure: 1, measures: 14 },
          { id: "c2", loop_id: "l", start_measure: 15, measures: 2 },
        ],
      },
      base.tracks[1],
    ],
    sections: [section("a", "Intro", 4, "intro"), section("b", "Verse", 8, "verse"), section("c", "Outro", 4, "outro")],
  });
}

const sectionIds = (song: Song) => song.sections!.map((s) => s.id);

describe("song store section actions", () => {
  it("makes each structural action one undo step", () => {
    const store = createSongStore(sectioned());
    const get = store.getState;
    get().addSection({ kind: "chorus" });
    get().insertSection({ kind: "bridge", measures: 2 }, "a", "after");
    get().renameSection("a", "Start");
    get().setSectionKind("a", "other");
    get().resizeSection("b", 6);
    get().duplicateSection("c");
    get().deleteSection("a");
    expect(get().past).toHaveLength(7);
    expect(get().song!.sections!.some((s) => s.name === "Start")).toBe(false);
  });

  it("restores the section, its clips and any split loop when a delete is undone, and re-applies it on redo", () => {
    const store = createSongStore(sectioned());
    const before = store.getState().song!;
    expect(store.getState().deleteSection("b")).toEqual({ sectionId: null });
    const deleted = store.getState().song!;
    expect(sectionIds(deleted)).toEqual(["a", "c"]);
    expect(deleted.measures).toBe(8);
    expect(deleted.tracks[0].loops.length).toBeGreaterThan(1);

    store.getState().undo();
    expect(store.getState().song).toEqual(before);
    expect(store.getState().song!.tracks[0].loops).toHaveLength(1);

    store.getState().redo();
    expect(store.getState().song).toEqual(deleted);
  });

  it("returns the refusal sentence and records no history", () => {
    const store = createSongStore(sectioned());
    expect(store.getState().resizeSection("a", 33)).toEqual({ error: expect.stringMatching(/1 to 32/) });
    expect(store.getState().deleteSection("missing")).toHaveProperty("error");
    expect(store.getState().past).toHaveLength(0);
  });

  it("refuses to edit sections while a track is generating", () => {
    const store = createSongStore(sectioned());
    store.getState().beginGenerating("t");
    expect(store.getState().addSection({ kind: "verse" })).toHaveProperty("error");
    expect(store.getState().past).toHaveLength(0);
  });

  it("returns the new section id so the caller can select it", () => {
    const store = createSongStore(sectioned());
    const result = store.getState().addSection({ kind: "bridge", measures: 4 });
    expect(result).toEqual({ sectionId: store.getState().song!.sections!.at(-1)!.id });
  });

  it("clamps the loop region when a structural edit shortens the song", () => {
    const store = createSongStore(sectioned());
    store.getState().setLoop({ region: { start: 20, end: 24 }, enabled: true });
    store.getState().deleteSection("c");
    store.getState().deleteSection("b");
    expect(store.getState().song!.measures).toBe(4);
    expect(store.getState().song!.loop_region).toEqual({ region: { start_measure: 16, end_measure: 16 }, enabled: true });
  });

  it("materializes an implicit section as part of the edit's undo step", () => {
    const base = newSongWithTracks();
    const store = createSongStore({ ...base, measures: 1 });
    store.getState().addSection({ kind: "intro", measures: 4 });
    expect(store.getState().song!.sections).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().song!.sections).toBeUndefined();
  });
});

describe("setSectionNotes", () => {
  it("writes notes without a history entry", () => {
    const store = createSongStore(sectioned());
    store.getState().setSectionNotes("b", "call and response");
    expect(store.getState().song!.sections![1].notes).toBe("call and response");
    expect(store.getState().past).toHaveLength(0);
  });

  it("caps notes at 5000 characters", () => {
    const store = createSongStore(sectioned());
    store.getState().setSectionNotes("b", "x".repeat(6000));
    expect(store.getState().song!.sections![1].notes).toHaveLength(5000);
  });

  it("keeps notes when a structural edit is undone and redone", () => {
    const store = createSongStore(sectioned());
    store.getState().renameSection("a", "Start");
    store.getState().setSectionNotes("b", "words");
    store.getState().undo();
    expect(store.getState().song!.sections![0].name).toBe("Intro");
    expect(store.getState().song!.sections![1].notes).toBe("words");
    store.getState().redo();
    expect(store.getState().song!.sections![1].notes).toBe("words");
  });

  it("restores a deleted section with the notes it had when it was deleted", () => {
    const store = createSongStore(sectioned());
    store.getState().setSectionNotes("b", "verse words");
    store.getState().deleteSection("b");
    store.getState().undo();
    expect(store.getState().song!.sections![1].notes).toBe("verse words");
  });

  it("keeps notes typed into the implicit section when everything is undone", () => {
    const base = newSongWithTracks();
    const store = createSongStore({ ...base, measures: 1 });
    store.getState().setSectionNotes("implicit", "idea");
    store.getState().resizeSection(store.getState().song!.sections![0].id, 4);
    store.getState().undo();
    expect(store.getState().song!.sections![0].notes).toBe("idea");
    store.getState().undo();
    expect(store.getState().song!.sections![0].notes).toBe("idea");
  });

  it("survives a simulated reload through the document", () => {
    const store = createSongStore(sectioned());
    store.getState().setSectionNotes("c", "fade out");
    const reloaded = createSongStore(JSON.parse(JSON.stringify(store.getState().song)));
    expect(reloaded.getState().song!.sections![2].notes).toBe("fade out");
  });
});
