import { clipEnvelope, planClip } from "./clipSchedule";
import type { PlaybackClip, SoundSource } from "./types";

type ToneModule = typeof import("tone");
type ToneBuffer = InstanceType<ToneModule["ToneAudioBuffer"]>;

interface Slot {
  player: InstanceType<ToneModule["Player"]>;
  gain: InstanceType<ToneModule["Gain"]>;
  // Compared with the audio clock to decide when the player may be re-pointed at another clip.
  busyUntil: number;
}

// Back-to-back clips need a second player while the first is still ringing, but a long song should not keep
// that many idle players alive.
const MAX_IDLE_PLAYERS = 4;

export interface AudioTrackSource extends SoundSource {
  // `position` is frames into the clip, so a start inside a clip or after a loop wrap resumes mid-audio.
  // Returns false when there is nothing to play, so the caller does not count the clip as sounding.
  playClip(clip: PlaybackClip, buffer: ToneBuffer, startAt: number, position: number): boolean;
  // Cuts what is sounding at a loop wrap or seek, so the old position cannot overlap the new one.
  stopClips(at: number): void;
}

// Audio tracks have no notes; the SoundSource shape is kept so the engine can own them like any other voice.
export function createAudioTrackSource(
  tone: ToneModule,
  output: import("tone").InputNode,
  now: () => number,
): AudioTrackSource {
  const slots: Slot[] = [];

  const acquire = (): Slot => {
    // Idle by the audio clock, not by the scheduled end: a clip due to end exactly where the next begins is
    // still sounding when the next is scheduled, and re-pointing its player would bend the tail of that clip.
    const clock = now();
    const idle = slots.filter((s) => s.busyUntil <= clock);
    for (const extra of idle.slice(MAX_IDLE_PLAYERS)) {
      extra.player.dispose();
      extra.gain.dispose();
      slots.splice(slots.indexOf(extra), 1);
    }
    if (idle.length > 0 && idle[0]) return idle[0];
    const gain = new tone.Gain(0);
    gain.connect(output);
    const player = new tone.Player();
    player.connect(gain);
    const slot = { player, gain, busyUntil: 0 };
    slots.push(slot);
    return slot;
  };

  return {
    async load() {},
    trigger() {},
    noteOn: () => ({}),
    noteOff() {},
    playClip(pc, buffer, startAt, position) {
      const plan = planClip(pc, position);
      if (!plan) return false;
      const slot = acquire();
      const { player, gain } = slot;
      player.buffer = buffer;
      player.loop = plan.loop;
      player.loopStart = plan.loopStart;
      player.loopEnd = plan.loopEnd;

      const points = clipEnvelope(pc, position);
      gain.gain.cancelScheduledValues(startAt);
      gain.gain.setValueAtTime(points[0].value, startAt);
      for (const point of points.slice(1)) gain.gain.linearRampToValueAtTime(point.value, startAt + point.at);

      player.start(startAt, plan.offset, plan.duration);
      // A looping player never reaches the end of its buffer, so without this its state would stay "started"
      // and the next start on the pooled player would be treated as a restart.
      player.stop(startAt + plan.duration);
      slot.busyUntil = startAt + plan.duration;
      return true;
    },
    stopClips(at) {
      for (const slot of slots) {
        if (slot.busyUntil <= at) continue;
        slot.player.stop(at);
        slot.busyUntil = at;
      }
    },
    stopAll() {
      for (const slot of slots) {
        slot.player.stop();
        slot.busyUntil = 0;
      }
    },
    dispose() {
      for (const slot of slots) {
        slot.player.dispose();
        slot.gain.dispose();
      }
      slots.length = 0;
    },
  };
}
