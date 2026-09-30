import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drums, note, patternWith } from "@/test/fixtures";
import * as api from "@/lib/api";
import { getPatternStore } from "@/lib/patternStore";
import { PatternEditorPage } from "./PatternEditorPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getLimits: vi.fn(),
  getInstruments: vi.fn(),
  generatePattern: vi.fn(),
  exportMidi: vi.fn(),
}));

// The audio engine is exercised in its own tests; here it would only add Tone.js to every page render.
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

const store = () => getPatternStore("drums");

async function renderPage() {
  render(<PatternEditorPage instrumentId="drums" title="Drum Machine" />);
  const form = screen.getByRole("form", { name: "Generate a pattern" });
  // Limits arrival enables the form; waiting on it avoids act warnings from late state updates.
  await waitFor(() => expect(within(form).getByRole("combobox", { name: "Measures" })).toBeEnabled());
  return form;
}

beforeEach(() => {
  localStorage.clear();
  store().setState({ pattern: null, prompt: "", past: [], future: [] });
  vi.mocked(api.getLimits).mockResolvedValue({
    max_input_tokens: 256,
    measure_options: [4, 8, 12, 16, 32],
  });
  vi.mocked(api.getInstruments).mockResolvedValue([drums]);
});

afterEach(() => vi.resetAllMocks());

describe("prompt form", () => {
  it("offers exactly the measure options from the limits endpoint", async () => {
    const form = await renderPage();
    const select = within(form).getByRole("combobox", { name: "Measures" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "4", "8", "12", "16", "32",
    ]);
    expect(select).toHaveValue("4");
  });

  it("shows 10 / 256 for a 40-character description", async () => {
    await renderPage();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Describe your groove" }),
      "laid-back boom-bap with ghosted snares!!",
    );
    expect(screen.getByText("10 / 256")).toBeInTheDocument();
  });

  it("disables Generate for blank or whitespace prompts", async () => {
    await renderPage();
    const generate = screen.getByRole("button", { name: "Generate" });
    expect(generate).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Describe your groove" }), "   ");
    expect(generate).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Describe your groove" }), "funk");
    expect(generate).toBeEnabled();
  });

  it("flags and disables Generate when over the token limit", async () => {
    vi.mocked(api.getLimits).mockResolvedValue({ max_input_tokens: 16, measure_options: [4] });
    await renderPage();
    const box = screen.getByRole("textbox", { name: "Describe your groove" });
    await userEvent.click(box);
    await userEvent.paste("a".repeat(68));
    expect(screen.getByText("17 / 16")).toBeInTheDocument();
    expect(screen.getByText(/too long/i)).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("requests the drums instrument and shows the generated pattern", async () => {
    vi.mocked(api.generatePattern).mockResolvedValue(
      patternWith([note("kick", 0), note("snare", 4)], { name: "Funky" }),
    );
    await renderPage();
    await userEvent.type(screen.getByRole("textbox", { name: "Describe your groove" }), "funky");
    await userEvent.type(screen.getByRole("spinbutton", { name: "Tempo (BPM)" }), "100");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(api.generatePattern).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: "drums",
        prompt: "funky",
        measures: 4,
        tempo_bpm: 100,
        time_signature: "4/4",
      }),
    );
    expect(await screen.findAllByTestId("note")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent('Generated "Funky".');
  });

  it("omits tempo when blank", async () => {
    vi.mocked(api.generatePattern).mockResolvedValue(patternWith([]));
    await renderPage();
    await userEvent.type(screen.getByRole("textbox", { name: "Describe your groove" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(vi.mocked(api.generatePattern).mock.calls[0][0]).not.toHaveProperty("tempo_bpm");
  });

  it("keeps the displayed pattern and the form values when generation fails", async () => {
    const existing = patternWith([note("kick", 0), note("kick", 8)]);
    store().setState({ pattern: existing });
    vi.mocked(api.generatePattern).mockRejectedValue(
      new api.ApiError("generation_failed", "The AI could not generate a pattern. Please try again.", 502),
    );
    await renderPage();
    const box = screen.getByRole("textbox", { name: "Describe your groove" });
    await userEvent.type(box, "funky");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The AI could not generate a pattern. Please try again. Your current pattern is unchanged.",
    );
    expect(store().getState().pattern).toBe(existing);
    expect(screen.getAllByTestId("note")).toHaveLength(2);
    expect(box).toHaveValue("funky");
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("disables Generate and shows Generating while in flight", async () => {
    let resolve!: (p: ReturnType<typeof patternWith>) => void;
    vi.mocked(api.generatePattern).mockReturnValue(new Promise((r) => (resolve = r)));
    const form = await renderPage();
    await userEvent.type(screen.getByRole("textbox", { name: "Describe your groove" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(screen.getByRole("button", { name: "Generating…" })).toBeDisabled();
    expect(form).toHaveAttribute("aria-busy", "true");
    resolve(patternWith([]));
    await screen.findByRole("button", { name: "Generate" });
  });

  it("offers a retry when limits fail to load", async () => {
    vi.mocked(api.getLimits).mockRejectedValueOnce(new Error("down"));
    render(<PatternEditorPage instrumentId="drums" title="Drum Machine" />);
    expect(await screen.findByText("Couldn't load generation settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(within(screen.getByRole("form", { name: "Generate a pattern" })).getByRole("combobox", { name: "Measures" })).toBeEnabled(),
    );
  });
});

describe("empty state and toolbar", () => {
  it("starts a blank grid with the form's measures", async () => {
    const form = await renderPage();
    await userEvent.selectOptions(within(form).getByRole("combobox", { name: "Measures" }), "8");
    await userEvent.click(await screen.findByRole("button", { name: "Start with a blank grid" }));
    const p = store().getState().pattern!;
    expect(p.measures).toBe(8);
    expect(p.rows).toEqual(drums.rows);
  });

  it("undo, redo, clear and tempo commit through the toolbar", async () => {
    store().setState({ pattern: patternWith([note("kick", 0)]) });
    await renderPage();
    const tempo = screen.getByRole("spinbutton", { name: "Tempo" });
    await userEvent.clear(tempo);
    await userEvent.type(tempo, "120{Enter}");
    expect(store().getState().pattern!.tempo_bpm).toBe(120);
    expect(store().getState().past).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(store().getState().pattern!.notes).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("Pattern cleared. Undo to restore.");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(store().getState().pattern!.notes).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(store().getState().pattern!.notes).toEqual([]);
  });

  it("changes measures from the toolbar", async () => {
    store().setState({ pattern: patternWith([note("kick", 0)]) });
    await renderPage();
    const toolbar = screen.getByRole("toolbar", { name: "Pattern" });
    await userEvent.selectOptions(within(toolbar).getByRole("combobox", { name: "Measures" }), "8");
    expect(store().getState().pattern!.measures).toBe(8);
    expect(store().getState().pattern!.notes).toHaveLength(2);
  });

  it("creates a new empty pattern from the dialog", async () => {
    store().setState({ pattern: patternWith([note("kick", 0)]) });
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "New…" }));
    const dialog = await screen.findByRole("dialog", { name: "New empty pattern", hidden: true });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Measures", hidden: true }), "8");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create", hidden: true }));
    const p = store().getState().pattern!;
    expect(p.measures).toBe(8);
    expect(p.notes).toEqual([]);
  });
});

describe("download MIDI", () => {
  let click: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("saves the blob under the server-provided filename", async () => {
    store().setState({ pattern: patternWith([note("kick", 0)]) });
    vi.mocked(api.exportMidi).mockResolvedValue({
      blob: new Blob(["x"]),
      filename: "songbird-boom-bap-92bpm.mid",
    });
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Download MIDI" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("songbird-boom-bap-92bpm.mid");
    expect(anchor.href).toBe("blob:mock");
    expect(api.exportMidi).toHaveBeenCalledWith(store().getState().pattern);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock"), { timeout: 3000 });
  });

  it("shows an error when export fails", async () => {
    store().setState({ pattern: patternWith([note("kick", 0)]) });
    vi.mocked(api.exportMidi).mockRejectedValue(new Error("nope"));
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Download MIDI" }));
    expect(await screen.findByText("Couldn't export MIDI. Try again.")).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
  });
});

describe("review fixes", () => {
  it("keeps a polite status region in every state", async () => {
    await renderPage();
    expect(screen.getByRole("status")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Start with a blank grid" }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("rejects fractional tempos", async () => {
    await renderPage();
    await userEvent.type(screen.getByRole("textbox", { name: "Describe your groove" }), "x");
    await userEvent.type(screen.getByRole("spinbutton", { name: "Tempo (BPM)" }), "120.5");
    expect(screen.getByText(/whole number/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("treats unparseable tempo text as invalid, not Auto", async () => {
    await renderPage();
    await userEvent.type(screen.getByRole("textbox", { name: "Describe your groove" }), "x");
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (BPM)" });
    await userEvent.type(tempo, "5");
    Object.defineProperty(tempo, "validity", { value: { badInput: true }, configurable: true });
    fireEvent.change(tempo, { target: { value: "" } });
    fireEvent.input(tempo);
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("undoes with Ctrl+Z while a select has focus", async () => {
    store().setState({ pattern: patternWith([note("kick", 0)]) });
    await renderPage();
    const toolbar = screen.getByRole("toolbar", { name: "Pattern" });
    const select = within(toolbar).getByRole("combobox", { name: "Measures" });
    await userEvent.selectOptions(select, "8");
    expect(store().getState().pattern!.measures).toBe(8);
    select.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(store().getState().pattern!.measures).toBe(4);
  });

  it("uses a neutral roll label before instruments load", async () => {
    vi.mocked(api.getInstruments).mockReturnValue(new Promise(() => {}));
    store().setState({ pattern: patternWith([]) });
    render(<PatternEditorPage instrumentId="drums" title="Drum Machine" />);
    expect(await screen.findByRole("group", { name: "Instrument piano roll" })).toBeInTheDocument();
  });
});
