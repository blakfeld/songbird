import { describe, expect, it, vi } from "vitest";
import { audioTakeMessage } from "@/components/editor/recordingMessages";
import type { RecordingInput } from "../audio/recorder/recordingInput";
import type { RecorderChunk } from "../audio/recorder/recorderTap";
import * as ops from "../song/audioClipOps";
import { addTrack, normalizeSong } from "../song/songOps";
import { createSongStore } from "../song/songStore";
import type { Sample } from "@/generated/Sample";
import { newSong, type Song } from "../song/types";
import { createAudioTake, type AudioSampleStore } from "./audioTake";
import type { AudioTakeLimit } from "./take";

// 120 BPM in 4/4 at 48 kHz: a measure is 2 s, 96000 frames and 3840 ticks.
const RATE = 48000;
const M_FRAMES = 96000;
const MEASURE = 3840;

const engine = () => {
  const listeners = new Set<(w: { kind: "start" | "wrap" | "seek"; contextTime: number; songSeconds: number; measure: number }) => void>();
  return {
    isPlaying: false,
    markTake: () => ({ contextTime: 0, transportSeconds: 0, songSeconds: null, sampleRate: RATE, outputLatency: 0, baseLatency: 0 }),
    subscribeLoopWrap: (cb: (w: { kind: "start" | "wrap" | "seek"; contextTime: number; songSeconds: number; measure: number }) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    start: (contextTime: number) => listeners.forEach((cb) => cb({ kind: "start", contextTime, songSeconds: 0, measure: 1 })),
  };
};

function input() {
  let onChunk: ((c: RecorderChunk) => void) | null = null;
  const real: RecordingInput = {
    tap: {
      startCapture: (cb) => (onChunk = cb),
      stopCapture: async () => {},
      subscribePeaks: () => () => {},
      clipHeld: () => false,
      clearClip: () => {},
      dispose: async () => {},
    },
    sampleRate: RATE,
    channels: 1,
    inputLatency: 0,
    fellBack: false,
    release: vi.fn(),
  };
  return { input: real, feed: (from: number, to: number) => onChunk?.({ frame: from, channels: [new Float32Array(to - from)] }) };
}

const audio: AudioSampleStore = { putSample: async (pcm) => ({ id: `h${pcm.data.length}`, unpin: () => {} }) };

// A single two-measure section reaches measure 32 and no further.
function sectioned(): { store: ReturnType<typeof createSongStore>; trackId: string; song: () => Song } {
  const base = addTrack(newSong("4/4", 120), { id: "audio", name: "Audio" }, "Vocals");
  const song = normalizeSong({
    ...base,
    measures: 2,
    sections: [{ id: "s", name: "Verse", kind: "verse", measures: 2, notes: "" }],
  });
  const store = createSongStore(song);
  return { store, trackId: song.tracks[0].id, song: () => store.getState().song as Song };
}

describe("recording in a sectioned song", () => {
  it("stops at the furthest measure the last section can reach, keeps what fits, and says why", async () => {
    const { store, trackId, song } = sectioned();
    const e = engine();
    const { input: i, feed } = input();
    const target = createAudioTake(store, audio, trackId, e as never, i, { offsetMs: () => 0 });
    const limits: AudioTakeLimit[] = [];
    target.onLimit?.((l) => limits.push(l));
    target.begin();
    e.start(10);
    feed(10 * RATE, 10 * RATE + 40 * M_FRAMES);
    const outcome = await target.end().settled!;
    expect(limits).toEqual(["section"]);
    expect(outcome).toMatchObject({ kind: "saved", limit: "section" });
    expect(song().measures).toBe(32);
    expect(song().sections![0].measures).toBe(32);
    expect(song().tracks[0].audio_clips![0].length_samples).toBe(32 * M_FRAMES);
    expect(audioTakeMessage(outcome)).toMatch(/last section can reach/);
  });

  it("refuses to place a take past the reach with the section-limit reason", () => {
    const { song, trackId } = sectioned();
    const take: Sample = { id: "t", name: "Vocals Take 1", sample_rate: RATE, channels: 1, length_samples: 2 * M_FRAMES, origin: "recording", track_id: trackId, recorded_at_ticks: 31 * MEASURE };
    const result = ops.recordTake(song(), trackId, [take], {
      sampleId: "t",
      startTicks: 31 * MEASURE,
      offsetSamples: 0,
      lengthSamples: 2 * M_FRAMES,
    });
    expect(result).toMatchObject({ song: null, reason: "section-limit" });
  });
});
