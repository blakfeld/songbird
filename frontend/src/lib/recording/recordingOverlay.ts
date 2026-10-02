// Peaks arrive at about 30 Hz, so they live outside the zustand state: a lane draws them from a ref on animation
// frames, and putting each one through React state would re-render the whole Studio for a thin sliver of waveform.
export interface PeakFeed {
  readonly values: readonly number[];
  push(peak: number): void;
  clear(): void;
  subscribe(cb: () => void): () => void;
}

export function createPeakFeed(): PeakFeed {
  const values: number[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((cb) => cb());
  return {
    values,
    push(peak) {
      values.push(peak);
      notify();
    },
    clear() {
      values.length = 0;
      notify();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

// Not part of the song: it exists only to draw a take that has no clip yet, and it must never reach history or a save.
export interface RecordingOverlay {
  trackId: string;
  // Where the take will land; null only when the song position is not yet known.
  startTicks: number | null;
  // False through the count-in, when only the landing point can be shown.
  started: boolean;
  takeName: string;
  // 1-based, and above 1 only while looping.
  pass: number;
  peaks: PeakFeed;
}
