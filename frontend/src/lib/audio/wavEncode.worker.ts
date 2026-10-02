import { encodeWav16 } from "./wavEncode";

interface Request {
  channels: Float32Array[];
  sampleRate: number;
}

self.onmessage = (event: MessageEvent<Request>) => {
  try {
    const { bytes, clipped } = encodeWav16(event.data.channels, event.data.sampleRate);
    self.postMessage({ ok: true, bytes, clipped }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ ok: false, message: String(error) });
  }
};
