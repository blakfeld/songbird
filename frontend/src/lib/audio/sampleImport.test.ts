import "fake-indexeddb/auto";
import { clear, createStore } from "idb-keyval";
import { Blob as NodeBlob } from "node:buffer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listLibrary } from "./sampleLibrary";
import { importAudioFiles, type DecodedAudio } from "./sampleImport";
import { listStoredSampleIds, readSamplePcm } from "./sampleStore";

// jsdom's Blob is not structured-cloneable by fake-indexeddb, unlike the real one in a browser.
beforeAll(() => {
  vi.stubGlobal("Blob", NodeBlob);
});

beforeEach(async () => {
  await clear(createStore("songbird-samples.test-user", "samples"));
  await clear(createStore("songbird-sample-library.test-user", "library"));
});

const file = (name: string, bytes = 8) => new File([new Uint8Array(bytes)], name);

const tone = (frames: number, channels = 1, sampleRate = 48000): DecodedAudio => ({
  sampleRate,
  channels: Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => Math.sin(i / 10 + c)),
  ),
});

const decodeAs = (by: Record<string, DecodedAudio>) => async (data: ArrayBuffer) => {
  const key = String(new Uint8Array(data)[0]);
  const hit = by[key];
  if (!hit) throw new Error("EncodingError");
  return hit;
};

const tagged = (name: string, tag: number) => new File([new Uint8Array([tag, 0, 0, 0])], name);

describe("importAudioFiles", () => {
  it("imports a WAV loop as a named sample in the library", async () => {
    const { outcomes } = await importAudioFiles([tagged("breakbeat-120.wav", 1)], {
      decode: decodeAs({ "1": tone(48000) }),
    });
    expect(outcomes[0]).toMatchObject({ ok: true, entry: { name: "breakbeat-120", length: 48000, channels: 1 } });
    expect((await listLibrary()).map((e) => e.name)).toEqual(["breakbeat-120"]);
    const stored = await readSamplePcm((await listLibrary())[0].id);
    expect(stored?.data).toHaveLength(48000);
  });

  it("skips an unsupported file and still imports the rest", async () => {
    const { outcomes } = await importAudioFiles([tagged("notes.txt", 9), tagged("kick.wav", 1)], {
      decode: decodeAs({ "1": tone(100) }),
    });
    expect(outcomes[0]).toMatchObject({
      ok: false,
      reason: "unsupported",
      message: "notes.txt is not an audio file the browser can read.",
    });
    expect(outcomes[1]).toMatchObject({ ok: true, entry: { name: "kick" } });
  });

  it("rejects audio longer than 20 minutes", async () => {
    const { outcomes } = await importAudioFiles([tagged("long.wav", 1)], {
      decode: async () => tone(1201 * 8000, 1, 8000),
    });
    expect(outcomes[0]).toMatchObject({ ok: false, reason: "too-long" });
    expect(await listStoredSampleIds()).toEqual([]);
  });

  it("rejects a file over 200 MB before reading it", async () => {
    const big = file("big.wav");
    Object.defineProperty(big, "size", { value: 200 * 1024 * 1024 + 1 });
    const decode = vi.fn();
    const { outcomes } = await importAudioFiles([big], { decode });
    expect(outcomes[0]).toMatchObject({ ok: false, reason: "too-large" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("mixes a 4-channel file down to stereo", async () => {
    const { outcomes } = await importAudioFiles([tagged("quad.wav", 1)], {
      decode: decodeAs({ "1": tone(1000, 4) }),
    });
    expect(outcomes[0]).toMatchObject({ ok: true, entry: { channels: 2 } });
  });

  it("stores one copy when the same file is imported twice", async () => {
    const decode = decodeAs({ "1": tone(500) });
    await importAudioFiles([tagged("a.wav", 1)], { decode });
    const { outcomes } = await importAudioFiles([tagged("copy of a.wav", 1)], { decode });
    expect(outcomes[0]).toMatchObject({ ok: true, duplicate: true, entry: { name: "a" } });
    expect(await listStoredSampleIds()).toHaveLength(1);
    expect(await listLibrary()).toHaveLength(1);
  });

  it("fails a file that does not fit and warns when space is low", async () => {
    const decode = decodeAs({ "1": tone(1000) });
    const full = await importAudioFiles([tagged("a.wav", 1)], {
      decode,
      estimate: async () => ({ quota: 1000, usage: 999 }),
    });
    expect(full.outcomes[0]).toMatchObject({ ok: false, reason: "no-storage" });
    expect(full.lowStorage).toBe(true);
    const roomy = await importAudioFiles([tagged("a.wav", 1)], {
      decode,
      estimate: async () => ({ quota: 10 ** 12, usage: 0 }),
    });
    expect(roomy.lowStorage).toBe(false);
  });

  it("reports progress per file", async () => {
    const onProgress = vi.fn();
    await importAudioFiles([tagged("a.wav", 1), tagged("b.wav", 1)], {
      decode: decodeAs({ "1": tone(10) }),
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ fileIndex: 1, fileCount: 2, stage: "done" }));
  });
});
