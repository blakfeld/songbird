import { useStore } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { MeasureCount } from "@/generated/MeasureCount";
import type { Pattern } from "@/generated/Pattern";
import type { TimeSignature } from "@/generated/TimeSignature";
import { clampLoop, defaultLoop, parseLoop, type LoopSetting } from "./loopRegion";
import * as ops from "./patternOps";

// Bounded so a long editing session cannot grow memory without limit.
const HISTORY_LIMIT = 100;

export const storageKey = (instrument: string) =>
  `songbird.patterns.${instrument}.v1`;

export interface PatternState {
  pattern: Pattern | null;
  // Bumped only when a whole pattern is loaded, so views can react to loads without reacting to edits.
  loadId: number;
  prompt: string;
  // Kept beside the pattern rather than in it so it stays out of undo history.
  loop: LoopSetting;
  past: Pattern[];
  future: Pattern[];

  setPattern: (pattern: Pattern) => void;
  newEmptyPattern: (
    instrument: InstrumentInfo,
    measures: MeasureCount,
    timeSignature?: TimeSignature,
    tempoBpm?: number,
  ) => void;
  toggleNote: (rowId: string, step: number, defaultLength?: number) => void;
  setVelocity: (rowId: string, step: number, velocity: number) => void;
  resizeNote: (rowId: string, step: number, lengthSteps: number) => void;
  moveNote: (rowId: string, step: number, toRowId: string) => void;
  setMeasures: (measures: MeasureCount) => void;
  setTempo: (tempoBpm: number) => void;
  setSwing: (swing: number) => void;
  clear: () => void;
  setPrompt: (prompt: string) => void;
  setLoop: (loop: LoopSetting) => void;
  undo: () => void;
  redo: () => void;
}

export type PatternStore = StoreApi<PatternState>;

// The loop has to follow every pattern swap, including undo and redo, because any of them can change the length.
const loopFor = (s: Pick<PatternState, "loop">, next: Pattern): LoopSetting =>
  clampLoop(s.loop, next.measures);

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
                  loop: loopFor(s, next),
                  loadId: s.loadId + 1,
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
              loop: loopFor(s, next),
              past: [...s.past, s.pattern].slice(-HISTORY_LIMIT),
              future: [],
            };
          });

        return {
          pattern: null,
          loadId: 0,
          prompt: "",
          loop: defaultLoop(),
          past: [],
          future: [],

          setPattern: commit,
          newEmptyPattern: (info, measures, timeSignature, tempoBpm) =>
            commit(ops.emptyPattern(info, measures, timeSignature, tempoBpm)),
          toggleNote: (rowId, step, defaultLength) =>
            edit((p) => ops.toggleNote(p, rowId, step, defaultLength)),
          setVelocity: (rowId, step, velocity) =>
            edit((p) => ops.setVelocity(p, rowId, step, velocity)),
          resizeNote: (rowId, step, len) =>
            edit((p) => ops.resizeNote(p, rowId, step, len)),
          moveNote: (rowId, step, toRowId) =>
            edit((p) => ops.moveNote(p, rowId, step, toRowId)),
          setMeasures: (measures) => edit((p) => ops.setMeasures(p, measures)),
          setTempo: (tempo) => edit((p) => ops.setTempo(p, tempo)),
          setSwing: (swing) => edit((p) => ops.setSwing(p, swing)),
          clear: () => edit(ops.clearNotes),
          setPrompt: (prompt) => set({ prompt }),
          setLoop: (loop) =>
            set((s) => {
              const m = s.pattern?.measures;
              return { loop: m === undefined ? loop : clampLoop(loop, m) };
            }),
          undo: () =>
            set((s) => {
              const previous = s.past[s.past.length - 1];
              if (!previous || !s.pattern) return s;
              return {
                pattern: previous,
                loop: loopFor(s, previous),
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
                loop: loopFor(s, next),
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
        partialize: (s) => ({
          pattern: s.pattern,
          prompt: s.prompt,
          loop: s.loop,
        }),
        // Stored state from before loops existed, or hand-edited, must never leave the store without a usable loop.
        merge: (persisted, current) => {
          const p = (persisted ?? {}) as Partial<PatternState>;
          const merged = { ...current, ...p };
          const loop = parseLoop(p.loop);
          const m = merged.pattern?.measures;
          return { ...merged, loop: m === undefined ? loop : clampLoop(loop, m) };
        },
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
