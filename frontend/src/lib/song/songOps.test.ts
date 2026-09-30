import { describe, expect, it } from "vitest";
import { drums, note, patternWith } from "@/test/fixtures";
import * as ops from "./songOps";
import { newSong, type Clip, type Song } from "./types";

const withClips = (song: Song, trackIndex: number, spans: [start: number, measures: number][]): Song => ({
  ...song,
  tracks: song.tracks.map((t, i) =>
    i === trackIndex
      ? {
          ...t,
          loops: [{ id: `l${i}`, name: "Loop", measures: 2, notes: [note("kick", 0)] }],
          clips: spans.map(([start_measure, measures], n): Clip => ({ id: `c${i}-${n}`, loop_id: `l${i}`, start_measure, measures })),
        }
      : t,
  ),
});

describe("tracks", () => {
  it("adds a second track with the same instrument, independently editable", () => {
    const s = ops.addTrack(newSong(), { id: "piano", name: "Piano" });
    const pianos = s.tracks.filter((t) => t.instrument === "piano");
    expect(pianos).toHaveLength(2);
    expect(pianos[0].id).not.toBe(pianos[1].id);
    expect(pianos[0].loops).not.toBe(pianos[1].loops);
  });

  it("refuses a 17th track", () => {
    let s = newSong();
    while (s.tracks.length < 16) s = ops.addTrack(s, { id: "piano", name: "Piano" });
    expect(ops.addTrack(s, { id: "piano", name: "Piano" })).toBe(s);
  });

  it("refuses to delete the last track", () => {
    let s = newSong();
    s = ops.deleteTrack(s, s.tracks[0].id);
    expect(s.tracks).toHaveLength(1);
    expect(ops.deleteTrack(s, s.tracks[0].id)).toBe(s);
  });

  it("renames within limits and ignores empty names", () => {
    const s = newSong();
    expect(ops.renameTrack(s, s.tracks[0].id, "  Beat ").tracks[0].name).toBe("Beat");
    expect(ops.renameTrack(s, s.tracks[0].id, "  ")).toBe(s);
    expect(ops.renameTrack(s, s.tracks[0].id, "x".repeat(60)).tracks[0].name).toHaveLength(40);
  });
});

describe("song settings", () => {
  it("lengthening appends silence and keeps existing clips", () => {
    const s = withClips(newSong(), 0, [[1, 8]]);
    const longer = ops.setSongLength(s, 12);
    expect(longer.measures).toBe(12);
    expect(longer.tracks[0].clips).toBe(s.tracks[0].clips);
  });

  it("shortening trims and deletes clips on every track and keeps every loop whole", () => {
    let s = ops.setSongLength(newSong(), 12);
    s = withClips(s, 0, [[7, 4], [11, 2]]);
    s = withClips(s, 1, [[1, 2]]);
    const cut = ops.setSongLength(s, 8);
    expect(cut.tracks[0].clips).toMatchObject([{ start_measure: 7, measures: 2 }]);
    expect(cut.tracks[0].loops).toBe(s.tracks[0].loops);
    expect(cut.tracks[1].clips).toBe(s.tracks[1].clips);
  });

  it("clamps length, tempo, swing and no-ops on equal values", () => {
    const s = newSong();
    expect(ops.setSongLength(s, 500).measures).toBe(128);
    expect(ops.setSongLength(s, 0).measures).toBe(1);
    expect(ops.setTempo(s, 1000).tempo_bpm).toBe(240);
    expect(ops.setTempo(s, 120)).toBe(s);
    expect(ops.setSwing(s, 2).swing).toBe(0.75);
    expect(ops.setSwing(s, 0)).toBe(s);
  });

  it("renames the song", () => {
    const s = newSong();
    expect(ops.renameSong(s, " Demo ").name).toBe("Demo");
    expect(ops.renameSong(s, "")).toBe(s);
  });
});

describe("mixer", () => {
  const three = () => {
    let s = newSong();
    s = ops.addTrack(s, { id: "bass", name: "Bass" });
    return s;
  };

  it("clamps volume and pan", () => {
    const s = newSong();
    const id = s.tracks[0].id;
    const m = ops.setMixer(s, id, { volume_db: -100, pan: 3 }).tracks[0];
    expect([m.volume_db, m.pan]).toEqual([-60, 1]);
    expect(ops.setMixer(s, id, { volume_db: 0 })).toBe(s);
  });

  it("everything is audible with no mute or solo", () => {
    expect(ops.audibleTracks(three())).toHaveLength(3);
  });

  it("solo isolates tracks", () => {
    const s = three();
    const soloed = ops.setMixer(s, s.tracks[2].id, { soloed: true });
    expect(ops.audibleTracks(soloed).map((t) => t.name)).toEqual(["Bass"]);
  });

  it("mute overrides solo", () => {
    const s = three();
    const id = s.tracks[2].id;
    const both = ops.setMixer(ops.setMixer(s, id, { soloed: true }), id, { muted: true });
    expect(ops.audibleTracks(both)).toEqual([]);
  });

  it("muting one track leaves the others audible", () => {
    const s = three();
    const muted = ops.setMixer(s, s.tracks[0].id, { muted: true });
    expect(ops.audibleTracks(muted).map((t) => t.name)).toEqual(["Piano", "Bass"]);
  });
});

describe("addTrack naming", () => {
  it("numbers repeated instruments with the smallest free suffix", () => {
    const piano = { id: "piano", name: "Piano" };
    let s = ops.addTrack({ ...newSong(), tracks: [] }, piano);
    expect(s.tracks.map((t) => t.name)).toEqual(["Piano"]);
    s = ops.addTrack(s, piano);
    s = ops.addTrack(s, piano);
    expect(s.tracks.map((t) => t.name)).toEqual(["Piano", "Piano 2", "Piano 3"]);
    s = { ...s, tracks: s.tracks.filter((t) => t.name !== "Piano 2") };
    expect(ops.addTrack(s, piano).tracks.at(-1)?.name).toBe("Piano 2");
  });

  it("keeps an explicit name as given", () => {
    const s = ops.addTrack(newSong(), { id: "piano", name: "Piano" }, "Lead");
    expect(s.tracks.at(-1)?.name).toBe("Lead");
  });
});

describe("addTrackFromPattern", () => {
  const pattern = patternWith([note("kick", 0), note("snare", 4)], { measures: 4 });

  it("adds a track named after the pattern with its notes", () => {
    const s = ops.addTrackFromPattern(newSong(), pattern);
    const t = s.tracks[s.tracks.length - 1];
    expect(t).toMatchObject({ name: "Boom Bap", instrument: drums.id });
    expect(t.loops).toMatchObject([{ name: "Boom Bap", measures: 4, notes: pattern.notes }]);
    expect(t.clips).toMatchObject([{ loop_id: t.loops[0].id, start_measure: 1, measures: 4 }]);
    expect(s.measures).toBe(8);
  });

  it("lengthens the song when the pattern is longer, leaving other tracks empty there", () => {
    const long = { ...pattern, measures: 16 as const };
    const base = withClips(newSong(), 0, [[1, 8]]);
    const s = ops.addTrackFromPattern(base, long);
    expect(s.measures).toBe(16);
    expect(s.tracks[0].clips).toBe(base.tracks[0].clips);
    expect(s.tracks[1].clips).toEqual([]);
    expect(s.tracks[2].clips).toMatchObject([{ start_measure: 1, measures: 16 }]);
  });

  it("places a short pattern as a short clip in a longer song", () => {
    const base = ops.setSongLength(newSong(), 16);
    const s = ops.addTrackFromPattern(base, { ...pattern, measures: 4 });
    expect(s.measures).toBe(16);
    expect(s.tracks[2].clips).toMatchObject([{ start_measure: 1, measures: 4 }]);
  });

  it("refuses at 16 tracks or a mismatched meter", () => {
    let s = newSong();
    while (s.tracks.length < 16) s = ops.addTrackFromPattern(s, pattern);
    expect(ops.addTrackFromPattern(s, pattern)).toBe(s);
    const waltz = newSong("3/4");
    expect(ops.addTrackFromPattern(waltz, pattern)).toBe(waltz);
  });
});
