import { analyzeSample, type PcmSample, type SampleAnalysis } from "./sampleAnalysis";

type WorkerReply =
  | { ok: true; analysis: SampleAnalysis; data: Float32Array }
  | { ok: false; message: string };

// Hashing a long decode would stall the page, so it goes to a worker; without Worker support
// (tests, old browsers) the same pure function runs inline.
export async function analyzeInWorker(
  pcm: PcmSample,
): Promise<{ analysis: SampleAnalysis; data: Float32Array }> {
  if (typeof Worker === "undefined") return { analysis: await analyzeSample(pcm), data: pcm.data };
  const worker = new Worker(new URL("./sampleAnalysis.worker.ts", import.meta.url));
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (event.data.ok) resolve({ analysis: event.data.analysis, data: event.data.data });
        else reject(new Error(event.data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage(pcm, { transfer: [pcm.data.buffer] });
    });
  } finally {
    worker.terminate();
  }
}
