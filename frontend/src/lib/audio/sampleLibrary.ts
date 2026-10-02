import { createStore, del, entries, get, set } from "idb-keyval";
import { requireCurrentUserId } from "@/lib/auth/currentUser";
import { cutUtf16 } from "@/lib/song/audioTiming";
import { runExclusive } from "./sampleStore";
import { scheduleGarbageCollection } from "./sampleGc";

export const SAMPLE_NAME_MAX = 80;

export interface SampleLibraryEntry {
  id: string;
  name: string;
  sampleRate: number;
  channels: number;
  length: number;
  importedAt: number;
}

// Per user for the same reason as the sample store: kept across sign-out, invisible to other users.
const stores = new Map<string, ReturnType<typeof createStore>>();
const index = () => {
  const userId = requireCurrentUserId();
  let store = stores.get(userId);
  if (!store) {
    store = createStore(`songbird-sample-library.${userId}`, "library");
    stores.set(userId, store);
  }
  return store;
};

// Both validators count UTF-16 units, so a cut by code points would let an emoji name overrun the limit.
export const clipSampleName = (name: string) => cutUtf16(name.trim(), SAMPLE_NAME_MAX);

export async function listLibrary(): Promise<SampleLibraryEntry[]> {
  const all = (await entries<string, SampleLibraryEntry>(index())).map(([, entry]) => entry);
  return all.sort((a, b) => b.importedAt - a.importedAt);
}

export async function libraryIds(): Promise<string[]> {
  return (await listLibrary()).map((e) => e.id);
}

export const getLibraryEntry = (id: string) => get<SampleLibraryEntry>(id, index());

// Re-importing known audio keeps the first entry, so its name and position in the list survive.
export async function addToLibrary(entry: SampleLibraryEntry): Promise<SampleLibraryEntry> {
  const existing = await getLibraryEntry(entry.id);
  if (existing) return existing;
  await set(entry.id, entry, index());
  return entry;
}

export async function renameLibrarySample(id: string, name: string): Promise<void> {
  const entry = await getLibraryEntry(id);
  const next = clipSampleName(name);
  if (!entry || !next) return;
  await set(id, { ...entry, name: next }, index());
}

export async function removeFromLibrary(id: string): Promise<void> {
  await runExclusive(() => del(id, index()));
  scheduleGarbageCollection();
}
