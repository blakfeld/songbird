import type { Song } from "@/lib/song/types";
import { deleteStoredSample, listStoredSampleIds, runExclusive } from "./sampleStore";

export const GC_DEBOUNCE_MS = 2000;

export const songSampleIds = (song: Song): string[] => (song.samples ?? []).map((s) => s.id);

export interface GcSources {
  libraryIds: () => Promise<string[]>;
  savedSongSampleIds: () => Promise<string[]>;
  // The open song and its undo and redo stacks: undo can bring back a clip whose sample nothing else holds.
  openSongs: () => Song[];
}

let openSongs: () => Song[] = () => [];
// A registered getter rather than a store import keeps this module free of the song store and its cycle with the library.
export function setOpenSongSource(source: (() => Song[]) | null) {
  openSongs = source ?? (() => []);
}

// Loaded lazily because the song library and the sample library both import this module to schedule collection.
const defaultSources = (): GcSources => ({
  libraryIds: async () => (await import("./sampleLibrary")).libraryIds(),
  savedSongSampleIds: async () =>
    (await import("@/lib/song/songLibrary")).getSongLibrary().savedSampleIds(),
  openSongs: () => openSongs(),
});

export async function collectGarbage(sources: GcSources = defaultSources()): Promise<string[]> {
  return runExclusive(async () => {
    // Every source is read before any delete, so a failed read aborts the pass instead of freeing audio that is in use.
    const live = new Set<string>([
      ...(await sources.libraryIds()),
      ...(await sources.savedSongSampleIds()),
      ...sources.openSongs().flatMap(songSampleIds),
    ]);
    const freed: string[] = [];
    for (const id of await listStoredSampleIds()) {
      if (live.has(id)) continue;
      await deleteStoredSample(id);
      freed.push(id);
    }
    return freed;
  });
}

let timer: ReturnType<typeof setTimeout> | undefined;
export function scheduleGarbageCollection(delay = GC_DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    // Collection is housekeeping; a failure only means audio stays stored until the next pass.
    void collectGarbage().catch(() => undefined);
  }, delay);
}
