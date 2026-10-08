import { describe, expect, it } from "vitest";
import type { Note } from "@/generated/Note";
import type { ToplineSource } from "@/generated/ToplineSource";
import { syllabifyLine } from "@/lib/topline/syllabify";
import { createSongStore } from "./songStore";
import { newSongWithTracks } from "./testFixtures";
import { MAX_TRACKS, newTrack } from "./types";

const rows = [
  { id: "C4", midi_note: 60 },
  { id: "E4", midi_note: 64 },
];
const sung = (row_id: string, step: number, lyric?: string): Note => ({
  row_id,
  step,
  length_steps: 2,
  velocity: 100,
  ...(lyric !== undefined && { lyric }),
});

const source: ToplineSource = {
  section_name: "Chorus",
  voice: "tenor",
  lines: [{ text: "hold me close", syllables: syllabifyLine("hold me close") }],
};
const chorus = { start_measure: 5, end_measure: 8 };
const notes = [sung("C4", 0, "hold"), sung("E4", 4, "me"), sung("C4", 8, "close")];

const setup = () => {
  const song = { ...newSongWithTracks(), lyrics: "[Chorus]\nhold me close\n" };
  return createSongStore(song);
};

describe("applyTopline", () => {
  it("adds a Vocal track holding the topline loop as one clip, in one undo step", () => {
    const store = setup();
    const before = store.getState().song!;
    expect(store.getState().applyTopline({ trackChoice: { kind: "new-vocal" }, range: chorus, notes, source })).toBeNull();
    const s = store.getState();
    const vocal = s.song!.tracks.at(-1)!;
    expect(vocal).toMatchObject({ name: "Vocal", instrument: "vocal" });
    expect(vocal.loops).toHaveLength(1);
    expect(vocal.loops[0]).toMatchObject({ name: "Chorus topline", measures: 4, notes, topline: source });
    expect(vocal.clips).toEqual([
      expect.objectContaining({ loop_id: vocal.loops[0].id, start_measure: 5, measures: 4 }),
    ]);
    expect(s.selectedTrackId).toBe(vocal.id);
    expect(s.selectedClipId).toBe(vocal.clips[0].id);
    expect(s.past).toHaveLength(1);
    s.undo();
    expect(store.getState().song).toEqual(before);
    expect(store.getState().song!.lyrics).toBe("[Chorus]\nhold me close\n");
  });

  it("places linked clips of the same loop on every other chorus", () => {
    const store = setup();
    const also = [
      { start_measure: 9, end_measure: 12 },
      { start_measure: 13, end_measure: 16 },
    ];
    store.getState().applyTopline({ trackChoice: { kind: "new-vocal" }, range: chorus, notes, source, alsoRanges: also });
    const vocal = store.getState().song!.tracks.at(-1)!;
    expect(vocal.loops).toHaveLength(1);
    expect(vocal.clips.map((c) => [c.start_measure, c.measures, c.loop_id])).toEqual(
      [5, 9, 13].map((start) => [start, 4, vocal.loops[0].id]),
    );
    expect(store.getState().past).toHaveLength(1);
  });

  it("writes onto an existing track", () => {
    const store = setup();
    const piano = store.getState().song!.tracks[1];
    expect(
      store.getState().applyTopline({ trackChoice: { kind: "track", trackId: piano.id }, range: chorus, notes, source }),
    ).toBeNull();
    const after = store.getState().song!;
    expect(after.tracks).toHaveLength(2);
    expect(after.tracks[1].loops[0].topline).toEqual(source);
  });

  it("truncates a long section name in the loop name to 40 characters", () => {
    const store = setup();
    const long = { ...source, section_name: "x".repeat(40) };
    store.getState().applyTopline({ trackChoice: { kind: "new-vocal" }, range: chorus, notes, source: long });
    expect(store.getState().song!.tracks.at(-1)!.loops[0].name).toHaveLength(40);
  });

  it("refuses a new Vocal track at 16 tracks and changes nothing", () => {
    const store = setup();
    const song = store.getState().song!;
    const full = { ...song, tracks: Array.from({ length: MAX_TRACKS }, (_, i) => newTrack("piano", `T${i}`)) };
    store.getState().loadSong(full);
    const message = store.getState().applyTopline({ trackChoice: { kind: "new-vocal" }, range: chorus, notes, source });
    expect(message).toMatch(/16 tracks/);
    expect(store.getState().song).toBe(full);
    expect(store.getState().past).toHaveLength(0);
  });

  it("refuses a track that no longer exists", () => {
    const store = setup();
    const message = store.getState().applyTopline({ trackChoice: { kind: "track", trackId: "gone" }, range: chorus, notes, source });
    expect(message).toMatch(/no longer/);
    expect(store.getState().past).toHaveLength(0);
  });
});

describe("reflowLyrics", () => {
  const withDrift = () => {
    const store = setup();
    store.getState().applyTopline({ trackChoice: { kind: "new-vocal" }, range: chorus, notes, source });
    const vocal = store.getState().song!.tracks.at(-1)!;
    const loop = vocal.loops[0];
    // The `me` note is gone and an unlabelled one sits between the others.
    store.getState().editLoopNotes(vocal.id, loop.id, [], () => [sung("C4", 0, "hold"), sung("E4", 4), sung("C4", 8, "close")]);
    return { store, vocal, loop };
  };

  it("restores the order in one undo step", () => {
    const { store, vocal, loop } = withDrift();
    const pastBefore = store.getState().past.length;
    expect(store.getState().reflowLyrics(vocal.id, loop.id, rows)).toEqual({ unplaced: 0 });
    const lyrics = () => store.getState().song!.tracks.at(-1)!.loops[0].notes.map((n) => n.lyric);
    expect(lyrics()).toEqual(["hold", "me", "close"]);
    expect(store.getState().past).toHaveLength(pastBefore + 1);
    store.getState().undo();
    expect(lyrics()).toEqual(["hold", undefined, "close"]);
  });

  it("reports unplaced syllables and spends no undo step when nothing changes", () => {
    const { store, vocal, loop } = withDrift();
    store.getState().reflowLyrics(vocal.id, loop.id, rows);
    const pastBefore = store.getState().past.length;
    store.getState().editLoopNotes(vocal.id, loop.id, [], (g) => g.notes.slice(0, 2));
    const afterEdit = store.getState().past.length;
    expect(afterEdit).toBe(pastBefore + 1);
    expect(store.getState().reflowLyrics(vocal.id, loop.id, rows)).toEqual({ unplaced: 1 });
    expect(store.getState().reflowLyrics(vocal.id, loop.id, rows)).toEqual({ unplaced: 1 });
    expect(store.getState().past).toHaveLength(afterEdit);
  });

  it("does nothing for a loop without a topline source", () => {
    const store = setup();
    store.getState().newClip(store.getState().song!.tracks[1].id, 1);
    const track = store.getState().song!.tracks[1];
    expect(store.getState().reflowLyrics(track.id, track.loops[0].id, rows)).toBeNull();
  });
});
