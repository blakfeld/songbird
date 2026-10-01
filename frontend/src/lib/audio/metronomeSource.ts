type ToneModule = typeof import("tone");

const ACCENT_HZ = 1600;
const BEAT_HZ = 1000;
const CLICK_SECONDS = 0.03;

export interface MetronomeSource {
  click(startSeconds: number, accent: boolean): void;
  dispose(): void;
}

// Connected straight to the destination rather than through a track channel, so a click can never
// be muted, panned, or reach an export.
export function createMetronomeSource(tone: ToneModule): MetronomeSource {
  const synth = new tone.Synth({
    oscillator: { type: "square" },
    envelope: { attack: 0.001, decay: 0.02, sustain: 0, release: 0.01 },
  }).toDestination();
  return {
    click(startSeconds, accent) {
      synth.triggerAttackRelease(
        accent ? ACCENT_HZ : BEAT_HZ,
        CLICK_SECONDS,
        startSeconds,
        accent ? 1 : 0.6,
      );
    },
    dispose() {
      synth.dispose();
    },
  };
}
