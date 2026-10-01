import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import * as api from "@/lib/api";
import { getPlaybackEngine } from "@/lib/audio/engine";
import { usePlayback } from "@/lib/audio/usePlayback";
import { createMidiAccess } from "@/lib/midi/access";
import { emptyPattern } from "@/lib/patternOps";
import { getPatternStore } from "@/lib/patternStore";
import { cellLabel } from "@/lib/pianoRoll";
import { createFakeMidi } from "@/test/fakeMidi";
import { drums } from "@/test/fixtures";
import { PatternEditorPage } from "./PatternEditorPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getLimits: vi.fn(),
  getInstruments: vi.fn(),
}));

// Stands in for the real hook's teardown, which stops the engine on unmount.
let onPlaybackTeardown: (() => void) | null = null;
vi.mock("@/lib/audio/usePlayback", () => ({ usePlayback: vi.fn() }));

vi.mock("tone", () => ({
  start: async () => {},
  getContext: () => ({ currentTime: 0 }),
}));

const piano: InstrumentInfo = {
  id: "piano",
  name: "Piano",
  kind: "melodic",
  midi_program: 0,
  range: { low: 60, high: 62 },
  midi_channel: 1,
  sustained: true,
  rows: [
    { id: "d4", name: "D4", midi_note: 62 },
    { id: "c4", name: "C4", midi_note: 60 },
  ],
};

const fake = () => createFakeMidi({ inputs: [{ id: "k", name: "KeyStep" }] });
const send = (m: ReturnType<typeof fake>, bytes: number[]) =>
  act(() => m.send("k", bytes, performance.now()));

async function renderGranted(instrument: InstrumentInfo) {
  const midi = fake();
  const access = createMidiAccess({ requestMIDIAccess: midi.requestMIDIAccess, storage: null });
  await access.request();
  getPatternStore(instrument.id).getState().setPattern(emptyPattern(instrument, 4));
  const view = render(
    <PatternEditorPage instrumentId={instrument.id} title={instrument.name} instrument={instrument} midi={access} />,
  );
  await screen.findByRole("button", { name: "Record" });
  return Object.assign(midi, { unmount: view.unmount });
}

const engineFor = (id: string) => getPlaybackEngine(id);

beforeEach(() => {
  localStorage.clear();
  onPlaybackTeardown = null;
  // Stores are module singletons, so history from an earlier test would hide whether Undo is enabled by the take itself.
  for (const id of ["piano", "drums"]) getPatternStore(id).setState({ pattern: null, past: [], future: [], gestureBase: null });
  vi.mocked(usePlayback).mockImplementation(() => {
    useEffect(() => () => onPlaybackTeardown?.(), []);
    return {
      isPlaying: false,
      status: "idle",
      error: null,
      toggle: vi.fn(),
      stop: vi.fn(),
      preload: vi.fn(),
      subscribePosition: () => () => {},
    };
  });
  vi.mocked(api.getLimits).mockResolvedValue({ max_input_tokens: 256, measure_options: [4, 8] });
  vi.mocked(api.getInstruments).mockResolvedValue([drums, piano]);
});

afterEach(() => vi.restoreAllMocks());

describe("MIDI keyboard on an instrument page", () => {
  it("plays a melodic note at its velocity without touching the pattern", async () => {
    const engine = engineFor("piano");
    const on = vi.spyOn(engine, "liveNoteOn").mockReturnValue({} as never);
    const off = vi.spyOn(engine, "liveNoteOff").mockImplementation(() => {});
    vi.spyOn(engine, "prepareLive").mockResolvedValue();
    const midi = await renderGranted(piano);
    const before = getPatternStore("piano").getState().pattern;

    await send(midi, [0x90, 60, 90]);
    expect(on).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c4" }),
      expect.objectContaining({ velocity: 90 }),
    );
    await send(midi, [0x80, 60, 0]);
    expect(off).toHaveBeenCalledTimes(1);
    expect(getPatternStore("piano").getState().pattern).toBe(before);
  });

  it("prepares the instrument's rows once access is granted", async () => {
    const prepare = vi.spyOn(engineFor("piano"), "prepareLive").mockResolvedValue();
    await renderGranted(piano);
    await waitFor(() => expect(prepare).toHaveBeenCalledWith(undefined, piano.rows));
  });

  it("shows a recorded take in the piano roll and ends it with one undo step", async () => {
    const engine = engineFor("piano");
    vi.spyOn(engine, "liveNoteOn").mockReturnValue({} as never);
    vi.spyOn(engine, "liveNoteOff").mockImplementation(() => {});
    vi.spyOn(engine, "prepareLive").mockResolvedValue();
    const play = vi.spyOn(engine, "play").mockResolvedValue();
    vi.spyOn(engine, "stepAt").mockReturnValueOnce({ step: 4, frac: 0, seconds: 0, stepSeconds: 0.125 }).mockReturnValueOnce({ step: 6, frac: 0, seconds: 0, stepSeconds: 0.125 });
    const midi = await renderGranted(piano);
    // The count-in is covered by the transport tests; skipping it starts the take at once.
    await userEvent.click(screen.getByRole("button", { name: "Count-in" }));

    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(play).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Recording from bar 1.");

    await send(midi, [0x90, 60, 100]);
    await send(midi, [0x80, 60, 0]);
    expect(screen.getByRole("button", { name: cellLabel("C4", 4, 16) })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(screen.getByRole("status")).toHaveTextContent("Recorded 1 note. Undo removes the take.");
    expect(getPatternStore("piano").getState().pattern?.notes).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(getPatternStore("piano").getState().pattern?.notes).toHaveLength(0);
  });

  it("fires a drum one-shot and records it as one step long", async () => {
    const engine = engineFor("drums");
    vi.spyOn(engine, "liveNoteOn").mockReturnValue({} as never);
    vi.spyOn(engine, "liveNoteOff").mockImplementation(() => {});
    vi.spyOn(engine, "prepareLive").mockResolvedValue();
    vi.spyOn(engine, "play").mockResolvedValue();
    vi.spyOn(engine, "stepAt").mockReturnValueOnce({ step: 2, frac: 0, seconds: 0, stepSeconds: 0.125 }).mockReturnValueOnce({ step: 9, frac: 0, seconds: 0, stepSeconds: 0.125 });
    const midi = await renderGranted(drums);
    await userEvent.click(screen.getByRole("button", { name: "Count-in" }));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await send(midi, [0x99, 38, 80]);
    await send(midi, [0x89, 38, 0]);
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(getPatternStore("drums").getState().pattern?.notes).toEqual([
      { row_id: "snare", step: 2, length_steps: 1, velocity: 80 },
    ]);
  });

  const step = (n: number) => ({ step: n, frac: 0, seconds: 0, stepSeconds: 0.125 });

  async function startPianoTake() {
    const engine = engineFor("piano");
    vi.spyOn(engine, "liveNoteOn").mockReturnValue({} as never);
    vi.spyOn(engine, "liveNoteOff").mockImplementation(() => {});
    vi.spyOn(engine, "prepareLive").mockResolvedValue();
    vi.spyOn(engine, "play").mockResolvedValue();
    const midi = await renderGranted(piano);
    await userEvent.click(screen.getByRole("button", { name: "Count-in" }));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    return { engine, midi };
  }

  it("ends the take before an undo so the next note cannot overwrite what the undo restored", async () => {
    const { engine, midi } = await startPianoTake();
    getPatternStore("piano").getState().toggleNote("d4", 8);
    vi.spyOn(engine, "stepAt")
      .mockReturnValueOnce(step(4))
      .mockReturnValueOnce(step(6))
      .mockReturnValueOnce(step(10))
      .mockReturnValueOnce(step(12));
    await send(midi, [0x90, 60, 100]);
    await send(midi, [0x80, 60, 0]);

    await userEvent.keyboard("{Control>}z{/Control}");

    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Recorded 1 note.");
    expect(getPatternStore("piano").getState().pattern?.notes.map((n) => n.row_id)).toEqual(["d4"]);

    await send(midi, [0x90, 60, 100]);
    await send(midi, [0x80, 60, 0]);
    expect(getPatternStore("piano").getState().pattern?.notes.map((n) => n.row_id)).toEqual(["d4"]);
  });

  it("keeps Undo enabled during a take that has no earlier history", async () => {
    const { engine, midi } = await startPianoTake();
    vi.spyOn(engine, "stepAt").mockReturnValueOnce(step(4)).mockReturnValueOnce(step(6));
    await send(midi, [0x90, 60, 100]);
    await send(midi, [0x80, 60, 0]);

    expect(getPatternStore("piano").getState().past).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("keeps a note toggled by hand during a take", async () => {
    const { engine, midi } = await startPianoTake();
    vi.spyOn(engine, "stepAt")
      .mockReturnValueOnce(step(4))
      .mockReturnValueOnce(step(6))
      .mockReturnValueOnce(step(10))
      .mockReturnValueOnce(step(12));
    await send(midi, [0x90, 60, 100]);
    await send(midi, [0x80, 60, 0]);
    getPatternStore("piano").getState().toggleNote("d4", 8);
    await send(midi, [0x90, 60, 100]);
    await send(midi, [0x80, 60, 0]);

    expect(getPatternStore("piano").getState().pattern?.notes.map((n) => `${n.row_id}@${n.step}`).sort()).toEqual([
      "c4@10",
      "c4@4",
      "d4@8",
    ]);
  });

  it("commits the take, including a key still held, when the page is left mid-take", async () => {
    const { engine, midi } = await startPianoTake();
    vi.spyOn(engine, "stepAt").mockReturnValueOnce(step(4)).mockReturnValueOnce(step(9));
    await send(midi, [0x90, 60, 100]);

    midi.unmount();

    const state = getPatternStore("piano").getState();
    expect(state.pattern?.notes).toEqual([{ row_id: "c4", step: 4, length_steps: 5, velocity: 100 }]);
    expect(state.past.length).toBeGreaterThan(0);
    expect(state.gestureBase).toBeNull();
  });

  it("tells the player to click when a note is dropped because the audio context is suspended", async () => {
    const engine = engineFor("piano");
    vi.spyOn(engine, "liveNoteOn").mockReturnValue(null);
    vi.spyOn(engine, "liveBlocked").mockReturnValue(true);
    vi.spyOn(engine, "prepareLive").mockResolvedValue();
    const midi = await renderGranted(piano);

    await send(midi, [0x90, 60, 100]);
    expect(screen.getByRole("status")).toHaveTextContent("Click anywhere to enable sound.");
  });

  it("ends the take when a piano-roll drag starts, so cancelling the drag cannot revert the take", async () => {
    const { engine, midi } = await startPianoTake();
    vi.spyOn(engine, "stepAt").mockReturnValueOnce(step(4)).mockReturnValueOnce(step(6));
    await send(midi, [0x90, 60, 100]);
    await send(midi, [0x80, 60, 0]);
    const bar = screen.getByTestId("note");

    fireEvent.pointerDown(bar, { clientX: 5, clientY: 100, button: 0, shiftKey: true });
    fireEvent.pointerMove(bar, { clientX: 5, clientY: 160 });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerUp(bar, { clientX: 5, clientY: 160 });

    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "false");
    expect(getPatternStore("piano").getState().pattern?.notes).toContainEqual(
      expect.objectContaining({ row_id: "c4", step: 4 }),
    );
  });

  it("keeps the notes of a held key at their real length when the page unmounts after playback stops", async () => {
    const engine = engineFor("piano");
    vi.spyOn(engine, "liveNoteOn").mockReturnValue({} as never);
    vi.spyOn(engine, "liveNoteOff").mockImplementation(() => {});
    vi.spyOn(engine, "prepareLive").mockResolvedValue();
    vi.spyOn(engine, "play").mockResolvedValue();
    let stopped = false;
    // Position lookups fail once playback has been torn down, so a late commit would stretch the note.
    let calls = 0;
    vi.spyOn(engine, "stepAt").mockImplementation(() => (stopped ? null : step(++calls === 1 ? 4 : 9)));
    onPlaybackTeardown = () => (stopped = true);
    const midi = await renderGranted(piano);
    await userEvent.click(screen.getByRole("button", { name: "Count-in" }));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await send(midi, [0x90, 60, 100]);

    midi.unmount();

    expect(getPatternStore("piano").getState().pattern?.notes).toEqual([
      { row_id: "c4", step: 4, length_steps: 5, velocity: 100 },
    ]);
  });
});
