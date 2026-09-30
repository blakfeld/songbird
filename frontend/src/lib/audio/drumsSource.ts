import type { Row } from "@/generated/Row";
import type { SoundSource } from "./types";
import { velocityToGain } from "./velocity";

type ToneModule = typeof import("tone");

export const DRUM_KIT_BASE_URL = "/kits/drums/";

export function createDrumsSource(
  tone: ToneModule,
  output?: import("tone").InputNode,
): SoundSource {
  let buffers: InstanceType<ToneModule["ToneAudioBuffers"]> | null = null;
  // Includes notes still being fetched so a play racing a preload reuses it.
  const loadedNotes = new Set<number>();
  let loading: Promise<void> | null = null;
  const active = new Set<InstanceType<ToneModule["ToneBufferSource"]>>();

  const covers = (notes: Set<number>) =>
    [...notes].every((n) => loadedNotes.has(n));

  return {
    // Kept across plays so playback still works if the network drops after the
    // first load; only a row whose sample isn't loaded yet triggers a fetch.
    load(rows: Row[]) {
      const wanted = new Set(rows.map((r) => r.midi_note));
      if (loading && covers(wanted)) return loading;
      const notes = new Set([...loadedNotes, ...wanted]);
      notes.forEach((n) => loadedNotes.add(n));
      const urls: Record<string, string> = {};
      for (const n of notes) urls[String(n)] = `${n}.wav`;
      const next = new tone.ToneAudioBuffers({
        urls,
        baseUrl: DRUM_KIT_BASE_URL,
      });
      const attempt = tone.loaded().then(
        () => {
          buffers = next;
        },
        (e) => {
          // A failed attempt must not be cached, or Play could never retry.
          if (loading === attempt) {
            loading = null;
            loadedNotes.clear();
          }
          throw e instanceof Error ? e : new Error(String(e));
        },
      );
      loading = attempt;
      return attempt;
    },

    // endSeconds is unused: a drum hit always rings out fully.
    trigger(row, startSeconds, _endSeconds, velocity) {
      const key = String(row.midi_note);
      if (!buffers?.has(key)) return;
      // Own gain per hit so a soft hit cannot change a still-ringing loud one.
      const gain = new tone.Gain(velocityToGain(velocity));
      if (output) gain.connect(output);
      else gain.toDestination();
      const src = new tone.ToneBufferSource({
        url: buffers.get(key),
        onended: () => {
          active.delete(src);
          src.dispose();
          gain.dispose();
        },
      }).connect(gain);
      active.add(src);
      src.start(startSeconds);
    },

    stopAll() {
      for (const src of active) src.stop();
    },

    dispose() {
      for (const src of active) src.stop();
    },
  };
}
