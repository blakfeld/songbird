import { describe, expect, it } from "vitest";
import type { AudioClip } from "@/generated/AudioClip";
import type { Sample } from "@/generated/Sample";
import { audioProblem } from "./song/audioValidation";
import { addTrack, normalizeSong } from "./song/songOps";
import { newSong, type Section, type Song } from "./song/types";
import * as ops from "./songSectionOps";

// At 120 BPM and 48 kHz a 4/4 measure is 3840 ticks and 96000 samples.
const MEASURE = 3840;
const M_SAMPLES = 96000;

const sample = (measures: number, rate = 48000): Sample => ({
  id: "s",
  name: "s",
  sample_rate: rate,
  channels: 2,
  length_samples: measures * M_SAMPLES,
  origin: "import",
});

const clip = (id: string, startMeasure: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id,
  sample_id: "s",
  start_ticks: (startMeasure - 1) * MEASURE,
  offset_samples: 0,
  slice_samples: 8 * M_SAMPLES,
  length_samples: 8 * M_SAMPLES,
  loop: false,
  gain_db: 0,
  fade_in_samples: 0,
  fade_out_samples: 0,
  ...over,
});

const section = (id: string, name: string, measures: number): Section => ({ id, name, kind: "other", measures, notes: "" });

function songWith(clips: AudioClip[], sections: Section[], s: Sample = sample(8)): Song {
  const base = addTrack({ ...newSong("4/4", 120), samples: [s] }, { id: "audio", name: "Audio" }, "Vocals");
  const song = { ...base, tracks: [{ ...base.tracks[0], audio_clips: clips }], sections, measures: sections.reduce((n, x) => n + x.measures, 0) };
  return normalizeSong(song);
}

const audio = (song: Song) => song.tracks[0].audio_clips!;
const ok = (r: ops.SectionOpResult) => {
  expect(r.song).not.toBeNull();
  return r.song as Song;
};
const valid = (song: Song) => expect(audioProblem(JSON.parse(JSON.stringify(song)))).toBeNull();

describe("audio follows a section edit", () => {
  const base = () => songWith([clip("a", 5, { length_samples: 7 * M_SAMPLES })], [section("x", "A", 8), section("y", "B", 4)]);

  it("splits a clip across an insertion, leaving the inserted measures silent", () => {
    const next = ok(ops.insertSection(base(), { kind: "verse", measures: 4 }, "x", "after"));
    const [head, tail] = audio(next);
    expect([head.start_ticks, head.length_samples]).toEqual([4 * MEASURE, 4 * M_SAMPLES]);
    // The tail starts at measure 13 and plays what measures 9-11 played before: the sample from measure 4 on.
    expect([tail.start_ticks, tail.offset_samples, tail.length_samples]).toEqual([12 * MEASURE, 4 * M_SAMPLES, 3 * M_SAMPLES]);
    expect(tail.slice_samples).toBe(4 * M_SAMPLES);
    valid(next);
  });

  it("keeps the fade-in on the head and the fade-out on the tail only", () => {
    const song = songWith(
      [clip("a", 5, { length_samples: 7 * M_SAMPLES, fade_in_samples: 1000, fade_out_samples: 2000 })],
      [section("x", "A", 8), section("y", "B", 4)],
    );
    const [head, tail] = audio(ok(ops.insertSection(song, { kind: "verse", measures: 4 }, "x", "after")));
    expect([head.fade_in_samples, head.fade_out_samples]).toEqual([1000, 0]);
    expect([tail.fade_in_samples, tail.fade_out_samples]).toEqual([0, 2000]);
  });

  it("clamps a fade that is longer than its piece to that piece and adds none at the cut", () => {
    // Clip from measure 5 is cut after one measure; its 3-measure fade-in cannot fit the 1-measure head.
    const song = songWith(
      [clip("a", 5, { length_samples: 7 * M_SAMPLES, fade_in_samples: 3 * M_SAMPLES, fade_out_samples: 2 * M_SAMPLES })],
      [section("x", "A", 5), section("y", "B", 7)],
    );
    const [head, tail] = audio(ok(ops.insertSection(song, { kind: "verse", measures: 2 }, "x", "after")));
    expect(head.length_samples).toBe(M_SAMPLES);
    expect([head.fade_in_samples, head.fade_out_samples]).toEqual([M_SAMPLES, 0]);
    expect([tail.fade_in_samples, tail.fade_out_samples]).toEqual([0, 2 * M_SAMPLES]);
    valid(ok(ops.insertSection(song, { kind: "verse", measures: 2 }, "x", "after")));
  });

  it("moves later audio and leaves earlier audio", () => {
    const song = songWith([clip("e", 1, { length_samples: M_SAMPLES }), clip("l", 9, { length_samples: M_SAMPLES })], [section("x", "A", 8), section("y", "B", 4)]);
    const next = ok(ops.insertSection(song, { kind: "verse", measures: 4 }, "x", "after"));
    expect(audio(next).map((c) => c.start_ticks)).toEqual([0, 12 * MEASURE]);
  });

  it("splits a looping clip on a repeat so it continues at the same loop position", () => {
    const song = songWith(
      [clip("a", 1, { loop: true, slice_samples: M_SAMPLES, length_samples: 6 * M_SAMPLES })],
      [section("x", "A", 4), section("y", "B", 2)],
    );
    const [head, tail] = audio(ok(ops.insertSection(song, { kind: "verse", measures: 2 }, "x", "after")));
    expect([head.length_samples, head.loop]).toEqual([4 * M_SAMPLES, true]);
    expect([tail.start_ticks, tail.offset_samples, tail.slice_samples, tail.length_samples, tail.loop]).toEqual([
      6 * MEASURE, 0, M_SAMPLES, 2 * M_SAMPLES, true,
    ]);
  });

  it("refuses to cut a looping clip mid-loop and names the audio track", () => {
    const song = songWith(
      [clip("a", 1, { loop: true, slice_samples: 3 * M_SAMPLES, length_samples: 6 * M_SAMPLES })],
      [section("x", "A", 4), section("y", "B", 2)],
    );
    const result = ops.insertSection(song, { kind: "verse", measures: 2 }, "x", "after");
    expect(result).toMatchObject({ song: null, reason: "loop-split", track: "Vocals" });
    expect(ops.describeRefusal(result as ops.Refusal)).toBe(
      "Vocals has a looping audio clip this edit would cut mid-loop. Turn its Loop off or trim it first.",
    );
  });

  it("deletes audio inside a removed span and closes up what follows", () => {
    const song = songWith(
      [clip("in", 3, { length_samples: M_SAMPLES }), clip("long", 5, { length_samples: 6 * M_SAMPLES }), clip("late", 12, { length_samples: M_SAMPLES })],
      [section("x", "A", 4), section("y", "B", 4), section("z", "C", 4)],
    );
    const next = ok(ops.deleteSection(song, "x"));
    expect(audio(next).map((c) => [c.id, c.start_ticks, c.length_samples])).toEqual([
      ["long", 0, 6 * M_SAMPLES],
      ["late", 7 * MEASURE, M_SAMPLES],
    ]);
    valid(next);
  });

  it("keeps the head of a clip crossing the start of a removed span, without a fade-out", () => {
    const song = songWith(
      [clip("a", 1, { length_samples: 6 * M_SAMPLES, fade_out_samples: 500 })],
      [section("x", "A", 4), section("y", "B", 2), section("z", "C", 2)],
    );
    const next = ok(ops.deleteSection(song, "y"));
    expect(audio(next)).toHaveLength(1);
    expect(audio(next)[0]).toMatchObject({ length_samples: 4 * M_SAMPLES, fade_out_samples: 0 });
  });

  it("copies a duplicated section's audio, split at both edges", () => {
    const song = songWith([clip("a", 3, { length_samples: 4 * M_SAMPLES })], [section("x", "A", 4), section("y", "B", 4)]);
    const next = ok(ops.duplicateSection(song, "y"));
    const starts = audio(next).map((c) => [c.start_ticks / MEASURE + 1, c.length_samples / M_SAMPLES, c.offset_samples / M_SAMPLES]);
    expect(starts).toEqual([
      [3, 2, 0],
      [5, 2, 2],
      [9, 2, 2],
    ]);
    valid(next);
  });

  it("rounds a cut that falls between samples down so the head never overlaps the tail", () => {
    // 100 BPM at 44.1 kHz is 27.5625 samples per tick, so most barlines fall between samples.
    const rate = 44100;
    const measureSamples = (3840 * rate) / 1600;
    const s = { ...sample(8, rate), length_samples: Math.ceil(measureSamples * 8) };
    const base = { ...songWith([], [section("x", "A", 4), section("y", "B", 2)], s), tempo_bpm: 100 };
    const song = { ...base, tracks: [{ ...base.tracks[0], audio_clips: [clip("a", 1, { slice_samples: s.length_samples, length_samples: Math.floor(measureSamples * 6) })] }] };
    const next = ok(ops.insertSection(song, { kind: "verse", measures: 2 }, "x", "after"));
    const [head, tail] = audio(next);
    expect(head.length_samples).toBe(Math.floor(measureSamples * 4));
    expect(tail.offset_samples).toBe(head.length_samples);
    expect(audioProblem(JSON.parse(JSON.stringify(next)))).toBeNull();
  });

  it("refuses an edit that would pass 256 audio clips and names the track", () => {
    const clips = Array.from({ length: 256 }, (_, i) => clip(`c${i}`, 1, { start_ticks: i * 2, length_samples: 1, slice_samples: 1 }));
    const wide = clip("wide", 1, { start_ticks: 600, length_samples: 20 * M_SAMPLES, slice_samples: 20 * M_SAMPLES });
    const song = songWith([...clips.slice(0, 255), wide].map((c, i) => (i < 255 ? c : { ...c, start_ticks: 1000 })), [section("x", "A", 4), section("y", "B", 20)], sample(20));
    const result = ops.insertSection(song, { kind: "verse", measures: 2 }, "x", "after");
    expect(result).toMatchObject({ song: null, reason: "clip-limit", track: "Vocals" });
  });

  it("lengthens the last section when audio runs past it, like a clip does", () => {
    const song = songWith([clip("a", 1, { length_samples: 6 * M_SAMPLES })], [section("x", "A", 4)]);
    expect(song.sections![0].measures).toBe(6);
    expect(song.measures).toBe(6);
  });
});
