import * as nwa from "node-web-audio-api";

// jsdom has no Web Audio, so a native implementation is exposed as the globals Tone looks for. This must run before
// Tone is first imported, which is why tests import it first and load Tone dynamically.
const globals = globalThis as Record<string, unknown>;
for (const [name, value] of Object.entries(nwa)) {
  if (/^(Audio|Offline|Biquad|Gain|Delay|Convolver|Dynamics|Oscillator|StereoPanner|Wave|Channel|Analyser|Constant|IIR|MediaStream|Panner|Periodic)/.test(name)) {
    globals[name] = value;
  }
}

// Tone builds a live AudioContext as soon as it's imported, before loadRealTone can swap in an offline one. Without
// a "none" sink that constructor opens an output device, which CI runners don't have.
// The package's typings lag its runtime, which accepts the standard AudioSinkOptions.
type SinkOptions = NonNullable<ConstructorParameters<typeof nwa.AudioContext>[0]> & { sinkId?: { type: "none" } };
globals.AudioContext = class extends nwa.AudioContext {
  constructor(options: SinkOptions = {}) {
    super({ ...options, sinkId: { type: "none" } } as SinkOptions);
  }
};

type ToneModule = typeof import("tone");

// The "live" context is itself offline so no audio device is opened; renders still get their own offline contexts.
export async function loadRealTone(sampleRate = 48000): Promise<ToneModule> {
  const tone = await import("tone");
  tone.setContext(new tone.OfflineContext(2, 1, sampleRate));
  return tone;
}
