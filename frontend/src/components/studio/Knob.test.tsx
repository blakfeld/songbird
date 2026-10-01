import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Knob, type KnobProps } from "./Knob";
import { PanKnob } from "./PanKnob";

afterEach(cleanup);

function setup(props: Partial<KnobProps> = {}) {
  const onChange = vi.fn();
  const onGestureStart = vi.fn();
  const onGestureEnd = vi.fn();
  render(
    <Knob
      label="Cutoff"
      value={1000}
      min={100}
      max={10000}
      defaultValue={900}
      scale="log"
      format={(v) => `${Math.round(v)} Hz`}
      onChange={onChange}
      onGestureStart={onGestureStart}
      onGestureEnd={onGestureEnd}
      {...props}
    />,
  );
  return { slider: screen.getByRole("slider", { name: "Cutoff" }), onChange, onGestureStart, onGestureEnd };
}

describe("Knob accessibility", () => {
  it("exposes value, range, and units", () => {
    const { slider } = setup();
    expect(slider).toHaveAttribute("aria-valuenow", "1000");
    expect(slider).toHaveAttribute("aria-valuemin", "100");
    expect(slider).toHaveAttribute("aria-valuemax", "10000");
    expect(slider).toHaveAttribute("aria-valuetext", "1000 Hz");
  });

  it("shows the value while focused and hides it on blur", async () => {
    const { slider } = setup();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    slider.focus();
    expect(await screen.findByRole("status")).toHaveTextContent("1000 Hz");
    act(() => slider.blur());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("Knob log scale", () => {
  // Each equal slice of travel must cover an equal ratio of frequency.
  it("moves one percent of travel as a constant ratio", async () => {
    const { slider, onChange } = setup();
    slider.focus();
    await userEvent.keyboard("{ArrowUp}");
    const up = onChange.mock.calls[0][0];
    expect(up).toBeCloseTo(1000 * 100 ** 0.01, 3);
    expect(up / 1000).toBeCloseTo(1000 / (1000 / 100 ** 0.01), 3);
  });

  it("makes a Page Up from the bottom a tenth of the octaves, not a tenth of the Hz", async () => {
    const { slider, onChange } = setup({ value: 100 });
    slider.focus();
    await userEvent.keyboard("{PageUp}");
    expect(onChange.mock.calls[0][0]).toBeCloseTo(100 * 100 ** 0.1, 3);
  });

  it("maps a drag through the log curve", () => {
    const { slider, onChange } = setup({ value: 100 });
    fireEvent.pointerDown(slider, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 100, clientY: 0, pointerId: 1 });
    // 100 px is half of a full sweep.
    expect(onChange).toHaveBeenLastCalledWith(expect.closeTo(1000, 3), { transient: true });
  });
});

describe("Knob keyboard", () => {
  const press = async (key: string, props: Partial<KnobProps> = {}) => {
    const ctx = setup({ scale: "linear", min: 0, max: 1, value: 0.3, defaultValue: 0.5, ...props });
    ctx.slider.focus();
    await userEvent.keyboard(key);
    return ctx;
  };

  it("steps 1% of travel per arrow press, three presses adding three steps", async () => {
    const { onChange } = await press("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([0.31, 0.31, 0.31]);
  });

  it("uses the step when given", async () => {
    const { onChange } = await press("{ArrowDown}", { step: 0.05 });
    expect(onChange).toHaveBeenCalledWith(0.25, { transient: true });
  });

  it("moves ten steps for Page Up and Page Down", async () => {
    expect((await press("{PageUp}")).onChange).toHaveBeenCalledWith(0.4, { transient: true });
    cleanup();
    expect((await press("{PageDown}")).onChange).toHaveBeenCalledWith(0.2, { transient: true });
  });

  it("jumps to the ends with Home and End", async () => {
    expect((await press("{Home}")).onChange).toHaveBeenCalledWith(0, { transient: true });
    cleanup();
    expect((await press("{End}")).onChange).toHaveBeenCalledWith(1, { transient: true });
  });

  it("clamps at the ends", async () => {
    const { onChange } = await press("{ArrowUp}", { value: 1 });
    expect(onChange).toHaveBeenCalledWith(1, { transient: true });
  });

  it("resets to the default on Delete as a committed change", async () => {
    const { onChange } = await press("{Delete}");
    expect(onChange).toHaveBeenCalledWith(0.5, { transient: false });
  });

  it("ends the gesture when the key is released", async () => {
    const { onGestureEnd } = await press("{ArrowUp}");
    expect(onGestureEnd).toHaveBeenCalled();
  });
});

describe("Knob pointer", () => {
  it("resets on double-click", async () => {
    const { slider, onChange } = setup();
    await userEvent.dblClick(slider);
    expect(onChange).toHaveBeenLastCalledWith(900, { transient: false });
  });

  it("drags finer with Shift", () => {
    const { slider, onChange } = setup({ scale: "linear", min: 0, max: 100, value: 50, defaultValue: 50 });
    fireEvent.pointerDown(slider, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 0, clientY: -40, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 0, clientY: -40, pointerId: 1, shiftKey: true });
    expect(onChange.mock.calls[0][0]).toBeCloseTo(70);
    expect(onChange.mock.calls[1][0]).toBeCloseTo(55);
  });

  it("raises the value for rightward and upward drags alike", () => {
    const { slider, onChange } = setup({ scale: "linear", min: 0, max: 100, value: 50, defaultValue: 50 });
    fireEvent.pointerDown(slider, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 20, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 0, clientY: -20, pointerId: 1 });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([60, 60]);
  });

  it("brackets a drag with gesture callbacks", () => {
    const { slider, onGestureStart, onGestureEnd } = setup();
    fireEvent.pointerDown(slider, { clientX: 0, clientY: 0, pointerId: 1 });
    expect(onGestureStart).toHaveBeenCalledOnce();
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(onGestureEnd).toHaveBeenCalledOnce();
  });
});

describe("PanKnob", () => {
  it("keeps its percent behavior on top of Knob", async () => {
    const onChange = vi.fn();
    render(
      <PanKnob name="Piano" value={0.5} onChange={onChange} onGestureStart={vi.fn()} onGestureEnd={vi.fn()} />,
    );
    const slider = screen.getByRole("slider", { name: "Pan Piano" });
    expect(slider).toHaveAttribute("aria-valuetext", "50% right");
    slider.focus();
    await userEvent.keyboard("{ArrowLeft}{0}");
    expect(onChange).toHaveBeenNthCalledWith(1, 0.49, { transient: true });
    expect(onChange).toHaveBeenNthCalledWith(2, 0, { transient: false });
  });
});
