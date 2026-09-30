import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LoopSetting } from "@/lib/loopRegion";
import { LoopRegion } from "./LoopRegion";
import { MeasureRuler } from "./MeasureRuler";

const MEASURES = 16;
// 10px per measure keeps the pointer maths readable: measure n spans x in [10(n-1), 10n).
const PX = 10;
const x = (measure: number) => (measure - 1) * PX + 5;

function mockBounds(el: HTMLElement) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: MEASURES * PX, bottom: 28, width: MEASURES * PX, height: 28, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

function Harness({
  initial,
  spy,
}: {
  initial: LoopSetting;
  spy?: (l: LoopSetting) => void;
}) {
  const [loop, setLoop] = useState(initial);
  return (
    <div style={{ ["--cell-w" as string]: "10px" }}>
      <MeasureRuler measures={MEASURES} stepsPerMeasure={1} beatSteps={1} showBeats={false}>
        <LoopRegion
          loop={loop}
          measures={MEASURES}
          stepsPerMeasure={1}
          measurePx={PX}
          onChange={(l) => {
            spy?.(l);
            setLoop(l);
          }}
        />
      </MeasureRuler>
    </div>
  );
}

function setup(initial: LoopSetting, spy = vi.fn()) {
  render(<Harness initial={initial} spy={spy} />);
  const hit = screen.getByTestId("loop-hit-layer");
  mockBounds(hit.parentElement as HTMLElement);
  return {
    spy,
    hit,
    body: () => screen.getByTestId("loop-region"),
    start: () => screen.getByRole("slider", { name: "Loop region start" }),
    end: () => screen.getByRole("slider", { name: "Loop region end" }),
  };
}

function drag(el: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(el, { clientX: x(from), button: 0 });
  fireEvent.pointerMove(el, { clientX: x(to) });
  fireEvent.pointerUp(el, { clientX: x(to) });
}

const region = () => {
  const b = screen.getByTestId("loop-region");
  return { start: Number(b.dataset.start), end: Number(b.dataset.end), enabled: b.dataset.enabled };
};

const on = (start: number, end: number, enabled = true): LoopSetting => ({
  region: { start, end },
  enabled,
});
const none = (enabled = false): LoopSetting => ({ region: null, enabled });

describe("LoopRegion pointer editing", () => {
  it("draws a region and keeps looping on", () => {
    const { hit } = setup(on(1, 8));
    drag(hit, 10, 12);
    expect(region()).toEqual({ start: 10, end: 12, enabled: "true" });
  });

  it("draws backwards", () => {
    const { hit } = setup(on(1, 4));
    drag(hit, 12, 9);
    expect(region()).toEqual({ start: 9, end: 12, enabled: "true" });
  });

  it("replaces the region by drawing elsewhere", () => {
    const { hit } = setup(on(5, 8));
    drag(hit, 13, 14);
    expect(region()).toMatchObject({ start: 13, end: 14 });
  });

  it("turns looping on when drawing while it is off", () => {
    const { hit } = setup(on(5, 8, false));
    drag(hit, 10, 12);
    expect(region()).toEqual({ start: 10, end: 12, enabled: "true" });
  });

  it("changes nothing on a press and release outside the region", () => {
    const { hit, spy } = setup(on(5, 8));
    fireEvent.pointerDown(hit, { clientX: x(12), button: 0 });
    fireEvent.pointerUp(hit, { clientX: x(12) });
    fireEvent.click(hit);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores a wobble under the drag threshold", () => {
    const { hit, spy } = setup(on(5, 8));
    fireEvent.pointerDown(hit, { clientX: 122, button: 0 });
    fireEvent.pointerMove(hit, { clientX: 125 });
    fireEvent.pointerUp(hit, { clientX: 125 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("moves the body without changing its length or the setting", () => {
    const { body } = setup(on(5, 8, false));
    drag(body(), 5, 7);
    expect(region()).toEqual({ start: 7, end: 10, enabled: "false" });
  });

  it("renders only the draw surface when there is no region", () => {
    setup(none());
    expect(screen.getByTestId("loop-hit-layer")).toBeInTheDocument();
    expect(screen.queryByTestId("loop-region")).not.toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("draws a first region from nothing and turns looping on", () => {
    const { hit, spy } = setup(none());
    drag(hit, 3, 6);
    expect(region()).toEqual({ start: 3, end: 6, enabled: "true" });
    expect(spy).toHaveBeenCalledWith(on(3, 6));
  });

  it("draws backwards from nothing", () => {
    const { hit } = setup(none());
    drag(hit, 9, 6);
    expect(region()).toMatchObject({ start: 6, end: 9 });
  });

  it("does not create a region on a click with no region", () => {
    const { hit, spy } = setup(none(true));
    fireEvent.pointerDown(hit, { clientX: x(4), button: 0 });
    fireEvent.pointerUp(hit, { clientX: x(4) });
    expect(spy).not.toHaveBeenCalled();
  });

  it("moves a full-length region instead of drawing, so it stays put", () => {
    const { body, spy } = setup(on(1, 16));
    drag(body(), 5, 8);
    expect(region()).toMatchObject({ start: 1, end: 16 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("toggles on a click of a whole-length region", () => {
    const { body } = setup(on(1, 16));
    fireEvent.pointerDown(body(), { clientX: x(3), button: 0 });
    fireEvent.pointerUp(body(), { clientX: x(3) });
    fireEvent.click(body());
    expect(region().enabled).toBe("false");
  });

  it("does not swallow the next keyboard toggle after drawing on the ruler", async () => {
    const { hit, body } = setup(on(5, 8));
    drag(hit, 12, 14);
    fireEvent.click(hit);
    body().focus();
    await userEvent.keyboard("{Enter}");
    expect(region().enabled).toBe("false");
  });

  it("does not swallow the next keyboard toggle after a cancelled move", async () => {
    const { body } = setup(on(5, 8));
    fireEvent.pointerDown(body(), { clientX: x(5), button: 0 });
    fireEvent.pointerMove(body(), { clientX: x(7) });
    fireEvent.pointerCancel(body(), { clientX: x(7) });
    body().focus();
    await userEvent.keyboard("{Enter}");
    expect(region().enabled).toBe("false");
  });

  it("keeps Space on an edge slider from scrolling", () => {
    const { end } = setup(on(5, 8));
    expect(fireEvent.keyDown(end(), { key: " " })).toBe(false);
  });

  it("stops moving at the last measure", () => {
    const { body } = setup(on(13, 16));
    drag(body(), 13, 16);
    expect(region()).toMatchObject({ start: 13, end: 16 });
  });

  it("resizes from either edge", () => {
    const { end, start } = setup(on(5, 8));
    drag(end(), 8, 12);
    drag(start(), 5, 3);
    expect(region()).toMatchObject({ start: 3, end: 12 });
  });

  it("keeps one measure when an edge is dragged past the other", () => {
    const { end } = setup(on(5, 8));
    drag(end(), 8, 2);
    expect(region()).toMatchObject({ start: 5, end: 5 });
  });

  it("commits once on release, previewing during the drag", () => {
    const { hit, spy } = setup(on(1, 8));
    fireEvent.pointerDown(hit, { clientX: x(10), button: 0 });
    fireEvent.pointerMove(hit, { clientX: x(11) });
    fireEvent.pointerMove(hit, { clientX: x(12) });
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("loop-region").style.width).toBe("calc(3 * calc(1 * var(--cell-w)))");
    fireEvent.pointerUp(hit, { clientX: x(12) });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("toggles looping on a click and back on a second click", () => {
    const { body } = setup(on(5, 8));
    fireEvent.pointerDown(body(), { clientX: x(6), button: 0 });
    fireEvent.pointerUp(body(), { clientX: x(6) });
    fireEvent.click(body());
    expect(region()).toEqual({ start: 5, end: 8, enabled: "false" });
    expect(body()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(body());
    expect(region().enabled).toBe("true");
  });

  it("does not toggle after a move drag", () => {
    const { body, spy } = setup(on(5, 8));
    drag(body(), 5, 7);
    fireEvent.click(body());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(region().enabled).toBe("true");
  });
});

describe("LoopRegion keyboard", () => {
  it("moves the end edge one measure per arrow and announces the value", async () => {
    const { end } = setup(on(5, 8));
    end().focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(region()).toMatchObject({ start: 5, end: 10 });
    expect(end()).toHaveAttribute("aria-valuenow", "10");
    expect(end()).toHaveAttribute("aria-valuetext", "Measure 10");
  });

  it("moves the start edge and supports Home, End and paging", async () => {
    const { start, end } = setup(on(5, 8));
    start().focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(region().start).toBe(4);
    await userEvent.keyboard("{Home}");
    expect(region().start).toBe(1);
    end().focus();
    await userEvent.keyboard("{PageUp}");
    expect(region().end).toBe(12);
    await userEvent.keyboard("{End}");
    expect(region().end).toBe(16);
    await userEvent.keyboard("{Home}");
    // The end edge cannot cross the start edge.
    expect(region().end).toBe(region().start);
  });

  it("exposes measure bounds on the sliders", () => {
    const { start, end } = setup(on(5, 8));
    expect(start()).toHaveAttribute("aria-valuemin", "1");
    expect(start()).toHaveAttribute("aria-valuemax", "8");
    expect(end()).toHaveAttribute("aria-valuemin", "5");
    expect(end()).toHaveAttribute("aria-valuemax", "16");
  });

  it("names the body with its span and looping state and toggles with Enter and Space", async () => {
    const { body } = setup(on(5, 8));
    expect(body()).toHaveAccessibleName("Loop region, measures 5 to 8, looping on");
    body().focus();
    await userEvent.keyboard("{Enter}");
    expect(body()).toHaveAccessibleName("Loop region, measures 5 to 8, looping off");
    await userEvent.keyboard(" ");
    expect(body()).toHaveAttribute("aria-pressed", "true");
  });

  it("moves the whole region with the arrows", async () => {
    const { body } = setup(on(5, 8));
    body().focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(region()).toMatchObject({ start: 6, end: 9 });
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(region()).toMatchObject({ start: 4, end: 7 });
  });

  it("keeps the setting when moving by keyboard", async () => {
    const { body } = setup(on(5, 8, false));
    body().focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(region().enabled).toBe("false");
  });
});

describe("LoopRegion keyboard creation", () => {
  it("offers Set loop region only while there is no region", () => {
    setup(none());
    expect(screen.getByRole("button", { name: "Set loop region" })).toBeInTheDocument();
  });

  it("does not offer it once a region exists", () => {
    setup(on(2, 3));
    expect(screen.queryByRole("button", { name: "Set loop region" })).not.toBeInTheDocument();
  });

  it.each([["{Enter}"], [" "]])("creates measure 1 with looping on and focuses the end edge on %j", async (key) => {
    const { spy } = setup(none());
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Set loop region" })).toHaveFocus();
    await userEvent.keyboard(key);
    expect(spy).toHaveBeenCalledWith(on(1, 1));
    expect(region()).toEqual({ start: 1, end: 1, enabled: "true" });
    expect(screen.getByRole("slider", { name: "Loop region end" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(region()).toMatchObject({ start: 1, end: 3 });
  });

  it("shows no readout chip when the button is focused with no region", async () => {
    setup(none());
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Set loop region" })).toHaveFocus();
    expect(screen.queryByTestId("loop-chip")).not.toBeInTheDocument();
  });

  it("announces the new region", async () => {
    setup(none());
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("Loop region measure 1, looping on.")).toBeInTheDocument();
  });
});
