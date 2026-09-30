import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clear } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import * as api from "@/lib/api";
import { cellLabel } from "@/lib/pianoRoll";
import { createSongLibrary, idbKeyValueStore, type SongLibrary } from "@/lib/song/songLibrary";
import { newSong, newTrack, type Song } from "@/lib/song/types";
import { drums, note } from "@/test/fixtures";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
}));

const audition = vi.fn(async () => {});
const toggle = vi.fn();
// The engine has its own tests; here it would only pull Tone.js into every page render.
vi.mock("@/lib/audio/useSongPlayback", () => ({
  useSongPlayback: () => ({
    isPlaying: false,
    status: "idle",
    error: null,
    toggle,
    stop: vi.fn(),
    preload: vi.fn(),
    subscribePosition: () => () => {},
    audition,
  }),
}));

const piano: InstrumentInfo = {
  id: "piano",
  name: "Piano",
  kind: "melodic",
  midi_program: 0,
  range: { low: 48, high: 60 },
  midi_channel: 1,
  sustained: true,
  rows: [
    { id: "c4", name: "C4", midi_note: 60 },
    { id: "b3", name: "B3", midi_note: 59 },
    { id: "c3", name: "C3", midi_note: 48 },
  ],
};

let library: SongLibrary;

async function renderStudio(song: Song = newSong()) {
  await library.create(song);
  render(<StudioPage library={library} />);
  await screen.findByRole("region", { name: "Arrangement" });
  return song;
}

const lane = (name: string) => screen.getByRole("group", { name: new RegExp(`^Track \\d+: ${name}`) });
const selectTrack = (name: RegExp) => userEvent.click(screen.getByRole("button", { name }));

beforeEach(async () => {
  localStorage.clear();
  await clear();
  library = createSongLibrary();
  audition.mockClear();
  toggle.mockClear();
  vi.mocked(api.getInstruments).mockResolvedValue([drums, piano]);
});
afterEach(() => vi.resetAllMocks());

describe("loading", () => {
  it("shows a loading state while the song opens, then the studio", async () => {
    await library.create(newSong());
    render(<StudioPage library={library} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading song…");
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Arrangement" })).toBeInTheDocument();
  });

  it("creates a default song on first visit", async () => {
    render(<StudioPage library={library} />);
    expect(await screen.findByRole("button", { name: "Rename song Untitled song" })).toBeInTheDocument();
    expect(lane("Drums")).toBeInTheDocument();
    expect(lane("Piano")).toBeInTheDocument();
  });
});

describe("song settings", () => {
  it("renames the song", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Rename song Untitled song" }));
    const input = screen.getByRole("textbox", { name: "Song name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Demo{Enter}");
    expect(screen.getByRole("button", { name: "Rename song Demo" })).toBeInTheDocument();
  });

  it("changes the length in bars", async () => {
    await renderStudio();
    const length = screen.getByRole("spinbutton", { name: "Length" });
    await userEvent.clear(length);
    await userEvent.type(length, "12{Enter}");
    expect(length).toHaveValue(12);
    expect(screen.getByRole("combobox", { name: "Loop end measure" })).toHaveValue("12");
  });

  it("shows the time signature read-only", async () => {
    await renderStudio({ ...newSong("6/8") });
    expect(screen.getByText("6/8")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /time signature/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /time signature/i })).not.toBeInTheDocument();
  });
});

describe("tracks", () => {
  it("disables Add track at 16 tracks", async () => {
    const song = newSong();
    song.tracks = Array.from({ length: 16 }, (_, i) => newTrack("piano", `Piano ${i + 1}`));
    await renderStudio(song);
    expect(screen.getByRole("button", { name: "Add track" })).toBeDisabled();
    expect(screen.getByText("16/16 · limit reached")).toBeInTheDocument();
  });

  it("adds a track from the instrument list and selects it", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Add track" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Piano" }));
    expect(screen.getAllByRole("group", { name: /^Track \d+: Piano/ })).toHaveLength(2);
    expect(screen.getByText("3/16")).toBeInTheDocument();
  });

  it("disables Delete when only one track is left", async () => {
    const song = newSong();
    song.tracks = [song.tracks[0]];
    await renderStudio(song);
    await userEvent.click(screen.getByRole("button", { name: "Track options for Drums" }));
    const del = screen.getByRole("menuitem", { name: "Delete track" });
    expect(del).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(del);
    expect(lane("Drums")).toBeInTheDocument();
  });

  it("deletes a track and restores it, notes and mixer included, with undo", async () => {
    const song = newSong();
    song.tracks[1].notes = [note("c4", 0)];
    song.tracks[1].volume_db = -6;
    await renderStudio(song);
    await userEvent.click(screen.getByRole("button", { name: "Track options for Piano" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete track" }));
    expect(screen.queryByRole("group", { name: /Piano/ })).not.toBeInTheDocument();
    expect(screen.getByText("Deleted the Piano track. Undo to restore.")).toBeInTheDocument();

    await userEvent.keyboard("{Meta>}z{/Meta}");
    expect(lane("Piano")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Volume Piano" })).toHaveValue("-6");
    expect(within(lane("Piano")).getByRole("img")).toHaveAccessibleName(/1 note/);
  });

  it("marks tracks silenced by another track's solo", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Solo Piano" }));
    expect(screen.getByRole("button", { name: "Solo Piano" })).toHaveAttribute("aria-pressed", "true");
    expect(lane("Drums")).toHaveAttribute("data-audible", "false");
    expect(lane("Drums")).toHaveAccessibleName(/not audible/);
    expect(lane("Piano")).toHaveAttribute("data-audible", "true");
  });

  it("resets volume with a double-click and shows pan text", async () => {
    await renderStudio();
    const volume = screen.getByRole("slider", { name: "Volume Piano" });
    await userEvent.dblClick(volume);
    expect(volume).toHaveValue("0");
    expect(screen.getByRole("slider", { name: "Pan Piano" })).toHaveAttribute("aria-valuetext", "Center");
  });
});

describe("editing the selected track", () => {
  const pianoCell = (row: string, step: number) =>
    screen.getByRole("button", { name: cellLabel(row, step, 16) });

  it("edits only the selected track, and the lane overview shows the note", async () => {
    await renderStudio();
    await selectTrack(/^Select Piano track/);
    expect(screen.getByRole("region", { name: "Editor: Piano" })).toBeInTheDocument();

    await userEvent.click(pianoCell("C4", 8));
    const bars = screen.getAllByTestId("note");
    expect(bars).toHaveLength(1);
    expect(bars[0].dataset).toMatchObject({ row: "c4", step: "8", velocity: "100" });
    expect(within(lane("Piano")).getByRole("img")).toHaveAccessibleName(/1 note/);
    expect(within(lane("Drums")).getByRole("img")).toHaveAccessibleName(/no notes/);
  });

  it("keeps edits when switching tracks and back", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: cellLabel("Kick", 0, 16) }));
    await selectTrack(/^Select Piano track/);
    await selectTrack(/^Select Drums track/);
    expect(screen.getAllByTestId("note")).toHaveLength(1);
    expect(screen.getByTestId("note").dataset.row).toBe("kick");
  });

  it("auditions a placed note through the selected track, at its velocity", async () => {
    await renderStudio();
    await selectTrack(/^Select Piano track/);
    await userEvent.click(pianoCell("C4", 8));
    expect(audition).toHaveBeenCalledTimes(1);
    const [row, options] = audition.mock.calls[0] as unknown as [
      { id: string },
      { voiceKey: string; velocity: number },
    ];
    expect(row.id).toBe("c4");
    expect(options.velocity).toBe(100);
    expect(options.voiceKey).toBe(
      screen.getByRole("button", { name: /^Select Piano track/ }).getAttribute("data-track-select"),
    );
  });

  it("stays silent when a note is removed, resized or changed in velocity", async () => {
    const song = newSong();
    song.tracks[1].notes = [note("c4", 0, 2), note("b3", 4)];
    await renderStudio(song);
    await selectTrack(/^Select Piano track/);
    await userEvent.click(pianoCell("B3", 4));
    pianoCell("C4", 0).focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowUp}{/Shift}");
    expect(audition).not.toHaveBeenCalled();
  });
});

describe("undo and redo", () => {
  it("undoes and redoes with the buttons and keyboard, skipping text fields", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: cellLabel("Kick", 0, 16) }));
    expect(screen.getAllByTestId("note")).toHaveLength(1);

    await userEvent.keyboard("{Control>}z{/Control}");
    expect(screen.queryAllByTestId("note")).toHaveLength(0);
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(screen.getAllByTestId("note")).toHaveLength(1);

    const tempo = screen.getByRole("spinbutton", { name: "Tempo" });
    await userEvent.click(tempo);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(screen.getAllByTestId("note")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryAllByTestId("note")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.getAllByTestId("note")).toHaveLength(1);
  });
});

describe("assistant column", () => {
  it("renders the empty state and a disabled input", async () => {
    await renderStudio();
    const panel = screen.getByRole("complementary", { name: "Assistant" });
    expect(within(panel).getByText("Your song assistant")).toBeInTheDocument();
    expect(within(panel).getByRole("textbox", { name: "Message the assistant" })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "Send message" })).toBeDisabled();
  });
});

describe("persistence", () => {
  it("saves edits to the library", async () => {
    const song = await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: cellLabel("Kick", 0, 16) }));
    await waitFor(async () => {
      const saved = await library.open(song.id);
      expect(saved?.tracks[0].notes).toHaveLength(1);
    });
    await act(async () => {});
  });
});

let originalClientHeight: PropertyDescriptor | undefined;

describe("resizing the dock", () => {
  const KEY = "songbird.studio.dockHeight";
  const separator = () => screen.getByRole("separator", { name: "Resize piano roll" });

  beforeEach(() => {
    // jsdom has no layout, so the available space is faked to make the bounds meaningful.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: () => void) {}
        observe() {
          this.cb();
        }
        disconnect() {}
      },
    );
    originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 900 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
    else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  it("trades height with the arrangement, within the minimums, and is kept after a reload", async () => {
    const song = await renderStudio();
    separator().focus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    const grown = Number(separator().getAttribute("aria-valuenow"));
    expect(grown).toBe(200 + 48);
    expect(localStorage.getItem(KEY)).toBe(String(grown));
    expect(separator()).toHaveAttribute("aria-valuemin", "200");
    expect(Number(separator().getAttribute("aria-valuemax"))).toBe(900 - 192 - 8);

    await userEvent.keyboard("{End}{ArrowUp}");
    expect(separator()).toHaveAttribute("aria-valuenow", String(900 - 192 - 8));
    await userEvent.keyboard("{Home}{ArrowDown}");
    expect(separator()).toHaveAttribute("aria-valuenow", "200");
    await userEvent.keyboard("{ArrowUp}");

    cleanup();
    render(<StudioPage library={library} />);
    await screen.findByRole("region", { name: "Arrangement" });
    expect(separator()).toHaveAttribute("aria-valuenow", "224");
    await userEvent.dblClick(separator());
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(song.id).toBeTruthy();
  });

  it("changes height by dragging the separator upward", async () => {
    await renderStudio();
    separator().focus();
    await userEvent.keyboard("{ArrowUp}");
    const start = Number(separator().getAttribute("aria-valuenow"));
    fireEvent.pointerDown(separator(), { clientY: 400 });
    fireEvent.pointerMove(separator(), { clientY: 340 });
    fireEvent.pointerUp(separator(), { clientY: 340 });
    expect(Number(separator().getAttribute("aria-valuenow"))).toBe(start + 60);
  });
});

describe("moving a note between rows", () => {
  it("previews each new row through the selected track and records one undo step", async () => {
    const song = newSong();
    song.tracks[1].notes = [note("c4", 8, 2, 80)];
    song.tracks[1].muted = true;
    await renderStudio(song);
    await selectTrack(/^Select Piano track/);
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 10 });
    try {
      const bar = screen.getByTestId("note");
      fireEvent.pointerDown(bar, { clientX: 5, clientY: 100, button: 0 });
      fireEvent.pointerMove(bar, { clientX: 5, clientY: 100 + 18 });
      fireEvent.pointerUp(bar, { clientX: 5, clientY: 100 + 18 });
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    }
    expect(screen.getByTestId("note").dataset).toMatchObject({ row: "b3", step: "8", velocity: "80", length: "2" });
    expect(audition).toHaveBeenCalledTimes(1);
    const [row, options] = audition.mock.calls[0] as unknown as [{ id: string }, { velocity: number; voiceKey: string }];
    expect(row.id).toBe("b3");
    expect(options.velocity).toBe(80);

    await userEvent.keyboard("{Control>}z{/Control}");
    expect(screen.getByTestId("note").dataset.row).toBe("c4");
  });
});

describe("opening by URL", () => {
  it("clears ?song= after reading it, and names the branch that was taken", async () => {
    const other = { ...newSong(), name: "Other" };
    await library.create(other);
    window.history.pushState(null, "", "/studio?song=missing");
    render(<StudioPage library={library} />);
    await screen.findByRole("region", { name: "Arrangement" });
    expect(window.location.search).toBe("");
    expect(screen.getByText("That song couldn't be found, so your last song was opened.")).toBeInTheDocument();
  });

  it("says a new song was created when there is no last song", async () => {
    window.history.pushState(null, "", "/studio?song=missing");
    render(<StudioPage library={library} />);
    await screen.findByRole("region", { name: "Arrangement" });
    expect(screen.getByText("That song couldn't be found, so a new song was created.")).toBeInTheDocument();
  });
});

describe("read failures", () => {
  it("shows a message and creates nothing when the saved songs cannot be read", async () => {
    const existing = { ...newSong(), name: "Precious" };
    await library.create(existing);
    const kv = idbKeyValueStore();
    const broken = createSongLibrary({ ...kv, get: () => Promise.reject(new Error("blocked")) });
    render(<StudioPage library={broken} />);
    expect(await screen.findByText(/Couldn't read your saved songs/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Arrangement" })).not.toBeInTheDocument();
    expect(broken.getLastSongId()).toBe(existing.id);
    expect((await library.list()).map((e) => e.id)).toEqual([existing.id]);
  });
});
