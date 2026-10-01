import { describe, expect, it } from "vitest";
import { toneDefaults } from "./soundDefaults";
import { SOUND_RANGES } from "./trackSound";

describe("toneDefaults", () => {
  it("never rests outside the range a document may store, even for the organ's zero decay", () => {
    for (const id of ["organ", "piano", "bass", "strings", "synth-pad", "drums", "unknown"]) {
      const d = toneDefaults(id);
      for (const key of ["filter_cutoff_hz", "filter_resonance", "attack_s", "decay_s", "sustain", "release_s", "pitch_semitones"] as const) {
        expect(d[key]).toBeGreaterThanOrEqual(SOUND_RANGES[key].min);
        expect(d[key]).toBeLessThanOrEqual(SOUND_RANGES[key].max);
      }
    }
    expect(toneDefaults("organ").decay_s).toBe(SOUND_RANGES.decay_s.min);
  });
});
