import type { Row } from "@/generated/Row";
import { createToneFilter, OPEN_CUTOFF_HZ, rampToneFilter, wantsFilter } from "./toneFilter";
import type { SoundSource, ToneControls } from "./types";
import { velocityToGain } from "./velocity";

type ToneModule = typeof import("tone");

export const DRUM_KIT_BASE_URL = "/kits/drums/";

export function createDrumsSource(
  tone: ToneModule,
  output?: import("tone").InputNode,
  initialTone?: ToneControls,
): SoundSource {
  let filter: ReturnType<typeof createToneFilter> | null = null;
  // Built on first need so an untouched kit keeps its original graph; hits already ringing finish on the old route.
  const ensureFilter = (controls: ToneControls | undefined, sweep: boolean) => {
    if (filter || !wantsFilter(controls)) return;
    // Created open and ramped when added mid-use, because starting at the target would make the first edit jump.
    filter = sweep
      ? createToneFilter(tone, OPEN_CUTOFF_HZ, undefined)
      : createToneFilter(tone, controls?.filterCutoffHz ?? OPEN_CUTOFF_HZ, controls?.filterResonance);
    if (output) filter.connect(output);
    else filter.toDestination();
    if (sweep && controls) rampToneFilter(filter, controls, OPEN_CUTOFF_HZ);
  };
  ensureFilter(initialTone, false);
  // Read per hit rather than baked in, because a sample's pitch is fixed once it starts.
  let playbackRate = 2 ** ((initialTone?.pitchSemitones ?? 0) / 12);

  let buffers: InstanceType<ToneModule["ToneAudioBuffers"]> | null = null;
  // Includes notes still being fetched so a play racing a preload reuses it.
  const loadedNotes = new Set<number>();
  let loading: Promise<void> | null = null;
  const active = new Set<InstanceType<ToneModule["ToneBufferSource"]>>();

  const covers = (notes: Set<number>) =>
    [...notes].every((n) => loadedNotes.has(n));

  const hit = (row: Row, startSeconds: number, velocity: number) => {
    const key = String(row.midi_note);
    if (!buffers?.has(key)) return;
    // Own gain per hit so a soft hit cannot change a still-ringing loud one.
    const gain = new tone.Gain(velocityToGain(velocity));
    if (filter) gain.connect(filter);
    else if (output) gain.connect(output);
    else gain.toDestination();
    const src = new tone.ToneBufferSource({
      url: buffers.get(key),
      playbackRate,
      onended: () => {
        active.delete(src);
        src.dispose();
        gain.dispose();
      },
    }).connect(gain);
    active.add(src);
    src.start(startSeconds);
  };

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

    setTone(controls) {
      playbackRate = 2 ** ((controls.pitchSemitones ?? 0) / 12);
      if (filter) rampToneFilter(filter, controls, OPEN_CUTOFF_HZ);
      else ensureFilter(controls, true);
    },

    // endSeconds is unused: a drum hit always rings out fully.
    trigger(row, startSeconds, _endSeconds, velocity) {
      hit(row, startSeconds, velocity);
    },

    // A drum hit is a one-shot, so a live key press never needs to hold anything.
    noteOn(row, startSeconds, velocity) {
      hit(row, startSeconds, velocity);
      return {};
    },

    noteOff() {},

    stopAll() {
      for (const src of active) src.stop();
    },

    dispose() {
      for (const src of active) src.stop();
      filter?.dispose();
    },
  };
}
