import { encodeWav16, type EncodedWav } from "./wavEncode";

type WorkerReply = ({ ok: true } & EncodedWav) | { ok: false; message: string };

// Encoding a long mix is a pass over millions of samples, so it goes to a worker; without Worker support
// (tests, old browsers) the same pure function runs inline.
export async function encodeWavInWorker(channels: Float32Array[], sampleRate: number): Promise<EncodedWav> {
  if (typeof Worker === "undefined") return encodeWav16(channels, sampleRate);
  const worker = new Worker(new URL("./wavEncode.worker.ts", import.meta.url));
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (event.data.ok) resolve({ bytes: event.data.bytes, clipped: event.data.clipped });
        else reject(new Error(event.data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ channels, sampleRate }, { transfer: channels.map((c) => c.buffer) });
    });
  } finally {
    worker.terminate();
  }
}
