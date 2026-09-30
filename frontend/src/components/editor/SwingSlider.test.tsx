import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwingSlider } from "./SwingSlider";

describe("SwingSlider", () => {
  it("commits once on release using the latest value", () => {
    const onCommit = vi.fn();
    render(<SwingSlider value={0} onCommit={onCommit} />);
    const slider = screen.getByRole("slider", { name: "Swing" });
    const capture = vi.fn();
    Object.assign(slider, { setPointerCapture: capture });
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: "20" } });
    fireEvent.change(slider, { target: { value: "30" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(capture).toHaveBeenCalledWith(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(0.3);
  });

  it("does not commit an unchanged value", () => {
    const onCommit = vi.fn();
    render(<SwingSlider value={0.1} onCommit={onCommit} />);
    const slider = screen.getByRole("slider", { name: "Swing" });
    fireEvent.change(slider, { target: { value: "10" } });
    fireEvent.pointerUp(slider);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
