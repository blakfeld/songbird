import { useStore } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { MeasureCount } from "@/generated/MeasureCount";
import type { Note } from "@/generated/Note";
import type { Pattern } from "@/generated/Pattern";
import type { TimeSignature } from "@/generated/TimeSignature";
import { requireCurrentUserId } from "./auth/currentUser";
import { clampLoop, defaultLoop, parseLoop, type LoopSetting } from "./loopRegion";
import * as ops from "./patternOps";

// Bounded so a long editing session cannot grow memory without limit.
const HISTORY_LIMIT = 100;

export const storageKey = (instrument: string, userId: string) =>
  `songbird.patterns.${userId}.${instrument}.v1`;

export interface PatternState {
  pattern: Pattern | null;
  // Bumped only when a whole pattern is loaded, so views can react to loads without reacting to edits.
  loadId: number;
  prompt: string;
  // Kept beside the pattern rather than in it so it stays out of undo history.
  loop: LoopSetting;
  past: Pattern[];
  future: Pattern[];
  // Set only while a drag is in flight, so the whole drag lands as one undo step.
  gestureBase: Pattern | null;
  gestureFuture: Pattern[] | null;

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
  editNotes: (
    fn: (grid: ops.NoteGrid) => Note[],
    options?: { transient?: boolean },
  ) => void;
  beginGesture: () => void;
  commitGesture: () => void;
  // A cancelled drag must neither spend an undo step nor wipe redo, so it restores rather than commits.
  cancelGesture: () => void;
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

export function createPatternStore(
  instrument: string,
  userId: string = requireCurrentUserId(),
): PatternStore {
  return createStore<PatternState>()(
    persist(
      (set, get) => {
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
                  gestureBase: null,
                  gestureFuture: null,
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
              // An edit during a drag folds into it, so history gets the pre-drag pattern, not a mid-drag preview.
              past: [...s.past, s.gestureBase ?? s.pattern].slice(-HISTORY_LIMIT),
              future: [],
              gestureBase: null,
              gestureFuture: null,
            };
          });

        return {
          pattern: null,
          loadId: 0,
          prompt: "",
          loop: defaultLoop(),
          past: [],
          future: [],
          gestureBase: null,
          gestureFuture: null,

          setPattern: commit,
          newEmptyPattern: (info, measures, timeSignature, tempoBpm) =>
            commit(ops.emptyPattern(info, measures, timeSignature, tempoBpm)),
          toggleNote: (rowId, step, defaultLength) =>
            edit((p) => ops.toggleNote(p, rowId, step, defaultLength)),
          setVelocity: (rowId, step, velocity) =>
            edit((p) => ops.setVelocity(p, rowId, step, velocity)),
          resizeNote: (rowId, step, len) =>
            edit((p) => ops.resizeNote(p, rowId, step, len)),
          editNotes: (fn, options) => {
            if (!options?.transient) {
              return edit((p) => {
                const notes = fn(ops.gridOf(p));
                return notes === p.notes ? p : { ...p, notes };
              });
            }
            set((s) => {
              if (!s.pattern) return s;
              // Replaying on the pre-gesture pattern lets a drag that returns to its start restore the original,
              // which is what keeps a no-op drag out of history.
              const base = s.gestureBase ?? s.pattern;
              const notes = fn(ops.gridOf(base));
              const next = notes === base.notes ? base : { ...base, notes };
              if (next === s.pattern) return s;
              return {
                pattern: next,
                gestureBase: base,
                gestureFuture: s.gestureBase ? s.gestureFuture : s.future,
                future: [],
              };
            });
          },
          beginGesture: () =>
            set((s) =>
              s.pattern && !s.gestureBase
                ? { gestureBase: s.pattern, gestureFuture: s.future }
                : s,
            ),
          commitGesture: () =>
            set((s) => {
              if (!s.gestureBase) return s;
              if (s.gestureBase === s.pattern) return { gestureBase: null, gestureFuture: null };
              return {
                past: [...s.past, s.gestureBase].slice(-HISTORY_LIMIT),
                gestureBase: null,
                gestureFuture: null,
              };
            }),
          cancelGesture: () =>
            set((s) =>
              s.gestureBase
                ? {
                    pattern: s.gestureBase,
                    future: s.gestureFuture ?? s.future,
                    gestureBase: null,
                    gestureFuture: null,
                  }
                : s,
            ),
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
          undo: () => {
            get().commitGesture();
            set((s) => {
              const previous = s.past[s.past.length - 1];
              if (!previous || !s.pattern) return s;
              return {
                pattern: previous,
                loop: loopFor(s, previous),
                past: s.past.slice(0, -1),
                future: [s.pattern, ...s.future],
              };
            });
          },
          redo: () => {
            get().commitGesture();
            set((s) => {
              const [next, ...rest] = s.future;
              if (!next || !s.pattern) return s;
              return {
                pattern: next,
                loop: loopFor(s, next),
                past: [...s.past, s.pattern],
                future: rest,
              };
            });
          },
        };
      },
      {
        name: storageKey(instrument, userId),
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

// One store per user and instrument keeps each one's work and storage key independent, and a
// different user never reuses a store that already holds the previous user's pattern in memory.
export function getPatternStore(instrument: string): PatternStore {
  const userId = requireCurrentUserId();
  const cacheKey = `${userId}/${instrument}`;
  let store = stores.get(cacheKey);
  if (!store) {
    store = createPatternStore(instrument, userId);
    stores.set(cacheKey, store);
  }
  return store;
}

export function usePatternStore<T>(
  instrument: string,
  selector: (state: PatternState) => T,
): T {
  return useStore(getPatternStore(instrument), selector);
}
