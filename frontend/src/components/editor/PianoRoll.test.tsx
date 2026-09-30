import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
