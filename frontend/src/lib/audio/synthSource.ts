import type { NoteHandle, SoundSource } from "./types";
import { velocityToGain } from "./velocity";

type ToneModule = typeof import("tone");
type Voice = InstanceType<ToneModule["Synth"]>;

export interface SynthPreset {
  voice: "Synth" | "FMSynth" | "AMSynth";
  options: Record<string, unknown>;
  // Built from the injected Tone module so importing presets never touches Tone.
  effects?: (tone: ToneModule) => Array<InstanceType<ToneModule["ToneAudioNode"]>>;
}

export const MAX_POLYPHONY = 32;

const FADE_SECONDS = 0.03;
// Long enough for the fade to finish before the nodes are disposed.
const DISPOSE_DELAY_MS = 200;

const midiToFrequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

interface PooledVoice {
  synth: Voice;
  // Includes the release tail; retriggering earlier would cut it off.
  freeAt: number;
  // Tone rejects a restart that is not strictly after the previous start.
  startedAt: number;
  // The live note currently holding this voice open, so a stale noteOff cannot release a successor.
  held: NoteHandle | null;
}

// Voices are driven directly rather than through Tone.PolySynth: its voices
// only become reusable after their release tail, so it drops notes exactly
// when stealing is needed, and it defers scheduled events to timeouts that
// cannot be cancelled on stop.
export function createSynthSource(preset: SynthPreset) {
  return (tone: ToneModule, output?: import("tone").InputNode): SoundSource => {
    const master = new tone.Gain(1);
    const effects = preset.effects?.(tone) ?? [];
    master.chain(...effects, output ?? tone.getDestination());

    const makePool = () => {
      const bus = new tone.Gain(1).connect(master);
      return { bus, voices: [] as PooledVoice[] };
    };
    let pool = makePool();

    const acquire = (startSeconds: number): PooledVoice | undefined => {
      const free = pool.voices.find((v) => v.freeAt <= startSeconds);
      if (free) return free;
      if (pool.voices.length < MAX_POLYPHONY) {
        const synth = new tone[preset.voice](preset.options as never) as Voice;
        synth.connect(pool.bus);
        const created = { synth, freeAt: 0, startedAt: -Infinity, held: null };
        pool.voices.push(created);
        return created;
      }
      // A voice that started at or after this note cannot be stolen without
      // wiping its queued events, so the note is dropped instead.
      // Held voices go last: cutting a key the player is still pressing is worse than cutting a tail.
      let oldest: PooledVoice | undefined;
      for (const v of pool.voices) {
        if (v.startedAt >= startSeconds) continue;
        if (
          !oldest ||
          (oldest.held && !v.held) ||
          (!oldest.held === !v.held && v.startedAt < oldest.startedAt)
        ) {
          oldest = v;
        }
      }
      return oldest;
    };

    const stopAll = () => {
      const old = pool;
      pool = makePool();
      old.bus.gain.rampTo(0, FADE_SECONDS);
      setTimeout(() => {
        old.voices.forEach((v) => v.synth.dispose());
        old.bus.dispose();
      }, DISPOSE_DELAY_MS);
    };

    return {
      load: () => Promise.resolve(),

      trigger(row, startSeconds, endSeconds, velocity) {
        const voice = acquire(startSeconds);
        if (!voice) return;
        // Retriggering an active voice replaces its pending release, which is
        // how the oldest note gives way to the new one.
        voice.synth.triggerAttack(
          midiToFrequency(row.midi_note),
          startSeconds,
          velocityToGain(velocity),
        );
        voice.synth.triggerRelease(endSeconds);
        voice.startedAt = startSeconds;
        voice.held = null;
        voice.freeAt =
          endSeconds + Number(voice.synth.toSeconds(voice.synth.envelope.release));
      },

      noteOn(row, startSeconds, velocity) {
        const handle: NoteHandle = {};
        const voice = acquire(startSeconds);
        if (!voice) return handle;
        voice.synth.triggerAttack(
          midiToFrequency(row.midi_note),
          startSeconds,
          velocityToGain(velocity),
        );
        voice.startedAt = startSeconds;
        voice.held = handle;
        // Unknown until noteOff, so nothing may reuse the voice in the meantime.
        voice.freeAt = Infinity;
        return handle;
      },

      noteOff(handle, endSeconds) {
        const voice = pool.voices.find((v) => v.held === handle);
        if (!voice) return;
        voice.synth.triggerRelease(endSeconds);
        voice.held = null;
        voice.freeAt =
          endSeconds + Number(voice.synth.toSeconds(voice.synth.envelope.release));
      },

      // Notes already handed to the audio graph for the near future cannot be
      // cancelled, so the whole pool is faded out and replaced.
      stopAll,

      dispose() {
        stopAll();
        // Deferred with the pool so the fade is not cut off by the master.
        setTimeout(() => {
          master.dispose();
          effects.forEach((e) => e.dispose());
        }, DISPOSE_DELAY_MS);
      },
    };
  };
}
