// Runs on the audio thread, so it only copies samples and posts messages: encoding, hashing and storage all
// happen on the main thread, where a slow frame cannot glitch playback.
const PEAK_HZ = 30;
// One second per chunk keeps message traffic low while bounding how much audio a crash or dropped message can lose.
const CHUNK_SECONDS = 1;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = Math.max(1, options.processorOptions?.channels ?? 1);
    this.chunkFrames = Math.round(sampleRate * CHUNK_SECONDS);
    this.peakFrames = Math.round(sampleRate / PEAK_HZ);
    this.capturing = false;
    this.buffers = null;
    this.filled = 0;
    this.chunkFrame = 0;
    this.peak = 0;
    this.peakCount = 0;
    this.port.onmessage = (event) => {
      const type = event.data?.type;
      if (type === "start") this.capturing = true;
      else if (type === "stop") {
        this.flush();
        this.capturing = false;
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  flush() {
    if (!this.buffers || this.filled === 0) return;
    const channels = this.buffers.map((b) => b.slice(0, this.filled));
    this.port.postMessage({ type: "chunk", frame: this.chunkFrame, channels }, channels.map((c) => c.buffer));
    this.buffers = null;
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0] ?? [];
    // A disconnected input has no channels; zeros keep the frame count continuous so later audio stays aligned.
    const frames = input[0]?.length ?? 128;

    let peak = 0;
    for (let c = 0; c < input.length; c++) {
      const data = input[c];
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
    }
    this.peak = Math.max(this.peak, peak);
    this.peakCount += frames;
    if (this.peakCount >= this.peakFrames) {
      this.port.postMessage({ type: "peak", frame: currentFrame, peak: this.peak });
      this.peak = 0;
      this.peakCount = 0;
    }

    if (!this.capturing) return true;
    if (this.buffers && this.filled + frames > this.chunkFrames) this.flush();
    if (!this.buffers) {
      this.buffers = Array.from({ length: this.channels }, () => new Float32Array(this.chunkFrames));
      this.chunkFrame = currentFrame;
    }
    for (let c = 0; c < this.channels; c++) {
      // A mono source asked for stereo repeats its only channel rather than leaving one side silent.
      const data = input[c] ?? input[0];
      if (data) this.buffers[c].set(data, this.filled);
    }
    this.filled += frames;
    return true;
  }
}

registerProcessor("songbird-recorder", RecorderProcessor);
