import { describe, expect, it } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import { trackLabel } from "./trackLabel";

const piano = { id: "piano", name: "Piano" } as InstrumentInfo;

describe("trackLabel", () => {
  it("names the instrument unless it equals the track name", () => {
    expect(trackLabel("Keys", "piano", [piano])).toBe("Keys (Piano)");
    expect(trackLabel("Piano", "piano", [piano])).toBe("Piano");
  });

  it("drops an instrument it cannot name, whether the list is missing or lacks it", () => {
    expect(trackLabel("Keys", "piano", null)).toBe("Keys");
    expect(trackLabel("Keys", "piano", [])).toBe("Keys");
  });

  it("falls back to the raw id only on request and only while the list is missing", () => {
    expect(trackLabel("Keys", "piano", null, { idFallback: true })).toBe("Keys (piano)");
    expect(trackLabel("Keys", "piano", [], { idFallback: true })).toBe("Keys");
  });
});
