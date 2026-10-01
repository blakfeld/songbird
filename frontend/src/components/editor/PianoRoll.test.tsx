import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Row } from "@/generated/Row";
import { emptyPattern, gridOf } from "@/lib/patternOps";
import { drums, note, patternWith } from "@/test/fixtures";
import { cellLabel } from "@/lib/pianoRoll";
import { clearClipboard, copyNotes } from "@/lib/noteClipboard";
import { getPatternStore, usePatternStore } from "@/lib/patternStore";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { PianoRoll } from "./PianoRoll";

const store = () => getPatternStore("drums");
const rowName = (id: string) => drums.rows.find((r) => r.id === id)!.name;
const cell = (row: string, step: number) =>
  screen.getByRole("button", { name: cellLabel(rowName(row), step, 16) });

let harnessProps: { onPlaceNote?: (row: Row, velocity: number) => void; onAnnounce?: (message: string) => void; follow?: boolean; isPlaying?: boolean; onManualScroll?: () => void; subscribePosition?: (cb: (s: number | null) => void) => () => void } = {};

function Harness() {
  useEditorShortcuts("drums");
  const pattern = usePatternStore("drums", (s) => s.pattern)!;
  const loadId = usePatternStore("drums", (s) => s.loadId);
  const actions = getPatternStore("drums").getState();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return <>
    <div ref={setSlot} />
    <PianoRoll
      instrumentName="Drums"
      grid={gridOf(pattern)}
      timeSignature={pattern.time_signature}
      stepsPerMeasure={pattern.steps_per_measure}
      resetKey={loadId}
      onToggleNote={actions.toggleNote}
      onSetVelocity={actions.setVelocity}
      onResizeNote={actions.resizeNote}
      onEditNotes={actions.editNotes}
      onBeginGesture={actions.beginGesture}
      onEndGesture={actions.commitGesture}
      onCancelGesture={actions.cancelGesture}
      inspectorTarget={slot}
      onAnnounce={harnessProps.onAnnounce}
      onPlaceNote={harnessProps.onPlaceNote}
      loop={{ region: null, enabled: false }}
      follow={harnessProps.follow ?? true}
      isPlaying={harnessProps.isPlaying ?? false}
      onManualScroll={harnessProps.onManualScroll ?? (() => {})}
      subscribePosition={harnessProps.subscribePosition ?? (() => () => {})}
    />
  </>;
}

function setup(notes = [note("kick", 0), note("snare", 4, 4, 70), note("hat_closed", 16, 2, 127)]) {
  store().setState({ pattern: patternWith(notes), prompt: "", past: [], future: [] });
  return render(<Harness />);
}

beforeEach(() => {
  harnessProps = {};
  clearClipboard();
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

describe("previewing a placed note", () => {
  it("reports the row and velocity when a note is added", async () => {
    const onPlaceNote = vi.fn();
    harnessProps = { onPlaceNote };
    setup([]);
    await userEvent.click(cell("snare", 4));
    expect(onPlaceNote).toHaveBeenCalledTimes(1);
    expect(onPlaceNote).toHaveBeenCalledWith(drums.rows[1], 100);
  });

  it("stays silent for removing, resizing and velocity changes", async () => {
    const onPlaceNote = vi.fn();
    harnessProps = { onPlaceNote };
    setup([note("snare", 4, 4), note("kick", 0)]);
    cell("kick", 0).focus();
    await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowRight}{/Shift}v{Delete}");
    expect(store().getState().pattern!.notes).toEqual([note("snare", 4, 4)]);
    expect(onPlaceNote).not.toHaveBeenCalled();
  });
});

describe("editing", () => {
  it("adds a length-1 velocity-100 note by clicking an empty cell", async () => {
    setup([]);
    await userEvent.click(cell("snare", 4));
    expect(store().getState().pattern!.notes).toEqual([note("snare", 4, 1, 100)]);
    expect(screen.getAllByTestId("note")).toHaveLength(1);
  });

  it("selects a note, without removing it, when a covered cell of a held note is clicked", async () => {
    setup([note("snare", 4, 4)]);
    await userEvent.click(cell("snare", 6));
    expect(store().getState().pattern!.notes).toEqual([note("snare", 4, 4)]);
    expect(screen.getByTestId("note")).toHaveAttribute("data-selected", "true");
  });

  it("selects a note, without removing it, when the bar is clicked", () => {
    setup([note("kick", 0)]);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.pointerUp(bar, { clientX: 5, clientY: 5 });
    expect(store().getState().pattern!.notes).toEqual([note("kick", 0)]);
    expect(bar).toHaveAttribute("data-selected", "true");
  });

  it("removes a note when it is double-clicked", async () => {
    setup([note("kick", 0), note("snare", 4)]);
    await userEvent.dblClick(screen.getAllByTestId("note")[0]);
    expect(store().getState().pattern!.notes).toEqual([note("snare", 4)]);
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
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 100, button: 0, shiftKey: true });
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
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 100, button: 0, shiftKey: true });
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
    await userEvent.dblClick(screen.getByTestId("note"));
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
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 100, button: 0, shiftKey: true });
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
// getByRole computes the accessible tree of every button; with ~4000 cells that costs ~700ms per query
// in jsdom, so these helpers go straight to the attribute the role query would have matched.
const byLabel = (selector: string, label: string) => {
  const el = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
    (e) => e.getAttribute("aria-label") === label,
  );
  if (!el) throw new Error(`No ${selector} labelled ${label}`);
  return el;
};
const pianoCell = (name: string, step: number) => byLabel("[data-cell]", cellLabel(name, step, 16));
const pianoKey = (name: string) => byLabel("[data-key]", name);

function PianoHarness({
  onAudition,
  onPlaceNote,
  onAnnounce,
}: {
  onAudition?: (row: Row) => void;
  onPlaceNote?: (row: Row, velocity: number) => void;
  onAnnounce?: (message: string) => void;
}) {
  const pattern = usePatternStore("piano", (s) => s.pattern)!;
  const loadId = usePatternStore("piano", (s) => s.loadId);
  const actions = getPatternStore("piano").getState();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return <>
    <div ref={setSlot} />
    <PianoRoll
      instrumentName="Piano"
      grid={gridOf(pattern)}
      timeSignature={pattern.time_signature}
      stepsPerMeasure={pattern.steps_per_measure}
      resetKey={loadId}
      onToggleNote={actions.toggleNote}
      onSetVelocity={actions.setVelocity}
      onResizeNote={actions.resizeNote}
      onEditNotes={actions.editNotes}
      onBeginGesture={actions.beginGesture}
      onEndGesture={actions.commitGesture}
      onCancelGesture={actions.cancelGesture}
      inspectorTarget={slot}
      onAnnounce={onAnnounce}
      onPlaceNote={onPlaceNote}
      kind="melodic"
      sustained
      onAudition={onAudition}
      loop={{ region: null, enabled: false }}
      follow
      isPlaying={false}
      onManualScroll={() => {}}
      subscribePosition={() => () => {}}
    />
  </>;
}

function loadPiano(notes: ReturnType<typeof note>[] = []) {
  pianoStore().getState().setPattern({ ...emptyPattern(piano, 4), notes });
}

describe("melodic piano roll", () => {
  beforeEach(() => {
    clearClipboard();
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
    expect(pianoKey("C4")).toHaveTextContent("C4");
    expect(pianoKey("E4")).toBeEmptyDOMElement();
  });

  it("styles sharps as black keys and gives every key its pitch as accessible name", () => {
    loadPiano();
    render(<PianoHarness />);
    expect(pianoKey("C#4")).toHaveAttribute("data-key", "black");
    expect(pianoKey("C4")).toHaveAttribute("data-key", "white");
    const labels = Array.from(document.querySelectorAll("[data-key]"), (k) => k.getAttribute("aria-label"));
    expect(labels).toEqual(pianoRows.map((r) => r.name));
  });

  it("draws white keys with real piano proportions and black keys on their own row", () => {
    loadPiano();
    render(<PianoHarness />);
    const idx = (name: string) => pianoRows.findIndex((r) => r.name === name);
    const key = pianoKey;
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
    const c4 = pianoKey("C4");
    expect(c4.tabIndex).toBe(0);
    c4.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(pianoKey("C#4")).toHaveFocus();
    expect(keys.filter((k) => k.tabIndex === 0)).toHaveLength(1);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(pianoKey("B3")).toHaveFocus();
  });

  it("auditions the focused key with Enter and Space", async () => {
    loadPiano();
    const onAudition = vi.fn();
    render(<PianoHarness onAudition={onAudition} />);
    pianoKey("A4").focus();
    await userEvent.keyboard("{Enter} ");
    expect(onAudition).toHaveBeenCalledTimes(2);
  });

  it("calls onAudition with the clicked key's row", async () => {
    loadPiano();
    const onAudition = vi.fn();
    render(<PianoHarness onAudition={onAudition} />);
    await userEvent.click(pianoKey("A4"));
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


const ROW_H = 18;
const dragNote = (bar: HTMLElement, dxSteps: number, dyRows: number, init: object = {}) => {
  fireEvent.pointerDown(bar, { clientX: 5, clientY: 500, button: 0, ...init });
  fireEvent.pointerMove(document, { clientX: 5 + dxSteps * 28, clientY: 500 + dyRows * ROW_H, ...init });
  fireEvent.pointerUp(document, { clientX: 5 + dxSteps * 28, clientY: 500 + dyRows * ROW_H, ...init });
};

describe("moving notes on a melodic roll", () => {
  beforeEach(() => {
    clearClipboard();
    localStorage.clear();
    pianoStore().setState({ pattern: null, loadId: 0, prompt: "", past: [], future: [] });
  });

  const rowAbove = (name: string, n: number) =>
    pianoRows[pianoRows.findIndex((r) => r.name === name) - n];

  it("drags a note up two semitones, previews each row once and records one undo step", () => {
    loadPiano([note("c4", 8, 3, 70)]);
    const onPlaceNote = vi.fn();
    render(<PianoHarness onPlaceNote={onPlaceNote} />);
    dragNote(screen.getByTestId("note"), 0, -2);

    expect(pianoStore().getState().pattern!.notes).toEqual([note(rowAbove("C4", 2).id, 8, 3, 70)]);
    expect(onPlaceNote.mock.calls).toEqual([[rowAbove("C4", 1), 70], [rowAbove("C4", 2), 70]]);
    expect(pianoStore().getState().past).toHaveLength(1);
    act(() => pianoStore().getState().undo());
    expect(pianoStore().getState().pattern!.notes).toEqual([note("c4", 8, 3, 70)]);
  });

  it("drags a note later in time without changing its row, length or velocity", () => {
    loadPiano([note("c4", 8, 3, 70)]);
    const onPlaceNote = vi.fn();
    render(<PianoHarness onPlaceNote={onPlaceNote} />);
    dragNote(screen.getByTestId("note"), 3, 0);
    expect(pianoStore().getState().pattern!.notes).toEqual([note("c4", 11, 3, 70)]);
    expect(onPlaceNote).not.toHaveBeenCalled();
  });

  it("settles in the last row where the note fit when the target row is occupied", () => {
    const blocker = note(rowAbove("C4", 2).id, 9, 1);
    loadPiano([note("c4", 8, 3), blocker]);
    render(<PianoHarness />);
    dragNote(screen.getAllByTestId("note").find((b) => b.dataset.row === "c4")!, 0, -2);

    const notes = pianoStore().getState().pattern!.notes;
    expect(notes).toContainEqual(note(rowAbove("C4", 1).id, 8, 3));
    expect(notes).toContainEqual(blocker);
  });

  it("does not record a drag that ends where it started", () => {
    loadPiano([note("c4", 8)]);
    const onPlaceNote = vi.fn();
    render(<PianoHarness onPlaceNote={onPlaceNote} />);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 500, button: 0 });
    fireEvent.pointerMove(document, { clientX: 5 + 56, clientY: 500 - 2 * ROW_H });
    fireEvent.pointerMove(document, { clientX: 5, clientY: 500 });
    fireEvent.pointerUp(document, { clientX: 5, clientY: 500 });
    expect(pianoStore().getState().past).toHaveLength(0);
    expect(pianoStore().getState().pattern!.notes).toEqual([note("c4", 8)]);
  });

  it("restores the notes when Escape cancels a drag", () => {
    loadPiano([note("c4", 8)]);
    render(<PianoHarness />);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 500, button: 0 });
    fireEvent.pointerMove(document, { clientX: 5 + 56, clientY: 500 });
    expect(pianoStore().getState().pattern!.notes).toEqual([note("c4", 10)]);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerUp(document, { clientX: 5 + 56, clientY: 500 });
    expect(pianoStore().getState().pattern!.notes).toEqual([note("c4", 8)]);
    expect(pianoStore().getState().past).toHaveLength(0);
  });

  it("changes pitch without Shift and changes velocity, in place, with Shift", () => {
    loadPiano([note("c4", 8, 2, 80)]);
    const onPlaceNote = vi.fn();
    render(<PianoHarness onPlaceNote={onPlaceNote} />);

    dragNote(screen.getByTestId("note"), 0, -1);
    const moved = pianoStore().getState().pattern!.notes[0];
    expect(moved.row_id).not.toBe("c4");
    expect(moved).toMatchObject({ step: 8, length_steps: 2, velocity: 80 });
    expect(onPlaceNote).toHaveBeenCalledTimes(1);

    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 500, button: 0, shiftKey: true });
    fireEvent.pointerMove(document, { clientX: 5, clientY: 470, shiftKey: true });
    expect(screen.getByText("Vel 110")).toBeInTheDocument();
    fireEvent.pointerUp(document, { clientX: 5, clientY: 470, shiftKey: true });
    expect(pianoStore().getState().pattern!.notes[0]).toMatchObject({ row_id: moved.row_id, velocity: 110 });
    expect(onPlaceNote).toHaveBeenCalledTimes(1);
    expect(pianoStore().getState().past).toHaveLength(2);
  });

  it("shows the target row and bar position while dragging", () => {
    loadPiano([note("c4", 8)]);
    render(<PianoHarness />);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 500, button: 0 });
    fireEvent.pointerMove(document, { clientX: 5 + 2 * 28, clientY: 500 - 2 * ROW_H });
    expect(screen.getByTestId("drag-tip")).toHaveTextContent(`${rowAbove("C4", 2).name} \u00b7 1.3.3`);
    fireEvent.pointerUp(document);
  });

  it("moves a focused note one row with Alt+Up and Alt+Down and one step with Alt+Right", async () => {
    loadPiano([note("c4", 8)]);
    const onPlaceNote = vi.fn();
    render(<PianoHarness onPlaceNote={onPlaceNote} />);
    pianoCell("C4", 8).focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(pianoStore().getState().pattern!.notes).toEqual([note(rowAbove("C4", 1).id, 8)]);
    expect(onPlaceNote).toHaveBeenCalledWith(rowAbove("C4", 1), 100);
    await userEvent.keyboard("{Alt>}{ArrowDown}{ArrowRight}{/Alt}");
    expect(pianoStore().getState().pattern!.notes).toEqual([note("c4", 9)]);
  });

  it("refuses an Alt+Arrow move that would leave the grid", async () => {
    loadPiano([note("c4", 0)]);
    render(<PianoHarness />);
    pianoCell("C4", 0).focus();
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(pianoStore().getState().pattern!.notes).toEqual([note("c4", 0)]);
    expect(pianoStore().getState().past).toHaveLength(0);
  });

  it("tells the user about drag, Shift-drag and removal in the note tooltip", () => {
    loadPiano([note("c4", 8, 2, 80)]);
    render(<PianoHarness />);
    const title = screen.getByTestId("note").getAttribute("title")!;
    expect(title).toContain("Shift-drag for velocity");
    expect(title).toContain("Double-click or Delete to remove");
  });
});

describe("selecting notes", () => {
  const notes = () => [note("kick", 0), note("kick", 4), note("snare", 4, 4), note("snare", 12), note("hat_closed", 2)];
  const selected = () =>
    screen.getAllByTestId("note").filter((b) => b.dataset.selected === "true").map((b) => `${b.dataset.row}:${b.dataset.step}`);
  const bar = (row: string, step: number) =>
    screen.getAllByTestId("note").find((b) => b.dataset.row === row && b.dataset.step === String(step))!;
  const click = (el: HTMLElement, init: object = {}) => {
    fireEvent.pointerDown(el, { clientX: 5, clientY: 5, button: 0, ...init });
    fireEvent.pointerUp(document, { clientX: 5, clientY: 5, ...init });
  };
  const box = (from: HTMLElement, x0: number, y0: number, x1: number, y1: number, init: object = {}) => {
    fireEvent.pointerDown(from, { clientX: x0, clientY: y0, button: 0, ...init });
    fireEvent.pointerMove(document, { clientX: x1, clientY: y1, ...init });
    fireEvent.pointerUp(document, { clientX: x1, clientY: y1, ...init });
  };
  // Cell centres, since the box is hit-tested in step and row units.
  const cx = (step: number) => step * 28 + 14;
  const cy = (row: number) => row * 32 + 16;

  it("selects only the clicked note", () => {
    setup(notes());
    click(bar("kick", 0));
    click(bar("snare", 4));
    expect(selected()).toEqual(["snare:4"]);
  });

  it("extends the selection with Shift-click and toggles with Ctrl-click", () => {
    setup(notes());
    click(bar("kick", 0));
    click(bar("kick", 4), { shiftKey: true });
    click(bar("snare", 12), { shiftKey: true });
    expect(selected()).toEqual(["kick:0", "kick:4", "snare:12"]);
    click(bar("kick", 4), { ctrlKey: true });
    expect(selected()).toEqual(["kick:0", "snare:12"]);
  });

  it("box-selects every note that starts or extends into the box", () => {
    setup(notes());
    // Steps 6-9 on the snare and hi-hat rows: the snare note at 4-7 reaches in, the one at 12 does not.
    box(cell("hat_closed", 9), cx(9), cy(2), cx(6), cy(1));
    expect(selected()).toEqual(["snare:4"]);
    expect(screen.queryByTestId("marquee")).not.toBeInTheDocument();
  });

  it("draws the selection box only after the drag threshold", () => {
    setup(notes());
    const start = cell("hat_closed", 9);
    fireEvent.pointerDown(start, { clientX: cx(9), clientY: cy(2), button: 0 });
    fireEvent.pointerMove(document, { clientX: cx(9) + 2, clientY: cy(2) });
    expect(screen.queryByTestId("marquee")).not.toBeInTheDocument();
    fireEvent.pointerMove(document, { clientX: cx(6), clientY: cy(1) });
    expect(screen.getByTestId("marquee")).toBeInTheDocument();
    fireEvent.pointerUp(document);
    expect(screen.queryByTestId("marquee")).not.toBeInTheDocument();
  });

  it("adds a box to the selection when Shift was held at the start", () => {
    setup(notes());
    click(bar("kick", 0));
    box(cell("hat_closed", 9), cx(9), cy(2), cx(6), cy(1), { shiftKey: true });
    expect(selected()).toEqual(["kick:0", "snare:4"]);
  });

  it("does not add a note when the box ends over its starting cell", async () => {
    setup([]);
    const start = cell("snare", 5);
    fireEvent.pointerDown(start, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(document, { clientX: 20, clientY: 0 });
    fireEvent.pointerUp(document, { clientX: 20, clientY: 0 });
    fireEvent.click(start);
    expect(store().getState().pattern!.notes).toEqual([]);
  });

  it("clears the selection when an empty cell is clicked, and adds the note", async () => {
    setup(notes());
    click(bar("kick", 0));
    await userEvent.click(cell("hat_closed", 9));
    expect(selected()).toEqual([]);
    expect(store().getState().pattern!.notes).toContainEqual(note("hat_closed", 9));
  });

  it("selects every note with Ctrl+A and clears with Escape", async () => {
    harnessProps = { onAnnounce: vi.fn() };
    setup(notes());
    cell("kick", 8).focus();
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(selected()).toHaveLength(5);
    expect(screen.getByText("5 notes selected", { selector: "p[aria-live]" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(selected()).toEqual([]);
    expect(screen.getByText("Selection cleared")).toBeInTheDocument();
  });

  it("deletes the selection with Delete and restores it with one undo", async () => {
    setup(notes());
    click(bar("kick", 0));
    click(bar("kick", 4), { shiftKey: true });
    click(bar("snare", 4), { shiftKey: true });
    await userEvent.keyboard("{Delete}");
    expect(store().getState().pattern!.notes).toEqual([note("snare", 12), note("hat_closed", 2)]);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(store().getState().pattern!.notes).toHaveLength(5);
  });

  it("selects a note with Enter and toggles it with Shift+Enter", async () => {
    setup(notes());
    cell("snare", 6).focus();
    await userEvent.keyboard("{Enter}");
    expect(selected()).toEqual(["snare:4"]);
    cell("kick", 0).focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(selected()).toEqual(["kick:0", "snare:4"]);
    expect(store().getState().pattern!.notes).toHaveLength(5);
  });

  it("says in the accessible names which notes are selected", () => {
    setup([note("snare", 4, 4)]);
    click(bar("snare", 4));
    const head = screen.getByRole("button", { name: "Snare, measure 1, step 5, selected" });
    expect(head).toHaveAttribute("aria-description", "Note, velocity 100, 4 steps");
    expect(cell("snare", 6)).toHaveAttribute("aria-description", "Held from step 5, selected");
  });

  it("resets the selection when a different pattern is loaded", () => {
    setup(notes());
    click(bar("kick", 0));
    expect(selected()).toHaveLength(1);
    act(() => store().getState().setPattern(patternWith(notes())));
    expect(selected()).toEqual([]);
  });

  it("drops a selected key when its note is removed from outside the roll, so a re-added note is not selected", () => {
    setup(notes());
    click(bar("kick", 0));
    act(() => store().getState().editNotes((g) => g.notes.filter((n) => !(n.row_id === "kick" && n.step === 0))));
    act(() => store().getState().editNotes((g) => [...g.notes, note("kick", 0)]));
    expect(selected()).toEqual([]);
  });

  it("drops the selection after undoing a move of the selected note", () => {
    setup([note("kick", 0)]);
    click(bar("kick", 0));
    fireEvent.pointerDown(bar("kick", 0), { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(document, { clientX: 10 + 28 * 2, clientY: 10 });
    fireEvent.pointerUp(document, { clientX: 10 + 28 * 2, clientY: 10 });
    expect(selected()).toEqual(["kick:2"]);
    act(() => store().getState().undo());
    expect(selected()).toEqual([]);
  });

  it("clears the selection when the step width changes", () => {
    setup(notes());
    click(bar("kick", 0));
    act(() =>
      store().setState((s) => ({ pattern: { ...s.pattern!, steps_per_measure: 12, notes: [...s.pattern!.notes] } })),
    );
    expect(selected()).toEqual([]);
  });

  it("does not swallow a later keyboard Enter after a box that ended on a different cell", async () => {
    setup(notes());
    box(cell("hat_closed", 9), cx(9), cy(2), cx(6), cy(1));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    cell("snare", 9).focus();
    await userEvent.keyboard("{Enter}");
    expect(store().getState().pattern!.notes).toContainEqual(note("snare", 9));
  });

  it("keeps the selection out of undo history", () => {
    setup(notes());
    click(bar("kick", 0));
    expect(store().getState().past).toHaveLength(0);
  });
});

describe("moving a selection on a drum roll", () => {
  const bar = (row: string, step: number) =>
    screen.getAllByTestId("note").find((b) => b.dataset.row === row && b.dataset.step === String(step))!;
  const drag = (el: HTMLElement, dx: number, dy: number, init: object = {}) => {
    fireEvent.pointerDown(el, { clientX: 10, clientY: 100, button: 0, ...init });
    fireEvent.pointerMove(document, { clientX: 10 + dx, clientY: 100 + dy, ...init });
    fireEvent.pointerUp(document, { clientX: 10 + dx, clientY: 100 + dy, ...init });
  };
  const click = (el: HTMLElement, init: object = {}) => {
    fireEvent.pointerDown(el, { clientX: 5, clientY: 5, button: 0, ...init });
    fireEvent.pointerUp(document, { clientX: 5, clientY: 5, ...init });
  };

  it("moves a selection as a block, up one row and right two steps", () => {
    setup([note("snare", 4), note("hat_closed", 8), note("kick", 0)]);
    click(bar("snare", 4));
    click(bar("hat_closed", 8), { shiftKey: true });
    drag(bar("snare", 4), 56, -32);
    expect(store().getState().pattern!.notes).toEqual(
      expect.arrayContaining([note("kick", 6), note("snare", 10), note("kick", 0)]),
    );
    expect(store().getState().pattern!.notes).toHaveLength(3);
    expect(store().getState().past).toHaveLength(1);
  });

  it("moves an unselected note alone, leaving the selection's notes in place", () => {
    setup([note("kick", 0), note("kick", 8)]);
    click(bar("kick", 0));
    drag(bar("kick", 8), 28, 0);
    expect(store().getState().pattern!.notes).toEqual([note("kick", 0), note("kick", 9)]);
  });

  it("box-selects four notes and drags one two steps right to move all four", () => {
    setup([note("kick", 0), note("kick", 4), note("snare", 8), note("snare", 12)]);
    fireEvent.pointerDown(cell("hat_closed", 15), { clientX: 15 * 28 + 14, clientY: 80, button: 0 });
    fireEvent.pointerMove(document, { clientX: 2, clientY: 2 });
    fireEvent.pointerUp(document, { clientX: 2, clientY: 2 });
    drag(bar("kick", 0), 56, 0);
    expect(store().getState().pattern!.notes).toEqual([
      note("kick", 2),
      note("kick", 6),
      note("snare", 10),
      note("snare", 14),
    ]);
  });

  it("stops the whole block at the grid edge", () => {
    setup([note("kick", 0), note("kick", 4)]);
    click(bar("kick", 0));
    click(bar("kick", 4), { shiftKey: true });
    drag(bar("kick", 0), -56, 0);
    expect(store().getState().pattern!.notes).toEqual([note("kick", 0), note("kick", 4)]);
    expect(store().getState().past).toHaveLength(0);
  });

  it("shift-drags a selection so every velocity changes by the same amount", () => {
    setup([note("kick", 0, 1, 60), note("kick", 4, 1, 120)]);
    click(bar("kick", 0));
    click(bar("kick", 4), { shiftKey: true });
    drag(bar("kick", 0), 0, -20, { shiftKey: true });
    expect(store().getState().pattern!.notes.map((n) => n.velocity)).toEqual([80, 127]);
    expect(store().getState().past).toHaveLength(1);
  });

  it("records one undo step for a drag made of many pointer moves", () => {
    setup([note("kick", 0)]);
    const el = bar("kick", 0);
    fireEvent.pointerDown(el, { clientX: 10, clientY: 100, button: 0 });
    for (let i = 1; i <= 5; i++) fireEvent.pointerMove(document, { clientX: 10 + i * 28, clientY: 100 });
    fireEvent.pointerUp(document, { clientX: 10 + 5 * 28, clientY: 100 });
    expect(store().getState().pattern!.notes).toEqual([note("kick", 5)]);
    expect(store().getState().past).toHaveLength(1);
  });
});

describe("note inspector", () => {
  const ctrlA = async (row: string, step: number) => {
    cell(row, step).focus();
    await userEvent.keyboard("{Control>}a{/Control}");
  };
  const velocity = () => screen.getByLabelText("Velocity") as HTMLInputElement;
  const length = () => screen.getByLabelText(/^Length/) as HTMLInputElement;

  it("shows only a hint while nothing is selected", () => {
    setup([note("kick", 0)]);
    expect(screen.getByText(/No notes selected/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Selected notes" })).not.toBeInTheDocument();
  });

  it("sets the velocity of every selected note and undoes it in one step", async () => {
    const notes = [0, 2, 4, 6, 8].map((s, i) => note("kick", s, 1, 40 + i * 20));
    setup(notes);
    await ctrlA("snare", 0);
    expect(within(screen.getByRole("group", { name: "Selected notes" })).getByText("5 notes selected")).toBeInTheDocument();
    expect(velocity()).toHaveValue(null);
    expect(velocity()).toHaveAttribute("placeholder", "Mixed");
    await userEvent.type(velocity(), "90{Enter}");
    expect(store().getState().pattern!.notes.map((n) => n.velocity)).toEqual([90, 90, 90, 90, 90]);
    expect(store().getState().past).toHaveLength(1);
    cell("snare", 0).focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(store().getState().pattern!.notes.map((n) => n.velocity)).toEqual([40, 60, 80, 100, 120]);
  });

  it("does not play the notes when a property changes", async () => {
    const onPlaceNote = vi.fn();
    harnessProps = { onPlaceNote };
    setup([note("kick", 0)]);
    await ctrlA("snare", 0);
    await userEvent.type(velocity(), "50{Enter}");
    expect(onPlaceNote).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range velocity without committing", async () => {
    setup([note("kick", 0)]);
    await ctrlA("snare", 0);
    await userEvent.type(velocity(), "300");
    expect(velocity()).toHaveAttribute("aria-invalid", "true");
    await userEvent.keyboard("{Enter}");
    expect(store().getState().pattern!.notes[0].velocity).toBe(100);
    expect(store().getState().past).toHaveLength(0);
  });

  it("shows velocity as the shared value when the notes agree", async () => {
    setup([note("kick", 0, 1, 70), note("kick", 4, 1, 70)]);
    await ctrlA("snare", 0);
    expect(velocity()).toHaveValue(70);
  });

  it("keeps the length read-only on a one-shot instrument", async () => {
    setup([note("kick", 0), note("snare", 4)]);
    await ctrlA("hat_closed", 0);
    expect(length()).toHaveAttribute("readonly");
    expect(length()).toHaveAttribute("title", "One-shot sounds always play in full.");
    expect(length()).toHaveValue(1);
  });

  it("does not let a key typed in the inspector reach the grid", async () => {
    setup([note("kick", 0)]);
    await ctrlA("snare", 0);
    await userEvent.type(velocity(), "{Delete}{Backspace}");
    expect(store().getState().pattern!.notes).toHaveLength(1);
  });
});

describe("note inspector on a sustained instrument", () => {
  beforeEach(() => {
    clearClipboard();
    localStorage.clear();
    pianoStore().setState({ pattern: null, loadId: 0, prompt: "", past: [], future: [] });
  });

  it("shows Mixed for different lengths and sets a length for every note", async () => {
    loadPiano([note("c4", 0, 2), note("e4", 8, 4)]);
    render(<PianoHarness />);
    pianoCell("C4", 0).focus();
    await userEvent.keyboard("{Control>}a{/Control}");
    const field = screen.getByLabelText(/^Length/) as HTMLInputElement;
    expect(field).toHaveAttribute("placeholder", "Mixed");
    expect(field).not.toHaveAttribute("readonly");
    await userEvent.type(field, "3{Enter}");
    expect(pianoStore().getState().pattern!.notes.map((n) => n.length_steps)).toEqual([3, 3]);
  });

  it("shortens a length that would run into the next note", async () => {
    loadPiano([note("c4", 0, 2), note("c4", 4, 2)]);
    render(<PianoHarness />);
    await userEvent.click(pianoCell("C4", 0));
    await userEvent.type(screen.getByLabelText(/^Length/), "8{Enter}");
    expect(pianoStore().getState().pattern!.notes).toEqual([note("c4", 0, 4), note("c4", 4, 2)]);
  });
});

describe("copying, cutting and pasting notes", () => {
  const selectedSteps = () =>
    screen.getAllByTestId("note").filter((b) => b.dataset.selected === "true").map((b) => `${b.dataset.row}:${b.dataset.step}`);

  it("pastes after the copied block, then after each pasted block", async () => {
    setup([note("kick", 0), note("snare", 4, 4), note("hat_closed", 15)]);
    cell("kick", 8).focus();
    await userEvent.keyboard("{Control>}ac{/Control}");
    await userEvent.keyboard("{Control>}v{/Control}");
    expect(store().getState().pattern!.notes).toHaveLength(6);
    expect(store().getState().pattern!.notes).toContainEqual(note("kick", 16));
    expect(store().getState().pattern!.notes).toContainEqual(note("snare", 20, 4));
    expect(selectedSteps().sort()).toEqual(["hat_closed:31", "kick:16", "snare:20"]);
    await userEvent.keyboard("{Control>}v{/Control}");
    expect(store().getState().pattern!.notes).toContainEqual(note("kick", 32));
    expect(store().getState().past).toHaveLength(2);
  });

  it("pastes at the hovered step, keeping spacing and rows", async () => {
    setup([note("kick", 4), note("snare", 8, 2, 70)]);
    cell("kick", 4).focus();
    await userEvent.keyboard("{Control>}ac{/Control}");
    fireEvent.pointerMove(cell("hat_closed", 20), { clientX: 20 * 28 + 5, clientY: 70 });
    await userEvent.keyboard("{Control>}v{/Control}");
    expect(store().getState().pattern!.notes).toContainEqual(note("kick", 20));
    expect(store().getState().pattern!.notes).toContainEqual(note("snare", 24, 2, 70));
  });

  it("falls back to after the block when the pointer has left the grid", async () => {
    setup([note("kick", 4)]);
    cell("kick", 4).focus();
    await userEvent.keyboard("{Control>}ac{/Control}");
    fireEvent.pointerMove(cell("hat_closed", 20), { clientX: 20 * 28 + 5, clientY: 70 });
    fireEvent.pointerLeave(screen.getByTestId("roll-grid"));
    await userEvent.keyboard("{Control>}v{/Control}");
    expect(store().getState().pattern!.notes).toContainEqual(note("kick", 5));
  });

  it("ignores the pointer over the ruler, so paste falls back to after the copy", async () => {
    setup([note("kick", 4)]);
    cell("kick", 4).focus();
    await userEvent.keyboard("{Control>}ac{/Control}");
    const ruler = screen.getByRole("group", { name: "Drums piano roll" }).querySelector(".sticky.top-0.z-30")!;
    fireEvent.pointerMove(ruler, { clientX: 20 * 28 + 5, clientY: 5 });
    await userEvent.keyboard("{Control>}v{/Control}");
    expect(store().getState().pattern!.notes).toContainEqual(note("kick", 5));
  });

  it("discards notes on rows the instrument lacks and says how many", async () => {
    const onAnnounce = vi.fn();
    harnessProps = { onAnnounce };
    copyNotes([note("kick", 0), note("c4", 0), note("e4", 4)]);
    setup([]);
    cell("kick", 0).focus();
    await userEvent.keyboard("{Control>}v{/Control}");
    expect(store().getState().pattern!.notes).toEqual([note("kick", 5)]);
    expect(onAnnounce).toHaveBeenCalledWith("Pasted 1 note. 2 didn't fit and were left out.");
  });

  it("shortens a pasted note at the end and drops one that starts past it", async () => {
    setup([note("kick", 0, 4), note("snare", 8)]);
    cell("kick", 0).focus();
    await userEvent.keyboard("{Control>}ac{/Control}");
    fireEvent.pointerMove(cell("hat_closed", 62), { clientX: 62 * 28 + 5, clientY: 70 });
    await userEvent.keyboard("{Control>}v{/Control}");
    const notes = store().getState().pattern!.notes;
    expect(notes).toContainEqual(note("kick", 62, 2));
    expect(notes.some((n) => n.row_id === "snare" && n.step >= 64)).toBe(false);
  });

  it("cuts the selection and restores it with one undo", async () => {
    setup([note("kick", 0), note("snare", 4), note("hat_closed", 8)]);
    cell("kick", 8).focus();
    await userEvent.keyboard("{Control>}ax{/Control}");
    expect(store().getState().pattern!.notes).toEqual([]);
    expect(store().getState().past).toHaveLength(1);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(store().getState().pattern!.notes).toHaveLength(3);
  });

  it("does nothing on copy when nothing is selected and on paste when nothing was copied", async () => {
    setup([note("kick", 0)]);
    cell("kick", 8).focus();
    await userEvent.keyboard("{Control>}cv{/Control}");
    expect(store().getState().pattern!.notes).toEqual([note("kick", 0)]);
  });

  it("keeps native copy and paste in text fields", async () => {
    setup([note("kick", 0)]);
    cell("kick", 0).focus();
    await userEvent.keyboard("{Control>}a{/Control}");
    const input = screen.getByLabelText("Velocity");
    input.focus();
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("stops Cmd/Ctrl+A from reaching document-level shortcuts", async () => {
    setup([note("kick", 0)]);
    const seen = vi.fn();
    const listener = (e: KeyboardEvent) => e.key === "a" && seen();
    document.addEventListener("keydown", listener);
    cell("kick", 0).focus();
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(seen).not.toHaveBeenCalled();
    document.removeEventListener("keydown", listener);
  });
});
