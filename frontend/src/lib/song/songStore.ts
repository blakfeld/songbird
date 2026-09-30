import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Note } from "@/generated/Note";
import type { Pattern } from "@/generated/Pattern";
import type { Row } from "@/generated/Row";
import type { NoteGrid } from "../patternOps";
import * as ops from "./songOps";
import type { Song } from "./types";

// Bounded so a long editing session cannot grow memory without limit.
const HISTORY_LIMIT = 100;

export interface SongState {
  song: Song | null;
  // Selection is deliberately outside history so switching tracks never becomes an undo step.
  selectedTrackId: string | null;
  past: Song[];
  future: Song[];
  // A drag commits one history entry, so the pre-drag song is kept to become that entry.
  gestureBase: Song | null;

  loadSong: (song: Song) => void;
  selectTrack: (trackId: string) => void;
  addTrack: (instrument: Pick<InstrumentInfo, "id" | "name">, name?: string) => void;
  deleteTrack: (trackId: string) => void;
  renameTrack: (trackId: string, name: string) => void;
  editTrackNotes: (
    trackId: string,
    rows: Row[],
    edit: (grid: NoteGrid) => Note[],
  ) => void;
  setMixer: (
    trackId: string,
    patch: ops.MixerPatch,
    options?: { transient?: boolean },
  ) => void;
  beginGesture: () => void;
  endGesture: () => void;
  setSongLength: (measures: number) => void;
  setTempo: (tempoBpm: number) => void;
  setSwing: (swing: number) => void;
  renameSong: (name: string) => void;
  addTrackFromPattern: (pattern: Pattern) => void;
  undo: () => void;
  redo: () => void;
}

export type SongStore = StoreApi<SongState>;

const push = (past: Song[], song: Song) => [...past, song].slice(-HISTORY_LIMIT);

// Undo or delete can remove the selected track, so selection falls back rather than dangling.
const validSelection = (song: Song, selected: string | null) =>
  selected && song.tracks.some((t) => t.id === selected)
    ? selected
    : (song.tracks[0]?.id ?? null);

export function createSongStore(initial: Song | null = null): SongStore {
  return createStore<SongState>()((set, get) => {
    const edit = (fn: (s: Song) => Song) =>
      set((s) => {
        if (!s.song) return s;
        const next = fn(s.song);
        if (next === s.song) return s;
        return {
          song: next,
          selectedTrackId: validSelection(next, s.selectedTrackId),
          past: push(s.past, s.gestureBase ?? s.song),
          future: [],
          gestureBase: null,
        };
      });

    return {
      song: initial,
      selectedTrackId: initial?.tracks[0]?.id ?? null,
      past: [],
      future: [],
      gestureBase: null,

      loadSong: (song) =>
        set({
          song,
          selectedTrackId: song.tracks[0]?.id ?? null,
          past: [],
          future: [],
          gestureBase: null,
        }),
      selectTrack: (trackId) =>
        set((s) =>
          s.song?.tracks.some((t) => t.id === trackId) &&
          s.selectedTrackId !== trackId
            ? { selectedTrackId: trackId }
            : s,
        ),
      addTrack: (instrument, name) => {
        const before = get().song;
        edit((s) => ops.addTrack(s, instrument, name));
        const after = get().song;
        if (after && after !== before)
          set({ selectedTrackId: after.tracks[after.tracks.length - 1].id });
      },
      deleteTrack: (trackId) => edit((s) => ops.deleteTrack(s, trackId)),
      renameTrack: (trackId, name) =>
        edit((s) => ops.renameTrack(s, trackId, name)),
      editTrackNotes: (trackId, rows, fn) =>
        edit((s) => {
          const track = s.tracks.find((t) => t.id === trackId);
          if (!track) return s;
          return ops.editTrackNotes(
            s,
            trackId,
            fn(ops.trackGrid(s, track, rows)),
          );
        }),
      setMixer: (trackId, patch, options) => {
        if (!options?.transient) return edit((s) => ops.setMixer(s, trackId, patch));
        set((s) => {
          if (!s.song) return s;
          const next = ops.setMixer(s.song, trackId, patch);
          if (next === s.song) return s;
          return {
            song: next,
            gestureBase: s.gestureBase ?? s.song,
            future: [],
          };
        });
      },
      beginGesture: () =>
        set((s) => (s.song && !s.gestureBase ? { gestureBase: s.song } : s)),
      endGesture: () =>
        set((s) => {
          if (!s.gestureBase) return s;
          if (s.gestureBase === s.song) return { gestureBase: null };
          return { past: push(s.past, s.gestureBase), gestureBase: null };
        }),
      setSongLength: (m) => edit((s) => ops.setSongLength(s, m)),
      setTempo: (t) => edit((s) => ops.setTempo(s, t)),
      setSwing: (w) => edit((s) => ops.setSwing(s, w)),
      renameSong: (name) => edit((s) => ops.renameSong(s, name)),
      addTrackFromPattern: (p) => edit((s) => ops.addTrackFromPattern(s, p)),
      undo: () => {
        get().endGesture();
        set((s) => {
          const previous = s.past[s.past.length - 1];
          if (!previous || !s.song) return s;
          return {
            song: previous,
            selectedTrackId: validSelection(previous, s.selectedTrackId),
            past: s.past.slice(0, -1),
            future: [s.song, ...s.future],
          };
        });
      },
      redo: () => {
        get().endGesture();
        set((s) => {
          const [next, ...rest] = s.future;
          if (!next || !s.song) return s;
          return {
            song: next,
            selectedTrackId: validSelection(next, s.selectedTrackId),
            past: push(s.past, s.song),
            future: rest,
          };
        });
      },
    };
  });
}

export function useSongStore<T>(
  store: SongStore,
  selector: (state: SongState) => T,
): T {
  return useStore(store, selector);
}
