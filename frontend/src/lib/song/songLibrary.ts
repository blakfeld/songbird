import { createStore } from "zustand/vanilla";
import type { TimeSignature } from "@/generated/TimeSignature";
import { ApiError } from "@/lib/api";
import { getCurrentUserId } from "@/lib/auth/currentUser";
import type { SongStore } from "./songStore";
import { scheduleGarbageCollection, setOpenSongSource } from "@/lib/audio/sampleGc";
import { migrateSong } from "./migrate";
import { projectsApi, type ProjectsApi } from "./projectsApi";
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

// Keyed by user so that if the tab closes before sign-out finishes clearing storage, the next
// user on this browser still reads only their own entry.
export const lastSongStorageKey = (userId: string) => `songbird.studio.lastSong.${userId}`;
const SAVE_DEBOUNCE_MS = 300;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
// The server refuses a save less than a second after the previous one for the same song. Waiting
// that out up front keeps routine fast edits from producing 429 responses at all; the margin
// covers the gap between the server's clock reading and this side seeing the response.
const MIN_SAVE_INTERVAL_MS = 1000 + 50;
// Used when a 429 carries no usable Retry-After; the server's minimum save interval is one second.
const DEFAULT_RETRY_AFTER_MS = 1000;
// A blocking write (rename, send to song, flush) waits out the save interval a few times, then
// hands the song back to the background retry rather than holding the caller indefinitely.
const MAX_BLOCKING_THROTTLE_WAITS = 3;

export interface SongIndexEntry {
  id: string;
  name: string;
  time_signature: TimeSignature;
  track_count: number;
  updated_at: number;
}

export interface SaveStatus {
  ok: boolean;
  message: string | null;
  // True from an edit until its debounced write lands, so the UI can tell "saved" from "about to save".
  saving: boolean;
  // Another session saved a newer revision. Autosave for that song stays off until the user chooses
  // to reload it or keep their version as a copy, because either side's edits would be lost.
  conflict: boolean;
}

const FAILURE_MESSAGE = "Changes are not being saved. Check your connection and try again.";

// Only these can succeed on a later attempt; a validation, ownership, or quota refusal will not.
const isTransient = (e: unknown) =>
  e instanceof ApiError && (e.code === "network_error" || e.status >= 500 || e.status === 408);

// Key order is not significant in JSON, and the server may return the stored document reordered.
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => k in b && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

// Thrown by `put` so a caller that must not report success on an unsaved song can tell why.
export class SaveRefusedError extends Error {
  constructor(readonly conflict: boolean) {
    super(conflict ? "The song was changed elsewhere." : "The song could not be saved.");
    this.name = "SaveRefusedError";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SongLibraryOptions {
  // Fired when a song is opened, copied or deleted, the moments the set of audio in use can shrink.
  onSamplesMayBeFree?: () => void;
}

export function createServerSongLibrary(
  api: ProjectsApi = projectsApi,
  { onSamplesMayBeFree }: SongLibraryOptions = {},
) {
  const status = createStore<SaveStatus>(() => ({
    ok: true,
    message: null,
    saving: false,
    conflict: false,
  }));
  // The server rejects a save whose revision is stale, so every song the library has seen carries one.
  const revisions = new Map<string, number>();
  const conflicts = new Set<string>();
  const lastSavedAt = new Map<string, number>();
  const untilSaveAllowed = (id: string) =>
    Math.max(0, (lastSavedAt.get(id) ?? -Infinity) + MIN_SAVE_INTERVAL_MS - Date.now());
  let inflight = 0;
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; song: Song }>();
  // Saves are serialized because two concurrent PUTs for one song would race on its revision and
  // report a conflict with the user's own earlier save.
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  // Reads report through their own flags so a failed read never raises the save-failure banner.
  // `invalid` separates a stored song that cannot be converted from one that does not exist.
  const readStatus = createStore<{ failed: boolean; invalid: boolean }>(() => ({ failed: false, invalid: false }));

  const settle = () => {
    if (pending.size === 0 && inflight === 0 && status.getState().saving) {
      status.setState({ saving: false });
    }
  };

  const markSaved = () => {
    if (!status.getState().ok) status.setState({ ok: true, message: null });
  };
  const markFailed = (message: string) => status.setState({ ok: false, message });
  const setConflict = (id: string, on: boolean) => {
    if (on) conflicts.add(id);
    else conflicts.delete(id);
    if (status.getState().conflict !== conflicts.size > 0) status.setState({ conflict: conflicts.size > 0 });
  };

  const rememberLast = (id: string | null) => {
    const userId = getCurrentUserId();
    if (userId === null) return;
    try {
      if (id === null) localStorage.removeItem(lastSongStorageKey(userId));
      else localStorage.setItem(lastSongStorageKey(userId), id);
    } catch {
      // The last-opened hint is a convenience; losing it must not block the song.
    }
  };

  const schedule = (song: Song, delayMs: number, failures: number) => {
    const existing = pending.get(song.id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      pending.delete(song.id);
      if (conflicts.has(song.id)) return settle();
      void write(song, { failures });
    }, Math.max(delayMs, untilSaveAllowed(song.id)));
    pending.set(song.id, { timer, song });
    if (!status.getState().saving) status.setState({ saving: true });
  };

  type Outcome = "saved" | "conflict" | "deferred" | "failed";

  // Failures never throw, so editing keeps working; the outcome tells callers that must know.
  const writeWithOutcome = (song: Song, opts: { failures?: number; blocking?: boolean } = {}): Promise<Outcome> => {
    inflight += 1;
    return enqueue(() => writeNow(song, opts.failures ?? 0, opts.blocking ?? false)).finally(() => {
      inflight -= 1;
      settle();
    });
  };
  const write = async (song: Song, opts: { failures?: number; blocking?: boolean } = {}) =>
    (await writeWithOutcome(song, opts)) === "saved";

  // After a transient failure the earlier attempt may have committed before its response was lost,
  // so the retry's 409 can be this save colliding with itself rather than with another session.
  const committedAlready = async (song: Song): Promise<boolean> => {
    try {
      const stored = await api.get(song.id);
      if (!sameJson(stored.song, song)) return false;
      revisions.set(song.id, stored.revision);
      lastSavedAt.set(song.id, Date.now());
      return true;
    } catch {
      return false;
    }
  };

  const writeNow = async (song: Song, failures: number, blocking: boolean): Promise<Outcome> => {
    // Edits made while this attempt was queued or waiting supersede it.
    const newer = () => pending.has(song.id);
    for (let throttled = 0; ; ) {
      try {
        const revision = revisions.get(song.id);
        if (revision === undefined) throw new Error(`No known revision for song ${song.id}`);
        // A write queued behind another save starts the moment that one returns, which is inside the server's
        // interval and would draw a logged 429 even though its timer was scheduled in time.
        const gap = untilSaveAllowed(song.id);
        if (gap > 0) {
          if (!blocking && newer()) return "deferred";
          await sleep(gap);
          // The wait can be long enough for another edit to supersede this snapshot.
          if (!blocking && newer()) return "deferred";
        }
        const saved = await api.save(song.id, song, revision);
        revisions.set(song.id, saved.revision);
        lastSavedAt.set(song.id, Date.now());
        markSaved();
        return "saved";
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          const wait = e.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
          if (blocking && throttled < MAX_BLOCKING_THROTTLE_WAITS) {
            throttled += 1;
            await sleep(wait);
            continue;
          }
          // Not a failure: it only means the save interval has not passed yet.
          if (!newer()) schedule(song, wait, failures);
          return "deferred";
        }
        if (e instanceof ApiError && e.code === "revision_conflict") {
          if (failures > 0 && (await committedAlready(song))) {
            markSaved();
            return "saved";
          }
          setConflict(song.id, true);
          return "conflict";
        }
        markFailed(e instanceof ApiError && !isTransient(e) ? e.message : FAILURE_MESSAGE);
        if (isTransient(e) && !newer()) {
          const next = failures + 1;
          schedule(song, Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (next - 1)), next);
        }
        return "failed";
      }
    }
  };

  const flush = async () => {
    const jobs = [...pending.values()];
    pending.clear();
    for (const j of jobs) clearTimeout(j.timer);
    await Promise.all(jobs.map((j) => write(j.song, { blocking: true })));
    await queue;
  };

  const createOnServer = async (song: Song, reportFailure = true): Promise<Song> => {
    inflight += 1;
    try {
      const project = await enqueue(() => api.create(song));
      revisions.set(project.id, project.revision);
      lastSavedAt.set(project.id, Date.now());
      markSaved();
      // The server picks the id, so the caller's copy has to adopt it or later saves target nothing.
      return { ...song, id: project.id };
    } catch (e) {
      if (reportFailure) markFailed(e instanceof ApiError && !isTransient(e) ? e.message : FAILURE_MESSAGE);
      throw e;
    } finally {
      inflight -= 1;
      settle();
    }
  };

  // Migration happens only in memory: opening an old song must not rewrite it until the user edits.
  const load = async (id: string): Promise<Song | null> => {
    readStatus.setState({ invalid: false });
    try {
      const project = await api.get(id);
      revisions.set(id, project.revision);
      readStatus.setState({ failed: false });
      const song = migrateSong(project.song);
      if (!song) readStatus.setState({ invalid: true });
      return song;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        readStatus.setState({ failed: false });
        return null;
      }
      readStatus.setState({ failed: true });
      return null;
    }
  };

  // The list endpoint carries no sample references, so each song is fetched.
  const sampleIdsBySong = async (): Promise<Map<string, Set<string>>> => {
    await flush();
    const bySong = new Map<string, Set<string>>();
    for (const summary of await api.list()) {
      const { song } = await api.get(summary.id);
      bySong.set(summary.id, new Set(rawSampleIds(song as unknown as RawSongSamples)));
    }
    return bySong;
  };

  return {
    status,
    readStatus,

    getLastSongId(): string | null {
      const userId = getCurrentUserId();
      if (userId === null) return null;
      try {
        return localStorage.getItem(lastSongStorageKey(userId));
      } catch {
        return null;
      }
    },

    async list(): Promise<SongIndexEntry[]> {
      try {
        const projects = await api.list();
        readStatus.setState({ failed: false });
        return projects.map((p) => ({
          id: p.id,
          name: p.name,
          time_signature: p.time_signature,
          track_count: p.track_count,
          updated_at: p.updated_at,
        }));
      } catch {
        readStatus.setState({ failed: true });
        return [];
      }
    },

    // Throws on failure because there is no id to hand back. The failure banner is raised as well
    // unless the caller reports the error itself, as an import does with the server's reason.
    async create(song: Song, options: { reportFailure?: boolean } = {}): Promise<Song> {
      const created = await createOnServer(song, options.reportFailure);
      rememberLast(created.id);
      return created;
    },

    async open(id: string): Promise<Song | null> {
      await flush();
      const song = await load(id);
      if (song) {
        setConflict(id, false);
        rememberLast(id);
      }
      onSamplesMayBeFree?.();
      return song;
    },

    // Send to song must not change the last-opened id, or the next Studio visit would reopen a song
    // the user was not working on.
    async peek(id: string): Promise<Song | null> {
      await flush();
      return load(id);
    },

    // A song the library has never seen is created, so the returned song may carry a new id.
    // Throws `SaveRefusedError` unless the song reached the server, so a caller never reports a
    // save that did not happen.
    async put(song: Song): Promise<Song> {
      if (!revisions.has(song.id)) {
        try {
          return await createOnServer(song);
        } catch {
          throw new SaveRefusedError(false);
        }
      }
      const outcome = await writeWithOutcome(song, { blocking: true });
      if (outcome === "saved") return song;
      if (outcome === "deferred") {
        // Left scheduled, it would save later after the caller was told it failed, and a resend would duplicate it.
        const job = pending.get(song.id);
        if (job) {
          clearTimeout(job.timer);
          pending.delete(song.id);
          settle();
        }
      }
      if (outcome === "conflict") {
        // The caller is not editing this song, so a banner for it would have nothing to attach to.
        setConflict(song.id, false);
      }
      throw new SaveRefusedError(outcome === "conflict");
    },

    save(song: Song) {
      if (conflicts.has(song.id)) return;
      schedule(song, SAVE_DEBOUNCE_MS, 0);
    },

    flush,

    hasConflict: (id: string) => conflicts.has(id),

    // For "Save as copy": the original keeps its newer server version, and this tab moves on to the copy.
    clearConflict(id: string) {
      setConflict(id, false);
    },

    async rename(id: string, name: string): Promise<Song | null> {
      await flush();
      const song = await load(id);
      const next = name.trim();
      if (!song || !next) return song;
      const renamed = { ...song, name: next };
      return (await write(renamed, { blocking: true })) ? renamed : null;
    },

    async duplicate(id: string): Promise<Song | null> {
      await flush();
      const song = await load(id);
      if (!song) return null;
      try {
        const copy = await createOnServer({ ...structuredClone(song), id: newId(), name: `${song.name} (copy)` });
        onSamplesMayBeFree?.();
        return copy;
      } catch {
        return null;
      }
    },

    async remove(id: string): Promise<void> {
      const job = pending.get(id);
      if (job) {
        clearTimeout(job.timer);
        pending.delete(id);
        settle();
      }
      try {
        await enqueue(() => api.remove(id));
        markSaved();
      } catch (e) {
        // Already gone is the outcome the caller wanted.
        if (!(e instanceof ApiError && e.status === 404)) markFailed(FAILURE_MESSAGE);
      }
      revisions.delete(id);
      setConflict(id, false);
      if (this.getLastSongId() === id) rememberLast(null);
      onSamplesMayBeFree?.();
    },

    // Raw documents, unmigrated, because only the ids matter and a song that cannot migrate may still hold audio.
    // A read failure propagates so garbage collection aborts rather than treating unreadable songs as empty.
    async savedSampleIds(): Promise<string[]> {
      return [...(await sampleIdsBySong()).values()].flatMap((ids) => [...ids]);
    },

    // Counted from raw documents like savedSampleIds, so the remove-from-library warning agrees with what collection keeps.
    async songsUsingSample(sampleId: string): Promise<number> {
      return [...(await sampleIdsBySong()).values()].filter((ids) => ids.has(sampleId)).length;
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

export type SongLibrary = ReturnType<typeof createServerSongLibrary>;

let shared: SongLibrary | undefined;

export function getSongLibrary(): SongLibrary {
  return (shared ??= createServerSongLibrary(undefined, { onSamplesMayBeFree: scheduleGarbageCollection }));
}
