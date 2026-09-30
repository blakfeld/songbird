import { useStore } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { MeasureCount } from "@/generated/MeasureCount";
import type { Pattern } from "@/generated/Pattern";
import type { TimeSignature } from "@/generated/TimeSignature";
import * as ops from "./patternOps";

// Bounded so a long editing session cannot grow memory without limit.
const HISTORY_LIMIT = 100;

export const storageKey = (instrument: string) =>
  `songbird.patterns.${instrument}.v1`;

export interface PatternState {
  pattern: Pattern | null;
  prompt: string;
  past: Pattern[];
  future: Pattern[];

  setPattern: (pattern: Pattern) => void;
  newEmptyPattern: (
    instrument: InstrumentInfo,
    measures: MeasureCount,
    timeSignature?: TimeSignature,
    tempoBpm?: number,
  ) => void;
  toggleNote: (rowId: string, step: number) => void;
  setVelocity: (rowId: string, step: number, velocity: number) => void;
  resizeNote: (rowId: string, step: number, lengthSteps: number) => void;
  setMeasures: (measures: MeasureCount) => void;
  setTempo: (tempoBpm: number) => void;
  setSwing: (swing: number) => void;
  clear: () => void;
  setPrompt: (prompt: string) => void;
  undo: () => void;
  redo: () => void;
}

export type PatternStore = StoreApi<PatternState>;

export function createPatternStore(instrument: string): PatternStore {
  return createStore<PatternState>()(
    persist(
      (set) => {
        const commit = (next: Pattern) =>
          set((s) =>
            next === s.pattern
              ? s
              : {
                  pattern: next,
                  past: s.pattern
                    ? [...s.past, s.pattern].slice(-HISTORY_LIMIT)
                    : s.past,
                  future: [],
                },
          );
        const edit = (fn: (p: Pattern) => Pattern) =>
          set((s) => {
            if (!s.pattern) return s;
            const next = fn(s.pattern);
            if (next === s.pattern) return s;
            return {
              pattern: next,
              past: [...s.past, s.pattern].slice(-HISTORY_LIMIT),
              future: [],
            };
          });

        return {
          pattern: null,
          prompt: "",
          past: [],
          future: [],

          setPattern: commit,
          newEmptyPattern: (info, measures, timeSignature, tempoBpm) =>
            commit(ops.emptyPattern(info, measures, timeSignature, tempoBpm)),
          toggleNote: (rowId, step) => edit((p) => ops.toggleNote(p, rowId, step)),
          setVelocity: (rowId, step, velocity) =>
            edit((p) => ops.setVelocity(p, rowId, step, velocity)),
          resizeNote: (rowId, step, len) =>
            edit((p) => ops.resizeNote(p, rowId, step, len)),
          setMeasures: (measures) => edit((p) => ops.setMeasures(p, measures)),
          setTempo: (tempo) => edit((p) => ops.setTempo(p, tempo)),
          setSwing: (swing) => edit((p) => ops.setSwing(p, swing)),
          clear: () => edit(ops.clearNotes),
          setPrompt: (prompt) => set({ prompt }),
          undo: () =>
            set((s) => {
              const previous = s.past[s.past.length - 1];
              if (!previous || !s.pattern) return s;
              return {
                pattern: previous,
                past: s.past.slice(0, -1),
                future: [s.pattern, ...s.future],
              };
            }),
          redo: () =>
            set((s) => {
              const [next, ...rest] = s.future;
              if (!next || !s.pattern) return s;
              return {
                pattern: next,
                past: [...s.past, s.pattern],
                future: rest,
              };
            }),
        };
      },
      {
        name: storageKey(instrument),
        storage: createJSONStorage(() => localStorage),
        // History is dropped so a reload never restores stale undo steps.
        partialize: (s) => ({ pattern: s.pattern, prompt: s.prompt }),
      },
    ),
  );
}

const stores = new Map<string, PatternStore>();

// One store per instrument keeps each instrument's work and storage key independent.
export function getPatternStore(instrument: string): PatternStore {
  let store = stores.get(instrument);
  if (!store) {
    store = createPatternStore(instrument);
    stores.set(instrument, store);
  }
  return store;
}

export function usePatternStore<T>(
  instrument: string,
  selector: (state: PatternState) => T,
): T {
  return useStore(getPatternStore(instrument), selector);
}
