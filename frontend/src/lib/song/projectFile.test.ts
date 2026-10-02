import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { clear, createStore } from "idb-keyval";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listLibrary } from "@/lib/audio/sampleLibrary";
import { listStoredSampleIds, putSample, readSamplePcm } from "@/lib/audio/sampleStore";
import { encodeWavFloat32 } from "@/lib/audio/wavFloat";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import {
  MAX_PROJECT_BYTES,
  parseProjectFile,
  projectFilename,
  readProjectFile,
  serializeProject,
} from "./projectFile";
import { createProjectBundle, readProjectBundle, isBundleFile } from "./projectBundle";
import { addSamplerTrack, assignPad } from "./samplerOps";
import { newSong, type Song } from "./types";

interface Case {
  name: string;
  song: Song;
  error: string | null;
}

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../fixtures/song_validation.json"), "utf8"),
);

// The registry the server really serves, so a row or instrument the stub forgot cannot hide a mismatch.
const instruments: InstrumentInfo[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../fixtures/instruments.json"), "utf8"),
);

const file = (song: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: "songbird-song", version: 1, song, ...over });

const valid = fixture.cases.filter((c) => c.error === null);
const invalid = fixture.cases.filter((c) => c.error !== null);
const base = valid[0].song;

const failure = (text: string) => {
  const r = parseProjectFile(text, instruments);
  return "error" in r ? r : null;
};
const error = (text: string) => failure(text)?.error ?? null;

const store = vi.hoisted(() => ({ failOnCall: 0, calls: 0 }));
vi.mock("@/lib/audio/sampleStore", async (orig) => {
  const real = await orig<typeof import("@/lib/audio/sampleStore")>();
  return {
    ...real,
    putSample: (...args: Parameters<typeof real.putSample>) => {
      store.calls += 1;
      if (store.failOnCall && store.calls === store.failOnCall) return Promise.reject(new Error("quota"));
      return real.putSample(...args);
    },
  };
});

describe("parseProjectFile against the shared song fixture", () => {
  it.each(valid)("accepts: $name", (c) => {
    expect(error(file(c.song))).toBeNull();
  });

  it.each(invalid)("rejects ($error): $name", (c) => {
    expect(failure(file(c.song))?.kind).toBe(c.error);
  });
});

describe("parseProjectFile", () => {
  it("round-trips a song", () => {
    const r = parseProjectFile(serializeProject(base), instruments);
    expect(r).toEqual({ ok: expect.objectContaining({ id: base.id, name: base.name, tracks: base.tracks }) });
  });

  it("writes the envelope with loops and clips as they are", () => {
    const doc = JSON.parse(serializeProject(base));
    expect(doc).toMatchObject({ format: "songbird-song", version: 1 });
    expect(doc.song).toEqual(base);
  });

  it("keeps unknown fields inside sound", () => {
    const sound = { tone: { filter_cutoff_hz: 800, future_knob: 1 }, future_group: true };
    const song = { ...base, tracks: [{ ...base.tracks[0], sound }, ...base.tracks.slice(1)] };
    const r = parseProjectFile(file(song), instruments);
    expect("ok" in r && r.ok.tracks[0].sound).toEqual(sound);
  });

  it("rejects a bad sound with the track and setting named", () => {
    const sound = { effects: { delay: { feedback: 1.5 } } };
    const song = { ...base, tracks: [{ ...base.tracks[0], sound }, ...base.tracks.slice(1)] };
    expect(error(file(song))).toMatch(/Track 1 "Drums": feedback must be 0-0.9, got 1.5/);
  });

  it("rejects a newer project version", () => {
    expect(error(file(base, { version: 2 }))).toMatch(/newer version of Songbird/);
  });

  it("rejects an unknown instrument by name", () => {
    const song = { ...base, tracks: [{ ...base.tracks[0], instrument: "theremin" }] };
    expect(error(file(song))).toMatch(/theremin/);
  });

  it("rejects invalid JSON and other formats", () => {
    expect(error("{nope")).toMatch(/valid JSON/);
    expect(error(file(base, { format: "other" }))).toMatch(/isn't a Songbird project/);
  });

  it("names the track with overlapping clips", () => {
    const [drumsTrack, ...rest] = base.tracks;
    const clips = [
      { id: "a", loop_id: drumsTrack.loops[0].id, start_measure: 1, measures: 3 },
      { id: "b", loop_id: drumsTrack.loops[0].id, start_measure: 3, measures: 2 },
    ];
    const song = { ...base, tracks: [{ ...drumsTrack, clips }, ...rest] };
    expect(error(file(song))).toMatch(/"Drums".*overlapping/);
  });

  it("keeps an unrecognised optional field", () => {
    const song = { ...base, mood: "wistful" };
    const r = parseProjectFile(file(song), instruments);
    expect(r).toHaveProperty("ok");
    expect(JSON.parse(serializeProject((r as { ok: Song }).ok)).song.mood).toBe("wistful");
  });

  it("converts an older song document as the library does", () => {
    const track = { ...base.tracks[0], loops: undefined, clips: undefined };
    const v1 = {
      ...base,
      version: 1,
      tracks: [{ ...track, notes: [{ row_id: "kick", step: 0, length_steps: 1, velocity: 100 }] }],
    };
    const r = parseProjectFile(file(v1), instruments);
    expect(r).toHaveProperty("ok");
    expect((r as { ok: Song }).ok.version).toBe(2);
    expect((r as { ok: Song }).ok.tracks[0].clips).toHaveLength(1);
  });

  it("refuses a file over 5 MB before reading it", async () => {
    const big = { size: MAX_PROJECT_BYTES + 1, text: () => Promise.reject(new Error("read")) } as unknown as File;
    expect(await readProjectFile(big, instruments)).toMatchObject({ kind: "size", error: expect.stringMatching(/5 MB/) });
  });

  it("names the download after the song", () => {
    expect(projectFilename({ name: "Late Train" })).toBe("late-train.songbird.json");
  });
});

describe("project bundles", () => {
  const FRAMES = 4800;
  const pcm = (seed: number) => ({
    sampleRate: 48000,
    channels: 2,
    data: Float32Array.from({ length: FRAMES * 2 }, (_, i) => Math.sin(i * seed) * 0.5),
  });
  const encoder = new TextEncoder();

  // jsdom's Blob is not structured-cloneable by fake-indexeddb, unlike the real one in a browser.
  beforeAll(() => {
    vi.stubGlobal("Blob", NodeBlob);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(async () => {
    store.calls = 0;
    store.failOnCall = 0;
    vi.restoreAllMocks();
    await clear();
    for (const [db, name] of [
      ["songbird-samples", "samples"],
      ["songbird-sample-library", "library"],
    ]) {
      await clear(createStore(db, name));
    }
  });

  const withAudio = (id: string, name = "breakbeat-120"): Song => {
    const song = JSON.parse(JSON.stringify(valid.find((c) => c.name === "Audio track accepted")!.song)) as Song;
    song.samples = [{ id, name, sample_rate: 48000, channels: 2, length_samples: FRAMES, origin: "import" }];
    song.tracks[1].audio_clips = [
      { ...song.tracks[1].audio_clips![0], sample_id: id, slice_samples: FRAMES, length_samples: FRAMES },
    ];
    return song;
  };

  // The store and library are emptied afterwards to stand in for a browser that has never seen the audio.
  async function bundleFor(seed: number, name?: string) {
    const { id } = await putSample(pcm(seed));
    const song = withAudio(id, name);
    const bytes = new Uint8Array(await (await createProjectBundle(song)).arrayBuffer());
    await clear(createStore("songbird-samples", "samples"));
    return { song, id, bytes, file: new File([bytes], "x.songbird.zip") };
  }

  const manual = (entries: Record<string, Uint8Array>) =>
    new File([zipSync(entries, { level: 0 })], "x.songbird.zip");
  const manifest = (song: Song) => encoder.encode(serializeProject(song));

  it("Round trip with audio: the same song opens with the same audio", async () => {
    const { song, id, file } = await bundleFor(1);
    expect(await isBundleFile(file)).toBe(true);
    const result = await readProjectBundle(file, instruments);
    // The same song a plain project file of it would give, which is what "the same song" means after migration.
    expect(result).toEqual(parseProjectFile(serializeProject(song), instruments));
    expect(result).toMatchObject({ ok: { samples: song.samples } });
    const stored = await readSamplePcm(id);
    expect(stored?.channels).toBe(2);
    expect(Array.from(stored!.data)).toEqual(Array.from(pcm(1).data));
  });

  it("Bundle adds to the library: the sample is stored and listed in a browser that never had it", async () => {
    const { file, id } = await bundleFor(2, "breakbeat-120");
    expect(await listLibrary()).toEqual([]);
    expect("ok" in (await readProjectBundle(file, instruments))).toBe(true);
    expect((await listLibrary()).map((e) => [e.id, e.name])).toEqual([[id, "breakbeat-120"]]);
    expect(await listStoredSampleIds()).toEqual([id]);
  });

  it("reuses audio the browser already stores, keeping its library entry", async () => {
    const { file, id } = await bundleFor(3);
    await putSample(pcm(3), async () => {
      const { addToLibrary } = await import("@/lib/audio/sampleLibrary");
      await addToLibrary({ id, name: "my own name", sampleRate: 48000, channels: 2, length: FRAMES, importedAt: 1 });
    });
    expect("ok" in (await readProjectBundle(file, instruments))).toBe(true);
    expect((await listLibrary()).map((e) => e.name)).toEqual(["my own name"]);
    expect(await listStoredSampleIds()).toEqual([id]);
  });

  it("Missing audio file: rejected with a message naming the sample, and the library is unchanged", async () => {
    const song = withAudio("a".repeat(32), "Lost Loop");
    const result = await readProjectBundle(manual({ "project.json": manifest(song) }), instruments);
    expect(result).toMatchObject({ kind: "bundle", error: expect.stringContaining("Lost Loop") });
    expect(await listLibrary()).toEqual([]);
    expect(await listStoredSampleIds()).toEqual([]);
  });

  it("rejects audio whose header disagrees with the sample, storing nothing", async () => {
    const song = withAudio("b".repeat(32));
    const mono = encodeWavFloat32({ sampleRate: 48000, channels: 1, data: new Float32Array(FRAMES * 2) });
    const result = await readProjectBundle(
      manual({ "project.json": manifest(song), [`audio/${"b".repeat(32)}.wav`]: mono }),
      instruments,
    );
    expect(result).toMatchObject({ kind: "bundle", error: expect.stringContaining("breakbeat-120") });
    expect(await listStoredSampleIds()).toEqual([]);
    expect(await listLibrary()).toEqual([]);
  });

  it("rejects audio that is not a float WAV", async () => {
    const song = withAudio("c".repeat(32));
    const result = await readProjectBundle(
      manual({ "project.json": manifest(song), [`audio/${"c".repeat(32)}.wav`]: new Uint8Array(1000) }),
      instruments,
    );
    expect(result).toMatchObject({ kind: "bundle", error: expect.stringContaining("can't be read") });
  });

  it("stops an entry that expands past its sample's size, so a zip bomb cannot fill memory", async () => {
    const song = withAudio("d".repeat(32));
    const wav = encodeWavFloat32(pcm(4));
    const bomb = new Uint8Array(wav.length + 40 * 1024 * 1024);
    bomb.set(wav);
    const file = new File(
      [zipSync({ "project.json": manifest(song), [`audio/${"d".repeat(32)}.wav`]: bomb }, { level: 6 })],
      "bomb.songbird.zip",
    );
    expect(file.size).toBeLessThan(1024 * 1024);
    const result = await readProjectBundle(file, instruments);
    expect(result).toMatchObject({ kind: "bundle", error: expect.stringContaining("larger") });
    expect(await listStoredSampleIds()).toEqual([]);
  });

  it("rejects a bundle without project.json and one that is not a zip", async () => {
    expect(await readProjectBundle(manual({ "readme.txt": encoder.encode("hi") }), instruments)).toMatchObject({
      kind: "bundle",
    });
    const junk = new File([new Uint8Array(100).fill(7)], "x.songbird.zip");
    expect(await isBundleFile(junk)).toBe(false);
    expect(await readProjectBundle(junk, instruments)).toMatchObject({ kind: "bundle" });
  });

  it("validates project.json exactly as a plain project file", async () => {
    const song = { ...withAudio("e".repeat(32)), tempo_bpm: 9999 };
    const result = await readProjectBundle(manual({ "project.json": manifest(song) }), instruments);
    expect(result).toMatchObject({ kind: "tempo" });
  });

  it("points the song at the audio's real id when the bundle's id was not its hash", async () => {
    const song = withAudio("f".repeat(32));
    const file = manual({
      "project.json": manifest(song),
      [`audio/${"f".repeat(32)}.wav`]: encodeWavFloat32(pcm(5)),
    });
    const result = await readProjectBundle(file, instruments);
    if (!("ok" in result)) throw new Error(result.error);
    const [stored] = await listStoredSampleIds();
    expect(stored).not.toBe("f".repeat(32));
    expect(result.ok.samples?.[0].id).toBe(stored);
    expect(result.ok.tracks[1].audio_clips?.[0].sample_id).toBe(stored);
  });

  const padSong = (id: string): Song => {
    const added = addSamplerTrack(newSong(), "pads")!;
    const kick = { id, name: "Kick", sample_rate: 48000, channels: 2, length_samples: FRAMES, origin: "import" as const };
    return assignPad(added.song, added.trackId, "pad-1", kick).song!;
  };

  it("bundles audio that only a sampler plays, so the pad still sounds when the bundle is opened", async () => {
    const { id } = await putSample(pcm(7));
    const bytes = new Uint8Array(await (await createProjectBundle(padSong(id))).arrayBuffer());
    await clear(createStore("songbird-samples", "samples"));
    const result = await readProjectBundle(new File([bytes], "pads.songbird.zip"), instruments);
    if (!("ok" in result)) throw new Error(result.error);
    expect(await listStoredSampleIds()).toEqual([id]);
    expect(result.ok.tracks[0].sampler?.pads?.[0].sample_id).toBe(id);
  });

  it("points a sampler at the audio's real id when the bundle's id was not its hash", async () => {
    const song = padSong("f".repeat(32));
    const file = manual({
      "project.json": manifest(song),
      [`audio/${"f".repeat(32)}.wav`]: encodeWavFloat32(pcm(5)),
    });
    const result = await readProjectBundle(file, instruments);
    if (!("ok" in result)) throw new Error(result.error);
    const [stored] = await listStoredSampleIds();
    expect(stored).not.toBe("f".repeat(32));
    expect(result.ok.tracks[0].sampler?.pads?.[0].sample_id).toBe(stored);
    expect(result.ok.samples?.[0].id).toBe(stored);
  });

  it("refuses to bundle a sample whose audio this browser has lost", async () => {
    await expect(createProjectBundle(withAudio("9".repeat(32), "Gone"))).rejects.toThrow(/Gone/);
  });

  const twoSamples = (a: string, b: string): Song => {
    const song = withAudio(a, "One");
    song.samples!.push({ id: b, name: "Two", sample_rate: 48000, channels: 2, length_samples: FRAMES, origin: "import" });
    song.tracks[1].audio_clips!.push({
      ...song.tracks[1].audio_clips![0],
      id: "a2",
      sample_id: b,
      start_ticks: 960,
    });
    return song;
  };
  // jsdom has no storage manager, so a test that cares about free space provides one.
  const freeSpace = (quota: number) =>
    Object.defineProperty(navigator, "storage", {
      value: { estimate: async () => ({ quota, usage: 0 }) },
      configurable: true,
    });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "storage");
  });
  const A = "1".repeat(32);
  const B = "2".repeat(32);

  it("keeps one sample when two turn out to be the same audio, and the song still validates", async () => {
    const wav = encodeWavFloat32(pcm(6));
    const result = await readProjectBundle(
      manual({ "project.json": manifest(twoSamples(A, B)), [`audio/${A}.wav`]: wav, [`audio/${B}.wav`]: wav }),
      instruments,
    );
    if (!("ok" in result)) throw new Error(result.error);
    expect(result.ok.samples).toHaveLength(1);
    const [stored] = await listStoredSampleIds();
    expect(result.ok.tracks[1].audio_clips?.map((c) => c.sample_id)).toEqual([stored, stored]);
    expect(await listLibrary()).toHaveLength(1);
  });

  it("takes back library entries already added when a later sample fails to store", async () => {
    store.failOnCall = 2;
    const result = await readProjectBundle(
      manual({
        "project.json": manifest(twoSamples(A, B)),
        [`audio/${A}.wav`]: encodeWavFloat32(pcm(7)),
        [`audio/${B}.wav`]: encodeWavFloat32(pcm(8)),
      }),
      instruments,
    );
    expect(result).toMatchObject({ kind: "bundle" });
    expect(await listLibrary()).toEqual([]);
  });

  it("refuses up front when the audio cannot fit, storing nothing", async () => {
    freeSpace(1000);
    const song = withAudio(A);
    const result = await readProjectBundle(
      manual({ "project.json": manifest(song), [`audio/${A}.wav`]: encodeWavFloat32(pcm(9)) }),
      instruments,
    );
    expect(result).toMatchObject({ kind: "bundle", error: expect.stringContaining("storage") });
    expect(store.calls).toBe(0);
  });

  it("warns when free space is under 200 MB but still opens the bundle", async () => {
    freeSpace(100 * 1024 * 1024);
    const warn = vi.fn();
    const result = await readProjectBundle(
      manual({ "project.json": manifest(withAudio(A)), [`audio/${A}.wav`]: encodeWavFloat32(pcm(10)) }),
      instruments,
      warn,
    );
    expect("ok" in result).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reads the file in slices of at most 64 KiB, bounding what one push can inflate", async () => {
    const sizes: number[] = [];
    const slice = File.prototype.slice;
    vi.spyOn(File.prototype, "slice").mockImplementation(function (this: File, a?: number, b?: number) {
      sizes.push((b ?? this.size) - (a ?? 0));
      return slice.call(this, a, b);
    });
    await readProjectBundle(
      manual({ "project.json": manifest(withAudio(A)), [`audio/${A}.wav`]: encodeWavFloat32(pcm(11)) }),
      instruments,
    );
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
  });

  it("rejects a data chunk that is not where the audio is read from", async () => {
    const wav = encodeWavFloat32(pcm(12));
    // A 8-byte JUNK chunk before data moves the audio while the file keeps its expected length, so the audio read
    // from the usual offset would be shifted and cut short.
    const shifted = new Uint8Array(wav.length);
    shifted.set(wav.subarray(0, 48));
    shifted.set(encoder.encode("JUNK"), 48);
    shifted.set(wav.subarray(48, wav.length - 8), 56);
    const result = await readProjectBundle(
      manual({ "project.json": manifest(withAudio(A)), [`audio/${A}.wav`]: shifted }),
      instruments,
    );
    expect(result).toMatchObject({ kind: "bundle" });
    expect(await listStoredSampleIds()).toEqual([]);
  });

  it("bundles only the samples clips use, and drops the rest from project.json", async () => {
    const { id } = await putSample(pcm(13));
    const song = withAudio(id);
    song.samples!.push({ id: "z".repeat(32), name: "Unused, audio lost", sample_rate: 48000, channels: 2, length_samples: 10, origin: "import" });
    const bytes = new Uint8Array(await (await createProjectBundle(song)).arrayBuffer());
    await clear(createStore("songbird-samples", "samples"));
    const result = await readProjectBundle(new File([bytes], "x.songbird.zip"), instruments);
    if (!("ok" in result)) throw new Error(result.error);
    expect(result.ok.samples?.map((s) => s.id)).toEqual([id]);
  });
});
