import { describe, expect, it, vi } from "vitest";
import type { PcmSample } from "../audio/sampleAnalysis";
import type { RecordingInput } from "../audio/recorder/recordingInput";
import type { PeakReading, RecorderChunk } from "../audio/recorder/recorderTap";
import { MAX_SAMPLES, MAX_TAKES_PER_TRACK } from "../song/audioTiming";
import * as ops from "../song/audioClipOps";
import { addTrack } from "../song/songOps";
import { createSongStore } from "../song/songStore";
import { newSong, type Song } from "../song/types";
import { createAudioTake, nextTakeNumber, prepareAudioTake, type AudioSampleStore } from "./audioTake";
import type { AudioTakeOutcome } from "./take";

// 120 BPM in 4/4 at 48 kHz: a measure is 2 s, 96000 frames and 3840 ticks.
const RATE = 48000;
const MEASURE = 3840;
const M_FRAMES = 96000;

function fakeEngine() {
  const listeners = new Set<(w: { kind: "start" | "wrap" | "seek"; contextTime: number; songSeconds: number; measure: number }) => void>();
  return {
    isPlaying: false,
    markTake: () => ({ contextTime: 0, transportSeconds: 0, songSeconds: null, sampleRate: RATE, outputLatency: 0, baseLatency: 0 }),
    subscribeLoopWrap: (cb: (typeof listeners extends Set<infer T> ? T : never)) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (kind: "start" | "wrap" | "seek", contextTime: number, songSeconds = 0) =>
      listeners.forEach((cb) => cb({ kind, contextTime, songSeconds, measure: 1 })),
  };
}

function fakeInput(sampleRate = RATE) {
  let onChunk: ((c: RecorderChunk) => void) | null = null;
  let lost: (() => void) | null = null;
  const peakCbs = new Set<(p: PeakReading) => void>();
  const release = vi.fn();
  const input: RecordingInput = {
    tap: {
      startCapture: (cb) => (onChunk = cb),
      stopCapture: async () => {},
      subscribePeaks: (cb) => {
        peakCbs.add(cb);
        return () => peakCbs.delete(cb);
      },
      clipHeld: () => false,
      clearClip: () => {},
      dispose: async () => {},
    },
    sampleRate,
    channels: 1,
    inputLatency: 0,
    fellBack: false,
    release,
    onLost: (cb) => {
      lost = cb;
      return () => {
        lost = null;
      };
    },
  };
  // The frame number is the signal, so a take can be checked for exactly which frames it kept.
  const feed = (from: number, to: number) => {
    const data = Float32Array.from({ length: to - from }, (_, i) => (from + i) / 10_000_000);
    onChunk?.({ frame: from, channels: [data] });
  };
  return { input, feed, release, lose: () => lost?.(), peak: (peak: number) => peakCbs.forEach((cb) => cb({ frame: 0, peak })) };
}

function fakeAudio(over: Partial<AudioSampleStore> = {}) {
  const stored: PcmSample[] = [];
  const unpin = vi.fn();
  const audio: AudioSampleStore = {
    putSample: async (pcm) => {
      stored.push(pcm);
      // First frame's value identifies the pass, which a content hash would also make unique.
      return { id: `h${pcm.data[0].toFixed(7)}-${pcm.data.length}`, unpin };
    },
    ...over,
  };
  return { audio, stored, unpin };
}

function setup() {
  const base = addTrack(newSong("4/4", 120), { id: "audio", name: "Audio" }, "Vocals");
  const trackId = base.tracks[0].id;
  const store = createSongStore(base);
  return { store, trackId, song: () => store.getState().song as Song };
}

const settle = async (target: ReturnType<typeof createAudioTake>): Promise<AudioTakeOutcome> => {
  const summary = target.end();
  return summary.settled!;
};

describe("audio take", () => {
  it("Record a vocal from stopped: one take, and one clip from measure 1 that plays it", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    const { input, feed, release } = fakeInput();
    const { audio, stored } = fakeAudio();
    const target = createAudioTake(store, audio, trackId, engine as never, input, { offsetMs: () => 0 });

    target.begin();
    // The count-in bar is captured too, and must be left out.
    expect(store.getState().recording).toMatchObject({ trackId, startTicks: 0, started: false, takeName: "Vocals Take 1", pass: 1 });
    engine.emit("start", 12);
    feed(10 * RATE, 12 * RATE + 8 * M_FRAMES);
    const outcome = await settle(target);

    expect(outcome).toMatchObject({ kind: "saved", takeName: "Vocals Take 1", takes: 1, measures: 8 });
    const [clip] = song().tracks[0].audio_clips!;
    expect(clip).toMatchObject({ start_ticks: 0, offset_samples: 0, length_samples: 8 * M_FRAMES, loop: false });
    expect(song().samples).toEqual([
      expect.objectContaining({ id: clip.sample_id, name: "Vocals Take 1", origin: "recording", track_id: trackId, recorded_at_ticks: 0, sample_rate: RATE, channels: 1 }),
    ]);
    expect(stored[0].data[0]).toBeCloseTo((12 * RATE) / 10_000_000, 7);
    expect(store.getState().recording).toBeNull();
    expect(release).toHaveBeenCalled();
  });

  it("Three passes: three takes, and the clip over measures 1-4 plays the third", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    const { input, feed } = fakeInput();
    const { audio } = fakeAudio();
    const target = createAudioTake(store, audio, trackId, engine as never, input, { offsetMs: () => 0 });
    const pass = 4 * M_FRAMES;

    target.begin();
    engine.emit("start", 10);
    feed(10 * RATE, 10 * RATE + pass);
    engine.emit("wrap", 10 + 8);
    expect(store.getState().recording?.pass).toBe(2);
    feed(10 * RATE + pass, 10 * RATE + 2 * pass);
    engine.emit("wrap", 10 + 16);
    feed(10 * RATE + 2 * pass, 10 * RATE + 3 * pass);
    const outcome = await settle(target);

    expect(outcome).toMatchObject({ kind: "saved", takes: 3, takeName: "Vocals Take 3", measures: 4 });
    expect(song().samples!.map((s) => s.name)).toEqual(["Vocals Take 1", "Vocals Take 2", "Vocals Take 3"]);
    const clips = song().tracks[0].audio_clips!;
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ start_ticks: 0, length_samples: pass });
    expect(clips[0].sample_id).toBe(song().samples![2].id);
    // Gapless: the passes are consecutive slices of one capture, cut at the wrap frames.
    expect(song().samples!.every((s) => s.length_samples === pass)).toBe(true);
  });

  it("One undo per session: the clip goes and the earlier clip comes back as it was", async () => {
    const { store, trackId, song } = setup();
    const earlier = {
      id: "old",
      name: "Old",
      sample_rate: RATE,
      channels: 1,
      length_samples: 8 * M_FRAMES,
      origin: "recording",
      track_id: trackId,
      recorded_at_ticks: 0,
    };
    const placed = ops.placeSample(song(), trackId, earlier, 0);
    store.getState().loadSong(placed.song!);
    const before = song();
    const engine = fakeEngine();
    const { input, feed } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });

    target.begin();
    expect(store.getState().recording).toMatchObject({ takeName: "Vocals Take 1" });
    engine.emit("start", 10, 4);
    // Punching in over measures 3-4 of the earlier take.
    feed(10 * RATE, 10 * RATE + 2 * M_FRAMES);
    await settle(target);

    const clips = song().tracks[0].audio_clips!;
    expect(clips.map((c) => [c.start_ticks, c.length_samples])).toEqual([
      [0, 2 * M_FRAMES],
      [2 * MEASURE, 2 * M_FRAMES],
      [4 * MEASURE, 4 * M_FRAMES],
    ]);
    store.getState().undo();
    expect(song()).toBe(before);
    // Loading a song is not history, so the one step undone was the whole session.
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(1);
  });

  it("Record past the end of a short song: the run is kept going, and the song grows to hold the take", async () => {
    const { store, trackId, song } = setup();
    expect(song().measures).toBe(1);
    const claim = { settle: vi.fn(), release: vi.fn() };
    const claimOpenEnded = vi.fn(() => claim);
    const engine = { ...fakeEngine(), claimOpenEnded };
    const { input, feed } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });

    target.begin();
    expect(claimOpenEnded).toHaveBeenCalledTimes(1);
    engine.emit("start", 10);
    feed(10 * RATE, 10 * RATE + 3 * M_FRAMES);
    const settled = target.end().settled!;
    // Held until the song has been extended, or the run would stop at the old end and cut playback off mid-bar.
    expect(claim.settle).toHaveBeenCalledTimes(1);
    expect(claim.release).not.toHaveBeenCalled();
    expect(song().measures).toBe(1);

    expect(await settled).toMatchObject({ kind: "saved", measures: 3 });
    expect(claim.release).toHaveBeenCalledTimes(1);
    expect(song().measures).toBe(3);
    expect(song().tracks[0].audio_clips![0]).toMatchObject({ start_ticks: 0, length_samples: 3 * M_FRAMES });
  });

  it("discarding a take that never began leaves another take's overlay and claim alone", async () => {
    const { store, trackId } = setup();
    const claim = { settle: vi.fn(), release: vi.fn() };
    const engine = { ...fakeEngine(), claimOpenEnded: () => claim };
    const running = createAudioTake(store, fakeAudio().audio, trackId, engine as never, fakeInput().input);
    running.begin();
    const overlay = store.getState().recording;
    expect(overlay).not.toBeNull();

    const idle = fakeInput();
    const neverBegun = createAudioTake(store, fakeAudio().audio, trackId, engine as never, idle.input);
    neverBegun.discard();
    await vi.waitFor(() => expect(idle.release).toHaveBeenCalled());
    expect(store.getState().recording).toBe(overlay);
    expect(claim.release).not.toHaveBeenCalled();
  });

  it("a finishing take clears only its own overlay, not the next take's", async () => {
    const { store, trackId } = setup();
    const engine = fakeEngine();
    const first = fakeInput();
    const a = createAudioTake(store, fakeAudio().audio, trackId, engine as never, first.input, { offsetMs: () => 0 });
    a.begin();
    engine.emit("start", 10);
    first.feed(10 * RATE, 10 * RATE + M_FRAMES);
    const saving = a.end().settled!;
    const b = createAudioTake(store, fakeAudio().audio, trackId, engine as never, fakeInput().input);
    b.begin();
    const next = store.getState().recording;
    await saving;
    expect(store.getState().recording).toBe(next);
  });

  it("records where each take sat in the song, so it can be lined up later", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    const { input, feed } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    target.begin();
    engine.emit("start", 10, 4);
    feed(10 * RATE, 10 * RATE + M_FRAMES);
    await settle(target);
    // Song time 4 s is measure 3.
    expect(song().samples![0].recorded_at_ticks).toBe(2 * MEASURE);
  });

  it("Seek while recording: a jump with looping off ends the take, keeping what came before it", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    const { input, feed } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    const limit = vi.fn();
    target.onLimit!(limit);
    target.begin();
    engine.emit("start", 10);
    feed(10 * RATE, 10 * RATE + M_FRAMES);
    engine.emit("seek", 10 + 2, 12);
    feed(10 * RATE + M_FRAMES, 10 * RATE + 2 * M_FRAMES);
    expect(limit).toHaveBeenCalledWith("seek");
    expect(await settle(target)).toMatchObject({ kind: "saved", takes: 1, limit: "seek" });
    // Only the audio before the jump became a take, however much was captured after it.
    expect(song().tracks[0].audio_clips![0].length_samples).toBe(M_FRAMES);
  });

  it("Stop just after the loop restarts: a last pass shorter than a beat is dropped, and the clip plays the one before", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    const { input, feed } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    target.begin();
    engine.emit("start", 10);
    feed(10 * RATE, 10 * RATE + M_FRAMES);
    engine.emit("wrap", 12);
    // A beat at 120 BPM is half a second; this pass got a tenth of one.
    feed(10 * RATE + M_FRAMES, 10 * RATE + M_FRAMES + Math.round(0.05 * RATE));
    const outcome = await settle(target);
    expect(outcome).toMatchObject({ kind: "saved", takes: 1, takeName: "Vocals Take 1" });
    expect(song().samples).toHaveLength(1);
    expect(song().tracks[0].audio_clips![0].sample_id).toBe(song().samples![0].id);
  });

  it("keeps a last pass of a beat or more", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    const { input, feed } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    target.begin();
    engine.emit("start", 10);
    feed(10 * RATE, 10 * RATE + M_FRAMES);
    engine.emit("wrap", 12);
    feed(10 * RATE + M_FRAMES, 10 * RATE + M_FRAMES + RATE);
    expect(await settle(target)).toMatchObject({ kind: "saved", takes: 2 });
    expect(song().samples).toHaveLength(2);
  });

  it("names takes after the highest number on the track, not the count", () => {
    const sample = (name: string, track = "t") => ({ id: name, name, sample_rate: RATE, channels: 1, length_samples: 1, origin: "recording", track_id: track, recorded_at_ticks: 0 });
    expect(nextTakeNumber([], "t", "Vocals")).toBe(1);
    expect(nextTakeNumber([sample("Vocals Take 3"), sample("Vocals Take 1")], "t", "Vocals")).toBe(4);
    expect(nextTakeNumber([sample("Vocals Take 9", "other"), sample("Renamed")], "t", "Vocals")).toBe(1);
  });

  it("a failed write discards the take and leaves the song as it was", async () => {
    const { store, trackId, song } = setup();
    const before = song();
    const pastBefore = store.getState().past.length;
    const engine = fakeEngine();
    const { input, feed, release } = fakeInput();
    const { audio } = fakeAudio({ putSample: () => Promise.reject(new Error("QuotaExceededError")) });
    const target = createAudioTake(store, audio, trackId, engine as never, input, { offsetMs: () => 0 });

    target.begin();
    engine.emit("start", 10);
    feed(10 * RATE, 10 * RATE + M_FRAMES);
    expect(await settle(target)).toEqual({ kind: "failed", reason: "storage" });
    expect(song()).toBe(before);
    expect(store.getState().past).toHaveLength(pastBefore);
    expect(release).toHaveBeenCalled();
  });

  it("keeps stored audio pinned until the song holds it, then lets go, and pins nothing when no audio was stored", async () => {
    const ok = setup();
    const okAudio = fakeAudio();
    const okInput = fakeInput();
    const okEngine = fakeEngine();
    const take = createAudioTake(ok.store, okAudio.audio, ok.trackId, okEngine as never, okInput.input, { offsetMs: () => 0 });
    take.begin();
    okEngine.emit("start", 10);
    okInput.feed(10 * RATE, 10 * RATE + M_FRAMES);
    const done = take.end().settled!;
    expect(okAudio.unpin).not.toHaveBeenCalled();
    await done;
    expect(okAudio.unpin).toHaveBeenCalledTimes(1);

    const bad = setup();
    const badAudio = fakeAudio();
    const badInput = fakeInput();
    const badEngine = fakeEngine();
    const failing = createAudioTake(bad.store, badAudio.audio, bad.trackId, badEngine as never, badInput.input, { offsetMs: () => 0 });
    failing.begin();
    badEngine.emit("start", 10);
    badInput.feed(10 * RATE, 10 * RATE + M_FRAMES);
    bad.store.getState().deleteTrack(bad.trackId);
    await failing.end().settled;
    expect(badAudio.unpin).not.toHaveBeenCalled();
  });

  it("asks the page to stop when the input is lost, and keeps what was recorded", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    const { input, feed, lose } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    const limit = vi.fn();
    target.onLimit!(limit);
    target.begin();
    engine.emit("start", 10);
    feed(10 * RATE, 10 * RATE + M_FRAMES);
    lose();
    expect(limit).toHaveBeenCalledWith("input");
    expect(await settle(target)).toMatchObject({ kind: "saved", limit: "input", trackName: "Vocals" });
    expect(song().tracks[0].audio_clips).toHaveLength(1);
  });

  it("changes nothing when the song no longer has the track", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    const { input, feed } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    target.begin();
    engine.emit("start", 10);
    feed(10 * RATE, 10 * RATE + M_FRAMES);
    store.getState().deleteTrack(trackId);
    const after = song();
    expect(await settle(target)).toEqual({ kind: "empty", trackName: "Vocals", limit: undefined });
    expect(song()).toBe(after);
  });

  it("applies the latencies and the user offset to where the take lands", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    engine.markTake = () => ({ contextTime: 0, transportSeconds: 0, songSeconds: null, sampleRate: RATE, outputLatency: 0.01, baseLatency: 0 });
    const { input, feed } = fakeInput();
    input.inputLatency = 0.008;
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    target.begin();
    // Song time 2 s (measure 2) is reached at context time 10; the clap is heard and captured 18 ms later.
    engine.emit("start", 10, 2);
    feed(10 * RATE, 10 * RATE + M_FRAMES);
    await settle(target);
    // The audio that arrives 18 ms after the punch is what the player played on the beat, so it sits on it.
    const [clip] = song().tracks[0].audio_clips!;
    expect(Math.abs(clip.start_ticks - MEASURE)).toBeLessThan(2);
  });

  it("asks the page to stop at the take limit and keeps what was recorded", async () => {
    const { store, trackId, song } = setup();
    const withTakes = {
      ...song(),
      samples: Array.from({ length: MAX_TAKES_PER_TRACK - 1 }, (_, i) => ({
        id: `x${i}`, name: `Vocals Take ${i + 1}`, sample_rate: RATE, channels: 1, length_samples: 1, origin: "recording", track_id: trackId, recorded_at_ticks: 0,
      })),
    };
    store.getState().loadSong(withTakes);
    const engine = fakeEngine();
    const { input, feed } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    const limit = vi.fn();
    target.onLimit!(limit);

    target.begin();
    engine.emit("start", 10);
    feed(10 * RATE, 10 * RATE + M_FRAMES);
    // The 64th take is this pass; the wrap would need a 65th.
    engine.emit("wrap", 10 + 2);
    feed(10 * RATE + M_FRAMES, 10 * RATE + 2 * M_FRAMES);
    expect(limit).toHaveBeenCalledWith("takes");
    const outcome = await settle(target);
    expect(outcome).toMatchObject({ kind: "saved", takes: 1, limit: "takes" });
    expect(song().tracks[0].audio_clips![0].length_samples).toBe(M_FRAMES);
  });

  // A low rate keeps twenty minutes of audio small enough to build in a test.
  it("stops by itself after 20 minutes of audio", () => {
    const { store, trackId } = setup();
    const engine = fakeEngine();
    const { input, feed } = fakeInput(100);
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    const limit = vi.fn();
    target.onLimit!(limit);
    target.begin();
    engine.emit("start", 0);
    // A wrap every 100 s keeps each pass inside the song, so only the duration can stop it.
    for (let s = 0; s < 1200; s += 100) {
      if (s) engine.emit("wrap", s);
      feed(s * 100, s * 100 + (s === 1100 ? 9999 : 10000));
      expect(limit).not.toHaveBeenCalled();
    }
    feed(1200 * 100 - 1, 1200 * 100);
    expect(limit).toHaveBeenCalledWith("duration");
  });

  it("stops at measure 128 and keeps the clip inside the song", async () => {
    const { store, trackId, song } = setup();
    const engine = fakeEngine();
    const { input, feed } = fakeInput(100);
    const target = createAudioTake(store, fakeAudio().audio, trackId, engine as never, input, { offsetMs: () => 0 });
    const limit = vi.fn();
    target.onLimit!(limit);
    target.begin();
    engine.emit("start", 0);
    // 128 measures of 2 s is 256 s.
    feed(0, 255 * 100);
    expect(limit).not.toHaveBeenCalled();
    feed(255 * 100, 258 * 100);
    expect(limit).toHaveBeenCalledWith("song");
    expect(await settle(target)).toMatchObject({ kind: "saved", limit: "song" });
    expect(song().measures).toBe(128);
    expect(song().tracks[0].audio_clips![0].length_samples).toBe(256 * 100);
  });

  it("discarding leaves no overlay, no change, and releases the input", async () => {
    const { store, trackId, song } = setup();
    const before = song();
    const { input, release } = fakeInput();
    const target = createAudioTake(store, fakeAudio().audio, trackId, fakeEngine() as never, input);
    target.begin();
    target.discard();
    await Promise.resolve();
    expect(store.getState().recording).toBeNull();
    expect(song()).toBe(before);
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
  });
});

describe("preparing an audio take", () => {
  const engine = () => ({ ...fakeEngine(), prepareInput: async () => ({}) as never });
  const open = (input = fakeInput().input) => async () => ({ input });

  it("refuses before asking for the input when the track is full of takes", async () => {
    const { store, trackId, song } = setup();
    store.getState().loadSong({
      ...song(),
      samples: Array.from({ length: MAX_TAKES_PER_TRACK }, (_, i) => ({
        id: `x${i}`, name: `T${i}`, sample_rate: RATE, channels: 1, length_samples: 1, origin: "recording", track_id: trackId, recorded_at_ticks: 0,
      })),
    });
    const openInput = vi.fn();
    expect(await prepareAudioTake(store, fakeAudio().audio, trackId, engine() as never, { openInput })).toEqual({ reason: "takes-full" });
    expect(openInput).not.toHaveBeenCalled();
  });

  it("refuses when the song already holds the most samples", async () => {
    const { store, trackId, song } = setup();
    store.getState().loadSong({
      ...song(),
      samples: Array.from({ length: MAX_SAMPLES }, (_, i) => ({
        id: `x${i}`, name: `S${i}`, sample_rate: RATE, channels: 1, length_samples: 1, origin: "import",
      })),
    });
    expect(await prepareAudioTake(store, fakeAudio().audio, trackId, engine() as never, { openInput: open() as never })).toEqual({ reason: "samples-full" });
  });

  it("passes on a denied permission or a missing input", async () => {
    const { store, trackId } = setup();
    for (const reason of ["denied", "no-input"] as const) {
      expect(
        await prepareAudioTake(store, fakeAudio().audio, trackId, engine() as never, { openInput: (async () => ({ reason })) as never }),
      ).toEqual({ reason });
    }
  });

  it("refuses without room in browser storage and releases the input it opened", async () => {
    const { store, trackId } = setup();
    const { input, release } = fakeInput();
    const result = await prepareAudioTake(store, fakeAudio().audio, trackId, engine() as never, {
      openInput: open(input) as never,
      estimate: async () => ({ quota: 1000, usage: 999 }),
    });
    expect(result).toEqual({ reason: "no-space" });
    expect(release).toHaveBeenCalled();
  });

  it("returns a take target when everything allows it", async () => {
    const { store, trackId } = setup();
    const result = await prepareAudioTake(store, fakeAudio().audio, trackId, engine() as never, {
      openInput: open() as never,
      estimate: async () => undefined,
    });
    expect(result).toHaveProperty("target");
  });
});
