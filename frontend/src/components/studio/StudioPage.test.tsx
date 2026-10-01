import "fake-indexeddb/auto";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clear } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import * as api from "@/lib/api";
import { createMidiAccess } from "@/lib/midi/access";
import { cellLabel } from "@/lib/pianoRoll";
import { createFakeMidi } from "@/test/fakeMidi";
import { createSongLibrary, idbKeyValueStore, songKey, type SongLibrary } from "@/lib/song/songLibrary";
import { normalizeSong } from "@/lib/song/songOps";
import { newTrack, type Clip, type Loop, type Song } from "@/lib/song/types";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { clearStoredValueCache } from "@/lib/useStoredValue";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
}));

const audition = vi.fn(async () => {});
const seekTo = vi.fn();
const positionListeners = new Set<(position: number | null) => void>();
const toggle = vi.fn();
const countInListeners = new Set<(beatsLeft: number | null) => void>();
const countInEndListeners = new Set<() => void>();
// Stands in for the real playback hook's teardown, which stops the engine on unmount.
let onPlaybackTeardown: (() => void) | null = null;
// Recording drives the engine directly; it is faked here for the same reason as the playback hook.
const fakeEngine = {
  prepareLive: vi.fn(async () => {}),
  liveNoteOn: vi.fn((): object | null => ({})),
  liveNoteOff: vi.fn(),
  liveBlocked: vi.fn(() => false),
  startMeasure: vi.fn(() => 1),
  stepAt: vi.fn((): { step: number; frac: number; seconds: number; stepSeconds: number } | null => null),
  play: vi.fn(async () => {}),
  stop: vi.fn(),
  setMetronome: vi.fn(),
  subscribeCountIn: (cb: (beatsLeft: number | null) => void) => {
    countInListeners.add(cb);
    return () => countInListeners.delete(cb);
  },
  subscribeCountInEnd: (cb: () => void) => {
    countInEndListeners.add(cb);
    return () => countInEndListeners.delete(cb);
  },
};
// The engine has its own tests; here it would only pull Tone.js into every page render.
type LoopArg = { region: { start: number; end: number } | null; enabled: boolean };
const loops: LoopArg[] = [];
vi.mock("@/lib/audio/useSongPlayback", () => ({
  useSongPlayback: (_store: unknown, _instruments: unknown, loop: LoopArg) => {
    useEffect(() => () => onPlaybackTeardown?.(), []);
    loops.push(loop);
    return {
    isPlaying: false,
    status: "idle",
    error: null,
    toggle,
    stop: vi.fn(),
    seek: seekTo,
    preload: vi.fn(),
    subscribePosition: (cb: (p: number | null) => void) => {
      positionListeners.add(cb);
      return () => positionListeners.delete(cb);
    },
    audition,
    engine: fakeEngine,
    };
  },
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

// The dock edits a clip's loop, so the default song needs one on each track to have anything to click.
function songWithDrumLoop(): Song {
  const song = newSongWithTracks();
  song.measures = 8;
  song.tracks = song.tracks.map((t) => trackWithNotes(t, [], song.measures));
  return song;
}

async function renderStudio(song: Song = songWithDrumLoop()) {
  await library.create(song);
  render(<StudioPage library={library} />);
  await screen.findByRole("region", { name: "Arrangement" });
  return song;
}

const lane = (name: string) => screen.getByRole("group", { name: new RegExp(`^Track \\d+: ${name}`) });
const selectTrack = (name: RegExp) => userEvent.click(screen.getByRole("button", { name }));

beforeEach(async () => {
  onPlaybackTeardown = null;
  localStorage.clear();
  clearStoredValueCache();
  await clear();
  library = createSongLibrary();
  audition.mockClear();
  toggle.mockClear();
  loops.length = 0;
  fakeEngine.prepareLive.mockResolvedValue(undefined);
  fakeEngine.liveNoteOn.mockReturnValue({});
  fakeEngine.stepAt.mockReturnValue(null);
  fakeEngine.liveBlocked.mockReturnValue(false);
  fakeEngine.startMeasure.mockReturnValue(1);
  fakeEngine.play.mockResolvedValue(undefined);
  vi.mocked(api.getInstruments).mockResolvedValue([drums, piano]);
});
afterEach(() => vi.resetAllMocks());

describe("loading", () => {
  it("shows a loading state while the song opens, then the studio", async () => {
    await library.create(newSongWithTracks());
    render(<StudioPage library={library} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading song…");
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Arrangement" })).toBeInTheDocument();
  });

  it("creates a default song with no tracks on first visit and shows the studio, not the skeleton", async () => {
    render(<StudioPage library={library} />);
    expect(await screen.findByRole("button", { name: "Rename song Untitled song" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Arrangement" })).toBeInTheDocument();
    expect(screen.queryByText("Loading song…")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(0);
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

  it("has no length control because the song follows its clips", async () => {
    await renderStudio();
    expect(screen.queryByRole("spinbutton", { name: "Length" })).not.toBeInTheDocument();
  });

  it("changes the time signature without a warning when no note is lost", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 1, [note("kick", 0)])], [C("c1", "a", 1, 1)]));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Time signature" }), "3/4");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Time signature" })).toHaveValue("3/4");
    expect(status()).toHaveTextContent("Time signature changed to 3/4.");
    expect(within(dockRegion()).getAllByRole("button", { name: /^Kick, measure 1/ })).toHaveLength(12);
  });

  it("asks before a lossy time signature change and applies it on confirm", async () => {
    await renderStudio(
      clipSong([L("a", "Groove A", 1, [note("kick", 0), note("kick", 12)])], [C("c1", "a", 1, 1)]),
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Time signature" }), "3/4");
    const dialog = await screen.findByRole("alertdialog", { name: "Change to 3/4?" });
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Change to 3/4 and remove 1 note?");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("combobox", { name: "Time signature" })).toHaveValue("4/4");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change to 3/4" }));
    expect(screen.getByRole("combobox", { name: "Time signature" })).toHaveValue("3/4");
    expect(status()).toHaveTextContent("Time signature changed to 3/4. 1 note removed.");
    expect(within(dockRegion()).getAllByTestId("note")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("combobox", { name: "Time signature" })).toHaveValue("4/4");
    expect(within(dockRegion()).getAllByTestId("note")).toHaveLength(2);
  });

  it("keeps the song in 4/4 with every note when a lossy change is cancelled", async () => {
    await renderStudio(
      clipSong([L("a", "Groove A", 1, [note("kick", 0), note("kick", 12)])], [C("c1", "a", 1, 1)]),
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Time signature" }), "3/4");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("combobox", { name: "Time signature" })).toHaveValue("4/4");
    expect(within(dockRegion()).getAllByTestId("note")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("changes the key as one undo step", async () => {
    await renderStudio();
    expect(screen.getByRole("combobox", { name: "Key tonic" })).toHaveValue("C");
    expect(screen.getByRole("combobox", { name: "Key mode" })).toHaveValue("major");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Key tonic" }), "A");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Key mode" }), "minor");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("combobox", { name: "Key mode" })).toHaveValue("major");
    expect(screen.getByRole("combobox", { name: "Key tonic" })).toHaveValue("A");
  });
});

describe("tracks", () => {
  it("disables Add track at 16 tracks", async () => {
    const song = newSongWithTracks();
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

  it("deletes the last track, shows the empty arrangement, and undo restores it", async () => {
    const song = newSongWithTracks();
    song.tracks = [trackWithNotes(song.tracks[0], [note("kick", 0)], song.measures)];
    song.tracks[0].volume_db = -6;
    await renderStudio(song);
    await userEvent.click(screen.getByRole("button", { name: "Track options for Drums" }));
    const del = screen.getByRole("menuitem", { name: "Delete track" });
    expect(del).not.toHaveAttribute("aria-disabled");
    await userEvent.click(del);
    expect(screen.queryAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Arrangement" })).toHaveTextContent("This song has no tracks yet");

    await userEvent.keyboard("{Meta>}z{/Meta}");
    expect(lane("Drums")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Volume Drums" })).toHaveValue("-6");
    expect(within(lane("Drums")).getByTestId("clip-notes")).toBeInTheDocument();
  });

  it("deletes a track and restores it, notes and mixer included, with undo", async () => {
    const song = newSongWithTracks();
    song.tracks[1] = trackWithNotes(song.tracks[1], [note("c4", 0)], song.measures);
    song.tracks[1].volume_db = -6;
    await renderStudio(song);
    await userEvent.click(screen.getByRole("button", { name: "Track options for Piano" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete track" }));
    expect(screen.queryByRole("group", { name: /Piano/ })).not.toBeInTheDocument();
    expect(screen.getByText("Deleted the Piano track. Undo to restore.")).toBeInTheDocument();

    await userEvent.keyboard("{Meta>}z{/Meta}");
    expect(lane("Piano")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Volume Piano" })).toHaveValue("-6");
    expect(within(lane("Piano")).getByTestId("clip-notes")).toBeInTheDocument();
  });

  it("closes a track's Sound panel when the track is deleted, and undo does not reopen it", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Sound for Piano" }));
    expect(await screen.findByRole("dialog", { name: "Piano sound" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Track options for Piano" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete track" }));
    expect(screen.queryByRole("dialog", { name: "Piano sound" })).not.toBeInTheDocument();

    await userEvent.keyboard("{Meta>}z{/Meta}");
    expect(lane("Piano")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    expect(screen.getByRole("region", { name: "Editor: Piano on Piano" })).toBeInTheDocument();

    await userEvent.click(pianoCell("C4", 8));
    const bars = screen.getAllByTestId("note");
    expect(bars).toHaveLength(1);
    expect(bars[0].dataset).toMatchObject({ row: "c4", step: "8", velocity: "100" });
    expect(within(lane("Piano")).getByTestId("clip-notes")).toBeInTheDocument();
    expect(within(lane("Drums")).queryByTestId("clip-notes")).not.toBeInTheDocument();
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
    const song = newSongWithTracks();
    song.tracks[1] = trackWithNotes(song.tracks[1], [note("c4", 0, 2), note("b3", 4)], song.measures);
    await renderStudio(song);
    await selectTrack(/^Select Piano track/);
    pianoCell("B3", 4).focus();
    await userEvent.keyboard("{Delete}");
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
  it("renders the empty state with an enabled input and Send disabled until there is text", async () => {
    await renderStudio();
    const panel = screen.getByRole("complementary", { name: "Assistant" });
    expect(within(panel).getByText("Your song assistant")).toBeInTheDocument();
    expect(within(panel).getByRole("textbox", { name: "Message the assistant" })).toBeEnabled();
    expect(within(panel).getByRole("button", { name: "Send message" })).toBeDisabled();
  });
});

describe("persistence", () => {
  it("saves edits to the library", async () => {
    const song = await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: cellLabel("Kick", 0, 16) }));
    await waitFor(async () => {
      const saved = await library.open(song.id);
      expect(saved?.tracks[0].loops[0].notes).toHaveLength(1);
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
    const song = newSongWithTracks();
    song.tracks[1] = trackWithNotes(song.tracks[1], [note("c4", 8, 2, 80)], song.measures);
    song.tracks[1].muted = true;
    await renderStudio(song);
    await selectTrack(/^Select Piano track/);
    const bar = screen.getByTestId("note");
    fireEvent.pointerDown(bar, { clientX: 5, clientY: 100, button: 0 });
    fireEvent.pointerMove(document, { clientX: 5, clientY: 100 + 18 });
    fireEvent.pointerMove(document, { clientX: 5 + 28, clientY: 100 + 18 });
    fireEvent.pointerUp(document, { clientX: 5 + 28, clientY: 100 + 18 });
    expect(screen.getByTestId("note").dataset).toMatchObject({ row: "b3", step: "9", velocity: "80", length: "2" });
    expect(audition).toHaveBeenCalledTimes(1);
    const [row, options] = audition.mock.calls[0] as unknown as [{ id: string }, { velocity: number; voiceKey: string }];
    expect(row.id).toBe("b3");
    expect(options.velocity).toBe(80);

    // A drag is one undo step on the Studio too, however many moves it took.
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(screen.getByTestId("note").dataset).toMatchObject({ row: "c4", step: "8" });
  });
});

const pianoCellOf = (row: string, step: number) =>
  screen.getByRole("button", { name: cellLabel(row, step, 16) });

describe("selecting, inspecting and pasting notes in the dock", () => {
  const dockOf = () => screen.getByRole("region", { name: /^Editor:/ });

  it("shows the note inspector in the dock header and edits the selection as one undo step", async () => {
    const song = newSongWithTracks();
    song.tracks[1] = trackWithNotes(song.tracks[1], [note("c4", 0, 2, 60), note("b3", 4, 2, 120)], song.measures);
    await renderStudio(song);
    await selectTrack(/^Select Piano track/);
    const dock = dockOf();
    expect(within(dock).getByText("No notes selected")).toBeInTheDocument();
    screen.getByRole("button", { name: cellLabel("C4", 0, 16) }).focus();
    await userEvent.keyboard("{Control>}a{/Control}");
    const inspector = within(dock).getByRole("group", { name: "Selected notes" });
    expect(within(inspector).getByText("2 notes selected")).toBeInTheDocument();
    expect(within(inspector).getByLabelText("Velocity")).toHaveAttribute("placeholder", "Mixed");
    await userEvent.type(within(inspector).getByLabelText("Velocity"), "90{Enter}");
    expect(screen.getAllByTestId("note").map((n) => n.dataset.velocity)).toEqual(["90", "90"]);
    screen.getByRole("button", { name: cellLabel("C4", 0, 16) + ", selected" }).focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(screen.getAllByTestId("note").map((n) => n.dataset.velocity)).toEqual(["60", "120"]);
  });

  it("clears the selection when another clip's loop is opened", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 1, [note("snare", 0)]), L("b", "Groove B", 1, [note("kick", 0)])], [C("c1", "a", 1, 1), C("c2", "b", 2, 1)]));
    await userEvent.click(clipButton(/^Groove A, measure 1/));
    screen.getByRole("button", { name: cellLabel("Snare", 0, 16) }).focus();
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(screen.getByTestId("note")).toHaveAttribute("data-selected", "true");
    await userEvent.click(clipButton(/^Groove B, measure 2/));
    expect(screen.getByTestId("note")).not.toHaveAttribute("data-selected");
  });

  it("pastes into another track and says how many notes were left out", async () => {
    const song = newSongWithTracks();
    song.tracks[0] = trackWithNotes(song.tracks[0], [note("kick", 0), note("kick", 4)], song.measures);
    song.tracks[1] = trackWithNotes(song.tracks[1], [], song.measures);
    await renderStudio(song);
    screen.getByRole("button", { name: cellLabel("Kick", 8, 16) }).focus();
    await userEvent.keyboard("{Control>}ac{/Control}");
    await selectTrack(/^Select Piano track/);
    pianoCellOf("C4", 0).focus();
    await userEvent.keyboard("{Control>}v{/Control}");
    expect(screen.queryAllByTestId("note")).toHaveLength(0);
    expect(screen.getByText("Pasted 0 notes. 2 didn't fit and were left out.", { selector: "p[role=status]" })).toBeInTheDocument();
  });
});

describe("opening by URL", () => {
  it("clears ?song= after reading it, and names the branch that was taken", async () => {
    const other = { ...newSongWithTracks(), name: "Other" };
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

describe("songs that cannot be opened", () => {
  const broken = () => {
    const song = { ...newSongWithTracks(), name: "Broken" };
    return { ...song, tracks: [{ ...song.tracks[0], loops: [null] }, song.tracks[1]] };
  };

  it("says a requested song could not be opened, not that it was missing", async () => {
    const bad = broken();
    await idbKeyValueStore().set(songKey(bad.id), bad);
    await library.create({ ...newSongWithTracks(), name: "Fine" });
    window.history.pushState(null, "", `/studio?song=${bad.id}`);
    render(<StudioPage library={library} />);
    await screen.findByRole("region", { name: "Arrangement" });
    expect(screen.getByText("That song couldn't be opened, so your last song was opened.")).toBeInTheDocument();
  });

  it("says the last-opened song could not be opened before creating a new one", async () => {
    const bad = broken();
    await idbKeyValueStore().set(songKey(bad.id), bad);
    localStorage.setItem("songbird.studio.lastSong", bad.id);
    render(<StudioPage library={library} />);
    await screen.findByRole("region", { name: "Arrangement" });
    expect(screen.getByText("Your last song couldn't be opened, so a new song was created.")).toBeInTheDocument();
  });
});

describe("read failures", () => {
  it("shows a message and creates nothing when the saved songs cannot be read", async () => {
    const existing = { ...newSongWithTracks(), name: "Precious" };
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


// Lanes have no layout in jsdom, so a fixed width makes one measure of a 16-measure song 100px.
const LANE_PX = 1600;
const MEASURE_PX = 100;
const px = (measure: number) => (measure - 1) * MEASURE_PX + MEASURE_PX / 2;

function stubLaneRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const isLane = this.dataset.testid === "clip-lane";
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: isLane ? LANE_PX : 0,
      bottom: 0,
      width: isLane ? LANE_PX : 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

const L = (id: string, name: string, measures: number, notes = [] as ReturnType<typeof note>[]): Loop => ({
  id,
  name,
  measures,
  notes,
});
const C = (id: string, loop_id: string, start_measure: number, measures: number): Clip => ({
  id,
  loop_id,
  start_measure,
  measures,
});

function clipSong(drumsLoops: Loop[], drumsClips: Clip[]): Song {
  const song = newSongWithTracks();
  song.tracks[0] = { ...song.tracks[0], loops: drumsLoops, clips: drumsClips };
  return normalizeSong(song);
}

const clipButton = (name: string | RegExp) => screen.getByRole("button", { name });
const laneOf = (name: string) => within(lane(name)).getByTestId("clip-lane");
const dockRegion = () => screen.getByRole("region", { name: /^Editor:/ });
const status = () => screen.getByRole("status");

describe("clips in the lane", () => {
  beforeEach(() => stubLaneRects());
  afterEach(() => vi.restoreAllMocks());

  it("shows linked clips with a shared colour and a different one for another loop", async () => {
    await renderStudio(
      clipSong(
        [L("a", "Groove A", 2, [note("kick", 0)]), L("f", "Fill", 1, [note("snare", 0)])],
        [C("c1", "a", 1, 2), C("c2", "a", 3, 2), C("c3", "f", 5, 1)],
      ),
    );
    const [one, two] = screen.getAllByRole("button", { name: /^Groove A/ });
    const fill = clipButton(/^Fill/);
    expect(one.className).toContain("border-indigo-600");
    expect(two.className).toContain("border-indigo-600");
    expect(fill.className).toContain("border-amber-600");
    expect(one).toHaveAttribute("title", expect.stringContaining("linked, 2 clips"));
    expect(fill).not.toHaveAttribute("title", expect.stringContaining("linked"));
  });

  it("names a clip with its loop, measures and link count", async () => {
    await renderStudio(
      clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2), C("c2", "a", 3, 2), C("c3", "a", 5, 2)]),
    );
    expect(clipButton("Groove A, measures 3 to 4, linked, 3 clips")).toBeInTheDocument();
  });

  it("names a repeating clip with how often its loop plays", async () => {
    await renderStudio(clipSong([L("a", "Bass 1", 2)], [C("c1", "a", 1, 8)]));
    expect(clipButton("Bass 1, measures 1 to 8, loop plays 4 times")).toBeInTheDocument();
    expect(within(laneOf("Drums")).getAllByTestId("repeat-mark")).toHaveLength(3);
  });

  it("shows a hint on an empty lane only", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    expect(within(lane("Piano")).getByText("Double-click to add a clip")).toBeInTheDocument();
    expect(within(lane("Drums")).queryByText("Double-click to add a clip")).not.toBeInTheDocument();
  });

  it("creates a 1-measure clip on double-click in an empty lane and selects it", async () => {
    await renderStudio(clipSong([], []));
    fireEvent.doubleClick(laneOf("Drums"), { clientX: px(5) });
    const created = await screen.findByRole("button", { name: "Drums 1, measure 5" });
    expect(created).toHaveAttribute("aria-current", "true");
    expect(dockRegion()).toHaveAccessibleName("Editor: Drums 1 on Drums");
    expect(within(dockRegion()).getByRole("button", { name: cellLabel("Kick", 15, 16) })).toBeInTheDocument();
    expect(within(dockRegion()).queryByRole("button", { name: cellLabel("Kick", 16, 16) })).not.toBeInTheDocument();
    expect(within(dockRegion()).queryAllByTestId("note")).toHaveLength(0);
  });

  it("places a new clip next to a neighbour without overlapping it", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 7, 2)]));
    fireEvent.doubleClick(laneOf("Drums"), { clientX: px(6) });
    expect(await screen.findByRole("button", { name: "Drums 1, measure 6" })).toBeInTheDocument();
    expect(clipButton(/^Groove A, measures 7 to 8/)).toBeInTheDocument();
  });

  it("creates a clip in the empty space past the song's end, which lengthens the song", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 8)]));
    fireEvent.doubleClick(laneOf("Piano"), { clientX: px(12) });
    expect(await screen.findByRole("button", { name: "Piano 1, measure 12" })).toBeInTheDocument();
  });

  it("selects the track when empty lane space is clicked, keeping the selected clip if it is there", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    fireEvent.click(laneOf("Piano"), { clientX: px(3) });
    expect(screen.getByRole("button", { name: /^Select Piano track/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(laneOf("Drums"), { clientX: px(9) });
    expect(clipButton(/^Groove A/)).toHaveAttribute("aria-current", "true");
  });

  it("does not seek or create when a clip itself is clicked or double-clicked", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    await userEvent.dblClick(clipButton(/^Groove A/));
    expect(screen.getAllByRole("button", { name: /^Groove A/ })).toHaveLength(1);
  });
});

describe("editing clips", () => {
  beforeEach(() => stubLaneRects());
  afterEach(() => vi.restoreAllMocks());

  const drag = (el: Element, from: number, to: number, init: object = {}) => {
    fireEvent.pointerDown(el, { clientX: from, button: 0, pointerId: 1, ...init });
    fireEvent.pointerMove(el, { clientX: to, pointerId: 1, ...init });
    fireEvent.pointerUp(el, { clientX: to, pointerId: 1, ...init });
  };

  it("stops a dragged clip at its neighbour and undoes the drag in one step", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2), C("c2", "a", 5, 2)]));
    drag(clipButton(/^Groove A, measures 1 to 2/), px(1), px(4));
    expect(clipButton(/^Groove A, measures 3 to 4/)).toBeInTheDocument();
    expect(clipButton(/^Groove A, measures 5 to 6/)).toBeInTheDocument();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(clipButton(/^Groove A, measures 1 to 2/)).toBeInTheDocument();
  });

  it("treats a tiny movement as a click, not a move", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    drag(clipButton(/^Groove A/), px(1), px(1) + 3);
    expect(clipButton(/^Groove A, measures 1 to 2/)).toBeInTheDocument();
  });

  it("cancels a drag with Escape and keeps no undo step", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    const block = clipButton(/^Groove A/);
    fireEvent.pointerDown(block, { clientX: px(1), button: 0, pointerId: 1 });
    fireEvent.pointerMove(block, { clientX: px(4), pointerId: 1 });
    expect(clipButton(/^Groove A, measures 4 to 5/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerUp(block, { clientX: px(4), pointerId: 1 });
    expect(clipButton(/^Groove A, measures 1 to 2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("repeats the loop when the right edge is dragged out", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c0", "a", 1, 2), C("c1", "a", 3, 2)]));
    const block = clipButton(/^Groove A, measures 3 to 4/);
    const handle = block.querySelector("[data-handle]")!;
    drag(handle, px(4), px(4) + 400);
    expect(clipButton("Groove A, measures 3 to 8, linked, 2 clips, loop plays 3 times")).toBeInTheDocument();
  });

  it("resizes the loop with a clip that is its only user", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    const handle = clipButton(/^Groove A/).querySelector("[data-handle]")!;
    drag(handle, px(2), px(2) + 600);
    expect(clipButton("Groove A, measures 1 to 8")).toBeInTheDocument();
    expect(within(dockRegion()).getByRole("button", { name: cellLabel("Kick", 7 * 16, 16) })).toBeInTheDocument();
  });

  it("drops a linked copy with Alt-drag and leaves the original", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    drag(clipButton(/^Groove A/), px(1), px(9), { altKey: true });
    expect(await screen.findByRole("button", { name: "Groove A, measures 9 to 10, linked, 2 clips" })).toBeInTheDocument();
    expect(clipButton("Groove A, measures 1 to 2, linked, 2 clips")).toBeInTheDocument();
  });

  it("selects the copy, not the source, when the browser clicks after an Alt-drag", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    const source = clipButton(/^Groove A/);
    drag(source, px(1), px(9), { altKey: true });
    fireEvent.click(source);
    const copy = await screen.findByRole("button", { name: /^Groove A, measures 9 to 10/ });
    expect(copy).toHaveAttribute("aria-current", "true");
    expect(clipButton(/^Groove A, measures 1 to 2/)).not.toHaveAttribute("aria-current");
  });

  it("restores the clip and keeps no undo step when the pointer is cancelled", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    const block = clipButton(/^Groove A/);
    fireEvent.pointerDown(block, { clientX: px(1), button: 0, pointerId: 1 });
    fireEvent.pointerMove(block, { clientX: px(4), pointerId: 1 });
    fireEvent.pointerCancel(block, { pointerId: 1 });
    expect(clipButton(/^Groove A, measures 1 to 2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("renders context menus on the document body", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    fireEvent.contextMenu(clipButton(/^Groove A/), { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu").parentElement).toBe(document.body);
  });

  it("does not duplicate on Ctrl+Shift+D or from inside a dialog", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    await userEvent.click(clipButton(/^Groove A/));
    expect(fireEvent.keyDown(document.body, { key: "D", ctrlKey: true, shiftKey: true })).toBe(true);
    await userEvent.click(within(dockRegion()).getByRole("button", { name: /^Loop Groove A/ }));
    const dialog = await screen.findByRole("dialog", { name: "Loops on Drums" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    close.focus();
    expect(fireEvent.keyDown(close, { key: "d", ctrlKey: true })).toBe(true);
    expect(document.querySelectorAll("[data-clip-id]")).toHaveLength(1);
  });

  it("seeks playback to the measure of an empty-space click", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    fireEvent.click(laneOf("Drums"), { clientX: px(9) });
    expect(seekTo).toHaveBeenCalledWith(9);
  });

  it("snaps an Alt-drag dropped on an occupied measure to the nearest free one", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2), C("c2", "a", 5, 2)]));
    drag(clipButton(/^Groove A, measures 1 to 2/), px(1), px(6), { altKey: true });
    expect(await screen.findByRole("button", { name: /^Groove A, measure 7 to|^Groove A, measures 7 to 8/ })).toBeInTheDocument();
  });

  it("reports when an Alt-drag copy has nowhere to go", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 4)], [C("c1", "a", 1, 128)]));
    drag(clipButton(/^Groove A/), 10, 300, { altKey: true });
    expect(status()).toHaveTextContent("There are no empty measures on Drums.");
  });

  it("moves, resizes and deletes with the keyboard", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    clipButton(/^Groove A/).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(status()).toHaveTextContent("Groove A, measures 2 to 3");
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(clipButton(/^Groove A, measures 2 to 4/)).toBeInTheDocument();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(status()).toHaveTextContent("Can't move further: the song starts at measure 1.");
    await userEvent.keyboard("{Delete}");
    expect(screen.queryByRole("button", { name: /^Groove A/ })).not.toBeInTheDocument();
    expect(status()).toHaveTextContent("Deleted a clip of “Groove A”. The loop is still available in Place loop. Undo to restore.");
  });

  it("makes a held arrow one undo step", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    clipButton(/^Groove A/).focus();
    await userEvent.keyboard("{ArrowRight>3/}{/ArrowRight}");
    expect(clipButton(/^Groove A, measures 4 to 5/)).toBeInTheDocument();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(clipButton(/^Groove A, measures 1 to 2/)).toBeInTheDocument();
  });

  it("keeps the loop available in Place loop after its only clip is deleted", async () => {
    await renderStudio(clipSong([L("k", "Chorus keys", 2)], [C("c1", "k", 1, 2)]));
    clipButton(/^Chorus keys/).focus();
    await userEvent.keyboard("{Delete}");
    await userEvent.click(screen.getByRole("button", { name: "Track options for Drums" }));
    expect(screen.getByRole("menuitem", { name: "Place Chorus keys, not placed" })).toBeInTheDocument();
  });

  it("duplicates after the selected clip with Ctrl+D and selects the copy", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    clipButton(/^Groove A/).focus();
    await userEvent.keyboard("{Control>}d{/Control}");
    const copy = await screen.findByRole("button", { name: "Groove A, measures 3 to 4, linked, 2 clips" });
    expect(copy).toHaveAttribute("aria-current", "true");
  });

  it("says why a duplicate has no room", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2), C("c2", "a", 3, 1)]));
    clipButton(/^Groove A, measures 1 to 2/).focus();
    await userEvent.keyboard("{Control>}d{/Control}");
    expect(screen.getAllByRole("button", { name: /^Groove A/ })).toHaveLength(2);
    expect(status()).toHaveTextContent("No room to duplicate “Groove A”. The next 2 bars after it aren't free.");
  });

  it("leaves Ctrl+D alone inside a text field", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    await userEvent.click(clipButton(/^Groove A/));
    const tempo = screen.getByRole("spinbutton", { name: "Tempo" });
    tempo.focus();
    const notPrevented = fireEvent.keyDown(tempo, { key: "d", ctrlKey: true });
    expect(notPrevented).toBe(true);
    expect(screen.getAllByRole("button", { name: /^Groove A/ })).toHaveLength(1);
  });

  it("moves focus between clips with Alt+arrows without selecting", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2), C("c2", "a", 5, 2)]));
    const first = clipButton(/^Groove A, measures 1 to 2/);
    first.focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    const second = clipButton(/^Groove A, measures 5 to 6/);
    expect(second).toHaveFocus();
    expect(second).not.toHaveAttribute("aria-current");
  });

  it("offers Duplicate, Make unique, Rename loop and Delete on a right-clicked clip", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2), C("c2", "a", 3, 2)]));
    fireEvent.contextMenu(clipButton(/^Groove A, measures 1 to 2/), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole("menu", { name: "Clip actions for Groove A, measures 1 to 2" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      expect.stringContaining("Duplicate"),
      "Make unique",
      expect.stringContaining("Rename loop…"),
      expect.stringContaining("Delete clip"),
    ]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Make unique" }));
    expect(status()).toHaveTextContent("This clip now plays “Groove A (copy)”. Editing it won't change the other clips.");
    expect(clipButton(/^Groove A \(copy\), measures 1 to 2$/)).toBeInTheDocument();
  });

  it("disables Make unique for a single clip and explains why", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    fireEvent.contextMenu(clipButton(/^Groove A/), { clientX: 10, clientY: 10 });
    const item = screen.getByRole("menuitem", { name: "Make unique" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("Only this clip uses Groove A");
  });

  it("opens the clip menu with Shift+F10", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    clipButton(/^Groove A/).focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: /^Clip actions for Groove A/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(clipButton(/^Groove A/)).toHaveFocus();
  });

  it("adds New clip and Place loop to the track menu and renames it Rename track…", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    await userEvent.click(screen.getByRole("button", { name: "Track options for Drums" }));
    expect(screen.getByRole("menuitem", { name: "New clip at measure 3" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename track…" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Place Groove A, used by 1 clip" }));
    expect(clipButton("Groove A, measures 3 to 4, linked, 2 clips")).toBeInTheDocument();
  });

  it("opens the lane menu at the pointer over an empty measure", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    fireEvent.contextMenu(laneOf("Drums"), { clientX: px(6), clientY: 20 });
    await userEvent.click(screen.getByRole("menuitem", { name: "New clip at measure 6" }));
    expect(await screen.findByRole("button", { name: "Drums 1, measure 6" })).toBeInTheDocument();
  });

  it("refuses at the loop limit through the status line", async () => {
    const loops = Array.from({ length: 64 }, (_, i) => L(`l${i}`, `Loop ${i}`, 1));
    await renderStudio(clipSong(loops, []));
    fireEvent.doubleClick(laneOf("Drums"), { clientX: px(2) });
    expect(status()).toHaveTextContent("Drums already has 64 loops, the most a track can hold. Delete an unused loop to add another.");
  });
});

describe("the dock edits the selected clip's loop", () => {
  beforeEach(() => stubLaneRects());
  afterEach(() => vi.restoreAllMocks());

  it("shows a loop-local grid numbered from 1", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 9, 2)]));
    const dock = dockRegion();
    expect(within(dock).getByRole("button", { name: cellLabel("Kick", 16, 16) })).toBeInTheDocument();
    expect(within(dock).queryByRole("button", { name: cellLabel("Kick", 32, 16) })).not.toBeInTheDocument();
  });

  it("names the loop, track and clip count in the dock header", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2), C("c2", "a", 3, 2)]));
    const dock = dockRegion();
    expect(dock).toHaveAccessibleName("Editor: Groove A on Drums");
    expect(within(dock).getByText("Drums · used by 2 clips")).toBeInTheDocument();
    expect(within(dock).getByRole("button", { name: "Loop Groove A. Show all loops on Drums" })).toBeInTheDocument();
  });

  it("changes every clip of the loop with one edit, and only that loop", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2), C("c2", "a", 3, 2), C("c3", "a", 5, 2)]));
    await userEvent.click(within(dockRegion()).getByRole("button", { name: cellLabel("Kick", 4, 16) }));
    expect(within(laneOf("Drums")).getAllByTestId("clip-notes")).toHaveLength(3);
    expect(within(laneOf("Piano")).queryAllByTestId("clip-notes")).toHaveLength(0);
  });

  it("gives one clip its own copy in Make unique, so later edits leave the others alone", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2, [note("snare", 0)])], [C("c1", "a", 1, 2), C("c2", "a", 3, 2)]));
    await userEvent.click(clipButton(/^Groove A, measures 3 to 4/));
    await userEvent.click(within(dockRegion()).getByRole("button", { name: /^Clip actions for/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Make unique" }));
    expect(dockRegion()).toHaveAccessibleName("Editor: Groove A (copy) on Drums");
    await userEvent.dblClick(within(dockRegion()).getByTestId("note"));
    expect(within(dockRegion()).queryAllByTestId("note")).toHaveLength(0);
    expect(within(laneOf("Drums")).getAllByTestId("clip-notes")).toHaveLength(1);
    await userEvent.click(clipButton(/^Groove A, measures 1 to 2/));
    expect(within(dockRegion()).getAllByTestId("note")).toHaveLength(1);
  });

  it("has no loop length control in the dock header", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    const dock = dockRegion();
    expect(within(dock).getByRole("button", { name: "Loop Groove A. Show all loops on Drums" })).toBeInTheDocument();
    expect(within(dock).getByText("Drums · used by 1 clip")).toBeInTheDocument();
    expect(within(dock).queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(within(dock).queryByLabelText(/length/i)).not.toBeInTheDocument();
  });

  it("marks the song's end on the ruler and lanes, and hides the marker at the 128 measure cap", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 8)]));
    const marks = screen.getAllByTestId("past-end");
    expect(marks.length).toBe(1 + 2);
    expect(marks[0].style.left).toBe("calc(var(--cell-w) * 128)");
    expect(screen.getByText(/Song length: 8 measures\./)).toBeInTheDocument();
    cleanup();
    await clear();
    library = createSongLibrary();
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 128)]));
    expect(screen.queryByTestId("past-end")).not.toBeInTheDocument();
  });

  it("shows the playhead at the loop position inside the clip and hides it outside", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 8)]));
    const playhead = () => within(dockRegion()).getByTestId("playhead");
    act(() => positionListeners.forEach((cb) => cb(4 * 16 + 5)));
    expect(playhead().style.display).toBe("");
    expect(playhead().style.transform).toContain("calc(5 * var(--cell-w))");
    act(() => positionListeners.forEach((cb) => cb(8 * 16 + 1)));
    expect(playhead().style.display).toBe("none");
  });

  it("shows an empty state with New clip for a track without clips", async () => {
    await renderStudio(clipSong([], []));
    const dock = dockRegion();
    expect(within(dock).getByRole("heading", { name: "Drums has no clips yet" })).toBeInTheDocument();
    expect(within(dock).queryByRole("group", { name: /piano roll/ })).not.toBeInTheDocument();
    const add = within(dock).getByRole("button", { name: "New clip" });
    expect(add).toHaveAccessibleDescription("Adds measure 1");
    await userEvent.click(add);
    expect(await screen.findByRole("button", { name: "Drums 1, measure 1" })).toBeInTheDocument();
    expect(dockRegion()).toHaveAccessibleName("Editor: Drums 1 on Drums");
  });

  it("selects a track's earliest clip from its header, or shows the empty state", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 5, 2), C("c2", "a", 1, 2)]));
    await selectTrack(/^Select Piano track/);
    expect(within(dockRegion()).getByRole("heading", { name: "Piano has no clips yet" })).toBeInTheDocument();
    await selectTrack(/^Select Drums track/);
    expect(clipButton(/^Groove A, measures 1 to 2/)).toHaveAttribute("aria-current", "true");
  });

  it("deletes a placed loop and its clips from the Loops dialog, restored by one undo", async () => {
    await renderStudio(clipSong([L("f", "Fill", 1), L("a", "Groove A", 2)], [C("c1", "f", 1, 1), C("c2", "f", 3, 1), C("c3", "f", 5, 1), C("c4", "a", 8, 2)]));
    await userEvent.click(within(dockRegion()).getByRole("button", { name: /^Loop Fill/ }));
    const dialog = await screen.findByRole("dialog", { name: "Loops on Drums" });
    expect(within(dialog).getByText("3 clips")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete Fill" }));
    expect(status()).toHaveTextContent("Deleted the loop “Fill” and its 3 clips. Undo to restore.");
    expect(screen.queryAllByRole("button", { name: /^Fill/ })).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(screen.getAllByRole("button", { name: /^Fill/ })).toHaveLength(3);
  });

  it("renames a loop everywhere from the Loops dialog", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2), C("c2", "a", 3, 2)]));
    await userEvent.click(within(dockRegion()).getByRole("button", { name: /^Loop Groove A/ }));
    const dialog = await screen.findByRole("dialog", { name: "Loops on Drums" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Rename Groove A" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Loop name Groove A" }), "{Control>}a{/Control}Verse{Enter}");
    expect(screen.getAllByRole("button", { name: /^Verse, measure/ })).toHaveLength(2);
  });

  it("renames the loop with F2 and returns focus to the clip", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    clipButton(/^Groove A/).focus();
    await userEvent.keyboard("{F2}");
    const input = await screen.findByRole("textbox", { name: "Loop name Groove A" });
    await userEvent.type(input, "{Control>}a{/Control}Chorus{Enter}");
    expect(await screen.findByRole("button", { name: /^Chorus, measures 1 to 2/ })).toBeInTheDocument();
    await waitFor(() => expect(clipButton(/^Chorus/)).toHaveFocus());
  });
});

describe("loop region", () => {
  const ruler = (measures: number) => {
    const hit = screen.getByTestId("loop-hit-layer");
    // 100px per measure keeps the pointer maths readable.
    (hit.parentElement as HTMLElement).getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: measures * 100, bottom: 28, width: measures * 100, height: 28, x: 0, y: 0, toJSON() {} }) as DOMRect;
    return hit;
  };
  const draw = (from: number, to: number, measures = 16) => {
    const hit = ruler(measures);
    fireEvent.pointerDown(hit, { clientX: (from - 1) * 100 + 50, button: 0 });
    fireEvent.pointerMove(hit, { clientX: (to - 1) * 100 + 50 });
    fireEvent.pointerUp(hit, { clientX: (to - 1) * 100 + 50 });
  };

  it("starts a new song with no region and looping off", async () => {
    await renderStudio();
    expect(loops.at(-1)).toEqual({ region: null, enabled: false });
    expect(screen.queryByTestId("loop-region")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loop playback" })).toHaveAttribute("aria-pressed", "false");
  });

  it("loops the whole song from the toggle without drawing a region", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Loop playback" }));
    expect(loops.at(-1)).toEqual({ region: null, enabled: true });
    expect(screen.queryByTestId("loop-region")).not.toBeInTheDocument();
  });

  it("loops a range drawn on the arrangement ruler across every track", async () => {
    await renderStudio();
    draw(5, 8);
    expect(loops.at(-1)).toEqual({ region: { start: 5, end: 8 }, enabled: true });
    expect(screen.getByRole("button", { name: "Loop playback" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches looping off from the transport so the song plays once", async () => {
    await renderStudio();
    draw(2, 3);
    await userEvent.click(screen.getByRole("button", { name: "Loop playback" }));
    expect(loops.at(-1)).toEqual({ region: { start: 2, end: 3 }, enabled: false });
    expect(screen.getByTestId("loop-region")).toHaveAttribute("data-enabled", "false");
  });

  it("keeps the region out of undo and saves it with the song", async () => {
    const song = await renderStudio();
    const tempo = screen.getByRole("spinbutton", { name: "Tempo" });
    await userEvent.clear(tempo);
    await userEvent.type(tempo, "100{Enter}");
    draw(2, 3);
    screen.getByTestId("loop-region").focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(tempo).toHaveValue(120);
    expect(screen.getByTestId("loop-region")).toHaveAttribute("data-start", "2");
    await waitFor(async () => {
      const saved = (await library.open(song.id))!;
      expect(saved.loop_region).toEqual({ region: { start_measure: 2, end_measure: 3 }, enabled: true });
    });
  });

  it("shows the song's region only on the arrangement ruler, not in the dock", async () => {
    await renderStudio();
    draw(5, 8);
    expect(screen.getAllByTestId("loop-region")).toHaveLength(1);
    const arrangement = screen.getByRole("region", { name: "Arrangement" });
    expect(within(arrangement).getByTestId("loop-region")).toBeInTheDocument();
    expect(screen.queryAllByTestId("loop-shade").every((el) => arrangement.contains(el))).toBe(true);
  });
});

describe("key highlighting", () => {
  // Sharp and in-key rows are both needed to tell a tint from the black-key shading.
  const keyed: InstrumentInfo = {
    ...piano,
    rows: [
      { id: "c4", name: "C4", midi_note: 60 },
      { id: "b3", name: "B3", midi_note: 59 },
      { id: "a#3", name: "A#3", midi_note: 58 },
      { id: "a3", name: "A3", midi_note: 57 },
    ],
  };
  const tints = () =>
    Array.from(dockRegion().querySelectorAll<HTMLElement>("[data-tint]")).map((el) => el.dataset.tint);
  const cell = (name: string) =>
    within(dockRegion()).getByRole("button", { name: cellLabel(name, 0, 16) });

  function pianoSong(): Song {
    const song = newSongWithTracks();
    song.tracks[1] = { ...song.tracks[1], loops: [L("p", "Riff", 1)], clips: [C("pc", "p", 1, 1)] };
    return normalizeSong(song);
  }

  beforeEach(() => vi.mocked(api.getInstruments).mockResolvedValue([drums, keyed]));

  it("highlights C major with the C rows as the tonic and no sharp rows", async () => {
    await renderStudio(pianoSong());
    await selectTrack(/^Select Piano track/);
    expect(tints()).toEqual(["tonic", "scale", "none", "scale"]);
    const dock = within(dockRegion());
    expect(dock.getByRole("button", { name: "C4" })).toHaveAccessibleDescription("Tonic of C major");
    expect(dock.getByRole("button", { name: "B3" })).toHaveAccessibleDescription("In C major");
    expect(dock.getByRole("button", { name: "A#3" })).not.toHaveAccessibleDescription();
    expect(dockRegion().querySelector('[data-tint="tonic"]')).toHaveTextContent("C");
    expect(cell("C4").className).toContain("bg-emerald-200/80");
    expect(cell("C4").className).toContain("border-b-emerald-600");
    expect(cell("B3").className).toContain("bg-emerald-100");
    expect(cell("B3").className).not.toContain("border-b-emerald");
    expect(cell("A#3").className).not.toContain("emerald");
  });

  it("bands every step of an in-key row across the whole grid and none of an out-of-key row", async () => {
    await renderStudio(pianoSong());
    await selectTrack(/^Select Piano track/);
    const rowCells = (row: number) =>
      Array.from(dockRegion().querySelectorAll<HTMLElement>(`[data-cell^="${row}:"]`));
    expect(rowCells(1).length).toBeGreaterThan(1);
    expect(rowCells(1).every((c) => /bg-emerald/.test(c.className))).toBe(true);
    expect(rowCells(2).some((c) => /emerald/.test(c.className))).toBe(false);
  });

  it("moves the tonic marking to the A rows when the key changes to A minor", async () => {
    await renderStudio(pianoSong());
    await selectTrack(/^Select Piano track/);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Key tonic" }), "A");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Key mode" }), "minor");
    expect(tints()).toEqual(["scale", "scale", "none", "tonic"]);
    expect(dockRegion().querySelector('[data-tint="tonic"]')).toHaveTextContent("A");
    expect(cell("A3").className).toContain("border-b-emerald-600");
    expect(cell("C4").className).not.toContain("border-b-emerald");
    expect(cell("C4").className).toContain("bg-emerald-100");
    expect(within(dockRegion()).getByRole("button", { name: "A3" })).toHaveAccessibleDescription("Tonic of A minor");
  });

  it("shows no key highlight on a drum track", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 1)], [C("c1", "a", 1, 1)]));
    expect(dockRegion().querySelector("[data-tint]")).toBeNull();
    expect(dockRegion().querySelector('[class*="bg-emerald"]')).toBeNull();
  });
});

describe("MIDI keyboard", () => {
  const midiFake = () => createFakeMidi({ inputs: [{ id: "k", name: "KeyStep" }] });
  async function grantedMidi() {
    const fake = midiFake();
    const access = createMidiAccess({ requestMIDIAccess: fake.requestMIDIAccess, storage: null });
    await access.request();
    return { fake, access };
  }
  const noteOn = (fake: ReturnType<typeof midiFake>, key: number) =>
    act(() => fake.send("k", [0x90, key, 90], performance.now()));
  const noteOff = (fake: ReturnType<typeof midiFake>, key: number) =>
    act(() => fake.send("k", [0x80, key, 0], performance.now()));

  async function renderWithMidi(song: Song) {
    const { fake, access } = await grantedMidi();
    await library.create(song);
    const view = render(<StudioPage library={library} midi={access} />);
    await screen.findByRole("region", { name: "Arrangement" });
    return Object.assign(fake, { unmount: view.unmount });
  }

  it("plays the selected track's instrument, following the selection", async () => {
    const song = songWithDrumLoop();
    const fake = await renderWithMidi(song);
    const [drumTrack, pianoTrack] = song.tracks;

    await waitFor(() =>
      expect(fakeEngine.prepareLive).toHaveBeenCalledWith(drumTrack.id, drums.rows),
    );
    noteOn(fake, 36);
    expect(fakeEngine.liveNoteOn).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "kick" }),
      expect.objectContaining({ voiceKey: drumTrack.id, velocity: 90 }),
    );

    await selectTrack(/^Select Piano track/);
    await waitFor(() =>
      expect(fakeEngine.prepareLive).toHaveBeenCalledWith(pianoTrack.id, piano.rows),
    );
    noteOn(fake, 60);
    expect(fakeEngine.liveNoteOn).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "c4" }),
      expect.objectContaining({ voiceKey: pianoTrack.id, velocity: 90 }),
    );
  });

  it("shows a recorded take in the lane right after note-off and puts it on the selected track", async () => {
    const song = newSongWithTracks();
    song.measures = 8;
    song.tracks[0] = trackWithNotes(song.tracks[0], [], 8);
    const fake = await renderWithMidi(normalizeSong(song));
    await selectTrack(/^Select Piano track/);
    await waitFor(() => expect(fakeEngine.prepareLive).toHaveBeenCalledWith(song.tracks[1].id, piano.rows));
    await userEvent.click(screen.getByRole("button", { name: "Count-in" }));

    expect(within(lane("Piano")).queryByTestId("clip-notes")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(fakeEngine.play).toHaveBeenCalled();
    expect(status()).toHaveTextContent("Recording from bar 1.");

    fakeEngine.stepAt.mockReturnValueOnce({ step: 0, frac: 0, seconds: 0, stepSeconds: 0.125 }).mockReturnValueOnce({ step: 4, frac: 0, seconds: 0, stepSeconds: 0.125 });
    noteOn(fake, 60);
    const before = performance.now();
    noteOff(fake, 60);
    expect(within(lane("Piano")).getByTestId("clip-notes")).toBeInTheDocument();
    expect(performance.now() - before).toBeLessThan(100);
    expect(within(lane("Drums")).queryByTestId("clip-notes")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(status()).toHaveTextContent("Recorded 1 note. Undo removes the take.");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(within(lane("Piano")).queryByTestId("clip-notes")).not.toBeInTheDocument();
  });

  async function recordPianoNote() {
    const song = newSongWithTracks();
    song.measures = 8;
    song.tracks[0] = trackWithNotes(song.tracks[0], [], 8);
    const fake = await renderWithMidi(normalizeSong(song));
    await selectTrack(/^Select Piano track/);
    await waitFor(() => expect(fakeEngine.prepareLive).toHaveBeenCalledWith(song.tracks[1].id, piano.rows));
    await userEvent.click(screen.getByRole("button", { name: "Count-in" }));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    fakeEngine.stepAt.mockReturnValueOnce({ step: 0, frac: 0, seconds: 0, stepSeconds: 0.125 }).mockReturnValueOnce({ step: 4, frac: 0, seconds: 0, stepSeconds: 0.125 });
    noteOn(fake, 60);
    noteOff(fake, 60);
    return fake;
  }

  it("ends the take before an undo, announcing only the committed notes and keeping redo", async () => {
    await recordPianoNote();
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "true");

    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "false");
    expect(status()).toHaveTextContent("Recorded 1 note.");
    expect(within(lane("Piano")).queryByTestId("clip-notes")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(within(lane("Piano")).getByTestId("clip-notes")).toBeInTheDocument();
  });

  it("ends the take when a clip is nudged mid-take, keeping the recorded notes", async () => {
    await recordPianoNote();
    const drumClip = screen.getByRole("button", { name: /^.*measures 1 to 8/ });
    drumClip.focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("{/ArrowRight}");

    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "false");
    expect(within(lane("Piano")).getByTestId("clip-notes")).toBeInTheDocument();
  });

  it("commits and saves a held note at its real length when the page unmounts after playback is torn down", async () => {
    const song = newSongWithTracks();
    song.measures = 8;
    song.tracks[0] = trackWithNotes(song.tracks[0], [], 8);
    const fake = await renderWithMidi(normalizeSong(song));
    await selectTrack(/^Select Piano track/);
    await waitFor(() => expect(fakeEngine.prepareLive).toHaveBeenCalledWith(song.tracks[1].id, piano.rows));
    await userEvent.click(screen.getByRole("button", { name: "Count-in" }));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    let calls = 0;
    fakeEngine.stepAt.mockImplementation(() => ({
      step: ++calls === 1 ? 0 : 4,
      frac: 0,
      seconds: 0,
      stepSeconds: 0.125,
    }));
    // Position lookups fail once playback is torn down, which would stretch a note committed late.
    onPlaybackTeardown = () => fakeEngine.stepAt.mockReturnValue(null);
    noteOn(fake, 60);

    fake.unmount();

    await waitFor(async () => {
      const saved = (await library.open(song.id))!;
      const notes = saved.tracks[1].loops.flatMap((l) => l.notes);
      expect(notes).toEqual([expect.objectContaining({ row_id: "c4", step: 0, length_steps: 4 })]);
    });
  });

  it("starts recording when the engine reports the count-in over, naming the engine's start bar", async () => {
    fakeEngine.startMeasure.mockReturnValue(3);
    await renderWithMidi(songWithDrumLoop());
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(fakeEngine.play).toHaveBeenCalledWith({ countIn: true });
    expect(status()).not.toHaveTextContent("Recording from");

    act(() => countInEndListeners.forEach((cb) => cb()));

    expect(status()).toHaveTextContent("Recording from bar 3.");
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "true");
  });

  it("cancels a count-in on Stop without recording", async () => {
    const fake = await renderWithMidi(songWithDrumLoop());
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(fakeEngine.play).toHaveBeenCalledWith({ countIn: true });
    act(() => countInListeners.forEach((cb) => cb(4)));
    noteOn(fake, 36);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(fakeEngine.stop).toHaveBeenCalled();
    expect(status()).toHaveTextContent("Count-in cancelled. Nothing was recorded.");
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("an empty song", () => {
  const emptySong = () => ({ ...newSongWithTracks(), tracks: [] });

  it("shows the ruler, Add track, the message, no lanes, and an empty dock", async () => {
    await renderStudio(emptySong());
    const arrangement = screen.getByRole("region", { name: "Arrangement" });
    expect(within(arrangement).getByRole("button", { name: "Add track" })).toBeEnabled();
    expect(arrangement).toHaveTextContent("Add a track, or describe a part in the chat.");
    expect(screen.queryAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Editor" })).toHaveTextContent("No track to edit");
    expect(screen.getByRole("button", { name: "Close piano roll" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download project" })).toBeEnabled();
  });

  it("adds the first track and selects it", async () => {
    await renderStudio(emptySong());
    await userEvent.click(screen.getByRole("button", { name: "Add track" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Drums" }));
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(1);
    expect(lane("Drums")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Editor: Drums" })).toBeInTheDocument();
    expect(screen.queryByText("This song has no tracks yet")).not.toBeInTheDocument();
  });
});

describe("recording in an empty song", () => {
  it("explains why Record is unavailable instead of doing nothing", async () => {
    await renderStudio({ ...newSongWithTracks(), tracks: [] });
    const record = screen.getByRole("button", { name: "Record" });
    expect(record).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(record);
    expect(status()).toHaveTextContent("Add a track to record onto.");
    expect(record).toHaveAttribute("aria-pressed", "false");
  });
});

describe("closing the dock", () => {
  const OPEN_KEY = "songbird.studio.dockOpen";
  const HEIGHT_KEY = "songbird.studio.dockHeight";
  const separator = () => screen.getByRole("separator", { name: "Resize piano roll" });
  const grooveSong = () => clipSong([L("a", "Groove A", 2, [note("kick", 0)])], [C("c1", "a", 1, 2)]);
  const close = () => userEvent.click(screen.getByRole("button", { name: "Close piano roll" }));

  beforeEach(() => {
    stubLaneRects();
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
    vi.restoreAllMocks();
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
    else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  it("hides the dock, handle and skip link but keeps the selection and the song", async () => {
    await renderStudio(grooveSong());
    await userEvent.click(clipButton(/^Groove A/));
    expect(screen.getByRole("link", { name: "Skip to piano roll" })).toBeInTheDocument();
    await close();
    expect(screen.queryByRole("region", { name: /^Editor/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize piano roll" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Skip to piano roll" })).not.toBeInTheDocument();
    expect(clipButton(/^Groove A/)).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(localStorage.getItem(OPEN_KEY)).toBe("false");
  });

  it("stays closed after a single click on a clip", async () => {
    await renderStudio(grooveSong());
    await close();
    await userEvent.click(clipButton(/^Groove A/));
    expect(clipButton(/^Groove A/)).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("region", { name: /^Editor/ })).not.toBeInTheDocument();
  });

  it("reopens on the clip at its prior height when a clip is double-clicked", async () => {
    localStorage.setItem(HEIGHT_KEY, "320");
    await renderStudio(grooveSong());
    expect(separator()).toHaveAttribute("aria-valuenow", "320");
    await close();
    await userEvent.dblClick(clipButton(/^Groove A/));
    expect(await screen.findByRole("region", { name: "Editor: Groove A on Drums" })).toBeInTheDocument();
    expect(separator()).toHaveAttribute("aria-valuenow", "320");
  });

  it("reopens on Enter without also firing the native click", async () => {
    await renderStudio(grooveSong());
    await close();
    const el = clipButton(/^Groove A/);
    const click = vi.fn();
    el.addEventListener("click", click);
    el.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("region", { name: "Editor: Groove A on Drums" })).toBeInTheDocument();
    expect(el).toHaveAttribute("aria-current", "true");
    expect(click).not.toHaveBeenCalled();
  });

  it("only selects on Enter while the dock is open, leaving focus on the clip", async () => {
    await renderStudio(grooveSong());
    const el = clipButton(/^Groove A/);
    el.focus();
    await userEvent.keyboard("{Enter}");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(el).toHaveAttribute("aria-current", "true");
    expect(el).toHaveFocus();
  });

  it("moves focus to the selected clip when the dock closes", async () => {
    await renderStudio(grooveSong());
    await userEvent.click(clipButton(/^Groove A/));
    await close();
    await waitFor(() => expect(clipButton(/^Groove A/)).toHaveFocus());
  });

  it("moves focus to the arrangement when the dock closes with no clip selected", async () => {
    await renderStudio(clipSong([], []));
    await close();
    await waitFor(() => expect(screen.getByRole("region", { name: "Arrangement" })).toHaveFocus());
  });

  it("reopens when a clip is created by double-clicking an empty lane", async () => {
    await renderStudio(clipSong([], []));
    await close();
    fireEvent.doubleClick(laneOf("Drums"), { clientX: px(5) });
    expect(await screen.findByRole("region", { name: "Editor: Drums 1 on Drums" })).toBeInTheDocument();
  });

  it("stays closed across a remount", async () => {
    await renderStudio(grooveSong());
    await close();
    cleanup();
    // The in-memory copy would answer without reading storage, hiding a failure to persist.
    clearStoredValueCache();
    render(<StudioPage library={library} />);
    await screen.findByRole("region", { name: "Arrangement" });
    expect(screen.queryByRole("region", { name: /^Editor/ })).not.toBeInTheDocument();
  });

  it("is not undone by Cmd+Z, which undoes the last song edit instead", async () => {
    await renderStudio(grooveSong());
    await userEvent.click(screen.getByRole("button", { name: "Add track" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Piano" }));
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(3);
    await close();
    await userEvent.keyboard("{Meta>}z{/Meta}");
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(2);
    expect(screen.queryByRole("region", { name: /^Editor/ })).not.toBeInTheDocument();
  });
});
