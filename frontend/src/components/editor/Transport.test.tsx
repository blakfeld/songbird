import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopRange, Playback } from "@/lib/audio/types";
import * as api from "@/lib/api";
import { drums, note, patternWith } from "@/test/fixtures";
import { getPatternStore } from "@/lib/patternStore";
import { PatternEditorPage } from "./PatternEditorPage";

const h = vi.hoisted(() => ({
  toggle: vi.fn(),
  listeners: new Set<(s: number | null) => void>(),
  state: { isPlaying: false, status: "ready" as const, error: null as string | null },
  loops: [] as { start: number; end: number }[],
}));

vi.mock("@/lib/audio/usePlayback", () => ({
  usePlayback: (_id: string, loop: LoopRange): Playback => {
    h.loops.push(loop);
    return {
      ...h.state,
      status: h.state.status,
      toggle: h.toggle,
      stop: vi.fn(),
      preload: vi.fn(),
      subscribePosition: (cb) => {
        h.listeners.add(cb);
        return () => h.listeners.delete(cb);
      },
    };
  },
}));

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getLimits: vi.fn(),
  getInstruments: vi.fn(),
}));

const store = () => getPatternStore("drums");
const emit = (step: number | null) => act(() => h.listeners.forEach((l) => l(step)));

async function setup() {
  store().setState({ pattern: patternWith([note("kick", 0)], { measures: 8 }), prompt: "", past: [], future: [] });
  render(<PatternEditorPage instrumentId="drums" title="Drum Machine" />);
  await waitFor(() => expect(within(screen.getByRole("toolbar")).getByRole("combobox", { name: "Measures" })).toBeEnabled());
}

beforeEach(() => {
  localStorage.clear();
  h.toggle.mockReset();
  h.listeners.clear();
  h.loops.length = 0;
  h.state = { isPlaying: false, status: "ready", error: null };
  vi.mocked(api.getLimits).mockResolvedValue({ max_input_tokens: 256, measure_options: [4, 8, 12, 16, 32] });
  vi.mocked(api.getInstruments).mockResolvedValue([drums]);
});

describe("Space", () => {
  it("toggles playback from a focused cell without toggling the cell", async () => {
    await setup();
    const cell = screen.getByRole("button", { name: "Snare, measure 1, step 5" });
    cell.focus();
    await userEvent.keyboard(" ");
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(cell).toHaveAttribute("aria-pressed", "false");
    expect(store().getState().pattern!.notes).toHaveLength(1);
  });

  it("toggles again on a second press", async () => {
    await setup();
    screen.getByRole("button", { name: "Kick, measure 1, step 2" }).focus();
    await userEvent.keyboard("  ");
    expect(h.toggle).toHaveBeenCalledTimes(2);
  });

  it("types a space in the prompt textarea without toggling", async () => {
    await setup();
    const box = screen.getByRole("textbox", { name: "Describe your groove" });
    await userEvent.type(box, "a b");
    expect(box).toHaveValue("a b");
    expect(h.toggle).not.toHaveBeenCalled();
  });

  it("only activates a toolbar button when it has focus", async () => {
    await setup();
    store().getState().toggleNote("snare", 0);
    screen.getByRole("button", { name: "Clear" }).focus();
    await userEvent.keyboard(" ");
    expect(store().getState().pattern!.notes).toEqual([]);
    expect(h.toggle).not.toHaveBeenCalled();
  });

  it("does not toggle from the Play button beyond its own click", async () => {
    await setup();
    screen.getByRole("button", { name: "Play" }).focus();
    await userEvent.keyboard(" ");
    expect(h.toggle).toHaveBeenCalledTimes(1);
  });

  it("toggles from the page body", async () => {
    await setup();
    await userEvent.keyboard(" ");
    expect(h.toggle).toHaveBeenCalledTimes(1);
  });
});

describe("transport", () => {
  it("shows Stop while playing and Loading sounds while loading", async () => {
    h.state = { isPlaying: true, status: "ready", error: null };
    await setup();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
  });

  it("disables Play while sounds load", async () => {
    h.state = { isPlaying: false, status: "loading" as "ready", error: null };
    await setup();
    expect(screen.getByRole("button", { name: /Loading sounds/ })).toBeDisabled();
  });

  it("shows an audio error", async () => {
    h.state = { isPlaying: false, status: "error" as "ready", error: "x" };
    await setup();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't start audio");
  });

  it("keeps the loop end at or after the start and resets it when measures change", async () => {
    await setup();
    const start = screen.getByRole("combobox", { name: "Loop start measure" });
    const end = screen.getByRole("combobox", { name: "Loop end measure" });
    expect(end).toHaveValue("8");
    await userEvent.selectOptions(end, "4");
    await userEvent.selectOptions(start, "6");
    expect(end).toHaveValue("6");
    expect(h.loops.at(-1)).toEqual({ start: 6, end: 6 });
    expect(screen.getAllByTestId("loop-shade")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Loop whole pattern" }));
    expect(h.loops.at(-1)).toEqual({ start: 1, end: 8 });

    await userEvent.selectOptions(start, "3");
    await userEvent.selectOptions(
      within(screen.getByRole("toolbar")).getByRole("combobox", { name: "Measures" }),
      "12",
    );
    expect(h.loops.at(-1)).toEqual({ start: 1, end: 12 });
  });

  it("offers measure options from the limits endpoint in the toolbar", async () => {
    vi.mocked(api.getLimits).mockResolvedValue({ max_input_tokens: 256, measure_options: [2, 4, 6] });
    store().setState({ pattern: patternWith([], { measures: 4 }), past: [], future: [] });
    render(<PatternEditorPage instrumentId="drums" title="Drum Machine" />);
    const select = within(await screen.findByRole("toolbar")).getByRole("combobox", { name: "Measures" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["2", "4", "6"]);
  });

  it("only updates the playhead when the whole step changes", async () => {
    await setup();
    const playhead = screen.getByTestId("playhead");
    emit(20.3);
    playhead.style.transform = "translateX(1px)";
    emit(20.9);
    expect(playhead.style.transform).toBe("translateX(1px)");
    emit(21.1);
    expect(playhead.style.transform).toContain("21");
  });

  it("marks the loop start and end caps on the ruler", async () => {
    await setup();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Loop start measure" }), "3");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Loop end measure" }), "5");
    const roll = screen.getByRole("group", { name: "Drums piano roll" });
    expect(roll.querySelectorAll("[data-loop-start]")).toHaveLength(1);
    expect(roll.querySelectorAll("[data-loop-end]")).toHaveLength(1);
    expect(roll.querySelectorAll("[data-in-loop]")).toHaveLength(3);
  });

  it("moves the playhead and readout from position updates", async () => {
    await setup();
    const playhead = screen.getByTestId("playhead");
    expect(playhead).toHaveStyle({ display: "none" });
    emit(20);
    expect(playhead.style.display).toBe("");
    expect(playhead.style.transform).toContain("20");
    expect(screen.getByText("Bar 2 · Beat 2")).toBeInTheDocument();
    emit(null);
    expect(playhead).toHaveStyle({ display: "none" });
  });
});
