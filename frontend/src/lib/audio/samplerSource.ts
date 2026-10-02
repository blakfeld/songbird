import type { Row } from "@/generated/Row";
import type { SamplerSettings } from "@/generated/SamplerSettings";
import { DEFAULT_ROOT_NOTE, SAMPLER_KEYS_ENVELOPE, type SamplerKind } from "@/lib/song/sampler";
import type { SampleBufferCache } from "./sampleBuffers";
import { createToneFilter, OPEN_CUTOFF_HZ, rampToneFilter, wantsFilter } from "./toneFilter";
import type { NoteHandle, SoundSource, ToneControls, ToneEnvelope } from "./types";
import { velocityToGain } from "./velocity";

type ToneModule = typeof import("tone");
type ToneBuffer = InstanceType<ToneModule["ToneAudioBuffer"]>;
type Player = InstanceType<ToneModule["Player"]>;
type GainNode = InstanceType<ToneModule["Gain"]>;

export const MAX_SAMPLER_VOICES = 32;

// Short enough that a stolen voice does not smear into its replacement, long enough to avoid a click.
const STEAL_FADE_SECONDS = 0.005;
const STOP_FADE_SECONDS = 0.03;
// Long enough for a fade to finish before the nodes are disposed.
const DISPOSE_DELAY_MS = 200;
const RETIRE_AFTER_SECONDS = 1;

export type SamplerSource = SoundSource;

interface Voice {
  player: Player;
  gain: GainNode;
  startedAt: number;
  // Infinity while a live key is down, because nothing may reuse the voice until it is released.
  endsAt: number;
  held: NoteHandle | null;
  // Velocity and pad gain folded into one scale, so every envelope ramp is relative to it.
  level: number;
  naturalEnd: number;
  sustained: boolean;
  disposed: boolean;
}

interface Plan {
  sampleId: string;
  rate: number;
  level: number;
  sustained: boolean;
}

// Pure so the audio graph and the mixdown's look-ahead agree on what a note means.
export function planSamplerNote(
  kind: SamplerKind,
  settings: SamplerSettings,
  row: Row,
  velocity: number,
  trackPitchSemitones: number,
): Plan | null {
  if (kind === "keys") {
    const keys = settings.keys;
    if (!keys?.sample_id) return null;
    const root = keys.root_note ?? DEFAULT_ROOT_NOTE;
    return {
      sampleId: keys.sample_id,
      rate: 2 ** ((row.midi_note - root) / 12),
      level: velocityToGain(velocity),
      sustained: !keys.one_shot,
    };
  }
  const pad = settings.pads?.find((p) => p.row_id === row.id);
  if (!pad) return null;
  return {
    sampleId: pad.sample_id,
    rate: 2 ** ((pad.pitch_semitones + trackPitchSemitones) / 12),
    level: velocityToGain(velocity) * 10 ** ((pad.gain_db ?? 0) / 20),
    sustained: false,
  };
}

const defaultEnvelope = (): ToneEnvelope => ({ ...SAMPLER_KEYS_ENVELOPE });

// Anchors the release ramp: a linear ramp starts from the previous event, so without the level at the key-up time
// the fade would begin where the decay ended instead of at the note's end.
function levelAfter(t: number, level: number, env: ToneEnvelope, oneShot: boolean): number {
  if (t <= 0) return 0;
  if (t < env.attack) return (level * t) / env.attack;
  if (oneShot) return level;
  if (t < env.attack + env.decay) return level * (1 - ((1 - env.sustain) * (t - env.attack)) / env.decay);
  return level * env.sustain;
}

// Voices are driven directly, like the synth's, so a note can be scheduled ahead of the audio clock and its
// release shaped on its own gain without a shared envelope.
export function createSamplerSource(kind: SamplerKind) {
  return (tone: ToneModule, output?: import("tone").InputNode, initialTone?: ToneControls): SamplerSource => {
    const bus = new tone.Gain(1);
    const target = output ?? tone.getDestination();
    let filter: ReturnType<typeof createToneFilter> | null = null;
    const route = (to: import("tone").InputNode) => {
      bus.disconnect();
      bus.connect(to);
    };
    const ensureFilter = (controls: ToneControls | undefined, sweep: boolean) => {
      if (filter || !wantsFilter(controls)) return;
      // Created open and ramped when added mid-use, because starting at the target would make the first edit jump.
      filter = sweep
        ? createToneFilter(tone, OPEN_CUTOFF_HZ, undefined)
        : createToneFilter(tone, controls?.filterCutoffHz ?? OPEN_CUTOFF_HZ, controls?.filterResonance);
      filter.connect(target);
      route(filter);
      if (sweep && controls) rampToneFilter(filter, controls, OPEN_CUTOFF_HZ);
    };
    bus.connect(target);
    ensureFilter(initialTone, false);

    let envelope: ToneEnvelope = { ...defaultEnvelope(), ...initialTone?.envelope };
    let trackPitch = initialTone?.pitchSemitones ?? 0;
    let settings: SamplerSettings = {};
    let buffers: SampleBufferCache | null = null;
    const held = new Set<string>();
    let ready: Promise<void> = Promise.resolve();
    let voices: Voice[] = [];

    const dispose = (v: Voice) => {
      if (v.disposed) return;
      v.disposed = true;
      v.player.dispose();
      v.gain.dispose();
      voices = voices.filter((o) => o !== v);
    };

    const sampleIds = (s: SamplerSettings) =>
      new Set([...(s.keys?.sample_id ? [s.keys.sample_id] : []), ...(s.pads ?? []).map((p) => p.sample_id)]);

    const acquireVoice = (startSeconds: number): boolean => {
      const live = voices.filter((v) => v.endsAt > startSeconds);
      if (live.length < MAX_SAMPLER_VOICES) return true;
      // A voice that begins at or after this note would be cut before it sounded, and a held key is the last to give way.
      let oldest: Voice | undefined;
      for (const v of live) {
        if (v.startedAt >= startSeconds) continue;
        if (!oldest || (oldest.held && !v.held) || (!oldest.held === !v.held && v.startedAt < oldest.startedAt))
          oldest = v;
      }
      if (!oldest) return false;
      oldest.gain.gain.cancelScheduledValues(startSeconds);
      oldest.gain.gain.rampTo(0, STEAL_FADE_SECONDS, startSeconds);
      oldest.player.stop(startSeconds + STEAL_FADE_SECONDS);
      oldest.endsAt = startSeconds;
      oldest.held = null;
      return true;
    };

    // Swept as notes arrive rather than when a player ends, because disposing a node from an end callback in the
    // middle of an offline render silences that render. A voice is only retired once the audio clock is well past it.
    const retireFinished = () => {
      const now = tone.now();
      for (const v of voices) if (v.endsAt + RETIRE_AFTER_SECONDS < now) dispose(v);
    };

    const begin = (
      row: Row,
      startSeconds: number,
      velocity: number,
      offsetSeconds = 0,
    ): { voice: Voice; buffer: ToneBuffer } | null => {
      retireFinished();
      const plan = planSamplerNote(kind, settings, row, velocity, trackPitch);
      if (!plan) return null;
      const buffer = buffers?.get(plan.sampleId);
      if (!buffer) return null;
      // Seconds of output already played, in sample time: a render window that opens mid-note joins the sample there.
      const offset = offsetSeconds * plan.rate;
      if (offset >= buffer.duration) return null;
      if (!acquireVoice(startSeconds)) return null;
      // A fresh player per note, because changing a player's rate would bend any of its earlier notes still scheduled.
      const player = new tone.Player({ playbackRate: plan.rate });
      player.buffer = buffer;
      const gain = new tone.Gain(0);
      player.connect(gain);
      gain.connect(bus);
      const naturalEnd = startSeconds + (buffer.duration - offset) / plan.rate;
      const voice: Voice = {
        player,
        gain,
        // The note's own start, so a resumed ring ranks by age against newer notes when the pool is full.
        startedAt: startSeconds - offsetSeconds,
        endsAt: naturalEnd,
        held: null,
        level: plan.level,
        naturalEnd,
        sustained: plan.sustained,
        disposed: false,
      };
      voices.push(voice);
      if (offset > 0) player.start(startSeconds, offset);
      else player.start(startSeconds);
      return { voice, buffer };
    };

    const attack = (voice: Voice, startSeconds: number, resumedAt = 0) => {
      const g = voice.gain.gain;
      if (kind === "pads" || resumedAt >= envelope.attack) {
        g.setValueAtTime(voice.level, startSeconds);
        return;
      }
      // A note resumed inside its attack continues the fade from where it would be, so the window's edge has no step.
      g.setValueAtTime(levelAfter(resumedAt, voice.level, envelope, true), startSeconds);
      g.linearRampToValueAtTime(voice.level, startSeconds + envelope.attack - resumedAt);
    };

    const release = (voice: Voice, atSeconds: number) => {
      const g = voice.gain.gain;
      const stopAt = Math.min(atSeconds + envelope.release, voice.naturalEnd);
      g.cancelAndHoldAtTime(atSeconds);
      g.linearRampToValueAtTime(0, atSeconds + envelope.release);
      voice.player.stop(stopAt);
      voice.endsAt = stopAt;
      voice.held = null;
    };

    const stopAll = () => {
      const now = tone.now();
      const old = voices;
      voices = [];
      for (const v of old) {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.rampTo(0, STOP_FADE_SECONDS, now);
        v.player.stop(now + STOP_FADE_SECONDS);
      }
      setTimeout(() => old.forEach(dispose), DISPOSE_DELAY_MS);
    };

    return {
      async load() {
        await ready;
      },

      setSamples(next, cache) {
        settings = next;
        buffers = cache;
        const wanted = sampleIds(next);
        const fresh = [...wanted].filter((id) => !held.has(id));
        const stale = [...held].filter((id) => !wanted.has(id));
        cache.acquire(fresh);
        fresh.forEach((id) => held.add(id));
        cache.release(stale);
        stale.forEach((id) => held.delete(id));
        // A sample the store lost stays unloadable, and the cache swallows that, so its notes stay silent.
        ready = cache.load(wanted);
      },

      setTone(controls) {
        envelope = { ...defaultEnvelope(), ...controls.envelope };
        trackPitch = controls.pitchSemitones ?? 0;
        if (filter) rampToneFilter(filter, controls, OPEN_CUTOFF_HZ);
        else ensureFilter(controls, true);
      },

      trigger(row, startSeconds, endSeconds, velocity, offsetSeconds = 0) {
        const started = begin(row, startSeconds, velocity, offsetSeconds);
        if (!started) return;
        const { voice } = started;
        if (kind === "keys") {
          const g = voice.gain.gain;
          if (!voice.sustained) {
            attack(voice, startSeconds, offsetSeconds);
            return;
          }
          const end = Math.max(endSeconds, startSeconds);
          const t = end - startSeconds;
          const { level } = voice;
          g.setValueAtTime(0, startSeconds);
          if (t <= envelope.attack) {
            g.linearRampToValueAtTime(levelAfter(t, level, envelope, false), end);
          } else {
            g.linearRampToValueAtTime(level, startSeconds + envelope.attack);
            if (t <= envelope.attack + envelope.decay) g.linearRampToValueAtTime(levelAfter(t, level, envelope, false), end);
            else g.linearRampToValueAtTime(level * envelope.sustain, startSeconds + envelope.attack + envelope.decay);
          }
          g.setValueAtTime(levelAfter(t, level, envelope, false), end);
          g.linearRampToValueAtTime(0, end + envelope.release);
          const stopAt = Math.min(end + envelope.release, voice.naturalEnd);
          voice.player.stop(stopAt);
          voice.endsAt = stopAt;
          return;
        }
        attack(voice, startSeconds, offsetSeconds);
      },

      noteOn(row, startSeconds, velocity) {
        const handle: NoteHandle = {};
        const started = begin(row, startSeconds, velocity);
        if (!started) return handle;
        const { voice } = started;
        attack(voice, startSeconds);
        if (kind === "keys" && voice.sustained) {
          voice.gain.gain.linearRampToValueAtTime(
            voice.level * envelope.sustain,
            startSeconds + envelope.attack + envelope.decay,
          );
          voice.held = handle;
          voice.endsAt = Infinity;
        }
        return handle;
      },

      noteOff(handle, endSeconds) {
        const voice = voices.find((v) => v.held === handle);
        if (voice) release(voice, Math.max(endSeconds, voice.startedAt));
      },

      stopAll,

      dispose() {
        stopAll();
        if (buffers) buffers.release([...held]);
        held.clear();
        // Deferred with the voices so their fade is not cut off by the bus.
        setTimeout(() => {
          bus.dispose();
          filter?.dispose();
        }, DISPOSE_DELAY_MS);
      },
    };
  };
}
