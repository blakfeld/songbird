import { createTakeState, type TakeState } from "../song/clipOps";
import type { Song } from "../song/types";
import type { SongStore } from "../song/songStore";
import type { TakeTarget } from "./take";

// The track is fixed by the caller at take start, so selecting another track mid-take cannot move the take.
export function createSongTake(store: SongStore, trackId: string): TakeTarget {
  let state: TakeState = createTakeState();
  let recorded = 0;
  // Compared by identity because another gesture can replace ours, and replaying on its base would wipe the take.
  let myBase: Song | null = null;

  const startGesture = () => {
    store.getState().beginGesture();
    myBase = store.getState().gestureBase;
  };

  return {
    begin: () => {
      state = createTakeState();
      recorded = 0;
      startGesture();
    },
    add: (note) => {
      // An edit commits the gesture and a drag replaces it; either way the rest of the take needs its own.
      // The take state survives, since it validates the clips it remembers and keeps a loop pass to one clip.
      if (!myBase || store.getState().gestureBase !== myBase) startGesture();
      store.getState().recordNotes(trackId, [note], state);
      recorded++;
    },
    end: () => {
      store.getState().endGesture();
      myBase = null;
      const dropped = Object.values(state.dropped).reduce((a, b) => a + b, 0);
      return { recorded: recorded - dropped, dropped: state.dropped };
    },
    discard: () => {
      store.getState().cancelGesture();
      myBase = null;
    },
  };
}
