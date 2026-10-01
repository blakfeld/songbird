import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChatEntry } from "@/generated/ChatEntry";
import type { ChatResponse } from "@/generated/ChatResponse";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Note } from "@/generated/Note";
import type { Pattern } from "@/generated/Pattern";
import type { Row } from "@/generated/Row";
import type { TimeSignature } from "@/generated/TimeSignature";
import type { NoteGrid } from "../patternOps";
import { clampLoop, type LoopSetting } from "../loopRegion";
import * as clipOps from "./clipOps";
import type { ClipFailure, ClipOpResult } from "./clipOps";
import * as ops from "./songOps";
import { songLoop, withLiveChat, withLiveLoop, withLoopSetting, withSongLoop } from "./songLoop";
import { MAX_CLIPS, MAX_LOOPS, MAX_TRACKS, type Song, type SongKey } from "./types";

// Bounded so a long editing session cannot grow memory without limit.
const HISTORY_LIMIT = 100;

export interface SongState {
  song: Song | null;
  // Selection is deliberately outside history so switching tracks never becomes an undo step.
  selectedTrackId: string | null;
  // Selecting a clip also selects its track, so the dock never shows a clip from another track.
  selectedClipId: string | null;
  past: Song[];
  future: Song[];
  // A drag commits one history entry, so the pre-drag song is kept to become that entry.
  gestureBase: Song | null;
  // Kept with the base because starting an edit clears redo, and a cancelled drag must give it back.
  gestureFuture: Song[] | null;
  // The live region as it was when the drag began; previews clamp from it so a transient shrink is never permanent.
  gestureLoop: LoopSetting | null;
  // While a generate is in flight its target track is locked and no other generate may start.
  generatingTrackId: string | null;
  generationToken: number | null;
  // Bumped on every load so an in-flight response can tell it was requested for a song that is no longer open.
  loadEpoch: number;

  loadSong: (song: Song) => void;
  selectTrack: (trackId: string) => void;
  selectClip: (clipId: string | null) => void;
  addTrack: (instrument: Pick<InstrumentInfo, "id" | "name">, name?: string) => void;
  deleteTrack: (trackId: string) => void;
  renameTrack: (trackId: string, name: string) => void;
  editLoopNotes: (
    trackId: string,
    loopId: string,
    rows: Row[],
    edit: (grid: NoteGrid) => Note[],
    options?: { transient?: boolean },
  ) => void;
  // Clip and loop actions return the reason an op was refused, or null on success, so the UI can say why.
  newClip: (trackId: string, measure: number) => ClipFailure | null;
  placeLoop: (
    trackId: string,
    loopId: string,
    measure: number,
    measures?: number,
  ) => ClipFailure | null;
  duplicateClip: (trackId: string, clipId: string) => ClipFailure | null;
  moveClip: (
    trackId: string,
    clipId: string,
    toStart: number,
    options?: { transient?: boolean },
  ) => ClipFailure | null;
  resizeClip: (
    trackId: string,
    clipId: string,
    measures: number,
    options?: { transient?: boolean },
  ) => ClipFailure | null;
  deleteClip: (trackId: string, clipId: string) => ClipFailure | null;
  makeUnique: (trackId: string, clipId: string) => ClipFailure | null;
  renameLoop: (trackId: string, loopId: string, name: string) => ClipFailure | null;
  deleteLoop: (trackId: string, loopId: string) => ClipFailure | null;
  // Returns false when another generate already holds the lock, so a double submit cannot start twice.
  beginGenerating: (trackId: string) => boolean;
  // A caller passes the token it began with, so a request that outlived its song cannot release a newer lock.
  endGenerating: (token?: number | null) => void;
  // The refusal is user-facing because the result has already been paid for and the user needs to know why it is lost.
  applyGeneratedRange: (
    trackId: string,
    range: { start_measure: number; end_measure: number },
    notes: Note[],
  ) => string | null;
  // A reply with no track is recorded but is not an undo step, because it changes no arrangement and undo
  // would otherwise swallow a conversation turn.
  applyChatResult: (userMessage: string, response: ChatResponse) => string | null;
  // Transient and applied to the current song, not the gesture base: each call builds on what the take already wrote.
  recordNotes: (trackId: string, notes: Note[], takeState: clipOps.TakeState) => void;
  setMixer: (
    trackId: string,
    patch: ops.MixerPatch,
    options?: { transient?: boolean },
  ) => void;
  beginGesture: () => void;
  endGesture: () => void;
  // A cancelled drag must neither spend an undo step nor wipe redo, so it restores rather than commits.
  cancelGesture: () => void;
  // Not an undo step: the region is a view setting, so undoing an edit must never move it.
  setLoop: (loop: LoopSetting) => void;
  setTempo: (tempoBpm: number) => void;
  setSwing: (swing: number) => void;
  renameSong: (name: string) => void;
  // Both are one undo step each; the UI asks for confirmation first when a meter change would drop notes.
  setTimeSignature: (ts: TimeSignature) => void;
  setKey: (key: SongKey) => void;
  addTrackFromPattern: (pattern: Pattern) => void;
  undo: () => void;
  redo: () => void;
}

const GENERATE_FAILURES: Record<ClipFailure, (track: string) => string> = {
  "clip-limit": (t) => `${t} already has ${MAX_CLIPS} clips, the most a track can hold. Delete some clips and try again.`,
  "loop-limit": (t) => `${t} already has ${MAX_LOOPS} loops, the most a track can hold. Delete an unused loop and try again.`,
  "not-found": () => "That track is no longer in the song.",
  "no-room": () => "There is no room for the generated part.",
  "not-shared": () => "That track is no longer in the song.",
  generating: (t) => `${t} is already being generated.`,
};

export type SongStore = StoreApi<SongState>;

export const CHAT_LIMIT = 20;
// Matches the server's cap on a history entry, so a long reply can never make later requests invalid.
const clipChat = (text: string) => [...text].slice(0, 4000).join("");

const push = (past: Song[], song: Song) => [...past, song].slice(-HISTORY_LIMIT);

// Undo or delete can remove the selected track or clip, so selection falls back rather than dangling.
const validSelection = (
  song: Song,
  trackId: string | null,
  clipId: string | null,
) => {
  const track = song.tracks.find((t) => t.id === trackId) ?? song.tracks[0];
  const clip =
    track?.id === trackId && clipId
      ? track.clips.find((c) => c.id === clipId)
      : undefined;
  return {
    selectedTrackId: track?.id ?? null,
    selectedClipId: clip?.id ?? null,
  };
};

// Clips are sorted, so the first one is the earliest.
const initialSelection = (song: Song | null) => ({
  selectedTrackId: song?.tracks[0]?.id ?? null,
  selectedClipId: song?.tracks[0]?.clips[0]?.id ?? null,
});

export function createSongStore(initial: Song | null = null): SongStore {
  return createStore<SongState>()((set, get) => {
    let lastToken = 0;
    const edit = (fn: (s: Song) => Song) =>
      set((s) => {
        if (!s.song) return s;
        const changed = fn(s.song);
        if (changed === s.song) return s;
        // Backstop for ops that forget to keep the stored length and region in step with the clips.
        const next = ops.normalizeSong(changed);
        return {
          song: next,
          ...validSelection(next, s.selectedTrackId, s.selectedClipId),
          past: push(s.past, s.gestureBase ?? s.song),
          future: [],
          gestureBase: null,
          gestureFuture: null,
          gestureLoop: null,
        };
      });

    // Transient runs skip history so a drag can update the song on every pointer move.
    const run = (
      fn: (song: Song) => ClipOpResult,
      trackId: string,
      options: { transient?: boolean; select?: boolean; allowLocked?: boolean } = {},
    ): ClipFailure | null => {
      // The generate result is the one writer the lock exists for; every other edit would be overwritten by it.
      if (!options.allowLocked && get().generatingTrackId === trackId) return "generating";
      const current = get().song;
      if (!current) return "not-found";
      // Transient ops are absolute targets, so replaying them on the pre-gesture song lets a
      // shrink-then-regrow drag bring back notes the shrink dropped.
      const base = options.transient ? get().gestureBase : null;
      const song = base ?? current;
      const result = fn(song);
      if (result.song === null) return result.reason;
      const gestureLoop = base ? get().gestureLoop : null;
      const next = base ? withLoopSetting(result.song, gestureLoop ?? songLoop(current)) : result.song;
      if (options.transient) {
        set((s) => {
          if (!s.song || next === s.song) return s;
          return {
            song: next,
            gestureBase: s.gestureBase ?? s.song,
            gestureFuture: s.gestureBase ? s.gestureFuture : s.future,
            gestureLoop: s.gestureBase ? s.gestureLoop : songLoop(s.song),
            future: [],
          };
        });
      } else {
        edit(() => next);
      }
      if (options.select && result.clipId)
        set({ selectedTrackId: trackId, selectedClipId: result.clipId });
      return null;
    };

    return {
      song: initial,
      ...initialSelection(initial),
      past: [],
      future: [],
      gestureBase: null,
      gestureFuture: null,
      gestureLoop: null,
      generatingTrackId: null,
      generationToken: null,
      loadEpoch: 0,

      loadSong: (song) =>
        set((s) => ({
          song,
          generatingTrackId: null,
          generationToken: null,
          loadEpoch: s.loadEpoch + 1,
          ...initialSelection(song),
          past: [],
          future: [],
          gestureBase: null,
          gestureFuture: null,
          gestureLoop: null,
        })),
      selectTrack: (trackId) =>
        set((s) => {
          const track = s.song?.tracks.find((t) => t.id === trackId);
          if (!track) return s;
          // Re-selecting the current track keeps its selected clip so a header click never loses the user's place.
          if (s.selectedTrackId === trackId && s.selectedClipId) return s;
          const clipId = track.clips[0]?.id ?? null;
          return s.selectedTrackId === trackId && s.selectedClipId === clipId
            ? s
            : { selectedTrackId: trackId, selectedClipId: clipId };
        }),
      selectClip: (clipId) =>
        set((s) => {
          if (clipId === null)
            return s.selectedClipId === null ? s : { selectedClipId: null };
          const track = s.song?.tracks.find((t) =>
            t.clips.some((c) => c.id === clipId),
          );
          if (!track) return s;
          return s.selectedTrackId === track.id && s.selectedClipId === clipId
            ? s
            : { selectedTrackId: track.id, selectedClipId: clipId };
        }),
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
      editLoopNotes: (trackId, loopId, rows, fn, options) => {
        if (get().generatingTrackId === trackId) return;
        const apply = (s: Song) => {
          const loop = s.tracks
            .find((t) => t.id === trackId)
            ?.loops.find((l) => l.id === loopId);
          if (!loop) return s;
          return clipOps.editLoopNotes(
            s,
            trackId,
            loopId,
            fn(clipOps.loopGrid(loop, rows, s.steps_per_measure)),
          );
        };
        if (!options?.transient) return edit(apply);
        set((s) => {
          if (!s.song) return s;
          // Replaying on the pre-gesture song lets a drag that returns to its start restore the original song,
          // which is what keeps a no-op drag out of history.
          const base = s.gestureBase;
          const applied = apply(base ?? s.song);
          const next = base ? withLoopSetting(applied, s.gestureLoop ?? songLoop(s.song)) : applied;
          if (next === s.song) return s;
          return {
            song: next,
            gestureBase: base ?? s.song,
            gestureFuture: base ? s.gestureFuture : s.future,
            gestureLoop: base ? s.gestureLoop : songLoop(s.song),
            future: [],
          };
        });
      },
      newClip: (trackId, measure) =>
        run((s) => clipOps.newClip(s, trackId, measure), trackId, { select: true }),
      placeLoop: (trackId, loopId, measure, measures) =>
        run((s) => clipOps.placeLoop(s, trackId, loopId, measure, measures), trackId, {
          select: true,
        }),
      duplicateClip: (trackId, clipId) =>
        run((s) => clipOps.duplicateClip(s, trackId, clipId), trackId, {
          select: true,
        }),
      moveClip: (trackId, clipId, toStart, options) =>
        run((s) => clipOps.moveClip(s, trackId, clipId, toStart), trackId, options),
      resizeClip: (trackId, clipId, measures, options) =>
        run((s) => clipOps.resizeClip(s, trackId, clipId, measures), trackId, options),
      deleteClip: (trackId, clipId) =>
        run((s) => clipOps.deleteClip(s, trackId, clipId), trackId),
      makeUnique: (trackId, clipId) =>
        run((s) => clipOps.makeUnique(s, trackId, clipId), trackId),
      renameLoop: (trackId, loopId, name) =>
        run((s) => clipOps.renameLoop(s, trackId, loopId, name), trackId),
      deleteLoop: (trackId, loopId) =>
        run((s) => clipOps.deleteLoop(s, trackId, loopId), trackId),
      beginGenerating: (trackId) => {
        const s = get();
        if (s.generatingTrackId !== null || !s.song?.tracks.some((t) => t.id === trackId))
          return false;
        set({ generatingTrackId: trackId, generationToken: ++lastToken });
        return true;
      },
      endGenerating: (token) =>
        set((s) =>
          token !== undefined && token !== s.generationToken
            ? s
            : { generatingTrackId: null, generationToken: null },
        ),
      applyGeneratedRange: (trackId, range, notes) => {
        const track = get().song?.tracks.find((t) => t.id === trackId);
        const reason = run((s) => clipOps.applyGeneratedRange(s, trackId, range, notes), trackId, {
          select: true,
          allowLocked: true,
        });
        return reason === null ? null : GENERATE_FAILURES[reason](track?.name ?? "That track");
      },
      applyChatResult: (userMessage, response) => {
        const current = get().song;
        if (!current) return "There is no song open.";
        const added = response.track ? ops.addChatTrack(current, response.track) : null;
        if (response.track && !added)
          return `The song already has ${MAX_TRACKS} tracks, the most it can hold.`;
        const entries: ChatEntry[] = [
          { role: "user", content: clipChat(userMessage) },
          {
            role: "assistant",
            content: clipChat(response.reply),
            ...(added && { track_id: added.trackId }),
          },
        ];
        const chat = [...(current.chat ?? []), ...entries].slice(-CHAT_LIMIT);
        if (!added) {
          set({ song: { ...current, chat } });
          return null;
        }
        edit(() => ({ ...added.song, chat }));
        const track = get().song?.tracks.find((t) => t.id === added.trackId);
        if (track) set({ selectedTrackId: track.id, selectedClipId: track.clips[0]?.id ?? null });
        return null;
      },
      recordNotes: (trackId, notes, takeState) =>
        set((s) => {
          if (!s.song || s.generatingTrackId === trackId) return s;
          const result = clipOps.recordNotes(s.song, trackId, notes, takeState);
          if (result.song === null || result.song === s.song) return s;
          return {
            song: result.song,
            gestureBase: s.gestureBase ?? s.song,
            gestureFuture: s.gestureBase ? s.gestureFuture : s.future,
            gestureLoop: s.gestureBase ? s.gestureLoop : songLoop(s.song),
            future: [],
          };
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
            gestureFuture: s.gestureBase ? s.gestureFuture : s.future,
            gestureLoop: s.gestureBase ? s.gestureLoop : songLoop(s.song),
            future: [],
          };
        });
      },
      beginGesture: () =>
        set((s) =>
          s.song && !s.gestureBase
            ? { gestureBase: s.song, gestureFuture: s.future, gestureLoop: songLoop(s.song) }
            : s,
        ),
      endGesture: () =>
        set((s) => {
          if (!s.gestureBase) return s;
          if (s.gestureBase === s.song)
            return { gestureBase: null, gestureFuture: null, gestureLoop: null };
          return { past: push(s.past, s.gestureBase), gestureBase: null, gestureFuture: null, gestureLoop: null };
        }),
      cancelGesture: () =>
        set((s) =>
          s.gestureBase
            ? {
                song: withLiveChat(withLoopSetting(s.gestureBase, s.gestureLoop ?? songLoop(s.song!)), s.song!),
                ...validSelection(s.gestureBase, s.selectedTrackId, s.selectedClipId),
                future: s.gestureFuture ?? s.future,
                gestureBase: null,
                gestureFuture: null,
                gestureLoop: null,
              }
            : s,
        ),
      setLoop: (loop) =>
        set((s) => {
          if (!s.song) return s;
          const next = withSongLoop(s.song, clampLoop(loop, ops.timelineMeasures(s.song)));
          // A region set mid-drag is the user's newest intent, so later previews must clamp from it.
          const gestureLoop = s.gestureBase
            ? clampLoop(loop, ops.timelineMeasures(s.gestureBase))
            : s.gestureLoop;
          return next === s.song && gestureLoop === s.gestureLoop ? s : { song: next, gestureLoop };
        }),
      setTempo: (t) => edit((s) => ops.setTempo(s, t)),
      setSwing: (w) => edit((s) => ops.setSwing(s, w)),
      renameSong: (name) => edit((s) => ops.renameSong(s, name)),
      setTimeSignature: (ts) => edit((s) => ops.setTimeSignature(s, ts)),
      setKey: (key) => edit((s) => ops.setKey(s, key)),
      addTrackFromPattern: (p) => edit((s) => ops.addTrackFromPattern(s, p)),
      undo: () => {
        get().endGesture();
        set((s) => {
          const previous = s.past[s.past.length - 1];
          if (!previous || !s.song) return s;
          const song = withLiveChat(withLiveLoop(previous, s.song), s.song);
          return {
            song,
            ...validSelection(song, s.selectedTrackId, s.selectedClipId),
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
          const song = withLiveChat(withLiveLoop(next, s.song), s.song);
          return {
            song,
            ...validSelection(song, s.selectedTrackId, s.selectedClipId),
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
