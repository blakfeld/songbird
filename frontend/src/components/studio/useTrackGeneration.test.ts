import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createSongStore } from "@/lib/song/songStore";
import { newSong } from "@/lib/song/types";
import { note } from "@/test/fixtures";
import { useTrackGeneration } from "./useTrackGeneration";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  generateTrack: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe("a generation that outlives its song", () => {
  it("is dropped, and does not release the lock of a generation started on the next song", async () => {
    const first = newSong();
    const second = newSong();
    const store = createSongStore(first);
    let resolve!: (r: Awaited<ReturnType<typeof api.generateTrack>>) => void;
    vi.mocked(api.generateTrack).mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useTrackGeneration(store, vi.fn(), (edit) => edit()));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.submit(first.tracks[0].id, { prompt: "p" });
    });
    expect(store.getState().generatingTrackId).toBe(first.tracks[0].id);

    store.getState().loadSong(second);
    expect(store.getState().beginGenerating(second.tracks[1].id)).toBe(true);

    await act(async () => {
      resolve({ track_id: first.tracks[0].id, range: { start_measure: 1, end_measure: 2 }, notes: [note("kick", 0)] });
      await pending;
    });

    expect(store.getState().song).toBe(second);
    expect(store.getState().generatingTrackId).toBe(second.tracks[1].id);
    expect(result.current.dialog).toBeNull();
  });
});
