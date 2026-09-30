import { describe, expect, it } from "vitest";
import { createDrumsSource } from "./drumsSource";
import { getSoundSourceFactory } from "./registry";

describe("sound source registry", () => {
  it("keeps the drum kit for drums", () => {
    expect(getSoundSourceFactory("drums")).toBe(createDrumsSource);
  });

  it("resolves a synth for piano and for unknown sustained ids", () => {
    const piano = getSoundSourceFactory("piano");
    const unknown = getSoundSourceFactory("theremin");
    expect(piano).not.toBe(createDrumsSource);
    expect(unknown).not.toBe(createDrumsSource);
    expect(typeof piano).toBe("function");
    expect(typeof unknown).toBe("function");
  });
});
