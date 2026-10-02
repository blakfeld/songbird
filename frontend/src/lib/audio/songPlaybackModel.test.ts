import { describe, expect, it } from "vitest";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { createSongStore } from "@/lib/song/songStore";
import { newTrack } from "@/lib/song/types";
import { createSongPlaybackModel } from "./songPlaybackModel";

const piano = { ...drums, id: "piano", name: "Piano", kind: "melodic" as const };

describe("song playback model", () => {
  it("reports song timing and one voice per track keyed by track id", () => {
    const song = newSongWithTracks();
    song.tempo_bpm = 90;
    song.tracks[1].pan = -1;
    const model = createSongPlaybackModel(createSongStore(song), [drums, piano]);
    expect(model.getTiming()).toEqual({ beatSteps: 4, tempo: 90, swing: 0, stepsPerMeasure: 16, measures: 1 });
    const voices = model.getVoices();
    expect(voices.map((v) => v.key)).toEqual(song.tracks.map((t) => t.id));
    expect(voices[1]).toMatchObject({ instrument: "piano", pan: -1, audible: true });
  });

  it("widens the timing to a looping region past the song's end only", () => {
    const song = { ...newSongWithTracks(), loop_region: { region: { start_measure: 5, end_measure: 9 }, enabled: true } };
    const store = createSongStore(song);
    const model = createSongPlaybackModel(store, [drums, piano]);
    expect(model.getTiming()?.measures).toBe(9);
    store.getState().setLoop({ region: { start: 5, end: 9 }, enabled: false });
    expect(model.getTiming()?.measures).toBe(1);
    store.getState().setLoop({ region: null, enabled: true });
    expect(model.getTiming()?.measures).toBe(1);
  });

  it("resolves solo and mute into audibility", () => {
    const song = newSongWithTracks();
    song.tracks[0].soloed = true;
    const model = createSongPlaybackModel(createSongStore(song), [drums, piano]);
    expect(model.getVoices().map((v) => v.audible)).toEqual([true, false]);
  });

  it("has nothing to play before the song or the instruments are loaded", () => {
    const empty = createSongPlaybackModel(createSongStore());
    expect(empty.getTiming()).toBeNull();
    expect(empty.getVoices()).toEqual([]);

    const model = createSongPlaybackModel(createSongStore(newSongWithTracks()));
    expect(model.getVoices()).toEqual([]);
    model.setInstruments([drums]);
    expect(model.getVoices().map((v) => v.instrument)).toEqual(["drums"]);
  });

  it("gives each voice the notes its clips resolve to", () => {
    const song = newSongWithTracks();
    song.tracks[0] = {
      ...trackWithNotes(song.tracks[0], [note("kick", 0)], 1),
      clips: [{ id: "c", loop_id: `${song.tracks[0].id}-loop`, start_measure: 3, measures: 2 }],
    };
    const model = createSongPlaybackModel(createSongStore(song), [drums, piano]);
    expect(model.getVoices()[0].notes.map((n) => n.step)).toEqual([32, 48]);
  });

  it("gives audio tracks an audio voice with their clips and each sample's rate", () => {
    const song = newSongWithTracks();
    song.samples = [{ id: "s1", name: "Loop", sample_rate: 44100, channels: 2, length_samples: 88200, origin: "import" }];
    const clip = {
      id: "c1",
      sample_id: "s1",
      start_ticks: 480,
      offset_samples: 0,
      slice_samples: 88200,
      length_samples: 88200,
      loop: false,
      gain_db: 0,
      fade_in_samples: 0,
      fade_out_samples: 0,
    };
    song.tracks.push({ ...newTrack("audio", "Loops"), audio_clips: [clip, { ...clip, id: "c2", sample_id: "missing" }] });
    const model = createSongPlaybackModel(createSongStore(song), [drums, piano]);
    const voices = model.getVoices();
    expect(voices.map((v) => v.kind)).toEqual(["instrument", "instrument", "audio"]);
    const audio = voices[2];
    expect(audio).toMatchObject({ instrument: "audio", rows: [], notes: [], audible: true });
    // The clip whose sample is not in the song is left out instead of failing playback.
    expect(audio.clips).toEqual([{ clip, sampleRate: 44100 }]);
    expect(model.getVoices()[2].clips).toBe(audio.clips);
  });

  it("has audio voices before the instrument list arrives, and resolves their mute and solo", () => {
    const song = newSongWithTracks();
    song.tracks = [{ ...newTrack("audio", "A"), soloed: true }, { ...newTrack("audio", "B") }];
    const model = createSongPlaybackModel(createSongStore(song));
    expect(model.getVoices().map((v) => v.audible)).toEqual([true, false]);
  });
});
