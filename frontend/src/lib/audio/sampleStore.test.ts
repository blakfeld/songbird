import "fake-indexeddb/auto";
import { clear, createStore } from "idb-keyval";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { createServerSongLibrary } from "@/lib/song/songLibrary";
import { createSongStore } from "@/lib/song/songStore";
import { newTrack, type Song } from "@/lib/song/types";
import { collectGarbage, setOpenSongSource, type GcSources } from "./sampleGc";
import { addToLibrary, listLibrary, removeFromLibrary } from "./sampleLibrary";
import { getSampleOverview, listStoredSampleIds, putSample, readSamplePcm } from "./sampleStore";

const withSamples = (song: Song, ids: string[]): Song =>
  ({ ...song, samples: ids.map((id) => ({ id, name: id })) }) as Song;

const pcm = (seed: number) => ({
  sampleRate: 48000,
  channels: 1,
  data: new Float32Array([seed, seed / 2, -seed]),
});

const entryFor = (id: string) => ({
  id,
  name: id,
  sampleRate: 48000,
  channels: 1,
  length: 3,
  importedAt: 1,
});

// Wipes the sample stores so each test starts from an empty browser.
async function reset() {
  await clear();
  for (const [db, name] of [
    ["songbird-samples.test-user", "samples"],
    ["songbird-sample-library.test-user", "library"],
  ]) {
    await clear(createStore(db, name));
  }
}

// jsdom's Blob is not structured-cloneable by fake-indexeddb, unlike the real one in a browser.
beforeAll(() => {
  vi.stubGlobal("Blob", NodeBlob);
});

beforeEach(async () => {
  localStorage.clear();
  await reset();
  setOpenSongSource(null);
});
afterEach(() => vi.useRealTimers());

const sources = (lib: ReturnType<typeof createServerSongLibrary>): GcSources => ({
  libraryIds: async () => (await listLibrary()).map((e) => e.id),
  savedSongSampleIds: () => lib.savedSampleIds(),
  openSongs: () => [],
});

describe("sampleStore", () => {
  it("survives reload with its audio and overview", async () => {
    const { id } = await putSample(pcm(0.8));
    await addToLibrary(entryFor(id));
    await collectGarbage(sources(createServerSongLibrary(createFakeProjectsApi().api)));
    const stored = await readSamplePcm(id);
    expect(Array.from(stored!.data)).toEqual(Array.from(pcm(0.8).data));
    expect(stored).toMatchObject({ sampleRate: 48000, channels: 1 });
    expect(await getSampleOverview(id)).toHaveLength(2);
  });

  it("stores one copy when the same audio is put twice", async () => {
    const first = await putSample(pcm(0.5));
    const second = await putSample(pcm(0.5));
    expect(second).toMatchObject({ id: first.id, created: false });
    expect(await listStoredSampleIds()).toEqual([first.id]);
  });

  it("asks the browser for persistence on the first store only", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, "storage", { value: { persist }, configurable: true });
    // The request is remembered per module load, so a fresh copy is the first store of a session.
    vi.resetModules();
    const fresh = await import("./sampleStore");
    (await import("@/lib/auth/currentUser")).setCurrentUserId("test-user");
    await fresh.putSample(pcm(0.31));
    await fresh.putSample(pcm(0.32));
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe("collectGarbage", () => {
  it("keeps a sample only a pad uses, in a saved song and in open history", async () => {
    const lib = createServerSongLibrary(createFakeProjectsApi().api);
    const { id } = await putSample(pcm(0.9));
    const pads: Song = {
      ...newSongWithTracks(),
      tracks: [
        {
          ...newTrack("sampler-pads", "Pads"),
          sampler: { pads: [{ row_id: "pad-1", sample_id: id, gain_db: 0, pitch_semitones: 0 }] },
        },
      ],
    };
    await lib.put(pads);
    expect(await collectGarbage(sources(lib))).toEqual([]);
    await lib.remove(pads.id);
    expect(await collectGarbage({ ...sources(lib), openSongs: () => [pads] })).toEqual([]);
    expect(await listStoredSampleIds()).toEqual([id]);
    expect(await collectGarbage(sources(lib))).toEqual([id]);
  });

  it("keeps a sample only a keys sampler uses", async () => {
    const lib = createServerSongLibrary(createFakeProjectsApi().api);
    const { id } = await putSample(pcm(0.95));
    const keys: Song = {
      ...newSongWithTracks(),
      tracks: [{ ...newTrack("sampler-keys", "Sampler"), sampler: { keys: { sample_id: id, root_note: 60, one_shot: false } } }],
    };
    expect(await collectGarbage({ ...sources(lib), openSongs: () => [keys] })).toEqual([]);
  });

  it("counts a stored song's pad and keys references as uses of the sample", async () => {
    const lib = createServerSongLibrary(createFakeProjectsApi().api);
    const padSong: Song = {
      ...newSongWithTracks(),
      tracks: [{ ...newTrack("sampler-pads", "Pads"), sampler: { pads: [{ row_id: "pad-1", sample_id: "only-pad", gain_db: 0, pitch_semitones: 0 }] } }],
    };
    const keysSong: Song = {
      ...newSongWithTracks(),
      tracks: [{ ...newTrack("sampler-keys", "Sampler"), sampler: { keys: { sample_id: "only-keys", root_note: 60, one_shot: false } } }],
    };
    await lib.put(padSong);
    await lib.put(keysSong);
    expect((await lib.savedSampleIds()).sort()).toEqual(["only-keys", "only-pad"]);
    expect(await lib.songsUsingSample("only-pad")).toBe(1);
    expect(await lib.songsUsingSample("only-keys")).toBe(1);
    expect(await lib.songsUsingSample("neither")).toBe(0);
  });

  it("keeps audio an undo step can bring back", async () => {
    const lib = createServerSongLibrary(createFakeProjectsApi().api);
    const { id } = await putSample(pcm(0.7));
    const base = newSongWithTracks();
    const store = createSongStore(withSamples(base, [id]));
    store.setState({ past: [withSamples(base, [id])] });
    store.setState({ song: base });
    await lib.put(base);
    const open = () => {
      const s = store.getState();
      return [s.song!, ...s.past, ...s.future];
    };
    expect(await collectGarbage({ ...sources(lib), openSongs: open })).toEqual([]);
    expect(await listStoredSampleIds()).toEqual([id]);
    store.setState({ past: [] });
    expect(await collectGarbage({ ...sources(lib), openSongs: open })).toEqual([id]);
  });

  it("keeps audio shared by two songs until both let go", async () => {
    const lib = createServerSongLibrary(createFakeProjectsApi().api);
    const { id } = await putSample(pcm(0.6));
    const a = withSamples(newSongWithTracks(), [id]);
    const b = withSamples(newSongWithTracks(), [id]);
    await lib.put(a);
    await lib.put(b);
    await lib.remove(a.id);
    expect(await collectGarbage(sources(lib))).toEqual([]);
    await lib.remove(b.id);
    expect(await collectGarbage(sources(lib))).toEqual([id]);
  });

  it("frees audio no song or library entry uses", async () => {
    const lib = createServerSongLibrary(createFakeProjectsApi().api);
    const { id } = await putSample(pcm(0.4));
    await addToLibrary(entryFor(id));
    expect(await collectGarbage(sources(lib))).toEqual([]);
    await removeFromLibrary(id);
    expect(await collectGarbage(sources(lib))).toEqual([id]);
    expect(await listStoredSampleIds()).toEqual([]);
  });

  it("aborts without deleting when a source cannot be read", async () => {
    const lib = createServerSongLibrary(createFakeProjectsApi().api);
    const { id } = await putSample(pcm(0.2));
    const broken = { ...sources(lib), savedSongSampleIds: () => Promise.reject(new Error("down")) };
    await expect(collectGarbage(broken)).rejects.toThrow();
    expect(await listStoredSampleIds()).toEqual([id]);
  });

  it("runs on song delete through the library hook", async () => {
    const hook = vi.fn();
    const lib = createServerSongLibrary(createFakeProjectsApi().api, { onSamplesMayBeFree: hook });
    const song = newSongWithTracks();
    await lib.create(song);
    await lib.open(song.id);
    await lib.duplicate(song.id);
    await lib.remove(song.id);
    expect(hook).toHaveBeenCalledTimes(3);
  });
});
