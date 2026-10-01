import "fake-indexeddb/auto";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clear, get, set } from "idb-keyval";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyPattern } from "@/lib/patternOps";
import { createSongLibrary, INDEX_KEY, type SongIndexEntry, type SongLibrary } from "@/lib/song/songLibrary";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { newSong, newTrack } from "@/lib/song/types";
import { drums, note, patternWith, trackWithNotes } from "@/test/fixtures";
import { SendToSongButton } from "./SendToSongButton";

let library: SongLibrary;

beforeEach(async () => {
  localStorage.clear();
  await clear();
  library = createSongLibrary();
});

async function openDialog(pattern = patternWith([note("kick", 0), note("snare", 4)], { name: "Boom Bap", tempo_bpm: 90, swing: 0.2 })) {
  render(<SendToSongButton pattern={pattern} library={library} />);
  await userEvent.click(screen.getByRole("button", { name: "Send to song…" }));
  return screen.findByRole("dialog", { name: 'Send "Boom Bap" to a song' });
}

describe("send to song", () => {
  it("creates a new song with the pattern's tempo, swing and meter and a single track", async () => {
    const dialog = await openDialog();
    expect(within(dialog).getByRole("radio", { name: /New song/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    expect(await within(dialog).findByText(/Added "Boom Bap" to "Boom Bap" as track 1\./)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open in Studio" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/studio\?song=.+/),
    );
    const [entry] = await library.list();
    const song = (await library.peek(entry.id))!;
    expect(song).toMatchObject({ tempo_bpm: 90, swing: 0.2, time_signature: "4/4", measures: 4 });
    expect(song.tracks).toHaveLength(1);
    expect(song.tracks[0]).toMatchObject({ name: "Boom Bap", instrument: "drums" });
    expect(song.tracks[0].loops).toMatchObject([{ name: "Boom Bap", measures: 4, notes: [note("kick", 0), note("snare", 4)] }]);
    expect(song.tracks[0].clips).toMatchObject([{ start_measure: 1, measures: 4 }]);
  });

  it("does not offer songs with a different time signature", async () => {
    await library.create({ ...newSong("4/4"), name: "Four" });
    await library.create({ ...newSong("3/4"), name: "Three" });
    const dialog = await openDialog(patternWith([], { name: "Boom Bap", time_signature: "3/4", steps_per_measure: 12 }));
    expect(await within(dialog).findByRole("radio", { name: /Three/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio", { name: /Four/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /New song/ })).toBeInTheDocument();
  });

  it("lengthens a shorter song to the pattern's length and leaves the pattern alone", async () => {
    const existing = { ...newSongWithTracks(), name: "Demo" };
    existing.tracks[0] = trackWithNotes(existing.tracks[0], [note("kick", 0)], 8);
    await library.create(existing);
    const pattern = { ...emptyPattern(drums, 16), name: "Boom Bap", notes: [note("kick", 200)] };
    const before = structuredClone(pattern);
    const dialog = await openDialog(pattern);

    await userEvent.click(await within(dialog).findByRole("radio", { name: /Demo/ }));
    expect(await within(dialog).findByText('"Demo" will be lengthened from 8 to 16 bars.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    await within(dialog).findByText(/as track 3\./);

    const saved = (await library.peek(existing.id))!;
    expect(saved.measures).toBe(16);
    expect(saved.tracks).toHaveLength(3);
    expect(saved.tracks[0].loops[0].notes).toEqual([note("kick", 0)]);
    expect(saved.tracks[2].loops[0].notes).toEqual([note("kick", 200)]);
    expect(saved.tracks[2].clips).toMatchObject([{ start_measure: 1, measures: 16 }]);
    expect(pattern).toEqual(before);
  });

  it("greys out a song with 16 tracks, also when the index has no track count", async () => {
    const full = { ...newSong(), name: "Full" };
    full.tracks = Array.from({ length: 16 }, (_, i) => newTrack("piano", `P${i}`));
    await library.create(full);
    await library.create({ ...newSong(), name: "Roomy" });
    const index = (await get(INDEX_KEY)) as SongIndexEntry[];
    await set(INDEX_KEY, index.map((e) => {
      const legacy: Partial<SongIndexEntry> = { ...e };
      delete legacy.track_count;
      return legacy;
    }));

    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /Full/ })).toBeDisabled());
    expect(within(dialog).getByText("Full: 16 tracks")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Roomy/ })).toBeEnabled();
  });
});
