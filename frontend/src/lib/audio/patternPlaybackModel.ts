import { getPatternStore, type PatternStore } from "@/lib/patternStore";
import { beatSteps } from "@/lib/pianoRoll";
import type { PlaybackModel } from "./types";

// The pattern is read on every call rather than captured, so live edits reach
// the scheduler.
export function createPatternPlaybackModel(
  instrumentId: string,
  store: PatternStore = getPatternStore(instrumentId),
): PlaybackModel {
  return {
    instrument: instrumentId,
    getTiming() {
      const p = store.getState().pattern;
      if (!p) return null;
      return {
        tempo: p.tempo_bpm,
        swing: p.swing,
        beatSteps: beatSteps(p.time_signature),
        stepsPerMeasure: p.steps_per_measure,
        measures: p.measures,
      };
    },
    getVoices() {
      const p = store.getState().pattern;
      if (!p) return [];
      return [
        {
          key: instrumentId,
          kind: "instrument" as const,
          instrument: instrumentId,
          rows: p.rows,
          notes: p.notes,
          volumeDb: 0,
          pan: 0,
          audible: true,
        },
      ];
    },
  };
}
