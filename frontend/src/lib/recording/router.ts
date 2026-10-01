import type { Row } from "@/generated/Row";
import type { LiveNote, PlaybackEngine } from "../audio/engine";
import type { MidiAccess, MidiEvent } from "../midi/access";
import { quantizeNote, type MappedStep, type TakeSummary, type TakeTarget } from "./take";

export interface LiveTarget {
  rows: Row[];
  voiceKey?: string;
  // Drum-like instruments ignore how long a key is held, both for recording and for the live sound.
  oneShot: boolean;
}

export interface TakeOptions {
  range: { start: number; end: number };
  looping: boolean;
}

export interface InputRouter {
  // Held notes are released first so nothing keeps sounding on a voice the player can no longer see selected.
  setLiveTarget(target: LiveTarget | null): void;
  startTake(target: TakeTarget, options: TakeOptions): void;
  endTake(): TakeSummary;
  discardTake(): void;
  // Commits the take rather than discarding it, since leaving a page is not a request to throw the notes away.
  dispose(): void;
}

export type RouterEngine = Pick<PlaybackEngine, "liveNoteOn" | "liveNoteOff" | "stepAt">;

interface HeldNote {
  key: number;
  row: Row;
  oneShot: boolean;
  velocity: number;
  live: LiveNote | null;
  // Absent when the note began outside a take or could not be mapped, so it is never recorded.
  onStep: MappedStep | null;
  // Pedal is holding a key that has already been physically released.
  keyReleased: boolean;
}

const SUSTAIN_DOWN = 64;
const EMPTY_SUMMARY = (): TakeSummary => ({ recorded: 0, dropped: {} });

export function createInputRouter(
  midi: Pick<MidiAccess, "subscribe">,
  engine: RouterEngine,
  now: () => number = () => performance.now(),
  // Called when a key press made no sound, so the page can say why instead of leaving the player guessing.
  onSilentNote?: () => void,
): InputRouter {
  let target: LiveTarget | null = null;
  let take: { target: TakeTarget; options: TakeOptions } | null = null;
  let pedalDown = false;
  const held = new Map<number, HeldNote>();

  const finish = (note: HeldNote, timeStamp: number) => {
    held.delete(note.key);
    if (note.live) engine.liveNoteOff(note.live);
    if (take && note.onStep) {
      const quantized = quantizeNote({
        row_id: note.row.id,
        velocity: note.velocity,
        on: note.onStep,
        off: engine.stepAt(timeStamp),
        range: take.options.range,
        looping: take.options.looping,
        oneShot: note.oneShot,
      });
      if (quantized) take.target.add(quantized);
    }
  };

  const noteOn = (e: MidiEvent) => {
    if (!target) return;
    const row = target.rows.find((r) => r.midi_note === e.note);
    if (!row) return;
    // A retrigger under the pedal ends the earlier press, since the map holds one note per key.
    const previous = held.get(e.note);
    if (previous) finish(previous, e.timeStamp);
    // Sounding comes first so the step lookup never delays it.
    const live = engine.liveNoteOn(row, {
      voiceKey: target.voiceKey,
      velocity: e.velocity,
    });
    if (!live) onSilentNote?.();
    held.set(e.note, {
      key: e.note,
      row,
      oneShot: target.oneShot,
      velocity: e.velocity,
      live,
      onStep: take ? engine.stepAt(e.timeStamp) : null,
      keyReleased: false,
    });
  };

  const noteOff = (e: MidiEvent) => {
    const note = held.get(e.note);
    if (!note || note.keyReleased) return;
    if (pedalDown) note.keyReleased = true;
    else finish(note, e.timeStamp);
  };

  const sustain = (e: MidiEvent) => {
    const down = e.velocity >= SUSTAIN_DOWN;
    if (down === pedalDown) return;
    pedalDown = down;
    if (down) return;
    for (const note of [...held.values()]) {
      if (note.keyReleased) finish(note, e.timeStamp);
    }
  };

  // Also drops the pedal, because the release that would normally lift it can no longer arrive.
  const releaseAll = (stamp: number = now()) => {
    pedalDown = false;
    for (const note of [...held.values()]) finish(note, stamp);
  };

  const unsubscribe = midi.subscribe((e) => {
    if (e.type === "on") noteOn(e);
    else if (e.type === "off") noteOff(e);
    else if (e.type === "reset") releaseAll(e.timeStamp);
    else sustain(e);
  });

  // Stops recording the held notes without silencing them, since the player is still holding the keys.
  const settleHeldForTake = (record: boolean) => {
    const stamp = now();
    for (const note of held.values()) {
      if (!note.onStep) continue;
      if (record && take) {
        const quantized = quantizeNote({
          row_id: note.row.id,
          velocity: note.velocity,
          on: note.onStep,
          off: engine.stepAt(stamp),
          range: take.options.range,
          looping: take.options.looping,
          oneShot: note.oneShot,
        });
        if (quantized) take.target.add(quantized);
      }
      note.onStep = null;
    }
  };

  return {
    setLiveTarget(next) {
      releaseAll();
      target = next;
    },
    startTake(next, options) {
      if (take) take.target.discard();
      settleHeldForTake(false);
      take = { target: next, options };
      next.begin();
    },
    endTake() {
      if (!take) return EMPTY_SUMMARY();
      settleHeldForTake(true);
      const summary = take.target.end();
      take = null;
      return summary;
    },
    discardTake() {
      if (!take) return;
      settleHeldForTake(false);
      take.target.discard();
      take = null;
    },
    dispose() {
      unsubscribe();
      // Held notes go into the take first, while it still exists to receive them.
      if (take) {
        settleHeldForTake(true);
        take.target.end();
        take = null;
      }
      releaseAll();
    },
  };
}
