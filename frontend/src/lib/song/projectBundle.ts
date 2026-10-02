import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipPassThrough } from "fflate";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Sample } from "@/generated/Sample";
import { slugify } from "../midiFilename";
import {
  decodeWavFloat32,
  encodeWavFloat32,
  FLOAT_HEADER_BYTES,
  floatWavBytes,
  parseFloatWavHeader,
} from "../audio/wavFloat";
import { LOW_STORAGE_BYTES } from "../audio/sampleImport";
import { addToLibrary, getLibraryEntry, removeFromLibrary } from "../audio/sampleLibrary";
import { hasSample, putSample, readSamplePcm } from "../audio/sampleStore";
import {
  MAX_PROJECT_BYTES,
  parseProjectFile,
  serializeProject,
  type ProjectParse,
} from "./projectFile";
import type { Song } from "./types";

// Audio dominates a bundle's size, and the spec's cap is on the file.
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
export const PROJECT_JSON = "project.json";
export const bundleFilename = (song: Pick<Song, "name">) => `${slugify(song.name, "song")}.songbird.zip`;

const audioPath = (id: string) => `audio/${id}.wav`;
// Small because one push can inflate a whole slice before the size limit is checked, so the slice bounds a bomb's burst.
const CHUNK = 64 * 1024;
// Enough for a float WAV's chunks to precede its data however a tool laid them out.
const HEADER_PEEK = 4096;
const MAX_ENTRIES = 5000;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export async function isBundleFile(file: File): Promise<boolean> {
  const head = new Uint8Array(await readBlob(file.slice(0, 4)));
  return ZIP_MAGIC.every((b, i) => head[i] === b);
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

class BundleError extends Error {}

const fail = (message: string): ProjectParse => ({ error: message, kind: "bundle" });

// Unused samples are left out of a bundle, so one whose audio this browser has lost cannot block saving a song that
// no longer plays it.
export function usedSamples(song: Song): Sample[] {
  const used = new Set(song.tracks.flatMap((t) => t.audio_clips?.map((c) => c.sample_id) ?? []));
  return (song.samples ?? []).filter((s) => used.has(s.id));
}

// Saved from the stored audio, so what is written is what plays. A sample the browser has lost cannot be bundled,
// and saying so beats writing a bundle that silently drops it.
export async function createProjectBundle(song: Song): Promise<Blob> {
  const samples = usedSamples(song);
  const parts: BlobPart[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else parts.push(chunk as BlobPart);
  });
  const add = (name: string, data: Uint8Array) => {
    // Stored rather than deflated: float audio barely compresses and the time is better spent elsewhere.
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(data, true);
  };
  add(PROJECT_JSON, new TextEncoder().encode(serializeProject({ ...song, samples })));
  for (const sample of samples) {
    const pcm = await readSamplePcm(sample.id);
    if (!pcm) throw new Error(`The audio for "${sample.name}" isn't available in this browser, so it can't be bundled.`);
    add(audioPath(sample.id), encodeWavFloat32(pcm));
  }
  zip.end();
  if (failure) throw failure;
  return new Blob(parts, { type: "application/zip" });
}

interface Wanted {
  // The most this entry may expand to; going over aborts the whole scan, which is what stops a zip bomb.
  limit: number;
  // Bytes kept from the start of the entry; the rest is only counted.
  keep: number;
}
interface Found {
  data: Uint8Array;
  total: number;
}

// Streams the file through the unzipper in slices so memory holds one slice plus whatever an entry is allowed to
// keep. `onFound` runs between slices, so the caller can finish with one entry before the next is read.
async function scan(
  file: File,
  wanted: (name: string) => Wanted | null,
  onFound: (name: string, found: Found) => Promise<void> | void,
): Promise<void> {
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  const finished: [string, Found][] = [];
  let problem: Error | null = null;
  let entries = 0;
  unzip.onfile = (entry) => {
    entries += 1;
    if (entries > MAX_ENTRIES) problem ??= new BundleError("That bundle has too many files.");
    const want = wanted(entry.name);
    if (!want || problem) return;
    const kept: Uint8Array[] = [];
    let keptBytes = 0;
    let total = 0;
    entry.ondata = (err, data, final) => {
      if (err) {
        problem ??= err;
        return;
      }
      if (problem) return;
      total += data.length;
      if (total > want.limit) {
        problem = new BundleError(`${entry.name} is larger than its sample allows.`);
        entry.terminate();
        return;
      }
      if (keptBytes < want.keep) {
        const piece = data.subarray(0, want.keep - keptBytes);
        kept.push(piece.slice());
        keptBytes += piece.length;
      }
      if (final) {
        const joined = new Uint8Array(keptBytes);
        let at = 0;
        for (const k of kept) {
          joined.set(k, at);
          at += k.length;
        }
        finished.push([entry.name, { data: joined, total }]);
      }
    };
    entry.start();
  };
  for (let at = 0; at < file.size; at += CHUNK) {
    const chunk = new Uint8Array(await readBlob(file.slice(at, at + CHUNK)));
    try {
      unzip.push(chunk, at + CHUNK >= file.size);
    } catch (e) {
      problem ??= e instanceof Error ? e : new Error(String(e));
    }
    if (problem) throw problem;
    for (const [name, found] of finished.splice(0)) await onFound(name, found);
  }
}

const sizeMessage = "That bundle is too large (limit 2 GB).";

// Every check that can be made from the file alone comes before any storing, and a failure while storing takes back
// the library entries this open added, so a rejected bundle leaves the library as it was.
export async function readProjectBundle(
  file: File,
  instruments: InstrumentInfo[],
  // Told once if free space is under the warning threshold, as in an audio import; it never blocks.
  onLowStorage: () => void = () => undefined,
): Promise<ProjectParse> {
  if (file.size > MAX_BUNDLE_BYTES) return { error: sizeMessage, kind: "size" };
  try {
    let json: string | null = null;
    await scan(
      file,
      (name) => (name === PROJECT_JSON ? { limit: MAX_PROJECT_BYTES, keep: MAX_PROJECT_BYTES } : null),
      (_name, { data }) => {
        json = new TextDecoder().decode(data);
      },
    );
    if (json === null) return fail("That bundle has no project.json.");
    const parsed = parseProjectFile(json, instruments);
    if ("error" in parsed) return parsed;

    const samples = parsed.ok.samples ?? [];
    const byPath = new Map(samples.map((s) => [audioPath(s.id), s]));
    const expected = (s: Sample) => floatWavBytes(s.length_samples, s.channels);
    const declared = samples.reduce((sum, s) => sum + expected(s), 0);
    if (declared > MAX_BUNDLE_BYTES) return { error: sizeMessage, kind: "size" };

    const seen = new Set<string>();
    await scan(
      file,
      (name) => {
        const s = byPath.get(name);
        return s ? { limit: expected(s), keep: HEADER_PEEK } : null;
      },
      (name, { data, total }) => {
        const sample = byPath.get(name)!;
        seen.add(sample.id);
        const header = parseFloatWavHeader(data);
        if (!header) throw new BundleError(`The audio for "${sample.name}" can't be read.`);
        if (
          header.sampleRate !== sample.sample_rate ||
          header.channels !== sample.channels ||
          header.frames !== sample.length_samples ||
          // Audio is read from a fixed offset, so a data chunk anywhere else would be stored truncated.
          header.dataOffset !== FLOAT_HEADER_BYTES ||
          total !== expected(sample)
        ) {
          throw new BundleError(`The audio for "${sample.name}" doesn't match what the project says about it.`);
        }
      },
    );
    for (const s of samples) {
      if (!seen.has(s.id)) return fail(`The bundle is missing the audio for "${s.name}".`);
    }

    const fresh: Sample[] = [];
    for (const s of samples) if (!(await hasSample(s.id))) fresh.push(s);
    const needed = fresh.reduce((sum, s) => sum + expected(s), 0);
    const space = await estimateStorage();
    if (space?.quota !== undefined && space.usage !== undefined) {
      const free = space.quota - space.usage;
      if (free < LOW_STORAGE_BYTES) onLowStorage();
      if (free < needed) return fail("There is not enough browser storage left to open this bundle.");
    }

    const remap = new Map<string, string>();
    // Samples this open adds to the library, so a failure part-way can take them back out again.
    const added: string[] = [];
    try {
      await scan(
        file,
        (name) => {
          const s = byPath.get(name);
          return s ? { limit: expected(s), keep: expected(s) } : null;
        },
        async (name, { data }) => {
          const sample = byPath.get(name)!;
          const pcm = decodeWavFloat32(data, parseFloatWavHeader(data)!);
          // Same id means the audio is already stored and nothing is written; a different id means the bundle's
          // author hashed differently, so the song is pointed at the id the audio really has.
          const { id } = await putSample(pcm, async (stored) => {
            if (!(await getLibraryEntry(stored))) added.push(stored);
            await addToLibrary({
              id: stored,
              name: sample.name,
              sampleRate: sample.sample_rate,
              channels: sample.channels,
              length: sample.length_samples,
              importedAt: Date.now(),
            });
          });
          if (id !== sample.id) remap.set(sample.id, id);
        },
      );
      if (!remap.size) return { ok: parsed.ok };
      // Re-checked because two samples may turn out to be the same audio, which leaves a duplicate id the
      // song's own rules reject.
      const rewritten = parseProjectFile(serializeProject(remapSamples(parsed.ok, remap)), instruments);
      if ("error" in rewritten) throw new BundleError(rewritten.error);
      return rewritten;
    } catch (e) {
      // Stored audio with no library entry is collected as garbage, so removing the entries is the whole undo.
      for (const id of added) await removeFromLibrary(id);
      throw e;
    }
  } catch (e) {
    if (e instanceof BundleError) return fail(e.message);
    return fail("Couldn't read that bundle. Your songs are unchanged.");
  }
}

async function estimateStorage() {
  try {
    return await navigator.storage?.estimate?.();
  } catch {
    return undefined;
  }
}

function remapSamples(song: Song, remap: Map<string, string>): Song {
  const id = (x: string) => remap.get(x) ?? x;
  return {
    ...song,
    samples: dedupe(song.samples?.map((s) => ({ ...s, id: id(s.id) }))),
    tracks: song.tracks.map((t) =>
      t.audio_clips ? { ...t, audio_clips: t.audio_clips.map((c) => ({ ...c, sample_id: id(c.sample_id) })) } : t,
    ),
  };
}

// The first of two samples that turn out to be the same audio is kept, and clips already point at the shared id.
function dedupe(samples: Sample[] | undefined): Sample[] | undefined {
  const seen = new Set<string>();
  return samples?.filter((s) => !seen.has(s.id) && !!seen.add(s.id));
}
