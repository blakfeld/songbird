import { describe, expect, it } from "vitest";
import { note } from "@/test/fixtures";
import { createSongStore } from "../song/songStore";
import { normalizeSong } from "../song/songOps";
import { MAX_CLIPS, newSong, type Clip } from "../song/types";
import { createSongTake } from "./songTake";

const SPM = 16;

function setup(clipList: Clip[] = [], measures = 8, loopNotes = [note("kick", 0)]) {
  const base = newSong();
  const store = createSongStore(
    normalizeSong({
      ...base,
      tracks: [
        {
          ...base.tracks[0],
          id: "t0",
          loops: [{ id: "a", name: "A", measures, notes: loopNotes }],
          clips: clipList.length ? clipList : [{ id: "c", loop_id: "a", start_measure: 1, measures }],
        },
        { ...base.tracks[1], id: "t1" },
      ],
    }),
  );
  return store;
}
const song = (s: ReturnType<typeof setup>) => s.getState().song!;

describe("song take", () => {
  it("undoes a take that created a clip and edited an existing loop in one step", () => {
    const store = setup();
    const before = song(store);
    const take = createSongTake(store, "t0");
    take.begin();
    take.add(note("kick", 2 * SPM));
    take.add(note("kick", 10 * SPM));
    expect(song(store).tracks[0].clips).toHaveLength(2);
    take.end();
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(song(store)).toEqual(before);
  });

  it("restores the song length with one undo after recording past the end", () => {
    const store = setup();
    const take = createSongTake(store, "t0");
    take.begin();
    take.add(note("kick", 9 * SPM));
    take.end();
    expect(song(store).measures).toBe(10);
    store.getState().undo();
    expect(song(store).measures).toBe(8);
    expect(song(store).tracks[0].clips).toHaveLength(1);
  });

  it("undoing mid-take ends the take and then undoes it", () => {
    const store = setup();
    const take = createSongTake(store, "t0");
    take.begin();
    take.add(note("kick", 9 * SPM));
    store.getState().undo();
    expect(song(store).tracks[0].clips).toHaveLength(1);
  });

  it("reports notes dropped at the clip limit", () => {
    const many: Clip[] = Array.from({ length: MAX_CLIPS }, (_, i) => ({
      id: `c${i}`,
      loop_id: "a",
      start_measure: 1,
      measures: 1,
    }));
    const store = setup(many, 1);
    const take = createSongTake(store, "t0");
    take.begin();
    take.add(note("kick", 4 * SPM));
    take.add(note("kick", 4 * SPM + 8));
    take.add(note("kick", 0));
    const summary = take.end();
    expect(summary.dropped).toEqual({ "clip-limit": 2 });
    expect(summary.recorded).toBe(1);
  });

  it("stays on the original track when another is selected mid-take", () => {
    const store = setup();
    const take = createSongTake(store, "t0");
    take.begin();
    take.add(note("kick", 9 * SPM));
    store.getState().selectTrack("t1");
    take.add(note("kick", 12 * SPM));
    take.end();
    expect(song(store).tracks[0].clips).toHaveLength(2);
    expect(song(store).tracks[1].clips).toHaveLength(0);
  });

  it("starts a new gesture when an edit committed the take's gesture", () => {
    const store = setup();
    const take = createSongTake(store, "t0");
    take.begin();
    take.add(note("kick", 9 * SPM));
    store.getState().setTempo(100);
    expect(store.getState().gestureBase).toBeNull();
    take.add(note("kick", 12 * SPM));
    expect(store.getState().gestureBase).not.toBeNull();
    take.end();
    expect(store.getState().past).toHaveLength(2);
    expect(song(store).tracks[0].clips.filter((c) => c.id !== "c")).toHaveLength(1);
  });

  it("re-bases when a drag's gesture replaced the cleared one, instead of replaying on a stale base", () => {
    const store = setup();
    const take = createSongTake(store, "t0");
    take.begin();
    take.add(note("kick", 9 * SPM));
    store.getState().setTempo(100);
    store.getState().beginGesture();
    take.add(note("kick", 12 * SPM));
    take.end();
    expect(song(store).tempo_bpm).toBe(100);
    expect(song(store).tracks[0].clips.filter((c) => c.id !== "c")).toHaveLength(1);
  });

  it("discards a take without history", () => {
    const store = setup();
    const before = song(store);
    const take = createSongTake(store, "t0");
    take.begin();
    take.add(note("kick", 9 * SPM));
    take.discard();
    expect(song(store)).toEqual(before);
    expect(store.getState().past).toHaveLength(0);
  });
});
