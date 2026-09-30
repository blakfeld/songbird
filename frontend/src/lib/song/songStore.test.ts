import { describe, expect, it } from "vitest";
import { drums, note } from "@/test/fixtures";
import { createSongStore } from "./songStore";
import { newSong } from "./types";

const setup = () => createSongStore(newSong());

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
    expect(store.getState().newClip(b.id, 2)).toBe("no-room");
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

