import { describe, expect, it } from "vitest";
import type { Sample } from "@/generated/Sample";
import * as ops from "./audioClipOps";
import { addSamplerTrack, assignPad } from "./samplerOps";
import { clipSampleName } from "@/lib/audio/sampleLibrary";
import { toSample } from "@/components/studio/useAudioActions";
import { audioProblem } from "./audioValidation";
import { addTrack, deleteTrack, setSound, setTempo, setTimeSignature } from "./songOps";
import { createSongStore } from "./songStore";
import { newSong, type Song } from "./types";

// At 120 BPM and 48 kHz one measure of 4/4 is 2 s, which is 96000 samples and 3840 ticks.
const MEASURE = 3840;
const M_SAMPLES = 96000;
const sample = (id: string, measures = 1, name = id): Sample => ({
  id,
  name,
  sample_rate: 48000,
  channels: 2,
  length_samples: M_SAMPLES * measures,
  origin: "import",
});

const start = (): { song: Song; trackId: string } => {
  const song = addTrack(newSong("4/4", 120), { id: "audio", name: "Audio" }, "Loops");
  return { song, trackId: song.tracks[0].id };
};

const place = (song: Song, trackId: string, s: Sample, measure: number) => {
  const r = ops.placeSample(song, trackId, s, (measure - 1) * MEASURE);
  if (!r.song) throw new Error(r.reason);
  return { song: r.song, id: r.clipId! };
};

const done = (r: ops.AudioOpResult) => {
  if (!r.song) throw new Error(r.reason);
  return r;
};

const clipOf = (song: Song, id: string) => song.tracks[0].audio_clips!.find((c) => c.id === id)!;

describe("replacing a span", () => {
  it("Punch in over an earlier take: keeps the audio on both sides of the punch", () => {
    const { song, trackId } = start();
    const placed = place(song, trackId, sample("take", 8), 1);
    const r = done(ops.replaceSpan(placed.song, trackId, 2 * MEASURE, 4 * MEASURE));
    const clips = r.song!.tracks[0].audio_clips!;
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ id: placed.id, start_ticks: 0, offset_samples: 0, length_samples: 2 * M_SAMPLES, slice_samples: 2 * M_SAMPLES });
    expect(clips[1]).toMatchObject({
      start_ticks: 4 * MEASURE,
      offset_samples: 4 * M_SAMPLES,
      length_samples: 4 * M_SAMPLES,
      slice_samples: 4 * M_SAMPLES,
    });
    expect(clips[1].id).not.toBe(placed.id);
  });

  it("removes a clip the span covers and trims one it only overlaps", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a"), 2);
    const b = place(a.song, trackId, sample("b", 2), 3);
    const r = done(ops.replaceSpan(b.song, trackId, MEASURE, 3 * MEASURE));
    const clips = r.song!.tracks[0].audio_clips!;
    expect(clips.map((c) => c.id)).toEqual([b.id]);
    expect(clips[0]).toMatchObject({ start_ticks: 3 * MEASURE, offset_samples: M_SAMPLES, length_samples: M_SAMPLES });
  });

  it("leaves clips outside the span, touching ones included", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a"), 1);
    expect(done(ops.replaceSpan(a.song, trackId, MEASURE, 2 * MEASURE)).song).toBe(a.song);
  });
});

describe("takes", () => {
  const take = (id: string, trackId: string): Sample => ({ ...sample(id, 1, `Take ${id}`), origin: "recording", track_id: trackId, recorded_at_ticks: 0 });

  function withTakes() {
    const { song, trackId } = start();
    const samples = [take("a", trackId), take("b", trackId), sample("imported")];
    const placed = place({ ...song, samples }, trackId, samples[1], 1);
    return { song: placed.song, trackId, clipId: placed.id };
  }

  it("lists a track's takes newest first and leaves imports out", () => {
    const { song, trackId } = withTakes();
    expect(ops.takesOf(song, trackId).map((s) => s.id)).toEqual(["b", "a"]);
    expect(ops.usesOf(song, "b")).toEqual({ clips: 1, pads: 0 });
    expect(ops.usesOf(song, "a")).toEqual({ clips: 0, pads: 0 });
  });

  it("deletes unused takes only, and refuses the whole request when a clip plays one", () => {
    const { song, trackId } = withTakes();
    expect(ops.deleteTakes(song, trackId, ["a", "b"])).toEqual({ song: null, reason: "in-use" });
    const done = ops.deleteTakes(song, trackId, ["a"]);
    expect(done.song?.samples?.map((s) => s.id)).toEqual(["b", "imported"]);
    expect(ops.deleteTakes(song, trackId, ["imported"])).toEqual({ song: null, reason: "not-found" });
  });

  it("Delete a track with takes: its unused takes go, one a clip elsewhere plays becomes an import, and the song stays valid", () => {
    const { song, trackId } = withTakes();
    const other = addTrack(song, { id: "audio", name: "Audio" }, "Other");
    const otherId = other.tracks[1].id;
    // Take "b" is played by the clip on the first track; move that clip to the other track.
    const clip = song.tracks[0].audio_clips![0];
    const moved = {
      ...other,
      tracks: [{ ...other.tracks[0], audio_clips: [] }, { ...other.tracks[1], audio_clips: [clip] }],
    };
    const after = deleteTrack(moved, trackId);
    expect(after.tracks.map((t) => t.id)).toEqual([otherId]);
    expect(after.samples!.map((s) => s.id)).toEqual(["b", "imported"]);
    const b = after.samples![0];
    expect(b.origin).toBe("import");
    expect("track_id" in b).toBe(false);
    expect("recorded_at_ticks" in b).toBe(false);
    expect(audioProblem(JSON.parse(JSON.stringify(after)))).toBeNull();
    // Without the fix the dangling track_id is what the validator rejects.
    expect(audioProblem(JSON.parse(JSON.stringify({ ...moved, tracks: moved.tracks.slice(1) })))?.kind).toBe("sample_track");
  });

  it("counts a sampler pad as a use: a take on a pad is kept by Delete unused, and survives its track going", () => {
    const { song, trackId } = withTakes();
    const sampler = addSamplerTrack(song, "pads")!;
    // The take "a" is added to the library and put on a pad, which is the same sample id.
    const padded = assignPad(sampler.song, sampler.trackId, "pad-1", song.samples![0]).song!;
    expect(ops.usesOf(padded, "a")).toEqual({ clips: 0, pads: 1 });
    expect(ops.deleteTakes(padded, trackId, ["a"])).toEqual({ song: null, reason: "in-use" });

    const after = deleteTrack(padded, trackId);
    const kept = after.samples!.find((s) => s.id === "a")!;
    expect(kept.origin).toBe("import");
    expect("track_id" in kept).toBe(false);
    expect(audioProblem(JSON.parse(JSON.stringify(after)))).toBeNull();
  });

  it("restores the track and its takes with one undo", () => {
    const { song, trackId } = withTakes();
    const store = createSongStore(song);
    store.getState().deleteTrack(trackId);
    expect(store.getState().song!.samples!.map((s) => s.id)).toEqual(["imported"]);
    store.getState().undo();
    expect(store.getState().song).toBe(song);
  });

  it("Switch keeps song time: the clip plays the chosen take from the point that matches where it sits", () => {
    const { song: base, trackId } = start();
    // Take a covers measures 1-4 of the song, take b measures 3-6, both recorded on the same track.
    const a = { ...take("a", trackId), length_samples: 4 * M_SAMPLES, recorded_at_ticks: 0 };
    const b = { ...take("b", trackId), length_samples: 4 * M_SAMPLES, recorded_at_ticks: 2 * MEASURE };
    const song = { ...base, samples: [a, b] };
    // The clip sits at measure 3 and plays a, which is therefore entered two measures in.
    const placed = place(song, trackId, a, 3);
    const clipA = clipOf(placed.song, placed.id);
    const withOffset = {
      ...placed.song,
      tracks: [{ ...placed.song.tracks[0], audio_clips: [{ ...clipA, offset_samples: 2 * M_SAMPLES, slice_samples: 2 * M_SAMPLES, length_samples: 2 * M_SAMPLES }] }],
    };

    // Measure 3 is where b began, so b is entered at its own start.
    const toB = clipOf(done(ops.switchTake(withOffset, trackId, placed.id, b)).song!, placed.id);
    expect(toB).toMatchObject({ sample_id: "b", start_ticks: 2 * MEASURE, offset_samples: 0, length_samples: 2 * M_SAMPLES });

    // And back: a clip at measure 3 on b goes to a two measures in, and is shortened to what a still holds.
    const onB = ops.switchTake({ ...withOffset, samples: [a, b] }, trackId, placed.id, b).song!;
    const backToA = clipOf(done(ops.switchTake(onB, trackId, placed.id, a)).song!, placed.id);
    expect(backToA).toMatchObject({ sample_id: "a", offset_samples: 2 * M_SAMPLES, slice_samples: 2 * M_SAMPLES, length_samples: 2 * M_SAMPLES });
  });

  it("starts a take recorded without a position, or on another track, from the top", () => {
    const { song, trackId } = withTakes();
    const clipId = song.tracks[0].audio_clips![0].id;
    const noPosition = { ...take("c", trackId), recorded_at_ticks: undefined } as Sample;
    const withC = { ...song, samples: [...song.samples!, noPosition] };
    expect(clipOf(done(ops.switchTake(withC, trackId, clipId, noPosition)).song!, clipId).offset_samples).toBe(0);
  });

  it("renames a sample, trimmed and cut to the name limit", () => {
    const { song } = withTakes();
    expect(ops.renameSample(song, "a", "  Best  ").song?.samples?.find((s) => s.id === "a")?.name).toBe("Best");
    expect(ops.renameSample(song, "a", "x".repeat(200)).song?.samples?.find((s) => s.id === "a")?.name).toHaveLength(80);
    expect(ops.renameSample(song, "a", "   ")).toEqual({ song: null, reason: "not-found" });
  });
});

describe("placing samples", () => {
  it("drags a sample to a lane at measure 5 with defaults and records the sample", () => {
    const { song, trackId } = start();
    const placed = place(song, trackId, sample("a", 2), 5);
    expect(clipOf(placed.song, placed.id)).toMatchObject({
      sample_id: "a",
      start_ticks: 4 * MEASURE,
      length_samples: 2 * M_SAMPLES,
      loop: false,
      gain_db: 0,
      fade_in_samples: 0,
      fade_out_samples: 0,
    });
    expect(placed.song.samples).toHaveLength(1);
    expect(placed.song.measures).toBe(6);
  });

  it("grows the song to the measure the sample ends in", () => {
    const { song, trackId } = start();
    const s = { ...sample("a"), length_samples: Math.round(M_SAMPLES * 1.5) };
    const placed = place({ ...song, measures: 4 }, trackId, s, 6);
    expect(placed.song.measures).toBe(7);
  });

  it("refuses an overlap and leaves the song unchanged", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 1);
    expect(ops.placeSample(a.song, trackId, sample("b"), MEASURE)).toEqual({ song: null, reason: "no-room" });
    expect(ops.placeSample(a.song, trackId, sample("b"), 2 * MEASURE).song).not.toBeNull();
  });

  it("refuses a placement past 128 measures", () => {
    const { song, trackId } = start();
    expect(ops.placeSample(song, trackId, sample("a", 2), 127 * MEASURE)).toEqual({
      song: null,
      reason: "song-limit",
    });
  });

  it("does not duplicate a sample already in the song", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a"), 1);
    expect(place(a.song, trackId, sample("a"), 3).song.samples).toHaveLength(1);
  });

  it("creates a new track named after the sample", () => {
    const { song } = start();
    const r = ops.placeOnNewTrack(song, sample("v", 1, "vocal-chop"), 8 * MEASURE);
    expect(r.song!.tracks[1]).toMatchObject({ name: "vocal-chop", instrument: "audio" });
    expect(r.song!.tracks[1].audio_clips![0].start_ticks).toBe(8 * MEASURE);
  });

  it("keeps the new track out when the clip is refused", () => {
    const { song } = start();
    expect(ops.placeOnNewTrack(song, sample("v", 2), 127 * MEASURE).song).toBeNull();
  });

  it("snaps to sixteenths unless free", () => {
    expect(ops.snapTicks(250)).toBe(240);
    expect(ops.snapTicks(250, true)).toBe(250);
  });
});

describe("editing audio clips", () => {
  const two = () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 1);
    const b = place(a.song, trackId, sample("b", 2), 5);
    return { song: b.song, trackId, a: a.id, b: b.id };
  };

  it("moves with snapping", () => {
    const { song, trackId, a } = two();
    const moved = ops.moveClip(song, trackId, a, 245).song!;
    expect(clipOf(moved, a).start_ticks).toBe(240);
    expect(clipOf(ops.moveClip(song, trackId, a, 245, true).song!, a).start_ticks).toBe(245);
  });

  it("stops at the next clip", () => {
    const { song, trackId, a } = two();
    expect(clipOf(ops.moveClip(song, trackId, a, 10 * MEASURE).song!, a).start_ticks).toBe(2 * MEASURE);
  });

  it("stops at the previous clip and at the song start", () => {
    const { song, trackId, a, b } = two();
    expect(clipOf(ops.moveClip(song, trackId, b, 0).song!, b).start_ticks).toBe(2 * MEASURE);
    expect(clipOf(ops.moveClip(song, trackId, a, -500).song!, a).start_ticks).toBe(0);
  });

  it("returns the same song when a move changes nothing", () => {
    const { song, trackId, a } = two();
    expect(ops.moveClip(song, trackId, a, 0).song).toBe(song);
  });

  it("trims the start keeping the audio aligned", () => {
    const { song, trackId, b } = two();
    const trimmed = clipOf(ops.trimStart(song, trackId, b, 5 * MEASURE).song!, b);
    expect(trimmed.start_ticks).toBe(5 * MEASURE);
    expect(trimmed.offset_samples).toBe(M_SAMPLES);
    expect(trimmed.slice_samples).toBe(M_SAMPLES);
    expect(trimmed.length_samples).toBe(M_SAMPLES);
  });

  it("never reveals audio before the sample start", () => {
    const { song, trackId, b } = two();
    const unchanged = ops.trimStart(song, trackId, b, 3 * MEASURE).song!;
    expect(clipOf(unchanged, b).offset_samples).toBe(0);
    const trimmed = ops.trimStart(song, trackId, b, 5 * MEASURE).song!;
    const back = clipOf(ops.trimStart(trimmed, trackId, b, 4 * MEASURE).song!, b);
    expect(back.offset_samples).toBe(0);
    expect(back.start_ticks).toBe(4 * MEASURE);
  });

  it("stops a non-looping end at the sample end", () => {
    const { song, trackId, a } = two();
    const short = ops.setEnd(song, trackId, a, MEASURE).song!;
    expect(clipOf(short, a).length_samples).toBe(M_SAMPLES);
    const long = ops.setEnd(short, trackId, a, 4 * MEASURE).song!;
    expect(clipOf(long, a).length_samples).toBe(2 * M_SAMPLES);
  });

  it("repeats the slice when a looping clip is extended", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 1);
    const looping = ops.setLoop(a.song, trackId, a.id, true).song!;
    const extended = clipOf(ops.setEnd(looping, trackId, a.id, 8 * MEASURE).song!, a.id);
    expect(extended.length_samples).toBe(8 * M_SAMPLES);
    expect(extended.slice_samples).toBe(2 * M_SAMPLES);
    expect(extended.length_samples / extended.slice_samples).toBe(4);
  });

  it("stops an extension at the neighbour", () => {
    const { song, trackId, a } = two();
    const looping = ops.setLoop(song, trackId, a, true).song!;
    expect(clipOf(ops.setEnd(looping, trackId, a, 20 * MEASURE).song!, a).length_samples).toBe(4 * M_SAMPLES);
  });

  it("limits length to the slice when looping is turned off", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a"), 1);
    const looped = ops.setEnd(ops.setLoop(a.song, trackId, a.id, true).song!, trackId, a.id, 4 * MEASURE).song!;
    expect(clipOf(looped, a.id).length_samples).toBe(4 * M_SAMPLES);
    const off = clipOf(ops.setLoop(looped, trackId, a.id, false).song!, a.id);
    expect(off).toMatchObject({ loop: false, length_samples: M_SAMPLES });
  });

  it("clamps gain and fades, which never exceed the clip together", () => {
    const { song, trackId, a } = two();
    expect(clipOf(ops.setGain(song, trackId, a, 40).song!, a).gain_db).toBe(12);
    const fadedIn = ops.setFades(song, trackId, a, { fadeIn: 3 * M_SAMPLES }).song!;
    expect(clipOf(fadedIn, a).fade_in_samples).toBe(2 * M_SAMPLES);
    const both = clipOf(ops.setFades(fadedIn, trackId, a, { fadeOut: 1000 }).song!, a);
    expect(both.fade_in_samples + both.fade_out_samples).toBe(2 * M_SAMPLES);
    expect(both.fade_out_samples).toBe(1000);
  });

  it("pulls fades inside when the clip is shortened", () => {
    const { song, trackId, a } = two();
    const faded = ops.setFades(song, trackId, a, { fadeIn: M_SAMPLES, fadeOut: M_SAMPLES }).song!;
    const shorter = clipOf(ops.setEnd(faded, trackId, a, MEASURE / 2).song!, a);
    expect(shorter.fade_in_samples + shorter.fade_out_samples).toBeLessThanOrEqual(shorter.length_samples);
  });

  it("duplicates immediately after the clip", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a"), 1);
    const dup = done(ops.duplicateClip(a.song, trackId, a.id));
    const copy = clipOf(dup.song!, dup.clipId!);
    expect(copy.start_ticks).toBe(MEASURE);
    expect(copy.id).not.toBe(a.id);
    expect(dup.song!.measures).toBe(2);
  });

  it("shortens a duplicate to the gap before the next clip", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 1);
    const b = place(a.song, trackId, sample("b"), 4);
    const dup = done(ops.duplicateClip(b.song, trackId, a.id));
    expect(clipOf(dup.song!, dup.clipId!)).toMatchObject({ start_ticks: 2 * MEASURE, length_samples: M_SAMPLES });
  });

  it("refuses a duplicate with no room", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 1);
    const b = place(a.song, trackId, sample("b"), 3);
    expect(ops.duplicateClip(b.song, trackId, a.id)).toEqual({ song: null, reason: "no-room" });
  });

  it("deletes a clip and shrinks the song", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 3), 1);
    const gone = ops.deleteClip(a.song, trackId, a.id).song!;
    expect(gone.tracks[0].audio_clips).toEqual([]);
    expect(gone.measures).toBe(1);
  });

  it("replaces the sample keeping position, gain, fades and loop", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 3);
    const tuned = ops.setGain(ops.setLoop(a.song, trackId, a.id, true).song!, trackId, a.id, -6).song!;
    const next = ops.replaceSample(tuned, trackId, a.id, sample("n", 1)).song!;
    expect(clipOf(next, a.id)).toMatchObject({
      sample_id: "n",
      start_ticks: 2 * MEASURE,
      offset_samples: 0,
      slice_samples: M_SAMPLES,
      length_samples: 2 * M_SAMPLES,
      gain_db: -6,
      loop: true,
    });
    expect(next.samples!.map((s) => s.id)).toContain("n");
  });

  it("shortens a non-looping clip to a shorter replacement", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 1);
    const next = ops.replaceSample(a.song, trackId, a.id, sample("n", 1)).song!;
    expect(clipOf(next, a.id).length_samples).toBe(M_SAMPLES);
  });

  it("reports an unknown clip", () => {
    const { song, trackId } = start();
    expect(ops.deleteClip(song, trackId, "nope")).toEqual({ song: null, reason: "not-found" });
  });
});

describe("song length and tempo with audio", () => {
  it("keeps a clip's start across a tempo change and moves its end", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 5);
    const slower = setTempo(a.song, 60);
    expect(clipOf(slower, a.id).start_ticks).toBe(4 * MEASURE);
    expect(clipOf(slower, a.id).length_samples).toBe(2 * M_SAMPLES);
    expect(slower.measures).toBe(5);
  });

  it("refuses a tempo change that would pass 128 measures", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 126);
    expect(setTempo(a.song, 240)).toBe(a.song);
    expect(setTempo(a.song, 60).tempo_bpm).toBe(60);
  });

  it("trims the earlier clip when a faster tempo would make touching clips overlap, as one undo step", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 1);
    const b = place(a.song, trackId, sample("b"), 3);
    const store = createSongStore(b.song);
    expect(store.getState().setTempo(121)).toBeNull();
    const faster = store.getState().song!;
    expect(faster.tempo_bpm).toBe(121);
    const first = clipOf(faster, a.id);
    expect(first.length_samples).toBeLessThan(2 * M_SAMPLES);
    expect(first.slice_samples).toBe(first.length_samples);
    expect(clipOf(faster, b.id).start_ticks).toBe(2 * MEASURE);
    expect(audioProblem(JSON.parse(JSON.stringify(faster)))).toBeNull();
    store.getState().undo();
    const restored = store.getState().song!;
    expect(restored.tempo_bpm).toBe(120);
    expect(clipOf(restored, a.id).length_samples).toBe(2 * M_SAMPLES);
  });

  it("refuses a time signature that would push audio past the limit", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 2), 127);
    expect(setTimeSignature(a.song, "3/4")).toBe(a.song);
  });

  it("is unaffected by swing", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a"), 2);
    const swung = { ...a.song, swing: 0.5 };
    expect(clipOf(swung, a.id).start_ticks).toBe(MEASURE);
    expect(ops.moveClip(swung, trackId, a.id, MEASURE).song).toBe(swung);
  });
});

describe("review fixes", () => {
  it("never lets a trimmed start push the clip's end into its neighbour at an awkward tempo", () => {
    const song0 = addTrack(newSong("4/4", 110), { id: "audio", name: "Audio" }, "Loops");
    const trackId = song0.tracks[0].id;
    const one: Sample = { id: "a", name: "a", sample_rate: 48000, channels: 1, length_samples: 48000, origin: "import" };
    const two = { ...one, id: "b" };
    // At 110 BPM one second is 1760 ticks, so these two clips touch exactly.
    const a = done(ops.placeSample(song0, trackId, one, 0));
    const b = done(ops.placeSample(a.song!, trackId, two, 1760));
    let current = b.song!;
    for (let step = 1; step <= 6; step++) {
      const trimmed = ops.trimStart(current, trackId, a.clipId!, step * 240).song!;
      expect(audioProblem(JSON.parse(JSON.stringify(trimmed)))).toBeNull();
      current = trimmed;
    }
    expect(clipOf(current, a.clipId!).start_ticks).toBeGreaterThan(0);
  });

  it("cuts sample names to 80 UTF-16 units without splitting an emoji", () => {
    const name = `${"a".repeat(79)}😀`;
    const cut = clipSampleName(name);
    expect(cut.length).toBeLessThanOrEqual(80);
    expect(cut).toBe("a".repeat(79));
    expect(toSample({ id: "x", name, sampleRate: 48000, channels: 1, length: 10, importedAt: 0 }).name.length).toBeLessThanOrEqual(80);
  });

  it("names later audio tracks Audio 2, Audio 3", () => {
    let song = newSong("4/4", 120);
    for (let i = 0; i < 3; i++) song = ops.addAudioTrack(song)!.song;
    expect(song.tracks.map((t) => t.name)).toEqual(["Audio", "Audio 2", "Audio 3"]);
  });

  it("keeps a shortened plain clip's slice equal to its length, so looping it later repeats only what is left", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a", 4), 1);
    const shorter = ops.setEnd(a.song, trackId, a.id, MEASURE, false).song!;
    expect(clipOf(shorter, a.id).slice_samples).toBe(M_SAMPLES);
    const looped = ops.setLoop(shorter, trackId, a.id, true).song!;
    const extended = clipOf(ops.setEnd(looped, trackId, a.id, 3 * MEASURE).song!, a.id);
    expect(extended.slice_samples).toBe(M_SAMPLES);
    expect(extended.length_samples).toBe(3 * M_SAMPLES);
  });

  it("converts audio starts per measure when the meter changes", () => {
    const { song, trackId } = start();
    const a = place(song, trackId, sample("a"), 3);
    const shifted = ops.moveClip(a.song, trackId, a.id, 2 * MEASURE + 960, false).song!;
    const converted = setTimeSignature(shifted, "3/4");
    // 3/4 has 12 steps of 240 ticks, so measure 3 starts at 5760 and the beat offset stays.
    expect(clipOf(converted, a.id).start_ticks).toBe(2 * 2880 + 960);
    expect(converted.time_signature).toBe("3/4");
  });

  it("refuses tone settings on an audio track", () => {
    const { song, trackId } = start();
    expect(setSound(song, trackId, { tone: { filter_cutoff_hz: 400 } })).toBe(song);
  });

  it("keeps a clip in place when its left edge is dragged past the sample's start", () => {
    const { song, trackId } = start();
    const a = done(ops.placeSample(song, trackId, sample("a"), 960));
    const moved = ops.trimStart(a.song!, trackId, a.clipId!, 480).song!;
    const c = clipOf(moved, a.clipId!);
    expect(c.start_ticks).toBe(960);
    expect(c.offset_samples).toBe(0);
  });

  it("names a track after a sample without splitting an emoji", () => {
    const made = ops.addAudioTrack(newSong("4/4", 120), `${"a".repeat(39)}😀`)!;
    expect(made.song.tracks[0].name).toBe("a".repeat(39));
  });
});
