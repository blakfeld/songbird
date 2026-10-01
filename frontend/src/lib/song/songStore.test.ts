import { describe, expect, it } from "vitest";
import { drums, note } from "@/test/fixtures";
import { createSongStore } from "./songStore";
import { normalizeSong } from "./songOps";
import { newSong } from "./types";

const setup = () => createSongStore(newSong());

// A stored length only exists because clips cover it, so region tests need a real clip to stand on.
const setupWithClip = (measures: number) => {
  const base = newSong();
  const [track, ...rest] = base.tracks;
  return createSongStore(
    normalizeSong({
      ...base,
      tracks: [
        {
          ...track,
          id: "t0",
          loops: [{ id: "l", name: "Loop", measures, notes: [] }],
          clips: [{ id: "c", loop_id: "l", start_measure: 1, measures }],
        },
        ...rest,
      ],
    }),
  );
};

describe("songStore history", () => {
  it("undoes a track deletion with notes and mixer settings", () => {
    const store = setup();
    const bass = (store.getState().addTrack({ id: "bass", name: "Bass" }),
    store.getState().song!.tracks[2]);
    store.getState().newClip(bass.id, 1);
    const loopId = store.getState().song!.tracks[2].loops[0].id;
    store.getState().editLoopNotes(bass.id, loopId, drums.rows, (g) => [...g.notes, note("kick", 0)]);
    store.getState().setMixer(bass.id, { volume_db: -6, pan: 0.5 });
    const before = store.getState().song!.tracks[2];
    store.getState().deleteTrack(bass.id);
    expect(store.getState().song!.tracks).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().song!.tracks[2]).toEqual(before);
    expect(before.loops[0].notes).toHaveLength(1);
    store.getState().redo();
    expect(store.getState().song!.tracks).toHaveLength(2);
  });

  it("records one undo step for a whole drag", () => {
    const store = setup();
    const id = store.getState().song!.tracks[0].id;
    store.getState().beginGesture();
    for (const v of [-2, -5, -10]) store.getState().setMixer(id, { volume_db: v }, { transient: true });
    store.getState().endGesture();
    expect(store.getState().song!.tracks[0].volume_db).toBe(-10);
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().song!.tracks[0].volume_db).toBe(0);
  });

  it("does not record selection or no-op edits", () => {
    const store = setup();
    const [a, b] = store.getState().song!.tracks;
    store.getState().selectTrack(b.id);
    store.getState().selectTrack(a.id);
    store.getState().setTempo(120);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().selectedTrackId).toBe(a.id);
  });

  it("caps history at 100 entries and clears redo on a new edit", () => {
    const store = setup();
    for (let i = 0; i < 120; i++) store.getState().setTempo(41 + i);
    expect(store.getState().past).toHaveLength(100);
    store.getState().undo();
    expect(store.getState().future).toHaveLength(1);
    store.getState().setTempo(200);
    expect(store.getState().future).toHaveLength(0);
  });

  it("falls back to a valid selection when the selected track is deleted", () => {
    const store = setup();
    const [a, b] = store.getState().song!.tracks;
    store.getState().selectTrack(b.id);
    store.getState().deleteTrack(b.id);
    expect(store.getState().selectedTrackId).toBe(a.id);
  });
});

describe("songStore clips", () => {
  // Two 2-measure clips of one loop on the first track, at measures 1 and 5.
  const withClips = () => {
    const store = setup();
    const trackId = store.getState().song!.tracks[0].id;
    store.getState().newClip(trackId, 1);
    const loopId = store.getState().song!.tracks[0].loops[0].id;
    store.getState().resizeClip(trackId, store.getState().song!.tracks[0].clips[0].id, 2);
    store.getState().placeLoop(trackId, loopId, 5, 2);
    store.getState().editLoopNotes(trackId, loopId, drums.rows, (g) => [...g.notes, note("kick", 0)]);
    return { store, trackId, loopId };
  };
  const clipsOf = (store: ReturnType<typeof setup>) => store.getState().song!.tracks[0].clips;

  it("selects a new clip and its track, and reports refusals", () => {
    const store = setup();
    const [a, b] = store.getState().song!.tracks;
    expect(store.getState().newClip(b.id, 1)).toBeNull();
    expect(store.getState().selectedTrackId).toBe(b.id);
    expect(store.getState().selectedClipId).toBe(store.getState().song!.tracks[1].clips[0].id);
    expect(store.getState().newClip(b.id, 1)).toBe("no-room");
    expect(store.getState().past).toHaveLength(1);
    expect(a.clips).toEqual([]);
  });

  it("leaves history alone when a clip is selected", () => {
    const { store } = withClips();
    const past = store.getState().past;
    store.getState().selectClip(clipsOf(store)[1].id);
    expect(store.getState().past).toBe(past);
    expect(store.getState().selectedClipId).toBe(clipsOf(store)[1].id);
    store.getState().selectClip(null);
    expect(store.getState().past).toBe(past);
  });

  it("selecting a track header picks its earliest clip, or none", () => {
    const { store, trackId } = withClips();
    const other = store.getState().song!.tracks[1].id;
    store.getState().selectTrack(other);
    expect(store.getState().selectedClipId).toBeNull();
    store.getState().selectTrack(trackId);
    expect(store.getState().selectedClipId).toBe(clipsOf(store)[0].id);
  });

  it("drops a selected clip that an undo removes", () => {
    const { store, trackId } = withClips();
    store.getState().duplicateClip(trackId, clipsOf(store)[0].id);
    expect(store.getState().selectedClipId).toBe(clipsOf(store)[1].id);
    store.getState().undo();
    expect(store.getState().selectedClipId).toBeNull();
    expect(store.getState().selectedTrackId).toBe(trackId);
  });

  it("undoes a whole drag of a clip as one step", () => {
    const { store, trackId } = withClips();
    const id = clipsOf(store)[0].id;
    const before = store.getState().past.length;
    store.getState().beginGesture();
    for (const to of [2, 3, 4]) store.getState().moveClip(trackId, id, to, { transient: true });
    store.getState().endGesture();
    expect(clipsOf(store)[0].start_measure).toBe(3);
    expect(store.getState().past).toHaveLength(before + 1);
    store.getState().undo();
    expect(clipsOf(store)[0].start_measure).toBe(1);
  });

  it("restores the pre-drag song on cancel without an undo entry", () => {
    const { store, trackId } = withClips();
    const id = clipsOf(store)[0].id;
    const before = store.getState().song;
    const past = store.getState().past;
    store.getState().beginGesture();
    store.getState().moveClip(trackId, id, 3, { transient: true });
    store.getState().cancelGesture();
    expect(store.getState().song).toBe(before);
    expect(store.getState().past).toBe(past);
    expect(store.getState().gestureBase).toBeNull();
  });

  it("keeps redo when a drag is cancelled", () => {
    const { store, trackId } = withClips();
    const id = clipsOf(store)[0].id;
    store.getState().deleteClip(trackId, clipsOf(store)[1].id);
    store.getState().undo();
    const future = store.getState().future;
    expect(future).toHaveLength(1);
    store.getState().beginGesture();
    store.getState().moveClip(trackId, id, 3, { transient: true });
    expect(store.getState().future).toHaveLength(0);
    store.getState().cancelGesture();
    expect(store.getState().future).toBe(future);
  });

  it("undoes make unique", () => {
    const { store, trackId } = withClips();
    const id = clipsOf(store)[1].id;
    const original = store.getState().song!;
    expect(store.getState().makeUnique(trackId, id)).toBeNull();
    expect(store.getState().song!.tracks[0].loops).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().song).toEqual(original);
  });

  it("restores a deleted loop and all its clips with one undo", () => {
    const { store, trackId, loopId } = withClips();
    const original = store.getState().song!;
    store.getState().deleteLoop(trackId, loopId);
    expect(clipsOf(store)).toEqual([]);
    store.getState().undo();
    expect(store.getState().song).toEqual(original);
    expect(clipsOf(store)).toHaveLength(2);
  });

  it("edits a loop's notes for every clip that uses it", () => {
    const { store, loopId } = withClips();
    const loop = store.getState().song!.tracks[0].loops.find((l) => l.id === loopId)!;
    expect(loop.notes).toEqual([note("kick", 0)]);
    expect(clipsOf(store).every((c) => c.loop_id === loopId)).toBe(true);
  });
});


describe("songStore loop region", () => {
  const stored = (store: ReturnType<typeof setup>) => store.getState().song!.loop_region;
  const R = (start: number, end: number, enabled = true) => ({
    region: { start, end },
    enabled,
  });
  const S = (start: number, end: number, enabled = true) => ({
    region: { start_measure: start, end_measure: end },
    enabled,
  });

  it("starts with no region and looping off", () => {
    expect(stored(setup())).toBeUndefined();
  });

  it("is not an undo step", () => {
    const store = setupWithClip(8);
    store.getState().setLoop(R(3, 4, false));
    expect(store.getState().past).toHaveLength(0);
    expect(stored(store)).toEqual(S(3, 4, false));
  });

  it("is left alone by undo and redo of another edit", () => {
    const store = setupWithClip(8);
    store.getState().setTempo(100);
    store.getState().setLoop(R(3, 4, false));
    store.getState().undo();
    expect(store.getState().song!.tempo_bpm).toBe(120);
    expect(stored(store)).toEqual(S(3, 4, false));
    store.getState().redo();
    expect(store.getState().song!.tempo_bpm).toBe(100);
    expect(stored(store)).toEqual(S(3, 4, false));
  });

  it("keeps looping on with no region across undo and redo", () => {
    const store = setup();
    store.getState().setTempo(100);
    store.getState().setLoop({ region: null, enabled: true });
    store.getState().undo();
    expect(stored(store)).toEqual({ region: null, enabled: true });
    store.getState().redo();
    expect(stored(store)).toEqual({ region: null, enabled: true });
  });

  it("is left alone by a cancelled gesture", () => {
    const store = setupWithClip(8);
    const id = store.getState().song!.tracks[0].id;
    store.getState().beginGesture();
    store.getState().setMixer(id, { volume_db: -10 }, { transient: true });
    store.getState().setLoop(R(2, 5));
    store.getState().cancelGesture();
    expect(store.getState().song!.tracks[0].volume_db).toBe(0);
    expect(stored(store)).toEqual(S(2, 5));
  });

  it("clamps the region when an undo changes the length past the timeline", () => {
    const store = setupWithClip(4);
    store.getState().resizeClip("t0", "c", 24);
    store.getState().setLoop(R(20, 30));
    store.getState().undo();
    expect(store.getState().song!.measures).toBe(4);
    expect(stored(store)).toEqual(S(16, 16));
  });

  it("accepts a region past the song's end up to the timeline's end", () => {
    const store = setupWithClip(4);
    store.getState().setLoop(R(10, 40));
    expect(stored(store)).toEqual(S(10, 16));
  });

  it("keeps a region past the song's end when an undo shortens the song", () => {
    const store = setupWithClip(4);
    store.getState().resizeClip("t0", "c", 16);
    store.getState().setLoop(R(9, 12));
    store.getState().undo();
    expect(store.getState().song!.measures).toBe(4);
    expect(stored(store)).toEqual(S(9, 12));
  });

  it("keeps a drawn region when lengthened, clamps it when shortened, and leaves no region alone", () => {
    const store = setupWithClip(8);
    store.getState().setLoop(R(1, 8));
    store.getState().resizeClip("t0", "c", 16);
    expect(stored(store)).toEqual(S(1, 8));
    store.getState().setLoop(R(9, 16));
    store.getState().resizeClip("t0", "c", 8);
    expect(stored(store)).toEqual(S(9, 16));
    store.getState().resizeClip("t0", "c", 20);
    store.getState().setLoop(R(25, 28));
    store.getState().resizeClip("t0", "c", 8);
    expect(stored(store)).toEqual(S(16, 16));
    store.getState().setLoop({ region: null, enabled: true });
    store.getState().resizeClip("t0", "c", 4);
    expect(stored(store)).toEqual({ region: null, enabled: true });
  });

  it("ignores a setLoop that changes nothing", () => {
    const store = setupWithClip(8);
    const before = store.getState().song;
    store.getState().setLoop({ region: null, enabled: false });
    expect(store.getState().song).toBe(before);
    store.getState().setLoop(R(1, 8));
    const set = store.getState().song;
    store.getState().setLoop(R(1, 8));
    expect(store.getState().song).toBe(set);
  });
});

describe("songStore loop region during a timeline-shrinking gesture", () => {
  const stored = (store: ReturnType<typeof setup>) => store.getState().song!.loop_region;
  const S = (start: number, end: number) => ({ region: { start_measure: start, end_measure: end }, enabled: true });
  const R = (start: number, end: number) => ({ region: { start, end }, enabled: true });

  it("gets the full region back when the drag returns to its start", () => {
    const store = setupWithClip(20);
    store.getState().setLoop(R(18, 22));
    store.getState().beginGesture();
    store.getState().resizeClip("t0", "c", 4, { transient: true });
    expect(stored(store)).toEqual(S(16, 16));
    store.getState().resizeClip("t0", "c", 20, { transient: true });
    store.getState().endGesture();
    expect(stored(store)).toEqual(S(18, 22));
    expect(store.getState().past).toHaveLength(0);
  });

  it("restores the full region when the drag is cancelled", () => {
    const store = setupWithClip(20);
    store.getState().setLoop(R(18, 22));
    store.getState().beginGesture();
    store.getState().resizeClip("t0", "c", 4, { transient: true });
    store.getState().cancelGesture();
    expect(stored(store)).toEqual(S(18, 22));
    expect(store.getState().song!.measures).toBe(20);
  });

  it("clamps the committed region when the drag ends shorter", () => {
    const store = setupWithClip(20);
    store.getState().setLoop(R(18, 22));
    store.getState().beginGesture();
    store.getState().resizeClip("t0", "c", 4, { transient: true });
    store.getState().endGesture();
    expect(stored(store)).toEqual(S(16, 16));
  });
});

describe("songStore song settings", () => {
  it("undoes a key change", () => {
    const store = setup();
    store.getState().setKey({ tonic: "E", mode: "minor" });
    expect(store.getState().song!.key).toEqual({ tonic: "E", mode: "minor" });
    store.getState().undo();
    expect(store.getState().song!.key).toEqual({ tonic: "C", mode: "major" });
  });

  it("undoes a time signature change as one step", () => {
    const store = setupWithClip(2);
    store.getState().editLoopNotes("t0", "l", drums.rows, () => [note("kick", 0), note("kick", 28)]);
    store.getState().setTimeSignature("3/4");
    expect(store.getState().song!.tracks[0].loops[0].notes).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().song!.time_signature).toBe("4/4");
    expect(store.getState().song!.tracks[0].loops[0].notes).toHaveLength(2);
  });
});

describe("songStore clip resize gestures", () => {
  it("restores notes when a drag shrinks and then regrows an unshared clip", () => {
    const store = setupWithClip(4);
    store.getState().editLoopNotes("t0", "l", drums.rows, () => [note("kick", 3 * 16)]);
    const loopOf = () => store.getState().song!.tracks[0].loops[0];
    store.getState().beginGesture();
    store.getState().resizeClip("t0", "c", 2, { transient: true });
    expect(loopOf().notes).toHaveLength(0);
    store.getState().resizeClip("t0", "c", 4, { transient: true });
    store.getState().endGesture();
    expect(loopOf()).toMatchObject({ measures: 4, notes: [note("kick", 3 * 16)] });
    expect(store.getState().song!.measures).toBe(4);
  });

  it("undoes a shrink that dropped notes in one step", () => {
    const store = setupWithClip(4);
    store.getState().editLoopNotes("t0", "l", drums.rows, () => [note("kick", 3 * 16)]);
    store.getState().resizeClip("t0", "c", 3);
    expect(store.getState().song!.tracks[0].loops[0].notes).toEqual([]);
    store.getState().undo();
    expect(store.getState().song!.tracks[0].loops[0]).toMatchObject({ measures: 4, notes: [note("kick", 3 * 16)] });
  });
});
