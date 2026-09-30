import { describe, expect, it } from "vitest";
import { drums } from "@/test/fixtures";
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
    expect(model.getTiming()).toEqual({ tempo: 90, swing: 0, stepsPerMeasure: 16, measures: 8 });
    const voices = model.getVoices();
    expect(voices.map((v) => v.key)).toEqual(song.tracks.map((t) => t.id));
    expect(voices[1]).toMatchObject({ instrument: "piano", pan: -1, audible: true });
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
});
