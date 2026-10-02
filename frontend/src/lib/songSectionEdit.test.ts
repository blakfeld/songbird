import { describe, expect, it } from "vitest";
import { note } from "@/test/fixtures";
import { newSongWithTracks } from "./song/testFixtures";
import { normalizeSong } from "./song/songOps";
import { createSongStore } from "./song/songStore";
import type { Section, Song } from "./song/types";
import * as ops from "./songSectionOps";

const section = (id: string, name: string, measures: number): Section => ({ id, name, kind: "other", measures, notes: "" });

function song(sections?: Section[]): Song {
  const base = newSongWithTracks();
  return normalizeSong({
    ...base,
    measures: sections ? sections.reduce((n, s) => n + s.measures, 0) : 16,
    tracks: [
      {
        ...base.tracks[0],
        id: "t",
        loops: [{ id: "a", name: "a", measures: 1, notes: [note("kick", 0)] }],
        clips: [{ id: "c", loop_id: "a", start_measure: sections ? 9 : 1, measures: sections ? 1 : 16 }],
      },
      base.tracks[1],
    ],
    ...(sections && { sections }),
  });
}

describe("editSection", () => {
  it("applies name, kind and length together", () => {
    const next = ops.editSection(song([section("v", "Verse", 8), section("c", "Chorus", 8)]), "v", {
      name: "Hook",
      kind: "chorus",
      measures: 12,
    }).song!;
    expect(ops.sectionsOf(next)[0]).toMatchObject({ name: "Hook", kind: "chorus", measures: 12 });
    expect(next.tracks[0].clips[0].start_measure).toBe(13);
  });

  it("materializes the implicit section once", () => {
    const next = ops.editSection(song(), ops.IMPLICIT_SECTION_ID, { name: "Whole", measures: 20 }).song!;
    expect(next.sections).toHaveLength(1);
    expect(next.sections![0]).toMatchObject({ name: "Whole", measures: 20 });
  });

  it("is one undo step in the store", () => {
    const store = createSongStore(song([section("v", "Verse", 8), section("c", "Chorus", 8)]));
    store.getState().editSection("v", { name: "Hook", kind: "chorus", measures: 4 });
    expect(store.getState().past).toHaveLength(1);
  });

  it("names the next free numbered default", () => {
    const s = song([section("v", "Verse", 8)]);
    expect(ops.defaultSectionName(s, "verse")).toBe("Verse 2");
    expect(ops.defaultSectionName(s, "bridge")).toBe("Bridge");
  });
});
