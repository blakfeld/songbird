import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clear } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import * as api from "@/lib/api";
import { cellLabel } from "@/lib/pianoRoll";
import { createSongLibrary, idbKeyValueStore, songKey, type SongLibrary } from "@/lib/song/songLibrary";
import { newSong, newTrack, type Clip, type Loop, type Song } from "@/lib/song/types";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
}));

const audition = vi.fn(async () => {});
const seekTo = vi.fn();
const positionListeners = new Set<(position: number | null) => void>();
const toggle = vi.fn();
// The engine has its own tests; here it would only pull Tone.js into every page render.
vi.mock("@/lib/audio/useSongPlayback", () => ({
  useSongPlayback: () => ({
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

// The dock edits a clip's loop, so the default song needs one on each track to have anything to click.
function songWithDrumLoop(): Song {
  const song = newSong();
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
    const song = newSong();
    song.tracks[1] = trackWithNotes(song.tracks[1], [note("c4", 0, 2), note("b3", 4)], song.measures);
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
    const song = newSong();
    song.tracks[1] = trackWithNotes(song.tracks[1], [note("c4", 8, 2, 80)], song.measures);
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

describe("songs that cannot be opened", () => {
  const broken = () => {
    const song = { ...newSong(), name: "Broken" };
    return { ...song, tracks: [{ ...song.tracks[0], loops: [null] }, song.tracks[1]] };
  };

  it("says a requested song could not be opened, not that it was missing", async () => {
    const bad = broken();
    await idbKeyValueStore().set(songKey(bad.id), bad);
    await library.create({ ...newSong(), name: "Fine" });
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

function clipSong(drumsLoops: Loop[], drumsClips: Clip[], measures = 16): Song {
  const song = newSong();
  song.measures = measures;
  song.tracks[0] = { ...song.tracks[0], loops: drumsLoops, clips: drumsClips };
  return song;
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

  it("creates a 4-measure clip on double-click in an empty lane and selects it", async () => {
    await renderStudio(clipSong([], []));
    fireEvent.doubleClick(laneOf("Drums"), { clientX: px(5) });
    const created = await screen.findByRole("button", { name: "Drums 1, measures 5 to 8" });
    expect(created).toHaveAttribute("aria-current", "true");
    expect(dockRegion()).toHaveAccessibleName("Editor: Drums 1 on Drums");
    expect(within(dockRegion()).getByRole("button", { name: cellLabel("Kick", 3 * 16, 16) })).toBeInTheDocument();
    expect(within(dockRegion()).queryByRole("button", { name: cellLabel("Kick", 4 * 16, 16) })).not.toBeInTheDocument();
    expect(within(dockRegion()).queryAllByTestId("note")).toHaveLength(0);
  });

  it("shortens a new clip to fit before its neighbour", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 7, 2)]));
    fireEvent.doubleClick(laneOf("Drums"), { clientX: px(5) });
    expect(await screen.findByRole("button", { name: "Drums 1, measures 5 to 6" })).toBeInTheDocument();
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
    await renderStudio(clipSong([L("a", "Groove A", 2)], [C("c1", "a", 1, 2)]));
    const block = clipButton(/^Groove A/);
    const handle = block.querySelector("[data-handle]")!;
    drag(handle, px(2), px(2) + 600);
    expect(clipButton("Groove A, measures 1 to 8, loop plays 4 times")).toBeInTheDocument();
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
    await renderStudio(clipSong([L("a", "Groove A", 4)], [C("c1", "a", 1, 4)], 4));
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
    expect(await screen.findByRole("button", { name: /^Drums 1, measures 6 to 9/ })).toBeInTheDocument();
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
    await userEvent.click(within(dockRegion()).getByTestId("note"));
    expect(within(dockRegion()).queryAllByTestId("note")).toHaveLength(0);
    expect(within(laneOf("Drums")).getAllByTestId("clip-notes")).toHaveLength(1);
    await userEvent.click(clipButton(/^Groove A, measures 1 to 2/));
    expect(within(dockRegion()).getAllByTestId("note")).toHaveLength(1);
  });

  it("announces a shortened loop when only a crossing note was truncated", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 4, [note("kick", 31, 4)])], [C("c1", "a", 1, 4)]));
    const field = within(dockRegion()).getByRole("spinbutton", { name: "Loop length" });
    await userEvent.clear(field);
    await userEvent.type(field, "2{Enter}");
    expect(status()).toHaveTextContent("Loop shortened to 2 bars.");
  });

  it("stays quiet when shortening a loop touches no note", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 4, [note("kick", 0)])], [C("c1", "a", 1, 4)]));
    const field = within(dockRegion()).getByRole("spinbutton", { name: "Loop length" });
    await userEvent.clear(field);
    await userEvent.type(field, "2{Enter}");
    expect(status()).toHaveTextContent("");
  });

  it("shortens a loop without changing its clips", async () => {
    await renderStudio(
      clipSong([L("a", "Groove A", 4, [note("kick", 0), note("kick", 2 * 16)])], [C("c1", "a", 1, 4)]),
    );
    const field = within(dockRegion()).getByRole("spinbutton", { name: "Loop length" });
    await userEvent.clear(field);
    await userEvent.type(field, "2{Enter}");
    expect(clipButton("Groove A, measures 1 to 4, loop plays 2 times")).toBeInTheDocument();
    expect(within(dockRegion()).getAllByTestId("note")).toHaveLength(1);
    expect(status()).toHaveTextContent("Loop shortened to 2 bars. Notes after bar 2 were removed. Undo to restore.");
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
    expect(add).toHaveAccessibleDescription("Adds measures 1–4");
    await userEvent.click(add);
    expect(await screen.findByRole("button", { name: "Drums 1, measures 1 to 4" })).toBeInTheDocument();
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

  it("announces clips being trimmed when the song is shortened", async () => {
    await renderStudio(clipSong([L("a", "Groove A", 2, [note("kick", 0)])], [C("c1", "a", 7, 6)], 16));
    const length = screen.getByRole("spinbutton", { name: "Length" });
    await userEvent.clear(length);
    await userEvent.type(length, "8{Enter}");
    expect(status()).toHaveTextContent("Shortened to 8 bars. Clips after bar 8 were trimmed or removed. Undo to restore.");
    expect(clipButton(/^Groove A, measures 7 to 8/)).toBeInTheDocument();
  });
});
