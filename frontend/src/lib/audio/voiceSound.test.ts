import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_SOUND, EFFECT_DEFAULTS, resolveSound } from "./voiceSound";

describe("resolveSound", () => {
  it("gives the shared default for an absent sound", () => {
    expect(resolveSound(undefined)).toBe(DEFAULT_VOICE_SOUND);
    expect(DEFAULT_VOICE_SOUND.effects).toEqual(EFFECT_DEFAULTS);
  });

  it("keeps tone as overrides only, so the instrument supplies the rest", () => {
    const { tone } = resolveSound({ tone: { filter_cutoff_hz: 300, release_s: 2 } });
    expect(tone).toEqual({ filterCutoffHz: 300, envelope: { release: 2 } });
  });

  it("fills effect defaults around the stored overrides", () => {
    const { effects } = resolveSound({ effects: { delay: { enabled: true, mix: 0.6 } } });
    expect(effects.delay).toEqual({ enabled: true, time: "1/8d", feedback: 0.35, mix: 0.6 });
    expect(effects.reverb.enabled).toBe(false);
  });

  it("clamps a value that slipped past validation", () => {
    expect(resolveSound({ effects: { reverb: { mix: 5 } } }).effects.reverb.mix).toBe(1);
  });

  it("treats a null leaf as absent instead of clamping it to the range minimum", () => {
    const sound = {
      tone: { filter_cutoff_hz: null, attack_s: null },
      effects: { reverb: { mix: null } },
    } as never;
    const resolved = resolveSound(sound);
    expect(resolved.tone).toEqual({});
    expect(resolved.effects.reverb.mix).toBe(EFFECT_DEFAULTS.reverb.mix);
  });
});
