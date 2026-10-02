import { downmixToStereo, interleave } from "./sampleAnalysis";
import { addToLibrary, clipSampleName, type SampleLibraryEntry } from "./sampleLibrary";
import { putSample } from "./sampleStore";

export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
export const MAX_IMPORT_SECONDS = 20 * 60;
export const LOW_STORAGE_BYTES = 200 * 1024 * 1024;

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export type ImportFailureReason = "unsupported" | "too-large" | "too-long" | "no-storage";

export type ImportStage = "reading" | "decoding" | "storing" | "done";

export interface ImportProgress {
  fileIndex: number;
  fileCount: number;
  name: string;
  stage: ImportStage;
}

export type ImportOutcome =
  | {
      ok: true;
      file: string;
      entry: SampleLibraryEntry;
      // True when the same audio was already stored, so nothing new was written.
      duplicate: boolean;
    }
  | { ok: false; file: string; reason: ImportFailureReason; message: string };

export interface ImportOptions {
  decode?: (data: ArrayBuffer) => Promise<DecodedAudio>;
  estimate?: () => Promise<{ quota?: number; usage?: number } | undefined>;
  onProgress?: (progress: ImportProgress) => void;
  now?: () => number;
}

export interface ImportBatch {
  outcomes: ImportOutcome[];
  // Set when free space was under the warning threshold at any point, so the UI can warn once for the batch.
  lowStorage: boolean;
}

const failures: Record<ImportFailureReason, (file: string) => string> = {
  unsupported: (f) => `${f} is not an audio file the browser can read.`,
  "too-large": (f) => `${f} is larger than 200 MB, the most that can be imported.`,
  "too-long": (f) => `${f} is longer than 20 minutes, the most that can be imported.`,
  "no-storage": (f) => `There is not enough browser storage left to import ${f}.`,
};

const fail = (file: string, reason: ImportFailureReason): ImportOutcome => ({
  ok: false,
  file,
  reason,
  message: failures[reason](file),
});

export const sampleNameFromFile = (fileName: string) => {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return clipSampleName(stem) || "Sample";
};

async function defaultDecode(data: ArrayBuffer): Promise<DecodedAudio> {
  // Tone's context is the one playback uses, so decoding there stores audio at the rate it will play at.
  const Tone = await import("tone");
  const context = Tone.getContext().rawContext as BaseAudioContext;
  const buffer = await context.decodeAudioData(data);
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
  };
}

async function defaultEstimate() {
  try {
    return await navigator.storage?.estimate?.();
  } catch {
    return undefined;
  }
}

export async function importAudioFile(
  file: File,
  index: number,
  count: number,
  options: ImportOptions = {},
  warn: () => void = () => undefined,
): Promise<ImportOutcome> {
  const { decode = defaultDecode, estimate = defaultEstimate, onProgress, now = Date.now } = options;
  const progress = (stage: ImportStage) =>
    onProgress?.({ fileIndex: index, fileCount: count, name: file.name, stage });

  if (file.size > MAX_IMPORT_BYTES) return fail(file.name, "too-large");

  progress("reading");
  let decoded: DecodedAudio;
  try {
    const data = await file.arrayBuffer();
    progress("decoding");
    decoded = await decode(data);
  } catch {
    return fail(file.name, "unsupported");
  }
  const frames = decoded.channels[0]?.length ?? 0;
  if (frames === 0 || decoded.channels.length === 0) return fail(file.name, "unsupported");
  if (frames / decoded.sampleRate > MAX_IMPORT_SECONDS) return fail(file.name, "too-long");

  const channels = downmixToStereo(decoded.channels);
  const needed = frames * channels.length * 4;
  const space = await estimate();
  if (space?.quota !== undefined && space.usage !== undefined) {
    const free = space.quota - space.usage;
    if (free < LOW_STORAGE_BYTES) warn();
    if (free < needed) return fail(file.name, "no-storage");
  }

  progress("storing");
  const data = interleave(channels);
  try {
    let entry!: SampleLibraryEntry;
    const stored = await putSample(
      { sampleRate: decoded.sampleRate, channels: channels.length, data },
      async (id) => {
        entry = await addToLibrary({
          id,
          name: sampleNameFromFile(file.name),
          sampleRate: decoded.sampleRate,
          channels: channels.length,
          length: frames,
          importedAt: now(),
        });
      },
    );
    const outcome = { entry, duplicate: !stored.created };
    progress("done");
    return { ok: true, file: file.name, ...outcome };
  } catch {
    return fail(file.name, "no-storage");
  }
}

export async function importAudioFiles(
  files: File[],
  options: ImportOptions = {},
): Promise<ImportBatch> {
  let lowStorage = false;
  const outcomes: ImportOutcome[] = [];
  // Sequential, because decoded audio is large and parallel imports would hold several copies in memory.
  for (const [i, file] of files.entries()) {
    outcomes.push(
      await importAudioFile(file, i, files.length, options, () => {
        lowStorage = true;
      }),
    );
  }
  return { outcomes, lowStorage };
}
