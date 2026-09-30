import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { drums } from "@/test/fixtures";
import { getPatternStore } from "@/lib/patternStore";
import { PatternEditorPage } from "./PatternEditorPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getLimits: vi.fn(),
  getInstruments: vi.fn(),
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

beforeEach(() => {
  vi.mocked(api.getLimits).mockResolvedValue({ max_input_tokens: 256, measure_options: [4] });
  vi.mocked(api.getInstruments).mockResolvedValue([drums]);
});

describe("hydration", () => {
  it("server markup omits persisted prompt state and hydrates without mismatches", async () => {
    getPatternStore("drums").setState({ prompt: "laid-back boom-bap with ghosted snares!!" });
    const page = <PatternEditorPage instrumentId="drums" title="Drum Machine" />;

    const html = renderToString(page);
    expect(html).not.toContain("ghosted");
    expect(html).not.toContain("10 / ");

    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    await act(async () => {
      hydrateRoot(container, page, { onRecoverableError: (e) => errors.push(e) });
    });
    spy.mockRestore();

    expect(errors).toEqual([]);
    expect(container.querySelector("textarea")).toHaveValue("laid-back boom-bap with ghosted snares!!");
    container.remove();
  });
});
