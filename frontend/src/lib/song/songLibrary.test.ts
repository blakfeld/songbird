import "fake-indexeddb/auto";
import { clear } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "@/test/fixtures";
import {
  INDEX_KEY,
  LAST_SONG_KEY,
  createSongLibrary,
  idbKeyValueStore,
  songKey,
  type KeyValueStore,
} from "./songLibrary";
import { createSongStore } from "./songStore";
import { newSong } from "./types";

beforeEach(async () => {
  localStorage.clear();
  await clear();
});
afterEach(() => vi.useRealTimers());

describe("songLibrary", () => {
  it("restores a saved song on reload and remembers it as last opened", async () => {
    const lib = createSongLibrary();
    const song = newSong();
    song.tracks[0].notes = [note("kick", 0)];
    song.tracks[0].volume_db = -6;
    await lib.create(song);
    const reloaded = createSongLibrary();
    expect(reloaded.getLastSongId()).toBe(song.id);
    expect(await reloaded.open(song.id)).toEqual(song);
    expect(localStorage.getItem(LAST_SONG_KEY)).toBe(song.id);
  });

  it("indexes name, time signature and updated_at, most recent first", async () => {
    const lib = createSongLibrary();
    const a = { ...newSong("3/4"), name: "A" };
    const b = { ...newSong(), name: "B" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    await lib.create(a);
    vi.setSystemTime(2000);
    await lib.create(b);
    expect(await lib.list()).toEqual([
      { id: b.id, name: "B", time_signature: "4/4", track_count: 2, updated_at: 2000 },
      { id: a.id, name: "A", time_signature: "3/4", track_count: 2, updated_at: 1000 },
    ]);
  });

  it("debounces saves by 300 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const lib = createSongLibrary();
    const song = newSong();
    lib.save(song);
    lib.save({ ...song, name: "Later" });
    await vi.advanceTimersByTimeAsync(299);
    expect(await idbKeyValueStore().get(songKey(song.id))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await lib.flush();
    vi.useRealTimers();
    expect(((await idbKeyValueStore().get(songKey(song.id))) as { name: string }).name).toBe("Later");
  });

  it("autosaves store edits", async () => {
    const lib = createSongLibrary();
    const store = createSongStore(newSong());
    lib.autosave(store);
    store.getState().renameSong("Auto");
    await lib.flush();
    expect((await lib.list())[0].name).toBe("Auto");
  });

  it("lists legacy index entries without track_count and fills it on save", async () => {
    const kv = idbKeyValueStore();
    const song = newSong();
    await kv.set(songKey(song.id), song);
    await kv.set(INDEX_KEY, [{ id: song.id, name: song.name, time_signature: "4/4", updated_at: 1 }]);
    const lib = createSongLibrary();
    expect((await lib.list())[0].track_count).toBeUndefined();
    const copy = (await lib.duplicate(song.id))!;
    await lib.rename(song.id, "New");
    const list = await lib.list();
    expect(list.find((e) => e.id === copy.id)!.track_count).toBe(2);
    expect(list.find((e) => e.id === song.id)!.track_count).toBe(2);
  });

  it("renames", async () => {
    const lib = createSongLibrary();
    const song = await lib.create(newSong());
    await lib.rename(song.id, "Renamed");
    expect((await lib.list())[0].name).toBe("Renamed");
    expect((await lib.open(song.id))!.name).toBe("Renamed");
  });

  it("duplicates independently", async () => {
    const lib = createSongLibrary();
    const demo = { ...newSong(), name: "Demo" };
    demo.tracks[0].notes = [note("kick", 0)];
    await lib.create(demo);
    const copy = (await lib.duplicate(demo.id))!;
    expect(copy.name).toBe("Demo (copy)");
    expect(copy.id).not.toBe(demo.id);
    expect(copy.tracks).toEqual(demo.tracks);
    const edited = { ...copy, tracks: [{ ...copy.tracks[0], notes: [] }, ...copy.tracks.slice(1)] };
    lib.save(edited);
    await lib.flush();
    expect((await lib.open(demo.id))!.tracks[0].notes).toHaveLength(1);
    expect((await lib.open(copy.id))!.tracks[0].notes).toHaveLength(0);
    expect(await lib.list()).toHaveLength(2);
  });

  it("deletes the body, index entry and last-opened pointer", async () => {
    const lib = createSongLibrary();
    const song = await lib.create(newSong());
    await lib.remove(song.id);
    expect(await lib.list()).toEqual([]);
    expect(await lib.open(song.id)).toBeNull();
    expect(lib.getLastSongId()).toBeNull();
  });

  it("writes unrecognised fields back unchanged", async () => {
    const kv = idbKeyValueStore();
    const song = { ...newSong(), sections: [{ name: "Verse" }] } as ReturnType<typeof newSong>;
    (song.tracks[0] as unknown as Record<string, unknown>).future_flag = 7;
    await kv.set(songKey(song.id), song);
    await kv.set(INDEX_KEY, [
      { id: song.id, name: song.name, time_signature: "4/4", updated_at: 1 },
    ]);
    const lib = createSongLibrary();
    const store = createSongStore(await lib.open(song.id));
    lib.autosave(store);
    store.getState().setTempo(100);
    await lib.flush();
    const saved = (await kv.get(songKey(song.id))) as Record<string, unknown>;
    expect(saved.sections).toEqual([{ name: "Verse" }]);
    expect((saved.tracks as Record<string, unknown>[])[0].future_flag).toBe(7);
    expect(saved.tempo_bpm).toBe(100);
  });

  it("reports storage failure while editing keeps working", async () => {
    const failing: KeyValueStore = {
      get: () => Promise.reject(new Error("nope")),
      set: () => Promise.reject(new Error("quota")),
      del: () => Promise.reject(new Error("nope")),
    };
    const lib = createSongLibrary(failing);
    const store = createSongStore(newSong());
    lib.autosave(store);
    store.getState().renameSong("Still editable");
    await lib.flush();
    expect(lib.status.getState().ok).toBe(false);
    expect(lib.status.getState().message).toMatch(/not being saved/i);
    expect(store.getState().song!.name).toBe("Still editable");
  });

  it("clears the failure status once a save succeeds", async () => {
    let fail = true;
    const kv = idbKeyValueStore();
    const flaky: KeyValueStore = {
      ...kv,
      set: (k, v) => (fail ? Promise.reject(new Error("quota")) : kv.set(k, v)),
    };
    const lib = createSongLibrary(flaky);
    await lib.create(newSong());
    expect(lib.status.getState().ok).toBe(false);
    fail = false;
    await lib.create(newSong());
    expect(lib.status.getState().ok).toBe(true);
  });

  it("reports saving from an edit until its debounced write lands", async () => {
    const lib = createSongLibrary();
    const song = newSong();
    await lib.create(song);
    expect(lib.status.getState().saving).toBe(false);
    lib.save({ ...song, name: "Changed" });
    expect(lib.status.getState().saving).toBe(true);
    await lib.flush();
    expect(lib.status.getState().saving).toBe(false);
  });

  it("peeks and puts without changing the last-opened song", async () => {
    const lib = createSongLibrary();
    const current = newSong();
    const other = { ...newSong(), name: "Other" };
    await lib.create(current);
    await lib.put(other);
    expect(lib.getLastSongId()).toBe(current.id);
    expect(await lib.peek(other.id)).toEqual(other);
    expect(lib.getLastSongId()).toBe(current.id);
    expect((await lib.list()).map((e) => e.id).sort()).toEqual([current.id, other.id].sort());
  });

  it("keeps the save failure after a successful read, and reports read failures separately", async () => {
    const kv = idbKeyValueStore();
    let failWrites = true;
    let failReads = false;
    const flaky: KeyValueStore = {
      ...kv,
      set: (k, v) => (failWrites ? Promise.reject(new Error("quota")) : kv.set(k, v)),
      get: (k) => (failReads ? Promise.reject(new Error("read")) : kv.get(k)),
    };
    const lib = createSongLibrary(flaky);
    await lib.create(newSong());
    expect(lib.status.getState().ok).toBe(false);

    await lib.list();
    expect(lib.status.getState().ok).toBe(false);
    expect(lib.readStatus.getState().failed).toBe(false);

    failReads = true;
    failWrites = false;
    await lib.list();
    expect(lib.readStatus.getState().failed).toBe(true);
    expect(lib.status.getState().ok).toBe(false);
  });
});
