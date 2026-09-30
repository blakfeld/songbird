import { describe, expect, it } from "vitest";
import { midiFilename } from "./midiFilename";

describe("midiFilename", () => {
  it("slugs the name and appends tempo", () => {
    expect(midiFilename({ name: "Dusty Boom Bap!", tempo_bpm: 90 })).toBe("songbird-dusty-boom-bap-90bpm.mid");
  });
  it("falls back when the name has no usable characters", () => {
    expect(midiFilename({ name: "!!!", tempo_bpm: 120 })).toBe("songbird-pattern-120bpm.mid");
  });
});
