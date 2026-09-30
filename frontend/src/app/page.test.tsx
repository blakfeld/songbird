import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import * as api from "@/lib/api";
import { drums } from "@/test/fixtures";
import Home from "./page";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe("landing page", () => {
  it("links every instrument, with drums at the drum machine URL", async () => {
    const piano = { ...drums, id: "piano", name: "Piano" } as InstrumentInfo;
    vi.mocked(api.getInstruments).mockResolvedValue([drums, piano]);
    render(<Home />);
    expect(await screen.findByRole("link", { name: /piano/i })).toHaveAttribute(
      "href",
      "/instruments/piano",
    );
    expect(screen.getByRole("link", { name: /drum machine/i })).toHaveAttribute(
      "href",
      "/drum-machine",
    );
  });

  it("links the Studio", async () => {
    vi.mocked(api.getInstruments).mockResolvedValue([drums]);
    render(<Home />);
    expect(await screen.findByRole("link", { name: "Open the Studio" })).toHaveAttribute(
      "href",
      "/studio",
    );
  });

  it("falls back to the drum machine link when the fetch fails", async () => {
    vi.mocked(api.getInstruments).mockRejectedValue(new Error("down"));
    render(<Home />);
    expect(await screen.findByRole("link", { name: /drum machine/i })).toHaveAttribute(
      "href",
      "/drum-machine",
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});
