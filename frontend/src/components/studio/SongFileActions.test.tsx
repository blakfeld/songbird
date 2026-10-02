import { newSongWithTracks } from "@/lib/song/testFixtures";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import * as api from "@/lib/api";
import { serializeProject } from "@/lib/song/projectFile";
import { createServerSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { type Song } from "@/lib/song/types";
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
let fake: ReturnType<typeof createFakeProjectsApi>;
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
  localStorage.clear();
  fake = createFakeProjectsApi();
  library = createServerSongLibrary(fake.api);
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
    const song = { ...newSongWithTracks(), name: "Late Train", tempo_bpm: 96 };
    renderActions(song);
    await userEvent.click(screen.getByRole("button", { name: "Download MIDI" }));
    await waitFor(() => expect(downloads).toEqual(["songbird-late-train-96bpm.mid"]));
    expect(api.exportSongMidi).toHaveBeenCalledWith(song);
  });

  it("shows the error and keeps the song when the export fails", async () => {
    vi.mocked(api.exportSongMidi).mockRejectedValue(new api.ApiError("invalid_song", "track 1 is bad", 422));
    const song = newSongWithTracks();
    const before = structuredClone(song);
    renderActions(song);
    await userEvent.click(screen.getByRole("button", { name: "Download MIDI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("track 1 is bad");
    expect(downloads).toEqual([]);
    expect(song).toEqual(before);
  });
});

describe("Download MIDI with no tracks", () => {
  it("is disabled while project download stays available", () => {
    renderActions({ ...newSongWithTracks(), tracks: [] });
    expect(screen.getByRole("button", { name: "Download MIDI" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download project" })).toBeEnabled();
  });
});

describe("Download project", () => {
  it("saves the song as <slug>.songbird.json", async () => {
    renderActions({ ...newSongWithTracks(), name: "Late Train" });
    await userEvent.click(screen.getByRole("button", { name: "Download project" }));
    expect(downloads).toEqual(["late-train.songbird.json"]);
  });
});

describe("Open project", () => {
  const choose = (file: File) => userEvent.upload(screen.getByLabelText("Project file"), file);

  it("adds the song to the library and opens it", async () => {
    renderActions(newSongWithTracks());
    const incoming = { ...newSongWithTracks(), name: "Imported" };
    await choose(projectFile(incoming));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: incoming.id })));
    expect((await library.list()).map((e) => e.name)).toEqual(["Imported"]);
  });

  it("shows the reason and leaves the library unchanged for a bad file", async () => {
    renderActions(newSongWithTracks());
    await choose(new File(["{nope"], "bad.songbird.json"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't valid JSON/);
    expect(await library.list()).toEqual([]);
    expect(onImported).not.toHaveBeenCalled();
  });

  it("shows an error and opens nothing when saving the import throws", async () => {
    renderActions(newSongWithTracks());
    vi.spyOn(library, "create").mockRejectedValue(new Error("disk"));
    await choose(projectFile({ ...newSongWithTracks(), name: "Imported" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't open that project/);
    expect(onImported).not.toHaveBeenCalled();
    expect(await library.list()).toEqual([]);
  });
});

// The default fake keeps client ids for seeding; these use the real server's rule that it picks the id.
describe("Open project against a server that assigns ids", () => {
  const choose = (file: File) => userEvent.upload(screen.getByLabelText("Project file"), file);

  beforeEach(() => {
    fake = createFakeProjectsApi({ assignIds: true });
    library = createServerSongLibrary(fake.api);
  });

  it("keeps both songs when the file's id is already in the library", async () => {
    const existing = await library.create({ ...newSongWithTracks(), name: "Existing" });
    renderActions(existing);
    await choose(projectFile({ ...existing, name: "Imported" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    const imported = onImported.mock.calls[0][0] as Song;
    expect(imported.id).not.toBe(existing.id);
    expect((await library.list()).map((e) => e.name).sort()).toEqual(["Existing", "Imported"]);
    expect((fake.stored(existing.id)!.song as Song).name).toBe("Existing");
  });

  it("never reuses the id inside the file", async () => {
    renderActions(newSongWithTracks());
    const incoming = { ...newSongWithTracks(), name: "Imported" };
    await choose(projectFile(incoming));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect((onImported.mock.calls[0][0] as Song).id).not.toBe(incoming.id);
  });

  it("shows the server's reason and leaves the library unchanged when the server refuses the song", async () => {
    renderActions(newSongWithTracks());
    fake.control.refuseCreate = "track 2 overlaps itself";
    await choose(projectFile({ ...newSongWithTracks(), name: "Imported" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("track 2 overlaps itself");
    expect(onImported).not.toHaveBeenCalled();
    expect(await library.list()).toEqual([]);
    expect(library.status.getState().ok).toBe(true);
  });
});
