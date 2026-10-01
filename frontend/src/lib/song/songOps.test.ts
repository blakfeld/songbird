import { describe, expect, it } from "vitest";
import { newSongWithTracks } from "./testFixtures";
import { drums, note, patternWith } from "@/test/fixtures";
import * as ops from "./songOps";
import { type Clip, type Song } from "./types";

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
    const s = ops.addTrack(newSongWithTracks(), { id: "piano", name: "Piano" });
    const pianos = s.tracks.filter((t) => t.instrument === "piano");
    expect(pianos).toHaveLength(2);
    expect(pianos[0].id).not.toBe(pianos[1].id);
    expect(pianos[0].loops).not.toBe(pianos[1].loops);
  });

  it("refuses a 17th track", () => {
    let s = newSongWithTracks();
    while (s.tracks.length < 16) s = ops.addTrack(s, { id: "piano", name: "Piano" });
    expect(ops.addTrack(s, { id: "piano", name: "Piano" })).toBe(s);
  });

  it("shrinks the song length when the track that set it is deleted", () => {
    const base = ops.addTrack(newSongWithTracks(), { id: "piano", name: "Piano" });
    const long = ops.normalizeSong(withClips(base, 1, [[1, 20]]));
    expect(long.measures).toBe(20);
    const after = ops.deleteTrack(long, long.tracks[1].id);
    expect(after.measures).toBe(ops.derivedMeasures(after));
    expect(after.measures).toBeLessThan(20);
  });

  it("deletes the last track", () => {
    let s = newSongWithTracks();
    s = ops.deleteTrack(s, s.tracks[0].id);
    s = ops.deleteTrack(s, s.tracks[0].id);
    expect(s.tracks).toEqual([]);
    expect(s.measures).toBe(1);
  });

  it("renames within limits and ignores empty names", () => {
    const s = newSongWithTracks();
    expect(ops.renameTrack(s, s.tracks[0].id, "  Beat ").tracks[0].name).toBe("Beat");
    expect(ops.renameTrack(s, s.tracks[0].id, "  ")).toBe(s);
    expect(ops.renameTrack(s, s.tracks[0].id, "x".repeat(60)).tracks[0].name).toHaveLength(40);
  });
});

describe("song settings", () => {
  it("follows the clips: lengthening appends silence and keeps existing clips", () => {
    const s = withClips(newSongWithTracks(), 0, [[1, 8]]);
    expect(ops.normalizeSong(s).measures).toBe(8);
    const moved = withClips(s, 0, [[11, 2]]);
    const longer = ops.normalizeSong(moved);
    expect(longer.measures).toBe(12);
    expect(longer.tracks[1].clips).toBe(s.tracks[1].clips);
  });

  it("shortens to the end of the last remaining clip, or 1 with no clips", () => {
    let s = withClips(newSongWithTracks(), 0, [[1, 6], [9, 4]]);
    expect(ops.normalizeSong(s).measures).toBe(12);
    s = withClips(s, 0, [[1, 6]]);
    expect(ops.normalizeSong(s).measures).toBe(6);
    expect(ops.normalizeSong(withClips(s, 0, [])).measures).toBe(1);
  });

  it("returns the same song when the length is already right", () => {
    const s = ops.normalizeSong(withClips(newSongWithTracks(), 0, [[1, 4]]));
    expect(ops.normalizeSong(s)).toBe(s);
  });

  it("keeps a loop region that lies past the song's end but inside the timeline", () => {
    const s = ops.normalizeSong({
      ...withClips(newSongWithTracks(), 0, [[1, 4]]),
      loop_region: { region: { start_measure: 3, end_measure: 12 }, enabled: true },
    });
    expect(s.loop_region?.region).toEqual({ start_measure: 3, end_measure: 12 });
  });

  it("clamps a loop region to the timeline when the song shrinks", () => {
    const s = ops.normalizeSong({
      ...withClips(newSongWithTracks(), 0, [[1, 4]]),
      loop_region: { region: { start_measure: 20, end_measure: 30 }, enabled: true },
    });
    expect(s.loop_region?.region).toEqual({ start_measure: 16, end_measure: 16 });
  });

  it("gives the timeline 8 spare measures, at least 16 in total, at most 128", () => {
    expect(ops.timelineMeasures({ measures: 1 })).toBe(16);
    expect(ops.timelineMeasures({ measures: 8 })).toBe(16);
    expect(ops.timelineMeasures({ measures: 20 })).toBe(28);
    expect(ops.timelineMeasures({ measures: 125 })).toBe(128);
  });

  it("has a default key of C major when the song has none", () => {
    expect(newSongWithTracks().key).toEqual({ tonic: "C", mode: "major" });
    const { key: _key, ...old } = newSongWithTracks();
    void _key;
    expect(ops.songKey(old)).toEqual({ tonic: "C", mode: "major" });
  });

  it("clamps tempo and swing and no-ops on equal values", () => {
    const s = newSongWithTracks();
    expect(ops.setTempo(s, 1000).tempo_bpm).toBe(240);
    expect(ops.setTempo(s, 120)).toBe(s);
    expect(ops.setSwing(s, 2).swing).toBe(0.75);
    expect(ops.setSwing(s, 0)).toBe(s);
  });

  it("renames the song", () => {
    const s = newSongWithTracks();
    expect(ops.renameSong(s, " Demo ").name).toBe("Demo");
    expect(ops.renameSong(s, "")).toBe(s);
  });
});

describe("mixer", () => {
  const three = () => {
    let s = newSongWithTracks();
    s = ops.addTrack(s, { id: "bass", name: "Bass" });
    return s;
  };

  it("clamps volume and pan", () => {
    const s = newSongWithTracks();
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
    let s = ops.addTrack({ ...newSongWithTracks(), tracks: [] }, piano);
    expect(s.tracks.map((t) => t.name)).toEqual(["Piano"]);
    s = ops.addTrack(s, piano);
    s = ops.addTrack(s, piano);
    expect(s.tracks.map((t) => t.name)).toEqual(["Piano", "Piano 2", "Piano 3"]);
    s = { ...s, tracks: s.tracks.filter((t) => t.name !== "Piano 2") };
    expect(ops.addTrack(s, piano).tracks.at(-1)?.name).toBe("Piano 2");
  });

  it("keeps an explicit name as given", () => {
    const s = ops.addTrack(newSongWithTracks(), { id: "piano", name: "Piano" }, "Lead");
    expect(s.tracks.at(-1)?.name).toBe("Lead");
  });
});

describe("addTrackFromPattern", () => {
  const pattern = patternWith([note("kick", 0), note("snare", 4)], { measures: 4 });

  it("adds a track named after the pattern with its notes", () => {
    const s = ops.addTrackFromPattern(newSongWithTracks(), pattern);
    const t = s.tracks[s.tracks.length - 1];
    expect(t).toMatchObject({ name: "Boom Bap", instrument: drums.id });
    expect(t.loops).toMatchObject([{ name: "Boom Bap", measures: 4, notes: pattern.notes }]);
    expect(t.clips).toMatchObject([{ loop_id: t.loops[0].id, start_measure: 1, measures: 4 }]);
    expect(s.measures).toBe(4);
  });

  it("lengthens the song when the pattern is longer, leaving other tracks empty there", () => {
    const long = { ...pattern, measures: 16 as const };
    const base = withClips(newSongWithTracks(), 0, [[1, 8]]);
    const s = ops.addTrackFromPattern(base, long);
    expect(s.measures).toBe(16);
    expect(s.tracks[0].clips).toBe(base.tracks[0].clips);
    expect(s.tracks[1].clips).toEqual([]);
    expect(s.tracks[2].clips).toMatchObject([{ start_measure: 1, measures: 16 }]);
  });

  it("places a short pattern as a short clip in a longer song", () => {
    const base = withClips(newSongWithTracks(), 0, [[1, 16]]);
    const s = ops.addTrackFromPattern(base, { ...pattern, measures: 4 });
    expect(s.measures).toBe(16);
    expect(s.tracks[2].clips).toMatchObject([{ start_measure: 1, measures: 4 }]);
  });

  it("refuses at 16 tracks or a mismatched meter", () => {
    let s = newSongWithTracks();
    while (s.tracks.length < 16) s = ops.addTrackFromPattern(s, pattern);
    expect(ops.addTrackFromPattern(s, pattern)).toBe(s);
    const waltz = newSongWithTracks("3/4");
    expect(ops.addTrackFromPattern(waltz, pattern)).toBe(waltz);
  });
});

describe("time signature", () => {
  const loopSong = (notes: ReturnType<typeof note>[], spm = 16) => {
    const s = withClips(newSongWithTracks(spm === 16 ? "4/4" : "3/4"), 0, [[1, 2]]);
    s.tracks[0].loops[0].notes = notes;
    return s;
  };

  it("4/4 to 3/4 keeps beats in their bars and removes what no longer fits", () => {
    const s = loopSong([note("kick", 16), note("kick", 20), note("kick", 28)]);
    expect(ops.countTimeSignatureLosses(s, "3/4")).toBe(1);
    const next = ops.setTimeSignature(s, "3/4");
    expect(next.time_signature).toBe("3/4");
    expect(next.steps_per_measure).toBe(12);
    expect(next.tracks[0].loops[0].notes.map((n) => n.step)).toEqual([12, 16]);
    expect(next.tempo_bpm).toBe(s.tempo_bpm);
    expect(next.tracks[0].clips).toBe(s.tracks[0].clips);
    expect(next.tracks[0].loops[0].measures).toBe(2);
  });

  it("keeps a sustain that crosses a barline", () => {
    const s = loopSong([note("kick", 8, 8)]);
    expect(ops.setTimeSignature(s, "3/4").tracks[0].loops[0].notes).toEqual([note("kick", 8, 8)]);
  });

  it("keeps a 2-bar note's length in 4/4, clamped only by the loop end", () => {
    const s = loopSong([note("kick", 0, 24)], 12);
    expect(ops.setTimeSignature(s, "4/4").tracks[0].loops[0].notes).toEqual([note("kick", 0, 24)]);
    const long = loopSong([note("kick", 12, 24)], 12);
    // The loop is 2 measures, so 4/4 ends at step 32 and the note starting at 16 can run 16 steps.
    expect(ops.setTimeSignature(long, "4/4").tracks[0].loops[0].notes).toEqual([note("kick", 16, 16)]);
  });

  it("leaves a 3/4 note at offset 10 with length 4 unchanged in 6/8", () => {
    const s = loopSong([note("kick", 10, 4)], 12);
    expect(ops.setTimeSignature(s, "6/8").tracks[0].loops[0].notes).toEqual([note("kick", 10, 4)]);
  });

  it("clamps a long note to the next note in its row after conversion", () => {
    const s = loopSong([note("kick", 8, 16), note("kick", 20), note("snare", 10, 4)]);
    const notes = ops.setTimeSignature(s, "3/4").tracks[0].loops[0].notes;
    expect(notes).toContainEqual(note("kick", 8, 8));
    expect(notes).toContainEqual(note("snare", 10, 4));
  });

  it("lengthening the measure loses nothing and leaves the last beat empty", () => {
    const s = loopSong([note("kick", 0), note("kick", 12), note("kick", 20)], 12);
    expect(ops.countTimeSignatureLosses(s, "4/4")).toBe(0);
    const next = ops.setTimeSignature(s, "4/4");
    expect(next.tracks[0].loops[0].notes.map((n) => n.step)).toEqual([0, 16, 24]);
  });

  it("converts 3/4 and 6/8 losslessly", () => {
    const s = loopSong([note("kick", 0), note("kick", 11), note("kick", 12, 12)], 12);
    expect(ops.countTimeSignatureLosses(s, "6/8")).toBe(0);
    const next = ops.setTimeSignature(s, "6/8");
    expect(next.steps_per_measure).toBe(12);
    expect(next.tracks[0].loops[0].notes).toEqual(s.tracks[0].loops[0].notes);
    expect(ops.setTimeSignature(next, "3/4").tracks[0].loops[0].notes).toEqual(s.tracks[0].loops[0].notes);
  });

  it("is a no-op for the same signature", () => {
    const s = newSongWithTracks();
    expect(ops.setTimeSignature(s, "4/4")).toBe(s);
  });
});

describe("key", () => {
  it("changes only the key", () => {
    const s = withClips(newSongWithTracks(), 0, [[1, 2]]);
    const next = ops.setKey(s, { tonic: "E", mode: "minor" });
    expect(next.key).toEqual({ tonic: "E", mode: "minor" });
    expect(next.tracks).toBe(s.tracks);
    expect(ops.setKey(next, { tonic: "E", mode: "minor" })).toBe(next);
  });
});

describe("track sound", () => {
  const song = () => newSongWithTracks();
  const id = (s: Song) => s.tracks[1].id;

  it("merges nested patches and keeps untouched and unknown fields", () => {
    const s0 = song();
    const seeded = {
      ...s0,
      tracks: s0.tracks.map((t, i) =>
        i === 1 ? { ...t, sound: { tone: { filter_cutoff_hz: 400, future: 1 } } as never } : t,
      ),
    };
    const s1 = ops.setSound(seeded, id(seeded), {
      tone: { filter_resonance: 0.5 },
      effects: { delay: { enabled: true, time: "1/4" } },
    });
    expect(s1.tracks[1].sound).toEqual({
      tone: { filter_cutoff_hz: 400, filter_resonance: 0.5, future: 1 },
      effects: { delay: { enabled: true, time: "1/4" } },
    });
    const s2 = ops.setSound(s1, id(s1), { effects: { delay: { feedback: 0.5 } } });
    expect(s2.tracks[1].sound?.effects?.delay).toEqual({ enabled: true, time: "1/4", feedback: 0.5 });
  });

  it("deletes a field with null and prunes the empty objects left behind", () => {
    const s0 = song();
    const s1 = ops.setSound(s0, id(s0), { tone: { filter_cutoff_hz: 300 } });
    expect(s1.tracks[1].sound).toBeDefined();
    const t = s1.tracks[1];
    const s2 = ops.setSound(s1, t.id, { tone: { filter_cutoff_hz: null } });
    expect("sound" in s2.tracks[1]).toBe(false);
    const s3 = ops.setSound(s1, t.id, { tone: null });
    expect("sound" in s3.tracks[1]).toBe(false);
  });

  it("keeps sibling fields when one is deleted", () => {
    const s0 = song();
    const s1 = ops.setSound(s0, id(s0), { tone: { filter_cutoff_hz: 300, sustain: 0.5 } });
    const s2 = ops.setSound(s1, s1.tracks[1].id, { tone: { sustain: null } });
    expect(s2.tracks[1].sound).toEqual({ tone: { filter_cutoff_hz: 300 } });
  });

  it("returns the same song when nothing changes", () => {
    const s0 = song();
    expect(ops.setSound(s0, id(s0), {})).toBe(s0);
    expect(ops.setSound(s0, id(s0), { tone: { filter_cutoff_hz: null } })).toBe(s0);
    expect(ops.setSound(s0, "missing", { tone: { sustain: 1 } })).toBe(s0);
    const s1 = ops.setSound(s0, id(s0), { effects: { reverb: { mix: 0.4 } } });
    expect(ops.setSound(s1, id(s1), { effects: { reverb: { mix: 0.4 } } })).toBe(s1);
  });

  it("resets by deleting the sound, and is a no-op when there is none", () => {
    const s0 = song();
    expect(ops.resetSound(s0, id(s0))).toBe(s0);
    const s1 = ops.setSound(s0, id(s0), { effects: { reverb: { enabled: true } } });
    const s2 = ops.resetSound(s1, id(s1));
    expect("sound" in s2.tracks[1]).toBe(false);
  });

  it("ignores tone fields that do not apply to the track's instrument", () => {
    const s0 = song();
    const [drumsTrack, piano] = s0.tracks;
    expect(ops.setSound(s0, drumsTrack.id, { tone: { attack_s: 0.5, sustain: 0.2 } })).toBe(s0);
    expect(ops.setSound(s0, piano.id, { tone: { pitch_semitones: 3 } })).toBe(s0);
    const mixed = ops.setSound(s0, drumsTrack.id, { tone: { attack_s: 0.5, pitch_semitones: 3 } });
    expect(mixed.tracks[0].sound).toEqual({ tone: { pitch_semitones: 3 } });
  });

  it("treats a stored null sound as absent and keeps the same song on a no-op", () => {
    const s0 = song();
    const nulled = { ...s0, tracks: s0.tracks.map((t, i) => (i === 1 ? { ...t, sound: null as never } : t)) };
    expect(ops.setSound(nulled, id(nulled), {})).toBe(nulled);
    expect(ops.setSound(nulled, id(nulled), { tone: { filter_cutoff_hz: null } })).toBe(nulled);
    expect(ops.setSound(nulled, id(nulled), { tone: { filter_cutoff_hz: 300 } }).tracks[1].sound).toEqual({
      tone: { filter_cutoff_hz: 300 },
    });
  });
});

describe("moveTrack", () => {
  const three = () => ops.addTrack(newSongWithTracks(), { id: "bass", name: "Bass" });
  const names = (s: Song) => s.tracks.map((t) => t.name);

  it("moves a track up and down, keeping the others in order", () => {
    const s = three();
    expect(names(ops.moveTrack(s, s.tracks[2].id, 1))).toEqual(["Drums", "Bass", "Piano"]);
    expect(names(ops.moveTrack(s, s.tracks[0].id, 1))).toEqual(["Piano", "Drums", "Bass"]);
  });

  it("moves to the first and last positions and clamps out-of-range targets", () => {
    const s = three();
    expect(names(ops.moveTrack(s, s.tracks[2].id, 0))).toEqual(["Bass", "Drums", "Piano"]);
    expect(names(ops.moveTrack(s, s.tracks[0].id, 2))).toEqual(["Piano", "Bass", "Drums"]);
    expect(names(ops.moveTrack(s, s.tracks[2].id, -5))).toEqual(["Bass", "Drums", "Piano"]);
    expect(names(ops.moveTrack(s, s.tracks[0].id, 99))).toEqual(["Piano", "Bass", "Drums"]);
  });

  it("returns the same song for a no-op, a clamped no-op, or an unknown id", () => {
    const s = three();
    expect(ops.moveTrack(s, s.tracks[1].id, 1)).toBe(s);
    expect(ops.moveTrack(s, s.tracks[2].id, 99)).toBe(s);
    expect(ops.moveTrack(s, "missing", 0)).toBe(s);
  });
});
