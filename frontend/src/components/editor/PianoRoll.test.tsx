import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Row } from "@/generated/Row";
import { emptyPattern } from "@/lib/patternOps";
import { drums, note, patternWith } from "@/test/fixtures";
import { cellLabel } from "@/lib/pianoRoll";
import { getPatternStore, usePatternStore } from "@/lib/patternStore";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { PianoRoll } from "./PianoRoll";

const store = () => getPatternStore("drums");
const rowName = (id: string) => drums.rows.find((r) => r.id === id)!.name;
const cell = (row: string, step: number) =>
  screen.getByRole("button", { name: cellLabel(rowName(row), step, 16) });

let harnessProps: { follow?: boolean; isPlaying?: boolean; onManualScroll?: () => void; subscribePosition?: (cb: (s: number | null) => void) => () => void } = {};

function Harness() {
  useEditorShortcuts("drums");
  const pattern = usePatternStore("drums", (s) => s.pattern)!;
  return <PianoRoll
      instrumentId="drums"
      instrumentName="Drums"
      pattern={pattern}
      loop={{ start: 1, end: pattern.measures }}
      follow={harnessProps.follow ?? true}
      isPlaying={harnessProps.isPlaying ?? false}
      onManualScroll={harnessProps.onManualScroll ?? (() => {})}
      subscribePosition={harnessProps.subscribePosition ?? (() => () => {})}
    />;
}

function setup(notes = [note("kick", 0), note("snare", 4, 4, 70), note("hat_closed", 16, 2, 127)]) {
  store().setState({ pattern: patternWith(notes), prompt: "", past: [], future: [] });
  return render(<Harness />);
}

beforeEach(() => {
  harnessProps = {};
  localStorage.clear();
  store().setState({ pattern: null, prompt: "", past: [], future: [] });
});

describe("piano roll rendering", () => {
  it("renders every note at its row, start and span", () => {
    setup();
    const bars = screen.getAllByTestId("note");
    expect(bars).toHaveLength(3);
    const byRow = Object.fromEntries(bars.map((b) => [b.dataset.row, b]));
    expect(byRow.kick.dataset).toMatchObject({ step: "0", length: "1", velocity: "100" });
    expect(byRow.snare.dataset).toMatchObject({ step: "4", length: "4", velocity: "70" });
    expect(byRow.hat_closed.dataset).toMatchObject({ step: "16", length: "2", velocity: "127" });

    // Cells are the source of truth for coverage: a note spans exactly length_steps pressed cells.
    for (const n of store().getState().pattern!.notes) {
      for (let s = Math.max(0, n.step - 1); s <= n.step + n.length_steps; s++) {
        const covered = s >= n.step && s < n.step + n.length_steps;
        expect(cell(n.row_id, s)).toHaveAttribute("aria-pressed", String(covered));
      }
    }
  });

  it("labels rows in instrument order and every step of every measure", () => {
    setup();
    expect(screen.getByRole("group", { name: "Drums piano roll" })).toBeInTheDocument();
    expect(screen.getByText("Closed Hi-Hat")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3 * 4 * 16);
    expect(cell("snare", 4)).toHaveAccessibleName("Snare, measure 1, step 5");
  });
});

describe("editing", () => {
  it("adds a length-1 velocity-100 note by clicking an empty cell", async () => {
    setup([]);
    await userEvent.click(cell("snare", 4));
    expect(store().getState().pattern!.notes).toEqual([note("snare", 4, 1, 100)]);
    expect(screen.getAllByTestId("note")).toHaveLength(1);
  });

  it("removes a note by clicking a covered cell of a held note", async () => {
    setup([note("snare", 4, 4)]);
    await userEvent.click(cell("snare", 6));
    expect(store().getState().pattern!.notes).toEqual([]);
    expect(screen.queryAllByTestId("note")).toHaveLength(0);
  });

  it("removes a note by clicking the bar", () => {
    setup([note("kick", 0)]);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.pointerUp(bar, { clientX: 5, clientY: 5 });
    expect(store().getState().pattern!.notes).toEqual([]);
  });

  it("Alt-click cycles the velocity preset", () => {
    setup([note("kick", 0, 1, 100)]);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.pointerUp(bar, { clientX: 5, clientY: 5, altKey: true });
    expect(store().getState().pattern!.notes[0].velocity).toBe(70);
  });

  it("vertical drag sets velocity once on release", () => {
    setup([note("kick", 0, 1, 100)]);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 100, button: 0 });
    fireEvent.pointerMove(bar, { clientX: 5, clientY: 160 });
    expect(bar.dataset.velocity).toBe("40");
    expect(store().getState().past).toHaveLength(0);
    fireEvent.pointerUp(bar, { clientX: 5, clientY: 160 });
    expect(store().getState().pattern!.notes[0].velocity).toBe(40);
    expect(store().getState().past).toHaveLength(1);
  });

  it("Escape cancels a velocity drag", () => {
    setup([note("kick", 0, 1, 100)]);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 100, button: 0 });
    fireEvent.pointerMove(bar, { clientX: 5, clientY: 160 });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerUp(bar, { clientX: 5, clientY: 160 });
    expect(store().getState().pattern!.notes[0].velocity).toBe(100);
  });

  it("keyboard shortcuts set velocity 40 via V cycling and Shift+Down", async () => {
    setup([note("kick", 0, 1, 100)]);
    cell("kick", 0).focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(store().getState().pattern!.notes[0].velocity).toBe(90);
    await userEvent.keyboard("v");
    expect(store().getState().pattern!.notes[0].velocity).toBe(70);
  });

  it("Cmd/Ctrl+Z undoes a removal and Shift+Cmd/Ctrl+Z redoes it", async () => {
    setup([note("kick", 0)]);
    await userEvent.click(cell("kick", 0));
    expect(store().getState().pattern!.notes).toEqual([]);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(store().getState().pattern!.notes).toEqual([note("kick", 0)]);
    expect(screen.getAllByTestId("note")).toHaveLength(1);
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(store().getState().pattern!.notes).toEqual([]);
    await userEvent.keyboard("{Meta>}z{/Meta}");
    expect(store().getState().pattern!.notes).toEqual([note("kick", 0)]);
  });

  it("arrow keys move the roving focus", async () => {
    setup([]);
    cell("kick", 0).focus();
    await userEvent.keyboard("{ArrowRight}{ArrowDown}");
    expect(cell("snare", 1)).toHaveFocus();
    expect(cell("snare", 1)).toHaveAttribute("tabindex", "0");
    expect(cell("kick", 0)).toHaveAttribute("tabindex", "-1");
  });

  it("keeps other notes unchanged when one is edited", async () => {
    setup([note("kick", 0), note("kick", 20)]);
    await act(async () => store().getState().setVelocity("kick", 0, 50));
    const bars = screen.getAllByTestId("note");
    expect(bars.map((b) => b.dataset.velocity)).toEqual(["50", "100"]);
    expect(within(bars[1]).getByTestId("note-resize")).toBeInTheDocument();
  });
});

describe("resizing", () => {
  const drag = (handle: HTMLElement, dxCells: number) => {
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(handle, { clientX: dxCells * 28, clientY: 0 });
    return () => fireEvent.pointerUp(handle, { clientX: dxCells * 28, clientY: 0 });
  };

  it("lengthens a note 1 to 4 by dragging the handle three cells", () => {
    setup([note("kick", 0)]);
    const bar = screen.getByTestId("note");
    const release = drag(within(bar).getByTestId("note-resize"), 3);
    expect(bar.dataset.length).toBe("4");
    expect(store().getState().past).toHaveLength(0);
    release();
    expect(store().getState().pattern!.notes[0].length_steps).toBe(4);
    expect(store().getState().past).toHaveLength(1);
  });

  it("stops at the next note on the row", () => {
    setup([note("kick", 0), note("kick", 4)]);
    const first = screen.getAllByTestId("note").find((n) => n.dataset.step === "0")!;
    const release = drag(within(first).getByTestId("note-resize"), 7);
    expect(first.dataset.length).toBe("4");
    release();
    expect(store().getState().pattern!.notes.find((n) => n.step === 0)!.length_steps).toBe(4);
  });

  it("does not remove the note when the handle is pressed", () => {
    setup([note("kick", 0)]);
    const handle = within(screen.getByTestId("note")).getByTestId("note-resize");
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerUp(handle, { clientX: 0, clientY: 0 });
    expect(store().getState().pattern!.notes).toHaveLength(1);
  });

  it("Escape cancels a resize", () => {
    setup([note("kick", 0)]);
    const bar = screen.getByTestId("note");
    drag(within(bar).getByTestId("note-resize"), 3);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(bar.dataset.length).toBe("1");
  });
});

describe("keyboard modifiers", () => {
  it("ignores V and Delete combined with Ctrl or Meta", async () => {
    setup([note("kick", 0, 1, 100)]);
    cell("kick", 0).focus();
    await userEvent.keyboard("{Control>}v{/Control}{Meta>}v{/Meta}{Meta>}{Backspace}{/Meta}");
    expect(store().getState().pattern!.notes).toEqual([note("kick", 0, 1, 100)]);
  });
});

describe("stale drag values", () => {
  it("commits the last pointermove value when pointerup follows in the same batch", () => {
    setup([note("kick", 0, 1, 100)]);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 100, button: 0 });
    fireEvent.pointerMove(bar, { clientX: 5, clientY: 110 });
    act(() => {
      fireEvent.pointerMove(bar, { clientX: 5, clientY: 160 });
      fireEvent.pointerUp(bar, { clientX: 5, clientY: 160 });
    });
    expect(store().getState().pattern!.notes[0].velocity).toBe(40);
  });

  it("commits the last resize value when pointerup follows in the same batch", () => {
    setup([note("kick", 0)]);
    const handle = within(screen.getByTestId("note")).getByTestId("note-resize");
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, button: 0 });
    act(() => {
      fireEvent.pointerMove(handle, { clientX: 84, clientY: 0 });
      fireEvent.pointerUp(handle, { clientX: 84, clientY: 0 });
    });
    expect(store().getState().pattern!.notes[0].length_steps).toBe(4);
  });
});

describe("follow and manual scroll", () => {
  function withPosition(props: Partial<typeof harnessProps> = {}) {
    const listeners = new Set<(s: number | null) => void>();
    harnessProps = {
      ...props,
      subscribePosition: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    setup([]);
    const scroller = screen.getByRole("group", { name: "Drums piano roll" });
    const scrollTo = vi.fn();
    Object.assign(scroller, { scrollTo });
    Object.defineProperty(scroller, "clientWidth", { value: 600, configurable: true });
    return { scroller, scrollTo, emit: (s: number | null) => act(() => listeners.forEach((l) => l(s))) };
  }

  it("page-flips when the playhead leaves the visible region", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    const { scrollTo, emit } = withPosition({ isPlaying: true });
    emit(2);
    expect(scrollTo).not.toHaveBeenCalled();
    emit(100);
    expect(scrollTo).toHaveBeenCalledWith({ left: 100 * 28 - 28, behavior: "smooth" });
  });

  it("jumps instead of animating under reduced motion", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const { scrollTo, emit } = withPosition({ isPlaying: true });
    emit(100);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

  it("does not scroll when follow is off", () => {
    const { scrollTo, emit } = withPosition({ follow: false, isPlaying: true });
    emit(100);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("ignores fractional positions within the same step", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    const { scrollTo, emit } = withPosition({ isPlaying: true });
    emit(100.2);
    emit(100.8);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("turns follow off on horizontal wheel, touch or scrollbar press while playing", () => {
    const onManualScroll = vi.fn();
    const { scroller } = withPosition({ isPlaying: true, onManualScroll });
    fireEvent.wheel(scroller, { deltaX: 40, deltaY: 0 });
    fireEvent.wheel(scroller, { deltaX: 0, deltaY: 40 });
    expect(onManualScroll).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(scroller);
    fireEvent.pointerDown(scroller);
    expect(onManualScroll).toHaveBeenCalledTimes(3);
    fireEvent.pointerDown(cell("kick", 0));
    expect(onManualScroll).toHaveBeenCalledTimes(3);
  });

  it("does not report manual scrolling while stopped", () => {
    const onManualScroll = vi.fn();
    const { scroller } = withPosition({ isPlaying: false, onManualScroll });
    fireEvent.wheel(scroller, { deltaX: 40, deltaY: 0 });
    expect(onManualScroll).not.toHaveBeenCalled();
  });
});

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pianoRows: Row[] = Array.from({ length: 61 }, (_, i) => {
  const midi = 96 - i;
  const name = `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
  return { id: name.toLowerCase().replace("#", "s"), name, midi_note: midi };
});
const piano: InstrumentInfo = {
  id: "piano",
  name: "Piano",
  kind: "melodic",
  midi_channel: 1,
  midi_program: 0,
  range: { low: 36, high: 96 },
  sustained: true,
  rows: pianoRows,
};
const pianoStore = () => getPatternStore("piano");
const pianoId = (name: string) => pianoRows.find((r) => r.name === name)!.id;
const pianoCell = (name: string, step: number) =>
  screen.getByRole("button", { name: cellLabel(name, step, 16) });

function PianoHarness({ onAudition }: { onAudition?: (row: Row) => void }) {
  const pattern = usePatternStore("piano", (s) => s.pattern)!;
  return <PianoRoll
      instrumentId="piano"
      instrumentName="Piano"
      kind="melodic"
      sustained
      onAudition={onAudition}
      pattern={pattern}
      loop={{ start: 1, end: pattern.measures }}
      follow
      isPlaying={false}
      onManualScroll={() => {}}
      subscribePosition={() => () => {}}
    />;
}

function loadPiano(notes: ReturnType<typeof note>[] = []) {
  pianoStore().getState().setPattern({ ...emptyPattern(piano, 4), notes });
}

describe("melodic piano roll", () => {
  beforeEach(() => {
    localStorage.clear();
    pianoStore().setState({ pattern: null, loadId: 0, prompt: "", past: [], future: [] });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders 61 keys with only C rows visibly labelled", () => {
    loadPiano();
    render(<PianoHarness />);
    const keys = document.querySelectorAll("[data-key]");
    expect(keys).toHaveLength(61);
    expect(screen.getByRole("button", { name: "C4" })).toHaveTextContent("C4");
    expect(screen.getByRole("button", { name: "E4" })).toBeEmptyDOMElement();
  });

  it("styles sharps as black keys and gives every key its pitch as accessible name", () => {
    loadPiano();
    render(<PianoHarness />);
    expect(screen.getByRole("button", { name: "C#4" })).toHaveAttribute("data-key", "black");
    expect(screen.getByRole("button", { name: "C4" })).toHaveAttribute("data-key", "white");
    const labels = Array.from(document.querySelectorAll("[data-key]"), (k) => k.getAttribute("aria-label"));
    expect(labels).toEqual(pianoRows.map((r) => r.name));
  });

  it("draws white keys with real piano proportions and black keys on their own row", () => {
    loadPiano();
    render(<PianoHarness />);
    const idx = (name: string) => pianoRows.findIndex((r) => r.name === name);
    const key = (name: string) => screen.getByRole("button", { name });
    expect(key("C4").style.height).toBe("calc(var(--row-h) * 5 / 3)");
    expect(key("A4").style.height).toBe("calc(var(--row-h) * 7 / 4)");
    expect(key("C#4").style.height).toBe("var(--row-h)");
    expect(key("C#4").style.top).toBe(`calc(var(--row-h) * ${idx("C#4")})`);
    // The top white key of a C-E group starts exactly on a row edge, as E does on a real keyboard.
    expect(key("E4").style.top).toBe(`calc(var(--row-h) * ${idx("E4") * 3} / 3)`);
  });

  it("is a single tab stop and moves between keys with the arrow keys", async () => {
    loadPiano();
    render(<PianoHarness />);
    const keys = Array.from(document.querySelectorAll<HTMLElement>("[data-key]"));
    expect(keys.filter((k) => k.tabIndex === 0)).toHaveLength(1);
    const c4 = screen.getByRole("button", { name: "C4" });
    expect(c4.tabIndex).toBe(0);
    c4.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "C#4" })).toHaveFocus();
    expect(keys.filter((k) => k.tabIndex === 0)).toHaveLength(1);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("button", { name: "B3" })).toHaveFocus();
  });

  it("auditions the focused key with Enter and Space", async () => {
    loadPiano();
    const onAudition = vi.fn();
    render(<PianoHarness onAudition={onAudition} />);
    screen.getByRole("button", { name: "A4" }).focus();
    await userEvent.keyboard("{Enter} ");
    expect(onAudition).toHaveBeenCalledTimes(2);
  });

  it("calls onAudition with the clicked key's row", async () => {
    loadPiano();
    const onAudition = vi.fn();
    render(<PianoHarness onAudition={onAudition} />);
    await userEvent.click(screen.getByRole("button", { name: "A4" }));
    expect(onAudition).toHaveBeenCalledWith(pianoRows.find((r) => r.name === "A4"));
    expect(pianoStore().getState().past).toHaveLength(0);
  });

  it("adds a one-beat note and clips it to the next note in the row", async () => {
    loadPiano([note(pianoId("E4"), 2, 2)]);
    render(<PianoHarness />);
    await userEvent.click(pianoCell("E4", 0));
    expect(pianoStore().getState().pattern!.notes).toContainEqual(note(pianoId("E4"), 0, 2));
    await userEvent.click(pianoCell("G4", 0));
    expect(pianoStore().getState().pattern!.notes).toContainEqual(note(pianoId("G4"), 0, 4));
  });

  it("scrolls loaded notes into view", () => {
    loadPiano([note(pianoId("C5"), 0), note(pianoId("G5"), 4)]);
    render(<PianoHarness />);
    const top = screen.getByRole("group").scrollTop;
    const rowH = 18;
    const g5 = pianoRows.findIndex((r) => r.name === "G5");
    const c5 = pianoRows.findIndex((r) => r.name === "C5");
    expect(top).toBeLessThanOrEqual(g5 * rowH);
    expect(top + 360).toBeGreaterThanOrEqual((c5 + 1) * rowH);
  });

  it("shows C4 for an empty pattern", () => {
    loadPiano();
    render(<PianoHarness />);
    const top = screen.getByRole("group").scrollTop;
    const c4 = pianoRows.findIndex((r) => r.name === "C4");
    expect(top).toBeLessThanOrEqual(c4 * 18);
    expect(top + 360).toBeGreaterThanOrEqual((c4 + 1) * 18);
  });

  it("re-scrolls when a new pattern is loaded but not when a note is edited", async () => {
    loadPiano();
    render(<PianoHarness />);
    const scroller = screen.getByRole("group");
    scroller.scrollTop = 50;
    await userEvent.click(pianoCell("E4", 0));
    expect(scroller.scrollTop).toBe(50);
    act(() => loadPiano([note(pianoId("C5"), 0)]));
    expect(scroller.scrollTop).not.toBe(50);
  });
});
