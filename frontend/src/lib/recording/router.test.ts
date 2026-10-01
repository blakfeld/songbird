import { afterEach, describe, expect, it, vi } from "vitest";
import type { Row } from "@/generated/Row";
import type { Note } from "@/generated/Note";
import type { LiveNote } from "../audio/engine";
import type { MidiEvent } from "../midi/access";
import { createInputRouter, type LiveTarget, type RouterEngine } from "./router";
import type { TakeSummary, TakeTarget } from "./take";

const rows: Row[] = [
  { id: "c4", name: "C4", midi_note: 60 },
  { id: "d4", name: "D4", midi_note: 62 },
];
const target: LiveTarget = { rows, voiceKey: "piano", oneShot: false };

function setup(
  stepFor: (t: number) => number | null = (t) => Math.round(t / 100),
  onSilentNote?: () => void,
) {
  let listener: (e: MidiEvent) => void = () => {};
  const midi = {
    subscribe: (cb: (e: MidiEvent) => void) => {
      listener = cb;
      return () => {
        listener = () => {};
      };
    },
  };
  const offs: LiveNote[] = [];
  const engine = {
    liveNoteOn: vi.fn((row: Row) => ({ row }) as unknown as LiveNote),
    liveNoteOff: vi.fn((n: LiveNote) => void offs.push(n)),
    stepAt: vi.fn((t: number) => {
      const step = stepFor(t);
      return step === null ? null : { step, frac: 0, seconds: t / 1000, stepSeconds: 0.125 };
    }),
  } satisfies RouterEngine;
  let clock = 0;
  const router = createInputRouter(midi, engine, () => clock, onSilentNote);
  const send = (type: MidiEvent["type"], note: number, velocity: number, timeStamp: number) =>
    listener({ type, note, velocity, timeStamp });
  const added: Note[] = [];
  const summary: TakeSummary = { recorded: 0, dropped: {} };
  const take: TakeTarget = {
    begin: vi.fn(),
    add: (n) => void added.push(n),
    end: vi.fn(() => summary),
    discard: vi.fn(),
  };
  return { router, engine, send, added, take, setClock: (t: number) => (clock = t) };
}

const range = { start: 0, end: 16 };

afterEach(() => vi.useRealTimers());

describe("InputRouter", () => {
  it("ignores a key outside the instrument", () => {
    const { router, engine, send, added, take } = setup();
    router.setLiveTarget(target);
    router.startTake(take, { range, looping: false });
    send("on", 30, 100, 0);
    send("off", 30, 0, 100);
    expect(engine.liveNoteOn).not.toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  it("passes velocity and voice key through", () => {
    const { router, engine, send } = setup();
    router.setLiveTarget(target);
    send("on", 62, 90, 0);
    expect(engine.liveNoteOn).toHaveBeenCalledWith(rows[1], { voiceKey: "piano", velocity: 90 });
  });

  it("does nothing without a live target", () => {
    const { engine, send } = setup();
    send("on", 60, 90, 0);
    expect(engine.liveNoteOn).not.toHaveBeenCalled();
  });

  it("holds notes under the sustain pedal until it lifts", () => {
    const { router, engine, send, added, take } = setup();
    router.setLiveTarget(target);
    router.startTake(take, { range, looping: false });
    send("sustain", 64, 127, 0);
    send("on", 60, 100, 200);
    send("off", 60, 0, 300);
    expect(engine.liveNoteOff).not.toHaveBeenCalled();
    send("sustain", 64, 0, 700);
    expect(engine.liveNoteOff).toHaveBeenCalledTimes(1);
    expect(added).toEqual([{ row_id: "c4", step: 2, length_steps: 5, velocity: 100 }]);
  });

  it("releases immediately without the pedal and records the length", () => {
    const { router, engine, send, added, take } = setup();
    router.setLiveTarget(target);
    router.startTake(take, { range, looping: false });
    send("on", 60, 80, 100);
    send("off", 60, 0, 400);
    expect(engine.liveNoteOff).toHaveBeenCalledTimes(1);
    expect(added).toEqual([{ row_id: "c4", step: 1, length_steps: 3, velocity: 80 }]);
  });

  it("ends the previous press when a pedal-held key is struck again", () => {
    const { router, engine, send } = setup();
    router.setLiveTarget(target);
    send("sustain", 64, 127, 0);
    send("on", 60, 100, 0);
    send("off", 60, 0, 10);
    send("on", 60, 100, 20);
    expect(engine.liveNoteOff).toHaveBeenCalledTimes(1);
    expect(engine.liveNoteOn).toHaveBeenCalledTimes(2);
  });

  it("does not record notes played outside a take", () => {
    const { router, send, added, take } = setup();
    router.setLiveTarget(target);
    send("on", 60, 100, 0);
    router.startTake(take, { range, looping: false });
    send("off", 60, 0, 300);
    expect(added).toEqual([]);
  });

  it("records a note still held at take end and keeps it sounding", () => {
    const { router, engine, send, added, take, setClock } = setup();
    router.setLiveTarget(target);
    router.startTake(take, { range, looping: false });
    send("on", 60, 100, 200);
    setClock(600);
    const summary = router.endTake();
    expect(summary).toEqual({ recorded: 0, dropped: {} });
    expect(added).toEqual([{ row_id: "c4", step: 2, length_steps: 4, velocity: 100 }]);
    expect(engine.liveNoteOff).not.toHaveBeenCalled();
    send("off", 60, 0, 900);
    expect(added).toHaveLength(1);
    expect(engine.liveNoteOff).toHaveBeenCalledTimes(1);
  });

  it("discards the take without recording held notes", () => {
    const { router, send, added, take } = setup();
    router.setLiveTarget(target);
    router.startTake(take, { range, looping: false });
    send("on", 60, 100, 0);
    router.discardTake();
    send("off", 60, 0, 300);
    expect(take.discard).toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  it("drops a note the engine cannot map to a step", () => {
    const { router, send, added, take } = setup(() => null);
    router.setLiveTarget(target);
    router.startTake(take, { range, looping: false });
    send("on", 60, 100, 0);
    send("off", 60, 0, 300);
    expect(added).toEqual([]);
  });

  it("releases held notes when the live target changes", () => {
    const { router, engine, send } = setup();
    router.setLiveTarget(target);
    send("on", 60, 100, 0);
    router.setLiveTarget({ rows: [rows[1]], oneShot: true });
    expect(engine.liveNoteOff).toHaveBeenCalledTimes(1);
    send("on", 60, 100, 10);
    expect(engine.liveNoteOn).toHaveBeenCalledTimes(1);
    send("on", 62, 100, 20);
    expect(engine.liveNoteOn).toHaveBeenCalledTimes(2);
  });

  it("records one-shot notes as one step", () => {
    const { router, send, added, take } = setup();
    router.setLiveTarget({ rows, oneShot: true });
    router.startTake(take, { range, looping: false });
    send("on", 60, 100, 300);
    send("off", 60, 0, 900);
    expect(added[0].length_steps).toBe(1);
  });

  it("stops listening after dispose and releases held notes", () => {
    const { router, engine, send } = setup();
    router.setLiveTarget(target);
    send("on", 60, 100, 0);
    router.dispose();
    expect(engine.liveNoteOff).toHaveBeenCalledTimes(1);
    send("on", 62, 100, 0);
    expect(engine.liveNoteOn).toHaveBeenCalledTimes(1);
  });

  it("ends and commits the take on dispose, recording the keys still held", () => {
    const { router, send, added, take, setClock } = setup();
    router.setLiveTarget(target);
    router.startTake(take, { range, looping: false });
    send("on", 60, 100, 200);
    setClock(600);
    router.dispose();
    expect(take.end).toHaveBeenCalledTimes(1);
    expect(take.discard).not.toHaveBeenCalled();
    expect(added).toEqual([expect.objectContaining({ row_id: "c4", step: 2, length_steps: 4 })]);
  });

  it("releases held notes on a reset, recording them off at that moment", () => {
    const { router, engine, send, added, take } = setup();
    router.setLiveTarget(target);
    router.startTake(take, { range, looping: false });
    send("on", 60, 100, 0);
    send("on", 62, 100, 100);
    send("reset", 0, 0, 500);
    expect(engine.liveNoteOff).toHaveBeenCalledTimes(2);
    expect(added.map((n) => [n.row_id, n.step, n.length_steps])).toEqual([
      ["c4", 0, 5],
      ["d4", 1, 4],
    ]);
    send("off", 60, 0, 700);
    expect(added).toHaveLength(2);
  });

  it("lifts the pedal on a reset so later notes release normally", () => {
    const { router, engine, send } = setup();
    router.setLiveTarget(target);
    send("sustain", 64, 127, 0);
    send("on", 60, 100, 10);
    send("reset", 0, 0, 20);
    send("on", 62, 100, 30);
    send("off", 62, 0, 40);
    expect(engine.liveNoteOff).toHaveBeenCalledTimes(2);
  });

  it("reports a key press that made no sound", () => {
    const onSilent = vi.fn();
    const { router, engine, send } = setup(undefined, onSilent);
    engine.liveNoteOn.mockReturnValue(null as unknown as LiveNote);
    router.setLiveTarget(target);
    send("on", 60, 100, 0);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it("reaches liveNoteOn within the 20 ms budget on a mocked clock", () => {
    vi.useFakeTimers();
    const { router, engine, send, take } = setup();
    router.setLiveTarget(target);
    router.startTake(take, { range, looping: false });
    let calledAt = -1;
    engine.liveNoteOn.mockImplementation((row: Row) => {
      calledAt = performance.now();
      return { row } as unknown as LiveNote;
    });
    const sentAt = performance.now();
    send("on", 60, 100, sentAt);
    expect(calledAt - sentAt).toBeLessThan(20);
  });
});
