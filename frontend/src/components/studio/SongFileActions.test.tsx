import "fake-indexeddb/auto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clear } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import * as api from "@/lib/api";
import { serializeProject } from "@/lib/song/projectFile";
import {
  createSongLibrary,
  idbKeyValueStore,
  INDEX_KEY,
  songKey,
  type SongLibrary,
} from "@/lib/song/songLibrary";
import { newSong, type Song } from "@/lib/song/types";
import { drums } from "@/test/fixtures";
import { SongFileActions } from "./SongFileActions";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  exportSongMidi: vi.fn(),
}));

const piano: InstrumentInfo = {
  id: "piano",
  name: "Piano",
  kind: "melodic",
  midi_program: 1,
  range: null,
  midi_channel: 1,
  sustained: true,
  rows: [{ id: "c4", name: "C4", midi_note: 60 }],
};

let library: SongLibrary;
let downloads: string[];
const onImported = vi.fn();
const onAnnounce = vi.fn();

function renderActions(song: Song) {
  render(
    <SongFileActions
      song={song}
      library={library}
      instruments={[drums, piano]}
      onImported={onImported}
      onAnnounce={onAnnounce}
    />,
  );
}

const projectFile = (song: Song, name = "song.songbird.json") =>
  new File([serializeProject(song)], name, { type: "application/json" });

beforeEach(async () => {
  await clear();
  localStorage.clear();
  library = createSongLibrary();
  downloads = [];
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("Download MIDI", () => {
  it("saves the file under the name the server gave", async () => {
    vi.mocked(api.exportSongMidi).mockResolvedValue({
      blob: new Blob(["x"]),
      filename: "songbird-late-train-96bpm.mid",
    });
    const song = { ...newSong(), name: "Late Train", tempo_bpm: 96 };
    renderActions(song);
    await userEvent.click(screen.getByRole("button", { name: "Download MIDI" }));
    await waitFor(() => expect(downloads).toEqual(["songbird-late-train-96bpm.mid"]));
    expect(api.exportSongMidi).toHaveBeenCalledWith(song);
  });

  it("shows the error and keeps the song when the export fails", async () => {
    vi.mocked(api.exportSongMidi).mockRejectedValue(new api.ApiError("invalid_song", "track 1 is bad", 422));
    const song = newSong();
    const before = structuredClone(song);
    renderActions(song);
    await userEvent.click(screen.getByRole("button", { name: "Download MIDI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("track 1 is bad");
    expect(downloads).toEqual([]);
    expect(song).toEqual(before);
  });
});

describe("Download project", () => {
  it("saves the song as <slug>.songbird.json", async () => {
    renderActions({ ...newSong(), name: "Late Train" });
    await userEvent.click(screen.getByRole("button", { name: "Download project" }));
    expect(downloads).toEqual(["late-train.songbird.json"]);
  });
});

describe("Open project", () => {
  const choose = (file: File) => userEvent.upload(screen.getByLabelText("Project file"), file);

  it("adds the song to the library and opens it", async () => {
    renderActions(newSong());
    const incoming = { ...newSong(), name: "Imported" };
    await choose(projectFile(incoming));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: incoming.id })));
    expect((await library.list()).map((e) => e.name)).toEqual(["Imported"]);
  });

  it("keeps both songs when the id is already in the library", async () => {
    const existing = { ...newSong(), name: "Existing" };
    await library.create(existing);
    renderActions(existing);
    await choose(projectFile({ ...existing, name: "Imported" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    const imported = onImported.mock.calls[0][0] as Song;
    expect(imported.id).not.toBe(existing.id);
    expect((await library.list()).map((e) => e.name).sort()).toEqual(["Existing", "Imported"]);
  });

  it("shows the reason and leaves the library unchanged for a bad file", async () => {
    renderActions(newSong());
    await choose(new File(["{nope"], "bad.songbird.json"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't valid JSON/);
    expect(await library.list()).toEqual([]);
    expect(onImported).not.toHaveBeenCalled();
  });

  it("shows an error and opens nothing when saving the import throws", async () => {
    renderActions(newSong());
    vi.spyOn(library, "create").mockRejectedValue(new Error("disk"));
    await choose(projectFile({ ...newSong(), name: "Imported" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't open that project/);
    expect(onImported).not.toHaveBeenCalled();
    expect(await library.list()).toEqual([]);
  });

  it("does not overwrite a stored song whose index entry can't be read", async () => {
    const existing = { ...newSong(), name: "Existing" };
    await createSongLibrary().create(existing);
    const kv = idbKeyValueStore();
    const blindIndex = {
      ...kv,
      get: (key: string) => (key === INDEX_KEY ? Promise.reject(new Error("index")) : kv.get(key)),
    };
    library = createSongLibrary(blindIndex);
    renderActions(existing);
    await choose(projectFile({ ...existing, name: "Imported" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect((onImported.mock.calls[0][0] as Song).id).not.toBe(existing.id);
    expect(((await kv.get(songKey(existing.id))) as Song).name).toBe("Existing");
  });
});
