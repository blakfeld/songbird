import { describe, expect, it } from "vitest";
import { newSongWithTracks } from "./testFixtures";
import { drums, note, patternWith } from "@/test/fixtures";
import { createTakeState } from "./clipOps";
import { createSongStore } from "./songStore";
import { normalizeSong } from "./songOps";

const setup = () => createSongStore(newSongWithTracks());

// A stored length only exists because clips cover it, so region tests need a real clip to stand on.
const setupWithClip = (measures: number) => {
  const base = newSongWithTracks();
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

  it("deletes the only track, leaves nothing selected, and undo restores it", () => {
    const store = setup();
    const [first, second] = store.getState().song!.tracks;
    store.getState().newClip(second.id, 1);
    store.getState().setMixer(second.id, { volume_db: -6, pan: 0.5 });
    const before = store.getState().song!.tracks[1];
    store.getState().deleteTrack(first.id);
    store.getState().deleteTrack(second.id);
    expect(store.getState().song!.tracks).toEqual([]);
    expect(store.getState().selectedTrackId).toBeNull();
    expect(store.getState().selectedClipId).toBeNull();
    store.getState().undo();
    expect(store.getState().song!.tracks).toHaveLength(1);
    expect(store.getState().song!.tracks[0]).toEqual(before);
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

  it("moves a track as one undo step, keeping the selection", () => {
    const store = setup();
    const [a, b] = store.getState().song!.tracks;
    store.getState().newClip(b.id, 1);
    store.getState().selectTrack(b.id);
    const { selectedTrackId, selectedClipId } = store.getState();
    const depth = store.getState().past.length;
    store.getState().moveTrack(b.id, 0);
    expect(store.getState().song!.tracks.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(store.getState().past).toHaveLength(depth + 1);
    expect(store.getState().selectedTrackId).toBe(selectedTrackId);
    expect(store.getState().selectedClipId).toBe(selectedClipId);
    store.getState().undo();
    expect(store.getState().song!.tracks.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("records nothing for a no-op move", () => {
    const store = setup();
    const [a] = store.getState().song!.tracks;
    store.getState().moveTrack(a.id, 0);
    store.getState().moveTrack("missing", 1);
    expect(store.getState().past).toHaveLength(0);
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

describe("generated ranges", () => {
  const range = { start_measure: 5, end_measure: 8 };
  const setupKeys = () => {
    const base = newSongWithTracks();
    const keys = {
      ...base.tracks[1],
      id: "keys",
      name: "Keys",
      loops: [{ id: "a", name: "Keys A", measures: 4, notes: [note("C4", 0)] }],
      clips: [{ id: "c", loop_id: "a", start_measure: 1, measures: 12 }],
    };
    return createSongStore(normalizeSong({ ...base, tracks: [base.tracks[0], keys] }));
  };

  it("applies as one undo step, selects the new clip, and undoes exactly", () => {
    const store = setupKeys();
    const before = store.getState().song!;
    expect(store.getState().applyGeneratedRange("keys", range, [note("E4", 2)])).toBeNull();
    const s = store.getState();
    expect(s.past).toHaveLength(1);
    const keys = s.song!.tracks[1];
    const placed = keys.clips.find((c) => c.start_measure === 5)!;
    expect(keys.loops.find((l) => l.id === placed.loop_id)!.name).toBe("Keys 1");
    expect(s.selectedTrackId).toBe("keys");
    expect(s.selectedClipId).toBe(placed.id);
    s.undo();
    expect(store.getState().song).toEqual(before);
  });

  it("refuses with a message at the loop limit and records nothing", () => {
    const store = setupKeys();
    const song = store.getState().song!;
    const keys = song.tracks[1];
    const loops = [...keys.loops, ...Array.from({ length: 63 }, (_, i) => ({ id: `x${i}`, name: `X${i}`, measures: 1, notes: [] }))];
    store.getState().loadSong({ ...song, tracks: [song.tracks[0], { ...keys, loops }] });
    const message = store.getState().applyGeneratedRange("keys", range, []);
    expect(message).toMatch(/64 loops/);
    expect(store.getState().past).toHaveLength(0);
  });

  it("locks the generating track's note edits and blocks a second generate", () => {
    const store = setupKeys();
    expect(store.getState().beginGenerating("keys")).toBe(true);
    expect(store.getState().beginGenerating("keys")).toBe(false);
    expect(store.getState().beginGenerating(store.getState().song!.tracks[0].id)).toBe(false);
    const before = store.getState().song;
    store.getState().editLoopNotes("keys", "a", [], () => []);
    store.getState().recordNotes("keys", [note("C4", 0)], createTakeState());
    expect(store.getState().song).toBe(before);
    expect(store.getState().applyGeneratedRange("keys", range, [])).toBeNull();
    store.getState().endGenerating();
    expect(store.getState().generatingTrackId).toBeNull();
    expect(store.getState().beginGenerating("missing")).toBe(false);
  });
});

describe("generation lock on clip operations", () => {
  it("refuses clip and loop ops on the locked track and allows other tracks", () => {
    const base = newSongWithTracks();
    const keys = {
      ...base.tracks[1],
      id: "keys",
      loops: [{ id: "a", name: "Keys A", measures: 2, notes: [] }],
      clips: [{ id: "c", loop_id: "a", start_measure: 1, measures: 2 }],
    };
    const store = createSongStore(normalizeSong({ ...base, tracks: [base.tracks[0], keys] }));
    store.getState().beginGenerating("keys");
    const before = store.getState().song;
    const s = store.getState();
    expect(s.deleteClip("keys", "c")).toBe("generating");
    expect(s.renameLoop("keys", "a", "New")).toBe("generating");
    expect(s.moveClip("keys", "c", 3)).toBe("generating");
    expect(store.getState().song).toBe(before);
    expect(s.newClip(base.tracks[0].id, 1)).toBeNull();
  });
});

describe("ranges past the song's end", () => {
  const range = { start_measure: 1, end_measure: 16 };

  it("grows a 1-measure song when a generated range covers 1-16, in one history entry", () => {
    const store = setup();
    expect(store.getState().song!.measures).toBe(1);
    const id = store.getState().song!.tracks[1].id;
    expect(store.getState().applyGeneratedRange(id, range, [note("c4", 0)])).toBeNull();
    const s = store.getState();
    expect(s.song!.measures).toBe(16);
    expect(s.song!.tracks[1].clips).toMatchObject([{ start_measure: 1, measures: 16 }]);
    expect(s.past).toHaveLength(1);
    s.undo();
    expect(store.getState().song!.measures).toBe(1);
  });

  it("grows a 1-measure song when a chat track covers 1-16", () => {
    const store = setup();
    const part = { name: "Piano", instrument: "piano", range, notes: [note("c4", 0)] };
    expect(store.getState().applyChatResult("16 bars", { reply: "ok", track: part })).toBeNull();
    const s = store.getState();
    expect(s.song!.measures).toBe(16);
    expect(s.song!.tracks[2].clips).toMatchObject([{ start_measure: 1, measures: 16 }]);
    expect(s.past).toHaveLength(1);
  });

  it("refuses a range past the 128-measure cap", () => {
    const store = setup();
    const id = store.getState().song!.tracks[1].id;
    expect(store.getState().applyGeneratedRange(id, { start_measure: 120, end_measure: 129 }, [])).not.toBeNull();
    const part = { name: "Piano", instrument: "piano", range: { start_measure: 120, end_measure: 129 }, notes: [] };
    expect(store.getState().applyChatResult("x", { reply: "ok", track: part })).toMatch(/128/);
    expect(store.getState().past).toHaveLength(0);
  });
});

describe("generation tokens", () => {
  it("ignores an endGenerating from a stale token and honours the current one", () => {
    const store = setup();
    const id = store.getState().song!.tracks[0].id;
    store.getState().beginGenerating(id);
    const stale = store.getState().generationToken;
    store.getState().loadSong(newSongWithTracks());
    const next = store.getState().song!.tracks[0].id;
    store.getState().beginGenerating(next);
    store.getState().endGenerating(stale);
    expect(store.getState().generatingTrackId).toBe(next);
    store.getState().endGenerating(store.getState().generationToken);
    expect(store.getState().generatingTrackId).toBeNull();
  });

  it("clears the lock on load", () => {
    const store = setup();
    store.getState().beginGenerating(store.getState().song!.tracks[0].id);
    store.getState().loadSong(newSongWithTracks());
    expect(store.getState().generatingTrackId).toBeNull();
  });
});

describe("chat results", () => {
  const range = { start_measure: 1, end_measure: 4 };
  const part = { name: "Bass", instrument: "bass", range, notes: [note("C2", 0, 4)] };

  it("adds the track with ids and defaults, labels the reply, and is one history entry", () => {
    const store = setup();
    expect(store.getState().applyChatResult("add bass", { reply: "Added a Bass track.", track: part })).toBeNull();
    const s = store.getState();
    const added = s.song!.tracks[2];
    expect(added).toMatchObject({ name: "Bass", instrument: "bass", volume_db: 0, pan: 0, muted: false });
    expect(added.loops).toHaveLength(1);
    expect(added.clips).toEqual([
      { id: expect.any(String), loop_id: added.loops[0].id, start_measure: 1, measures: 4 },
    ]);
    expect(added.loops[0].notes).toEqual(part.notes);
    expect(s.song!.chat).toEqual([
      { role: "user", content: "add bass" },
      { role: "assistant", content: "Added a Bass track.", track_id: added.id },
    ]);
    expect(s.past).toHaveLength(1);
    expect(s.selectedTrackId).toBe(added.id);
  });

  it("undo removes the track but keeps the conversation, and redo brings the track back", () => {
    const store = setup();
    store.getState().applyChatResult("add bass", { reply: "Added a Bass track.", track: part });
    const id = store.getState().song!.tracks[2].id;
    store.getState().undo();
    expect(store.getState().song!.tracks).toHaveLength(2);
    expect(store.getState().song!.chat).toHaveLength(2);
    expect(store.getState().song!.chat![1].track_id).toBe(id);
    store.getState().redo();
    expect(store.getState().song!.tracks[2].id).toBe(id);
    expect(store.getState().song!.chat).toHaveLength(2);
  });

  it("records a reply-only turn without an undo step or a track", () => {
    const store = setup();
    store.getState().applyChatResult("what tempo?", { reply: "120 BPM.", track: null });
    const s = store.getState();
    expect(s.song!.tracks).toHaveLength(2);
    expect(s.past).toHaveLength(0);
    expect(s.song!.chat).toEqual([
      { role: "user", content: "what tempo?" },
      { role: "assistant", content: "120 BPM." },
    ]);
  });

  it("keeps only the latest 20 messages", () => {
    const store = setup();
    for (let i = 0; i < 12; i++)
      store.getState().applyChatResult(`q${i}`, { reply: `a${i}`, track: null });
    const chat = store.getState().song!.chat!;
    expect(chat).toHaveLength(20);
    expect(chat[0]).toEqual({ role: "user", content: "q2" });
    expect(chat[19]).toEqual({ role: "assistant", content: "a11" });
  });

  it("refuses a track at the 16-track limit and records nothing", () => {
    const base = newSongWithTracks();
    const store = createSongStore({
      ...base,
      tracks: Array.from({ length: 16 }, (_, i) => ({ ...base.tracks[0], id: `t${i}`, name: `T${i}` })),
    });
    expect(store.getState().applyChatResult("more", { reply: "ok", track: part })).toMatch(/16 tracks/);
    expect(store.getState().song!.chat).toBeUndefined();
  });

  it("keeps unrecognised song fields through a chat turn", () => {
    const store = createSongStore({ ...newSongWithTracks(), future_field: { a: 1 } } as never);
    store.getState().applyChatResult("add bass", { reply: "ok", track: part });
    expect((store.getState().song as unknown as Record<string, unknown>).future_field).toEqual({ a: 1 });
  });
});

describe("track sound", () => {
  const cutoff = (v: number) => ({ tone: { filter_cutoff_hz: v } });
  const soundOf = (store: ReturnType<typeof setup>) => store.getState().song!.tracks[1].sound;
  const idOf = (store: ReturnType<typeof setup>) => store.getState().song!.tracks[1].id;

  it("records one undo step for a whole drag", () => {
    const store = setup();
    const id = idOf(store);
    store.getState().beginGesture();
    for (const v of [900, 600, 300]) store.getState().setSound(id, cutoff(v), { transient: true });
    store.getState().endGesture();
    expect(soundOf(store)).toEqual(cutoff(300));
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(soundOf(store)).toBeUndefined();
  });

  it("records no step when a drag returns to its starting value", () => {
    const store = setup();
    const id = idOf(store);
    store.getState().setSound(id, cutoff(500));
    const stepsBefore = store.getState().past.length;
    store.getState().beginGesture();
    for (const v of [900, 700, 500]) store.getState().setSound(id, cutoff(v), { transient: true });
    store.getState().endGesture();
    expect(store.getState().past).toHaveLength(stepsBefore);
    expect(soundOf(store)).toEqual(cutoff(500));
  });

  it("records one step for a toggle and one for a reset", () => {
    const store = setup();
    const id = idOf(store);
    store.getState().setSound(id, { effects: { reverb: { enabled: true } } });
    expect(store.getState().past).toHaveLength(1);
    store.getState().setSound(id, cutoff(300));
    store.getState().resetSound(id);
    expect(soundOf(store)).toBeUndefined();
    expect(store.getState().past).toHaveLength(3);
    store.getState().undo();
    expect(soundOf(store)).toEqual({ ...cutoff(300), effects: { reverb: { enabled: true } } });
  });

  it("does not record a reset of a track with no sound", () => {
    const store = setup();
    store.getState().resetSound(idOf(store));
    expect(store.getState().past).toHaveLength(0);
  });

  it("creates tracks without sound from Add Track, Send to song and chat", () => {
    const store = setup();
    store.getState().addTrack({ id: "bass", name: "Bass" });
    store.getState().addTrackFromPattern(patternWith([note("kick", 0)]));
    store.getState().applyChatResult("add bass", {
      reply: "ok",
      track: { name: "Bass", instrument: "bass", range: { start_measure: 1, end_measure: 4 }, notes: [note("C2", 0, 4)] },
    });
    const added = store.getState().song!.tracks.slice(2);
    expect(added.length).toBeGreaterThanOrEqual(2);
    for (const t of added) expect("sound" in t).toBe(false);
  });

  it("keeps a track's sound when notes are generated into it", () => {
    const store = setup();
    const id = idOf(store);
    store.getState().setSound(id, cutoff(400));
    expect(
      store.getState().applyGeneratedRange(id, { start_measure: 1, end_measure: 4 }, [note("c4", 0)]),
    ).toBeNull();
    expect(soundOf(store)).toEqual(cutoff(400));
  });
});

describe("lyrics", () => {
  it("is not an undo step", () => {
    const store = setup();
    store.getState().setLyrics("la la");
    expect(store.getState().song!.lyrics).toBe("la la");
    expect(store.getState().past).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().song!.lyrics).toBe("la la");
  });

  it("omits the field when empty so the song serializes as before", () => {
    const store = setup();
    store.getState().setLyrics("x");
    store.getState().setLyrics("");
    expect("lyrics" in store.getState().song!).toBe(false);
  });

  it("keeps lyrics when a track add is undone and redone", () => {
    const store = setup();
    const count = store.getState().song!.tracks.length;
    store.getState().addTrack({ id: "bass", name: "Bass" });
    store.getState().setLyrics("words");
    store.getState().undo();
    expect(store.getState().song!.tracks).toHaveLength(count);
    expect(store.getState().song!.lyrics).toBe("words");
    store.getState().redo();
    expect(store.getState().song!.tracks).toHaveLength(count + 1);
    expect(store.getState().song!.lyrics).toBe("words");
  });

  it("drops lyrics that were typed after the snapshot only when they are cleared", () => {
    const store = setup();
    store.getState().setLyrics("words");
    store.getState().addTrack({ id: "bass", name: "Bass" });
    store.getState().setLyrics("");
    store.getState().undo();
    expect("lyrics" in store.getState().song!).toBe(false);
  });

  it("keeps lyrics when a gesture is cancelled", () => {
    const store = setup();
    const id = store.getState().song!.tracks[0].id;
    store.getState().beginGesture();
    store.getState().setMixer(id, { volume_db: -10 }, { transient: true });
    store.getState().setLyrics("mid-drag words");
    store.getState().cancelGesture();
    expect(store.getState().song!.tracks[0].volume_db).not.toBe(-10);
    expect(store.getState().song!.lyrics).toBe("mid-drag words");
  });

  it("keeps lyrics and chat written during a drag through later previews and the drag's end", () => {
    const store = setup();
    const id = store.getState().song!.tracks[1].id;
    const sound = (v: number) => ({ tone: { filter_cutoff_hz: v } });
    store.getState().beginGesture();
    store.getState().setSound(id, sound(900), { transient: true });
    store.getState().setLyrics("mid-drag words");
    store.getState().applyChatResult("hi", { reply: "hello", track: null });
    store.getState().setSound(id, sound(600), { transient: true });
    expect(store.getState().song!.lyrics).toBe("mid-drag words");
    expect(store.getState().song!.chat).toHaveLength(2);
    store.getState().endGesture();
    store.getState().undo();
    expect(store.getState().song!.lyrics).toBe("mid-drag words");
    expect(store.getState().song!.chat).toHaveLength(2);
  });
});
