import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import * as api from "@/lib/api";
import { getPatternStore } from "@/lib/patternStore";
import { emptyPattern } from "@/lib/patternOps";
import { drums } from "@/test/fixtures";
import Page from "./page";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getLimits: vi.fn(),
  getInstruments: vi.fn(),
  generatePattern: vi.fn(),
}));

vi.mock("@/lib/audio/usePlayback", () => ({
  usePlayback: () => ({
    isPlaying: false,
    status: "idle",
    error: null,
    toggle: vi.fn(),
    stop: vi.fn(),
    preload: vi.fn(),
    subscribePosition: () => () => {},
  }),
}));

const piano: InstrumentInfo = {
  id: "piano",
  name: "Piano",
  kind: "melodic",
  midi_program: 0,
  range: { low: 36, high: 96 },
  midi_channel: 1,
  sustained: true,
  rows: [{ id: "c4", name: "C4", midi_note: 60 }],
} as InstrumentInfo;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.getLimits).mockResolvedValue({
    max_input_tokens: 256,
    measure_options: [4, 8],
  });
  vi.mocked(api.getInstruments).mockResolvedValue([drums, piano]);
});

afterEach(() => {
  vi.resetAllMocks();
});

const renderId = async (id: string) =>
  render(await Page({ params: Promise.resolve({ id }) }));

describe("instrument page", () => {
  it("renders the editor for a listed instrument", async () => {
    await renderId("piano");
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Piano" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Measures" })).toBeEnabled(),
    );
  });

  it("shows a not-found panel for an unlisted id without generating", async () => {
    await renderId("kazoo");
    expect(await screen.findByText("Instrument not found")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/");
    expect(api.generatePattern).not.toHaveBeenCalled();
  });

  it("shows a retryable error instead of not-found when instruments fail to load", async () => {
    vi.mocked(api.getInstruments).mockRejectedValueOnce(new Error("down"));
    await renderId("piano");
    expect(await screen.findByText("Instruments could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Instrument not found")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Piano" })).toBeInTheDocument();
  });

  it("styles the roll as melodic without waiting for a second instruments fetch", async () => {
    vi.mocked(api.getInstruments)
      .mockResolvedValueOnce([drums, piano])
      .mockReturnValue(new Promise(() => {}));
    getPatternStore("piano").getState().setPattern(emptyPattern(piano, 4));
    await renderId("piano");
    const key = await screen.findByRole("button", { name: "C4" });
    expect(key).toHaveAttribute("data-key", "white");
  });

  it("redirects drums to the drum machine", async () => {
    await renderId("drums");
    expect(redirect).toHaveBeenCalledWith("/drum-machine");
  });
});
