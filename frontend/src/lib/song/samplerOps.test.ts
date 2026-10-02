import { describe, expect, it } from "vitest";
import type { Sample } from "@/generated/Sample";
import { parseProjectFile, serializeProject } from "./projectFile";
import { BUILT_IN_IDS, noteName, withBuiltIns } from "./sampler";
import {
  addSamplerTrack,
  assignPad,
  assignPads,
  chooseKeysSample,
  clearKeysSample,
  clearPad,
  setOneShot,
  setPadGain,
  setPadPitch,
  setRootNote,
} from "./samplerOps";
import { setSound } from "./songOps";
import { createSongStore } from "./songStore";
import { newSongWithTracks } from "./testFixtures";
import { MAX_TRACKS, newSong, newTrack, type Song } from "./types";

const sample = (id: string, name = id): Sample => ({
  id,
  name,
  sample_rate: 48000,
  channels: 1,
  length_samples: 48000,
  origin: "import",
});

const song = () => newSongWithTracks();
const withKeys = () => {
  const added = addSamplerTrack(song(), "keys")!;
  return { song: added.song, id: added.trackId };
};
const withPads = () => {
  const added = addSamplerTrack(song(), "pads")!;
  return { song: added.song, id: added.trackId };
};
const track = (s: Song, id: string) => s.tracks.find((t) => t.id === id)!;

describe("sampler built-ins", () => {
  it("lists keys C7 down to C1 and sixteen pad rows", () => {
    const [keys, pads] = withBuiltIns([]);
    expect(keys.rows).toHaveLength(73);
    expect(keys.rows[0]).toEqual({ id: "C7", name: "C7", midi_note: 96 });
    expect(keys.rows.at(-1)).toEqual({ id: "C1", name: "C1", midi_note: 24 });
    expect(pads.rows.map((r) => r.name).slice(0, 2)).toEqual(["Pad 1", "Pad 2"]);
    expect(pads.rows[15]).toEqual({ id: "pad-16", name: "Pad 16", midi_note: 51 });
    expect(BUILT_IN_IDS.has("sampler-pads")).toBe(true);
  });

  it("names notes like the rows do", () => {
    expect([noteName(60), noteName(61), noteName(0), noteName(127)]).toEqual(["C4", "C#4", "C-1", "G9"]);
  });
});

describe("addSamplerTrack", () => {
  it("adds a Sampler or Pads track with one empty loop and a clip at measure 1", () => {
    const keys = addSamplerTrack(song(), "keys")!;
    const t = track(keys.song, keys.trackId);
    expect(t).toMatchObject({ name: "Sampler", instrument: "sampler-keys" });
    expect(t.loops).toHaveLength(1);
    expect(t.loops[0].notes).toEqual([]);
    expect(t.clips).toEqual([{ id: keys.clipId, loop_id: t.loops[0].id, start_measure: 1, measures: 1 }]);
    expect(addSamplerTrack(song(), "pads")!.song.tracks.at(-1)!.name).toBe("Pads");
  });

  it("numbers repeats", () => {
    const first = addSamplerTrack(song(), "pads")!;
    const second = addSamplerTrack(first.song, "pads")!;
    expect(second.song.tracks.at(-1)!.name).toBe("Pads 2");
  });

  it("counts toward the track limit", () => {
    const full: Song = { ...song(), tracks: Array.from({ length: MAX_TRACKS }, (_, i) => newTrack("piano", `T${i}`)) };
    expect(addSamplerTrack(full, "keys")).toBeNull();
  });

  it("is one undo step and selects the new track and clip", () => {
    const store = createSongStore(song());
    const added = store.getState().addSamplerTrack("pads")!;
    expect(store.getState().past).toHaveLength(1);
    expect(store.getState()).toMatchObject({ selectedTrackId: added.trackId, selectedClipId: added.clipId });
    store.getState().undo();
    expect(store.getState().song!.tracks).toHaveLength(2);
  });

  it("passes the shared validator once a sample is chosen", () => {
    const added = addSamplerTrack(newSong(), "keys")!;
    const chosen = chooseKeysSample(added.song, added.trackId, sample("s1")).song!;
    expect(parseProjectFile(serializeProject(chosen), [])).toHaveProperty("ok");
  });
});

describe("keys ops", () => {
  it("chooses a sample, records it in the song, and keeps root and one-shot", () => {
    const { song: s, id } = withKeys();
    const rooted = setOneShot(setRootNote(s, id, 52).song!, id, true).song!;
    const next = chooseKeysSample(rooted, id, sample("s1")).song!;
    expect(track(next, id).sampler).toEqual({ keys: { sample_id: "s1", root_note: 52, one_shot: true } });
    expect(next.samples).toEqual([sample("s1")]);
  });

  it("does not duplicate a known sample in the song", () => {
    const { song: s, id } = withKeys();
    const once = chooseKeysSample(s, id, sample("s1")).song!;
    const again = chooseKeysSample(once, id, sample("s1")).song!;
    expect(again).toBe(once);
    expect(chooseKeysSample(clearKeysSample(once, id).song!, id, sample("s1")).song!.samples).toHaveLength(1);
  });

  it("clearing keeps the other settings and returns to no field when all are default", () => {
    const { song: s, id } = withKeys();
    const chosen = chooseKeysSample(setRootNote(s, id, 48).song!, id, sample("s1")).song!;
    expect(track(clearKeysSample(chosen, id).song!, id).sampler).toEqual({
      keys: { sample_id: null, root_note: 48, one_shot: false },
    });
    const plain = clearKeysSample(chooseKeysSample(s, id, sample("s1")).song!, id).song!;
    expect(track(plain, id).sampler).toBeUndefined();
  });

  it("clamps the root note and refuses the wrong track kind", () => {
    const { song: s, id } = withKeys();
    expect(track(setRootNote(s, id, 400).song!, id).sampler?.keys?.root_note).toBe(127);
    const pads = withPads();
    expect(setRootNote(pads.song, pads.id, 60)).toEqual({ song: null, reason: "wrong-kind" });
    expect(chooseKeysSample(s, "missing", sample("s1"))).toEqual({ song: null, reason: "not-found" });
  });
});

describe("pad ops", () => {
  it("assigns a sample to a pad and adds it to the song", () => {
    const { song: s, id } = withPads();
    const next = assignPad(s, id, "pad-1", sample("kick")).song!;
    expect(track(next, id).sampler?.pads).toEqual([
      { row_id: "pad-1", sample_id: "kick", gain_db: 0, pitch_semitones: 0 },
    ]);
    expect(next.samples).toEqual([sample("kick")]);
  });

  it("keeps a replaced pad's gain and pitch", () => {
    const { song: s, id } = withPads();
    const tuned = setPadPitch(setPadGain(assignPad(s, id, "pad-2", sample("a")).song!, id, "pad-2", -6).song!, id, "pad-2", 3).song!;
    const replaced = assignPad(tuned, id, "pad-2", sample("b")).song!;
    expect(track(replaced, id).sampler?.pads).toEqual([{ row_id: "pad-2", sample_id: "b", gain_db: -6, pitch_semitones: 3 }]);
  });

  it("assigns several files in order from a pad down and stops at pad-16", () => {
    const { song: s, id } = withPads();
    const result = assignPads(s, id, "pad-15", [sample("a"), sample("b"), sample("c")]);
    expect(result.song).not.toBeNull();
    if (!result.song) return;
    expect(result.assigned.map((a) => [a.rowId, a.sample.id])).toEqual([
      ["pad-15", "a"],
      ["pad-16", "b"],
    ]);
    expect(track(result.song, id).sampler?.pads?.map((p) => p.row_id)).toEqual(["pad-15", "pad-16"]);
  });

  it("keeps pads in row order whatever order they were assigned in", () => {
    const { song: s, id } = withPads();
    const next = assignPad(assignPad(s, id, "pad-9", sample("a")).song!, id, "pad-3", sample("b")).song!;
    expect(track(next, id).sampler?.pads?.map((p) => p.row_id)).toEqual(["pad-3", "pad-9"]);
  });

  it("clamps gain and pitch and ignores an empty pad", () => {
    const { song: s, id } = withPads();
    const assigned = assignPad(s, id, "pad-1", sample("a")).song!;
    const loud = setPadPitch(setPadGain(assigned, id, "pad-1", 99).song!, id, "pad-1", -99.4).song!;
    expect(track(loud, id).sampler?.pads?.[0]).toMatchObject({ gain_db: 12, pitch_semitones: -24 });
    expect(setPadGain(assigned, id, "pad-5", 3).song).toBe(assigned);
  });

  it("clearing the last pad removes the sampler field", () => {
    const { song: s, id } = withPads();
    const cleared = clearPad(assignPad(s, id, "pad-1", sample("a")).song!, id, "pad-1").song!;
    expect(track(cleared, id).sampler).toBeUndefined();
  });

  it("refuses a bad row", () => {
    const { song: s, id } = withPads();
    expect(assignPad(s, id, "C4", sample("a"))).toEqual({ song: null, reason: "not-found" });
  });
});

describe("tone knobs by sampler kind", () => {
  it("lets pads take the pitch knob and refuses envelope fields", () => {
    const { song: s, id } = withPads();
    const next = setSound(s, id, { tone: { pitch_semitones: 3, attack_s: 0.2 } });
    expect(track(next, id).sound).toEqual({ tone: { pitch_semitones: 3 } });
  });

  it("lets keys take the envelope and refuses the pitch knob", () => {
    const { song: s, id } = withKeys();
    const next = setSound(s, id, { tone: { pitch_semitones: 3, release_s: 0.2 } });
    expect(track(next, id).sound).toEqual({ tone: { release_s: 0.2 } });
  });
});
