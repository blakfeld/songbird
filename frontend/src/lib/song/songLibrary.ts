import { del, get, set } from "idb-keyval";
import { createStore } from "zustand/vanilla";
import type { TimeSignature } from "@/generated/TimeSignature";
import type { SongStore } from "./songStore";
import { scheduleGarbageCollection, setOpenSongSource } from "@/lib/audio/sampleGc";
import { migrateSong } from "./migrate";
import { newId, type Song } from "./types";

interface RawSongSamples {
  samples?: { id?: unknown }[];
  tracks?: { sampler?: { keys?: { sample_id?: unknown }; pads?: { sample_id?: unknown }[] } }[];
}

// A saved song's sampler assignments count as uses beside its sample list, so audio only a pad plays is never freed.
function rawSampleIds(raw: RawSongSamples | undefined): string[] {
  const ids: unknown[] = (raw?.samples ?? []).map((s) => s?.id);
  for (const t of raw?.tracks ?? []) {
    ids.push(t?.sampler?.keys?.sample_id);
    for (const p of t?.sampler?.pads ?? []) ids.push(p?.sample_id);
  }
  return ids.filter((id): id is string => typeof id === "string");
}

const KEY_PREFIX = "songbird.songs.v1.";
export const INDEX_KEY = `${KEY_PREFIX}index`;
export const LAST_SONG_KEY = "songbird.studio.lastSong";
const SAVE_DEBOUNCE_MS = 300;

export const songKey = (id: string) => `${KEY_PREFIX}${id}`;

export interface SongIndexEntry {
  id: string;
  name: string;
  time_signature: TimeSignature;
  // Optional because entries written before this field existed lack it; absent means unknown.
  track_count?: number;
  updated_at: number;
}

export interface KeyValueStore {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  del: (key: string) => Promise<void>;
}

export function idbKeyValueStore(): KeyValueStore {
  return {
    get: (k) => get(k),
    set: (k, v) => set(k, v),
    del: (k) => del(k),
  };
}

export interface SaveStatus {
  ok: boolean;
  message: string | null;
  // True from an edit until its debounced write lands, so the UI can tell "saved" from "about to save".
  saving: boolean;
}

const FAILURE_MESSAGE = "Changes are not being saved: browser storage is unavailable or full.";

export interface SongLibraryOptions {
  // Fired when a song is opened, copied or deleted, the moments the set of audio in use can shrink.
  onSamplesMayBeFree?: () => void;
}

export function createSongLibrary(
  kv: KeyValueStore = idbKeyValueStore(),
  { onSamplesMayBeFree }: SongLibraryOptions = {},
) {
  const status = createStore<SaveStatus>(() => ({
    ok: true,
    message: null,
    saving: false,
  }));
  let inflight = 0;
  const pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; song: Song }
  >();
  // Index updates are read-modify-write, so they are serialized to avoid lost entries.
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  // Only writes drive `status`: a read that works says nothing about whether saving works, so it
  // must not clear the "not saved" banner. Storage errors are absorbed so editing never breaks.
  const guarded = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      const result = await fn();
      if (!status.getState().ok) status.setState({ ok: true, message: null });
      return result;
    } catch {
      status.setState({ ok: false, message: FAILURE_MESSAGE });
      return fallback;
    }
  };

  // Reads report through their own flags so a failed read never raises the save-failure banner.
  // `invalid` separates a stored song that cannot be converted from one that does not exist.
  const readStatus = createStore<{ failed: boolean; invalid: boolean }>(() => ({ failed: false, invalid: false }));
  const guardedRead = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      const result = await fn();
      readStatus.setState({ failed: false });
      return result;
    } catch {
      readStatus.setState({ failed: true });
      return fallback;
    }
  };

  const readIndex = async () =>
    ((await kv.get(INDEX_KEY)) as SongIndexEntry[] | undefined) ?? [];

  const settle = () => {
    if (pending.size === 0 && inflight === 0 && status.getState().saving) {
      status.setState({ saving: false });
    }
  };

  const write = (song: Song) => {
    inflight += 1;
    return writeNow(song).finally(() => {
      inflight -= 1;
      settle();
    });
  };

  const writeNow = (song: Song) =>
    enqueue(() =>
      guarded(async () => {
        const now = Date.now();
        await kv.set(songKey(song.id), song);
        const entry: SongIndexEntry = {
          id: song.id,
          name: song.name,
          time_signature: song.time_signature,
          track_count: song.tracks.length,
          updated_at: now,
        };
        const index = await readIndex();
        await kv.set(INDEX_KEY, [
          ...index.filter((e) => e.id !== song.id),
          entry,
        ]);
      }, undefined),
    );

  const rememberLast = (id: string | null) => {
    try {
      if (id === null) localStorage.removeItem(LAST_SONG_KEY);
      else localStorage.setItem(LAST_SONG_KEY, id);
    } catch {
      // The last-opened hint is a convenience; losing it must not block the song.
    }
  };

  const flush = async () => {
    const jobs = [...pending.values()];
    pending.clear();
    for (const j of jobs) clearTimeout(j.timer);
    await Promise.all(jobs.map((j) => write(j.song)));
    await queue;
  };

  // Migration happens only in memory: opening an old song must not rewrite it until the user edits.
  const load = (id: string) =>
    guardedRead(async () => {
      readStatus.setState({ invalid: false });
      const raw = await kv.get(songKey(id));
      if (raw === undefined) return null;
      const song = migrateSong(raw);
      if (!song) readStatus.setState({ invalid: true });
      return song;
    }, null);

  return {
    status,
    readStatus,

    getLastSongId(): string | null {
      try {
        return localStorage.getItem(LAST_SONG_KEY);
      } catch {
        return null;
      }
    },

    async list(): Promise<SongIndexEntry[]> {
      const index = await guardedRead(readIndex, []);
      return [...index].sort((a, b) => b.updated_at - a.updated_at);
    },

    async create(song: Song): Promise<Song> {
      rememberLast(song.id);
      await write(song);
      return song;
    },

    async open(id: string): Promise<Song | null> {
      await flush();
      const song = await load(id);
      if (song) rememberLast(id);
      onSamplesMayBeFree?.();
      return song;
    },

    // Send to song must not change the last-opened id, or the next Studio visit would reopen a song
    // the user was not working on.
    async peek(id: string): Promise<Song | null> {
      await flush();
      return load(id);
    },

    async put(song: Song): Promise<Song> {
      await write(song);
      return song;
    },

    save(song: Song) {
      const existing = pending.get(song.id);
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        pending.delete(song.id);
        void write(song);
      }, SAVE_DEBOUNCE_MS);
      pending.set(song.id, { timer, song });
      if (!status.getState().saving) status.setState({ saving: true });
    },

    flush,

    async rename(id: string, name: string): Promise<Song | null> {
      await flush();
      const song = await load(id);
      const next = name.trim();
      if (!song || !next) return song;
      const renamed = { ...song, name: next };
      await write(renamed);
      return renamed;
    },

    async duplicate(id: string): Promise<Song | null> {
      await flush();
      const song = await load(id);
      if (!song) return null;
      const copy: Song = {
        ...structuredClone(song),
        id: newId(),
        name: `${song.name} (copy)`,
      };
      await write(copy);
      onSamplesMayBeFree?.();
      return copy;
    },

    async remove(id: string): Promise<void> {
      const job = pending.get(id);
      if (job) {
        clearTimeout(job.timer);
        pending.delete(id);
        settle();
      }
      await enqueue(() =>
        guarded(async () => {
          await kv.del(songKey(id));
          const index = await readIndex();
          await kv.set(
            INDEX_KEY,
            index.filter((e) => e.id !== id),
          );
        }, undefined),
      );
      if (this.getLastSongId() === id) rememberLast(null);
      onSamplesMayBeFree?.();
    },

    // Raw reads, unmigrated, because only the ids matter and a song that cannot migrate may still hold audio.
    // A read failure propagates so garbage collection aborts rather than treating unreadable songs as empty.
    async savedSampleIds(): Promise<string[]> {
      await flush();
      const ids = new Set<string>();
      for (const entry of await readIndex()) {
        const raw = (await kv.get(songKey(entry.id))) as RawSongSamples | undefined;
        for (const id of rawSampleIds(raw)) ids.add(id);
      }
      return [...ids];
    },

    // Counted from raw documents like savedSampleIds, so the remove-from-library warning agrees with what collection keeps.
    async songsUsingSample(sampleId: string): Promise<number> {
      await flush();
      let count = 0;
      for (const entry of await readIndex()) {
        const raw = (await kv.get(songKey(entry.id))) as RawSongSamples | undefined;
        if (rawSampleIds(raw).includes(sampleId)) count++;
      }
      return count;
    },

    autosave(store: SongStore): () => void {
      let last = store.getState().song;
      setOpenSongSource(() => {
        const s = store.getState();
        return [s.song, s.gestureBase, ...s.past, ...s.future, ...(s.gestureFuture ?? [])].filter(
          (song): song is Song => song !== null,
        );
      });
      const unsubscribe = store.subscribe((s) => {
        if (s.song && s.song !== last) this.save(s.song);
        last = s.song;
      });
      return () => {
        unsubscribe();
        setOpenSongSource(null);
      };
    },
  };
}

export type SongLibrary = ReturnType<typeof createSongLibrary>;

let shared: SongLibrary | undefined;

export function getSongLibrary(): SongLibrary {
  return (shared ??= createSongLibrary(undefined, { onSamplesMayBeFree: scheduleGarbageCollection }));
}
