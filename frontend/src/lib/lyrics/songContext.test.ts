import { describe, expect, it } from "vitest";
import { newSong, type Section, type Song } from "../song/types";
import { songContext } from "./songContext";

const sec = (id: string, name: string): Section => ({ id, name, kind: "chorus", measures: 8, notes: "n", chords: undefined } as Section);

describe("songContext", () => {
  it("sends implicit section ids as they are for an unsectioned song", () => {
    const song: Song = { ...newSong(), measures: 40 };
    const ctx = songContext(song);
    expect(ctx.sections.map((s) => [s.id, s.name, s.measures])).toEqual([
      ["implicit", "Song", 32],
      ["implicit-2", "Song 2", 8],
    ]);
    expect(ctx.sections.every((s) => s.chords.length === 0)).toBe(true);
  });

  it("projects real sections with their kind and notes", () => {
    const song: Song = { ...newSong(), measures: 8, sections: [sec("a", "Hook")] };
    expect(songContext(song).sections).toEqual([
      { id: "a", name: "Hook", kind: "chorus", measures: 8, notes: "n", chords: [] },
    ]);
  });

  it("carries the song's tempo, meter and name", () => {
    const ctx = songContext({ ...newSong("3/4", 90), name: "Late Train" });
    expect(ctx).toMatchObject({ name: "Late Train", tempo_bpm: 90, time_signature: "3/4" });
  });
});
