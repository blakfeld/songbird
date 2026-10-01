import { describe, expect, it } from "vitest";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { createSongStore } from "@/lib/song/songStore";
import { newSong } from "@/lib/song/types";
import { createSongPlaybackModel } from "./songPlaybackModel";

const piano = { ...drums, id: "piano", name: "Piano", kind: "melodic" as const };

describe("song playback model", () => {
  it("reports song timing and one voice per track keyed by track id", () => {
    const song = newSong();
    song.tempo_bpm = 90;
    song.tracks[1].pan = -1;
    const model = createSongPlaybackModel(createSongStore(song), [drums, piano]);
    expect(model.getTiming()).toEqual({ beatSteps: 4, tempo: 90, swing: 0, stepsPerMeasure: 16, measures: 1 });
    const voices = model.getVoices();
    expect(voices.map((v) => v.key)).toEqual(song.tracks.map((t) => t.id));
    expect(voices[1]).toMatchObject({ instrument: "piano", pan: -1, audible: true });
  });

  it("widens the timing to a looping region past the song's end only", () => {
    const song = { ...newSong(), loop_region: { region: { start_measure: 5, end_measure: 9 }, enabled: true } };
    const store = createSongStore(song);
    const model = createSongPlaybackModel(store, [drums, piano]);
    expect(model.getTiming()?.measures).toBe(9);
    store.getState().setLoop({ region: { start: 5, end: 9 }, enabled: false });
    expect(model.getTiming()?.measures).toBe(1);
    store.getState().setLoop({ region: null, enabled: true });
    expect(model.getTiming()?.measures).toBe(1);
  });

  it("resolves solo and mute into audibility", () => {
    const song = newSong();
    song.tracks[0].soloed = true;
    const model = createSongPlaybackModel(createSongStore(song), [drums, piano]);
    expect(model.getVoices().map((v) => v.audible)).toEqual([true, false]);
  });

  it("has nothing to play before the song or the instruments are loaded", () => {
    const empty = createSongPlaybackModel(createSongStore());
    expect(empty.getTiming()).toBeNull();
    expect(empty.getVoices()).toEqual([]);

    const model = createSongPlaybackModel(createSongStore(newSong()));
    expect(model.getVoices()).toEqual([]);
    model.setInstruments([drums]);
    expect(model.getVoices().map((v) => v.instrument)).toEqual(["drums"]);
  });

  it("gives each voice the notes its clips resolve to", () => {
    const song = newSong();
    song.tracks[0] = {
      ...trackWithNotes(song.tracks[0], [note("kick", 0)], 1),
      clips: [{ id: "c", loop_id: `${song.tracks[0].id}-loop`, start_measure: 3, measures: 2 }],
    };
    const model = createSongPlaybackModel(createSongStore(song), [drums, piano]);
    expect(model.getVoices()[0].notes.map((n) => n.step)).toEqual([32, 48]);
  });
});
