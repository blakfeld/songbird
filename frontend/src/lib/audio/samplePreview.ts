import { sharedSampleBuffers } from "./sampleBuffers";

type Listener = (playingId: string | null) => void;

// One player straight to the destination keeps previews out of the song's mixer and transport, so a preview can
// run while the song plays and never moves the playhead.
export interface SamplePreview {
  toggle(id: string): Promise<void>;
  stop(): void;
  subscribe(listener: Listener): () => void;
  current(): string | null;
}

export function createSamplePreview(): SamplePreview {
  let playing: string | null = null;
  let player: { stop(): unknown; dispose(): unknown } | null = null;
  // A later request makes an earlier one that is still loading drop its result, so only the newest preview sounds.
  let ticket = 0;
  const listeners = new Set<Listener>();
  const set = (id: string | null) => {
    playing = id;
    for (const l of listeners) l(id);
  };
  const halt = () => {
    const old = player;
    player = null;
    if (old) {
      try {
        old.stop();
      } catch {
        // Already stopped.
      }
      old.dispose();
    }
  };

  return {
    current: () => playing,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      ticket++;
      halt();
      if (playing !== null) set(null);
    },
    async toggle(id) {
      const mine = ++ticket;
      const wasPlaying = playing === id;
      halt();
      if (wasPlaying) {
        set(null);
        return;
      }
      set(id);
      try {
        const Tone = await import("tone");
        await Tone.start();
        const buffers = sharedSampleBuffers(Tone);
        await buffers.load([id]);
        const buffer = buffers.get(id);
        if (mine !== ticket) return;
        if (!buffer) {
          set(null);
          return;
        }
        buffers.acquire([id]);
        const next = new Tone.Player(buffer).toDestination();
        player = next;
        next.onstop = () => {
          buffers.release([id]);
          if (player === next) {
            player = null;
            set(null);
          }
        };
        next.start();
      } catch {
        if (mine === ticket) set(null);
      }
    },
  };
}

let shared: SamplePreview | null = null;
export const getSamplePreview = () => (shared ??= createSamplePreview());
