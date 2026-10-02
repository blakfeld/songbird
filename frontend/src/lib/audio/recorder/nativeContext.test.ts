import { describe, expect, it } from "vitest";
import { loadRealTone } from "@/test/webAudio";
import { nativeContextOf } from "./nativeContext";

describe("nativeContextOf", () => {
  it("finds the native context under Tone's wrapper, a different object that is a real audio context", async () => {
    const tone = await loadRealTone();
    const ctx = tone.getContext();
    const native = nativeContextOf(ctx);
    expect(native).not.toBe(ctx.rawContext);
    expect(typeof native.createGain).toBe("function");
    expect(native.sampleRate).toBe(ctx.sampleRate);
  });

  it("fails loudly when the library no longer exposes it", () => {
    expect(() => nativeContextOf({ rawContext: {} })).toThrow(/native context/);
    expect(() => nativeContextOf({})).toThrow(/native context/);
  });
});
