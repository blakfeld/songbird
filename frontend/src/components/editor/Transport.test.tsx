import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Playback } from "@/lib/audio/types";
import type { LoopSetting } from "@/lib/loopRegion";
import * as api from "@/lib/api";
import { drums, note, patternWith } from "@/test/fixtures";
import { createPatternStore, getPatternStore } from "@/lib/patternStore";
import { PatternEditorPage } from "./PatternEditorPage";

const h = vi.hoisted(() => ({
  toggle: vi.fn(),
  listeners: new Set<(s: number | null) => void>(),
  state: { isPlaying: false, status: "ready" as const, error: null as string | null },
  loops: [] as LoopSetting[],
}));

vi.mock("@/lib/audio/usePlayback", () => ({
  usePlayback: (_id: string, loop: LoopSetting): Playback => {
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
  store().setState({ pattern: patternWith([note("kick", 0)], { measures: 8 }), loop: { region: null, enabled: false }, prompt: "", past: [], future: [] });
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

const rulerBounds = () => {
  const ruler = screen.getByTestId("loop-hit-layer");
  (ruler.parentElement as HTMLElement).getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 28, width: 800, height: 28, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return ruler;
};

const drawOnRuler = (from: number, to: number) => {
  const ruler = rulerBounds();
  fireEvent.pointerDown(ruler, { clientX: (from - 1) * 100 + 50, button: 0 });
  fireEvent.pointerMove(ruler, { clientX: (to - 1) * 100 + 50 });
  fireEvent.pointerUp(ruler, { clientX: (to - 1) * 100 + 50 });
};

describe("loop toggle", () => {
  it("shows an unpressed Loop toggle beside Play and no measure dropdowns", async () => {
    await setup();
    const toggle = screen.getByRole("button", { name: "Loop playback" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("Loop");
    expect(screen.queryByRole("combobox", { name: /Loop (start|end) measure/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Loop whole/ })).not.toBeInTheDocument();
  });

  it("starts with no region, looping off, and an empty ruler", async () => {
    await setup();
    expect(h.loops.at(-1)).toEqual({ region: null, enabled: false });
    expect(screen.queryByTestId("loop-region")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("loop-shade")).toHaveLength(0);
  });

  it("loops the whole pattern from the toggle without drawing a region", async () => {
    await setup();
    await userEvent.click(screen.getByRole("button", { name: "Loop playback" }));
    expect(screen.getByRole("button", { name: "Loop playback" })).toHaveAttribute("aria-pressed", "true");
    expect(h.loops.at(-1)).toEqual({ region: null, enabled: true });
    expect(screen.queryByTestId("loop-region")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("loop-shade")).toHaveLength(0);
  });

  it("turns looping off without changing the region and dims it", async () => {
    await setup();
    drawOnRuler(3, 4);
    await userEvent.click(screen.getByRole("button", { name: "Loop playback" }));
    expect(screen.getByRole("button", { name: "Loop playback" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("loop-region")).toHaveAttribute("data-enabled", "false");
    expect(screen.getByTestId("loop-region")).toHaveAttribute("data-start", "3");
    expect(screen.getByTestId("loop-region")).toHaveAttribute("data-end", "4");
    expect(h.loops.at(-1)).toEqual({ region: { start: 3, end: 4 }, enabled: false });
    expect(screen.queryAllByTestId("loop-shade")).toHaveLength(0);
  });

  it("keeps Loop usable while sounds load", async () => {
    h.state = { isPlaying: false, status: "loading" as "ready", error: null };
    await setup();
    expect(screen.getByRole("button", { name: "Loop playback" })).toBeEnabled();
  });
});

describe("loop region on the ruler", () => {
  it("drawing from an empty ruler creates a region, turns looping on and shades the rest", async () => {
    await setup();
    drawOnRuler(5, 8);
    expect(screen.getByRole("button", { name: "Loop playback" })).toHaveAttribute("aria-pressed", "true");
    expect(h.loops.at(-1)).toEqual({ region: { start: 5, end: 8 }, enabled: true });
    expect(screen.getAllByTestId("loop-shade")).toHaveLength(2);
  });

  it("restores the region and looping setting after a reload", async () => {
    await setup();
    drawOnRuler(3, 4);
    await userEvent.click(screen.getByRole("button", { name: "Loop playback" }));
    expect(createPatternStore("drums").getState().loop).toEqual({ region: { start: 3, end: 4 }, enabled: false });
  });

  it("keeps a drawn region when the pattern is lengthened", async () => {
    await setup();
    drawOnRuler(1, 8);
    await userEvent.selectOptions(
      within(screen.getByRole("toolbar")).getByRole("combobox", { name: "Measures" }),
      "12",
    );
    expect(h.loops.at(-1)).toEqual({ region: { start: 1, end: 8 }, enabled: true });
  });

  it("clamps a partial region when the pattern is shortened", async () => {
    await setup();
    drawOnRuler(6, 8);
    await userEvent.selectOptions(
      within(screen.getByRole("toolbar")).getByRole("combobox", { name: "Measures" }),
      "4",
    );
    expect(h.loops.at(-1)).toEqual({ region: { start: 4, end: 4 }, enabled: true });
  });

  it("does not make the region an undo step", async () => {
    await setup();
    store().getState().toggleNote("snare", 0);
    drawOnRuler(3, 4);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(store().getState().pattern!.notes).toHaveLength(1);
    expect(screen.getByTestId("loop-region")).toHaveAttribute("data-start", "3");
  });

  it("creates a region from the keyboard without starting playback", async () => {
    await setup();
    const create = screen.getByRole("button", { name: "Set loop region" });
    create.focus();
    await userEvent.keyboard(" ");
    expect(h.loops.at(-1)).toEqual({ region: { start: 1, end: 1 }, enabled: true });
    expect(screen.getByRole("slider", { name: "Loop region end" })).toHaveFocus();
    expect(h.toggle).not.toHaveBeenCalled();
  });

  it("keeps Space and Enter on the region from starting playback", async () => {
    await setup();
    drawOnRuler(3, 4);
    const body = screen.getByTestId("loop-region");
    body.focus();
    await userEvent.keyboard(" ");
    expect(body).toHaveAttribute("aria-pressed", "false");
    await userEvent.keyboard("{Enter}");
    expect(body).toHaveAttribute("aria-pressed", "true");
    screen.getByRole("slider", { name: "Loop region end" }).focus();
    await userEvent.keyboard(" ");
    expect(h.toggle).not.toHaveBeenCalled();
  });
});
