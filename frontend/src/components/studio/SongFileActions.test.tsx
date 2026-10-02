import "fake-indexeddb/auto";
import { newSongWithTracks } from "@/lib/song/testFixtures";
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
import { type Song } from "@/lib/song/types";
import { drums } from "@/test/fixtures";
import * as mixdown from "@/lib/audio/mixdown";
import * as bundle from "@/lib/song/projectBundle";
import { SongFileActions } from "./SongFileActions";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  exportSongMidi: vi.fn(),
}));

vi.mock("@/lib/audio/mixdown", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/mixdown")>()),
  renderMixdown: vi.fn(),
}));

vi.mock("@/lib/song/projectBundle", async (orig) => ({
  ...(await orig<typeof import("@/lib/song/projectBundle")>()),
  createProjectBundle: vi.fn(),
  isBundleFile: vi.fn(),
  readProjectBundle: vi.fn(),
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

describe("Download WAV", () => {
  const wav = new Blob(["RIFF"], { type: "audio/wav" });

  it("saves the mixdown as songbird-<slug>-<bpm>bpm.wav", async () => {
    vi.mocked(mixdown.renderMixdown).mockResolvedValue({ wav, clipped: false, seconds: 4 });
    const song = { ...newSongWithTracks(), name: "Late Train", tempo_bpm: 96 };
    renderActions(song);
    await userEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    await waitFor(() => expect(downloads).toEqual(["songbird-late-train-96bpm.wav"]));
    expect(mixdown.renderMixdown).toHaveBeenCalledWith(song, expect.any(Function), expect.any(AbortSignal), {
      instruments: [drums, piano],
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("falls back to a generic slug for a name with no letters", async () => {
    vi.mocked(mixdown.renderMixdown).mockResolvedValue({ wav, clipped: false, seconds: 4 });
    renderActions({ ...newSongWithTracks(), name: "!!!", tempo_bpm: 120 });
    await userEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    await waitFor(() => expect(downloads).toEqual(["songbird-song-120bpm.wav"]));
  });

  it("shows progress and lets the user cancel, with no file saved", async () => {
    vi.mocked(mixdown.renderMixdown).mockImplementation(
      (_song, onProgress, signal) =>
        new Promise((_resolve, reject) => {
          onProgress(0.4);
          signal?.addEventListener("abort", () =>
            reject(new DOMException("The render was cancelled.", "AbortError")),
          );
        }),
    );
    renderActions(newSongWithTracks());
    await userEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    expect(await screen.findByRole("progressbar", { name: "Rendering WAV" })).toHaveValue(0.4);
    await userEvent.click(screen.getByRole("button", { name: "Cancel render" }));
    expect(await screen.findByRole("button", { name: "Download WAV" })).toBeEnabled();
    expect(downloads).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onAnnounce).toHaveBeenCalledWith("WAV render cancelled.");
  });

  it("warns after the download when the mix clipped", async () => {
    vi.mocked(mixdown.renderMixdown).mockResolvedValue({ wav, clipped: true, seconds: 4 });
    renderActions(newSongWithTracks());
    await userEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/clipped/i);
    expect(downloads).toHaveLength(1);
  });

  it("shows an error when the render fails", async () => {
    vi.mocked(mixdown.renderMixdown).mockRejectedValue(new Error("boom"));
    renderActions(newSongWithTracks());
    await userEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't render the WAV");
    expect(downloads).toEqual([]);
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

describe("Download project with audio", () => {
  const withSample = (): Song => ({
    ...newSongWithTracks(),
    name: "Late Train",
    samples: [{ id: "s1", name: "Break", sample_rate: 48000, channels: 2, length_samples: 10, origin: "import" }],
  });
  const withClip = (): Song => {
    const song = withSample();
    song.tracks = [
      {
        ...song.tracks[0],
        instrument: "audio",
        audio_clips: [
          { id: "c", sample_id: "s1", start_ticks: 0, offset_samples: 0, slice_samples: 10, length_samples: 10, loop: false, gain_db: 0, fade_in_samples: 0, fade_out_samples: 0 },
        ],
      },
    ];
    return song;
  };

  it("saves a .songbird.zip bundle when the song has samples", async () => {
    vi.mocked(bundle.createProjectBundle).mockResolvedValue(new Blob(["PK"]));
    renderActions(withClip());
    await userEvent.click(screen.getByRole("button", { name: "Download project" }));
    await waitFor(() => expect(downloads).toEqual(["late-train.songbird.zip"]));
  });

  it("saves plain JSON when no clip uses the song's samples", async () => {
    renderActions({ ...withSample(), name: "Late Train" });
    await userEvent.click(screen.getByRole("button", { name: "Download project" }));
    expect(downloads).toEqual(["late-train.songbird.json"]);
  });

  it("shows why when the audio cannot be bundled", async () => {
    vi.mocked(bundle.createProjectBundle).mockRejectedValue(new Error("The audio for \"Break\" isn't available."));
    renderActions(withClip());
    await userEvent.click(screen.getByRole("button", { name: "Download project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't available");
    expect(downloads).toEqual([]);
  });
});

describe("Open project bundle", () => {
  it("opens it and warns when browser storage is running low", async () => {
    const incoming = { ...newSongWithTracks(), name: "Bundled" };
    vi.mocked(bundle.isBundleFile).mockResolvedValue(true);
    vi.mocked(bundle.readProjectBundle).mockImplementation(async (_file, _instruments, onLowStorage) => {
      onLowStorage?.();
      return { ok: incoming };
    });
    renderActions(newSongWithTracks());
    await userEvent.upload(screen.getByLabelText("Project file"), new File(["PK"], "x.songbird.zip"));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: incoming.id })));
    expect(screen.getByRole("status")).toHaveTextContent(/storage is running low/i);
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

  it("keeps both songs when the id is already in the library", async () => {
    const existing = { ...newSongWithTracks(), name: "Existing" };
    await library.create(existing);
    renderActions(existing);
    await choose(projectFile({ ...existing, name: "Imported" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    const imported = onImported.mock.calls[0][0] as Song;
    expect(imported.id).not.toBe(existing.id);
    expect((await library.list()).map((e) => e.name).sort()).toEqual(["Existing", "Imported"]);
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

  it("does not overwrite a stored song whose index entry can't be read", async () => {
    const existing = { ...newSongWithTracks(), name: "Existing" };
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
