import { describe, expect, it } from "vitest";
import { newSong, type Section, type Song } from "@/lib/song/types";
import { describePosition, sectionNameAt, songSteps } from "./position";

const section = (id: string, name: string, kind: Section["kind"], measures: number): Section => ({
  id,
  name,
  kind,
  measures,
  notes: "",
});

const sectioned = (): Song => ({
  ...newSong(),
  measures: 8,
  sections: [section("v", "Verse", "verse", 4), section("c", "Chorus", "chorus", 4)],
});

describe("sectionNameAt", () => {
  it("names the section containing a step", () => {
    expect(sectionNameAt(sectioned(), 0)).toBe("Verse");
    expect(sectionNameAt(sectioned(), 63)).toBe("Verse");
    expect(sectionNameAt(sectioned(), 64)).toBe("Chorus");
  });

  it("gives the inclusive end step to the last real section", () => {
    const song = sectioned();
    expect(sectionNameAt(song, songSteps(song))).toBe("Chorus");
    expect(describePosition(song, songSteps(song))).toMatch(/in Chorus$/);
  });

  it("gives the inclusive end step to the last implicit chunk of an unsectioned song", () => {
    const song: Song = { ...newSong(), measures: 40 };
    expect(sectionNameAt(song, 0)).toBe("Song");
    expect(sectionNameAt(song, songSteps(song))).toBe("Song 2");
  });

  it("names nothing past the end", () => {
    const song = sectioned();
    expect(sectionNameAt(song, songSteps(song) + 1)).toBeNull();
  });
});
