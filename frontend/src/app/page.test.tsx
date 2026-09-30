import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("landing page", () => {
  it("links to the drum machine", () => {
    render(<Home />);
    expect(
      screen.getByRole("link", { name: /drum machine/i }),
    ).toHaveAttribute("href", "/drum-machine");
  });
});
