import { analyzeSample, type PcmSample } from "./sampleAnalysis";

self.onmessage = async (event: MessageEvent<PcmSample>) => {
  const pcm = event.data;
  try {
    const analysis = await analyzeSample(pcm);
    // The buffer goes back with the result because the caller still has to store it.
    self.postMessage({ ok: true, analysis, data: pcm.data }, { transfer: [pcm.data.buffer] });
  } catch (error) {
    self.postMessage({ ok: false, message: String(error) });
  }
};
