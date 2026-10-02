import { describe, expect, it } from "vitest";
import type { Sample } from "@/generated/Sample";
import { note } from "@/test/fixtures";
import * as audioOps from "./song/audioClipOps";
import { addTrack, audioFits, normalizeSong } from "./song/songOps";
import { newSongWithTracks } from "./song/testFixtures";
import { createSongStore } from "./song/songStore";
import { newSong, type Section, type SectionKind, type Song } from "./song/types";
import * as ops from "./songSectionOps";

const section = (id: string, name: string, measures: number, kind: SectionKind = "other"): Section => ({
  id,
  name,
  kind,
  measures,
  notes: "",
});

describe("duplicating across a baked loop", () => {
  it("keeps the original loop for a piece that starts on a repeat of it", () => {
    const base = newSongWithTracks();
    const song = normalizeSong({
      ...base,
      measures: 16,
      tracks: [
        {
          ...base.tracks[0],
          id: "t",
          loops: [{ id: "groove", name: "Groove", measures: 4, notes: [note("kick", 0)] }],
          clips: [{ id: "c", loop_id: "groove", start_measure: 1, measures: 16 }],
        },
        base.tracks[1],
      ],
      sections: [section("a", "A", 2), section("b", "B", 2), section("c", "C", 12)],
    });
    const next = ops.duplicateSection(song, "b").song!;
    const track = next.tracks[0];
    const names = track.loops.map((l) => l.name);
    expect(names).toEqual(["Groove", "Groove (cont.)"]);
    // Measures 5-16 were a repeat of Groove, so after the 2-measure shift they are still Groove.
    expect(track.clips.map((c) => [c.start_measure, c.measures, c.loop_id])).toEqual([
      [1, 2, "groove"],
      [3, 2, track.loops[1].id],
      [5, 2, track.loops[1].id],
      [7, 12, "groove"],
    ]);
  });
});

describe("duplicate names", () => {
  it("always numbers a copy, even when the unnumbered name is absent", () => {
    const song = { ...newSongWithTracks(), measures: 12, sections: [section("v", "Verse", 8), section("c", "Chorus 2", 4)] };
    const next = ops.duplicateSection(song, "c").song!;
    expect(ops.sectionsOf(next).map((s) => s.name)).toEqual(["Verse", "Chorus 2", "Chorus 3"]);
  });
});

describe("notes through undo of an unsectioned song", () => {
  it("keeps notes typed into the implicit section after clips changed its length", () => {
    const base = newSongWithTracks();
    const store = createSongStore(base);
    const track = base.tracks[0].id;
    store.getState().newClip(track, 8);
    store.getState().newClip(track, 12);
    store.getState().setSectionNotes("implicit", "idea");
    store.getState().newClip(track, 16);
    while (store.getState().past.length > 0) store.getState().undo();
    const song = store.getState().song!;
    expect(song.sections?.[0].notes).toBe("idea");
    expect(song.sections?.[0].measures).toBe(song.measures);
  });
});

describe("audio and the last section's reach", () => {
  // The last section starts at measure 9, so it can reach measure 40 and no further.
  const MEASURE = 3840;
  const M = 96000;
  const s: Sample = { id: "s", name: "s", sample_rate: 48000, channels: 2, length_samples: 2 * M, origin: "import" };

  function start(sections = true): { song: Song; trackId: string } {
    const song = addTrack({ ...newSong("4/4", 120), samples: [s] }, { id: "audio", name: "Audio" }, "Audio");
    const sectioned = sections ? { sections: [section("a", "A", 8), section("b", "B", 4)], measures: 12 } : {};
    return { song: normalizeSong({ ...song, ...sectioned }), trackId: song.tracks[0].id };
  }

  it("refuses to place audio that would end past it, and allows audio up to it", () => {
    const { song, trackId } = start();
    const refused = audioOps.placeSample(song, trackId, s, 39 * MEASURE);
    expect(refused).toMatchObject({ song: null, reason: "section-limit" });
    const placed = audioOps.placeSample(song, trackId, s, 38 * MEASURE);
    expect(placed.song!.measures).toBe(40);
  });

  it("stops a move at the reach", () => {
    const { song, trackId } = start();
    const placed = audioOps.placeSample(song, trackId, s, 20 * MEASURE);
    const moved = audioOps.moveClip(placed.song!, trackId, (placed as { clipId: string }).clipId, 60 * MEASURE);
    expect(moved.song!.tracks[0].audio_clips![0].start_ticks).toBe(38 * MEASURE);
  });

  it("refuses a duplicate that would pass it", () => {
    const { song, trackId } = start();
    const placed = audioOps.placeSample(song, trackId, s, 38 * MEASURE);
    expect(audioOps.duplicateClip(placed.song!, trackId, (placed as { clipId: string }).clipId)).toMatchObject({
      song: null,
      reason: "section-limit",
    });
  });

  it("refuses a tempo that would stretch audio past it, where an unsectioned song allows it", () => {
    const { song, trackId } = start();
    const placed = audioOps.placeSample(song, trackId, s, 38 * MEASURE).song!;
    expect(audioFits({ ...placed, tempo_bpm: 140 })).toBe(false);
    const plain = audioOps.placeSample(start(false).song, trackId, s, 38 * MEASURE).song!;
    expect(audioFits({ ...plain, tempo_bpm: 140 })).toBe(true);
  });
});
