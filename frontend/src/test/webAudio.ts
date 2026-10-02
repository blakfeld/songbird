import * as nwa from "node-web-audio-api";

// jsdom has no Web Audio, so a native implementation is exposed as the globals Tone looks for. This must run before
// Tone is first imported, which is why tests import it first and load Tone dynamically.
const globals = globalThis as Record<string, unknown>;
for (const [name, value] of Object.entries(nwa)) {
  if (/^(Audio|Offline|Biquad|Gain|Delay|Convolver|Dynamics|Oscillator|StereoPanner|Wave|Channel|Analyser|Constant|IIR|MediaStream|Panner|Periodic)/.test(name)) {
    globals[name] = value;
  }
}

type ToneModule = typeof import("tone");

// The "live" context is itself offline so no audio device is opened; renders still get their own offline contexts.
export async function loadRealTone(sampleRate = 48000): Promise<ToneModule> {
  const tone = await import("tone");
  tone.setContext(new tone.OfflineContext(2, 1, sampleRate));
  return tone;
}
