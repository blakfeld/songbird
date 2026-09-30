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
    store.getState().editTrackNotes(bass.id, drums.rows, (g) => [...g.notes, note("kick", 0)]);
    store.getState().setMixer(bass.id, { volume_db: -6, pan: 0.5 });
    const before = store.getState().song!.tracks[2];
    store.getState().deleteTrack(bass.id);
    expect(store.getState().song!.tracks).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().song!.tracks[2]).toEqual(before);
    expect(before.notes).toHaveLength(1);
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
