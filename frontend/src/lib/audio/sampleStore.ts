import { createStore, del, get, keys, set } from "idb-keyval";
import { requireCurrentUserId } from "@/lib/auth/currentUser";
import { analyzeInWorker } from "./sampleAnalysisClient";
import type { PcmSample } from "./sampleAnalysis";

export interface StoredSample {
  sampleRate: number;
  channels: number;
  // Frames per channel, kept beside the blob so metadata reads never touch the audio bytes.
  length: number;
  // Interleaved little-endian Float32, which is lossless against the decode and needs no decode on load.
  data: Blob;
  overview: Float32Array;
}

// One database per user: the audio is not on the server, so it must survive sign-out, and the id in
// the name keeps the next user on this browser from reading it.
const stores = new Map<string, ReturnType<typeof createStore>>();
const samples = () => {
  const userId = requireCurrentUserId();
  let store = stores.get(userId);
  if (!store) {
    store = createStore(`songbird-samples.${userId}`, "samples");
    stores.set(userId, store);
  }
  return store;
};

// Store writes and garbage collection share one queue so a collection can never see a sample that is
// stored but not yet in the library, and delete it.
let queue: Promise<unknown> = Promise.resolve();
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

let persistRequested = false;
// Without persistence the browser may evict the whole store under pressure, silently emptying songs.
async function requestPersistence() {
  if (persistRequested) return;
  persistRequested = true;
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is best effort; the store still works without it.
  }
}

export interface PutResult {
  id: string;
  // False when identical audio was already stored, so a second import costs no space.
  created: boolean;
  overview: Float32Array;
}

// `register` runs inside the same exclusive section as the write, which is what lets a caller add the
// library entry before garbage collection can look at the new sample.
export async function putSample(
  pcm: PcmSample,
  register?: (id: string) => Promise<void>,
): Promise<PutResult> {
  const frames = Math.floor(pcm.data.length / pcm.channels);
  const { analysis, data } = await analyzeInWorker(pcm);
  return runExclusive(async () => {
    const existing = await get<StoredSample>(analysis.id, samples());
    if (existing) {
      await register?.(analysis.id);
      return { id: analysis.id, created: false, overview: existing.overview };
    }
    await requestPersistence();
    const record: StoredSample = {
      sampleRate: pcm.sampleRate,
      channels: pcm.channels,
      length: frames,
      data: new Blob([data as BlobPart]),
      overview: analysis.overview,
    };
    await set(analysis.id, record, samples());
    await register?.(analysis.id);
    return { id: analysis.id, created: true, overview: analysis.overview };
  });
}

export const getStoredSample = (id: string) => get<StoredSample>(id, samples());

export async function readSamplePcm(id: string): Promise<PcmSample | undefined> {
  const record = await getStoredSample(id);
  if (!record) return undefined;
  const buffer = await new Response(record.data).arrayBuffer();
  return { sampleRate: record.sampleRate, channels: record.channels, data: new Float32Array(buffer) };
}

export async function getSampleOverview(id: string): Promise<Float32Array | undefined> {
  return (await getStoredSample(id))?.overview;
}

export async function hasSample(id: string): Promise<boolean> {
  return (await getStoredSample(id)) !== undefined;
}

export async function listStoredSampleIds(): Promise<string[]> {
  return (await keys(samples())) as string[];
}

export const deleteStoredSample = (id: string) => del(id, samples());
