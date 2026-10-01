import "fake-indexeddb/auto";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clear } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { TrackGenerateResponse } from "@/generated/TrackGenerateResponse";
import * as api from "@/lib/api";
import { createSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { newSong, type Song } from "@/lib/song/types";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
  getSongLimits: vi.fn(),
  generateTrack: vi.fn(),
}));

// Playback pulls Tone.js in; generation never touches it.
const fakeEngine = {
  prepareLive: vi.fn(async () => {}),
  liveNoteOn: vi.fn(() => ({})),
  liveNoteOff: vi.fn(),
  liveBlocked: vi.fn(() => false),
  startMeasure: vi.fn(() => 1),
  stepAt: vi.fn(() => null),
  play: vi.fn(async () => {}),
  stop: vi.fn(),
  setMetronome: vi.fn(),
  subscribeCountIn: () => () => {},
  subscribeCountInEnd: () => () => {},
};
vi.mock("@/lib/audio/useSongPlayback", () => ({
  useSongPlayback: () => ({
    isPlaying: false,
    status: "idle",
    error: null,
    toggle: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    preload: vi.fn(),
    subscribePosition: () => () => {},
    audition: vi.fn(async () => {}),
    engine: fakeEngine,
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
    { id: "c3", name: "C3", midi_note: 48 },
  ],
};

// 48-measure songs render hundreds of clip cells, which is slow under a loaded runner.
const SLOW = 30_000;

let library: SongLibrary;

function songOf(measures: number, loopRegion?: Song["loop_region"]): Song {
  const song = newSong();
  song.measures = measures;
  song.tracks = song.tracks.map((t) => trackWithNotes(t, [note(t.instrument === "drums" ? "kick" : "c4", 0)], measures));
  if (loopRegion) song.loop_region = loopRegion;
  return song;
}

async function renderStudio(song: Song) {
  await library.create(song);
  render(<StudioPage library={library} />);
  await screen.findByRole("region", { name: "Arrangement" });
}

const lane = (name: string) => screen.getByRole("group", { name: new RegExp(`^Track \\d+: ${name}`) });

async function openGenerate(track: string) {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`^Track options for ${track}`) }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Generate part with AI/ }));
  return screen.findByRole("dialog", { name: `Generate ${track}` });
}

const response = (range = { start_measure: 1, end_measure: 4 }): TrackGenerateResponse => ({
  track_id: "x",
  range,
  notes: [note("c3", 0, 4)],
});

beforeEach(async () => {
  localStorage.clear();
  await clear();
  library = createSongLibrary();
  vi.mocked(api.getInstruments).mockResolvedValue([drums, piano]);
  vi.mocked(api.getSongLimits).mockResolvedValue({
    max_input_tokens: 256,
    max_range_measures: 32,
    max_song_measures: 128,
    max_tracks: 16,
    max_chat_messages: 20,
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("generate a track", () => {
  it("shows an error and leaves the track unchanged when generation fails", async () => {
    vi.mocked(api.generateTrack).mockRejectedValue(
      new api.ApiError("generation_failed", "The AI could not generate a pattern. Please try again.", 502),
    );
    await renderStudio(songOf(8));
    const dialog = await openGenerate("Piano");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Describe the part" }), "a bass line");
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));

    const alert = await within(await screen.findByRole("dialog", { name: "Generate Piano" })).findByRole("alert");
    expect(alert).toHaveTextContent("could not generate");
    expect(alert).toHaveTextContent("Piano is unchanged");
    expect(screen.getByRole("textbox", { name: "Describe the part" })).toHaveValue("a bass line");
    expect(within(lane("Piano")).getAllByTestId("clip-notes")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("does not offer the whole song for a 48-measure song", async () => {
    await renderStudio(songOf(48));
    const dialog = await openGenerate("Piano");
    expect(within(dialog).queryByRole("radio", { name: /Whole song/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Custom measures" })).toBeChecked();
  }, SLOW);

  it("defaults a one-measure song to a custom 1-8 span that may run past the song's end", async () => {
    vi.mocked(api.generateTrack).mockResolvedValue(response({ start_measure: 1, end_measure: 16 }));
    await renderStudio(songOf(1));
    const dialog = await openGenerate("Piano");
    expect(within(dialog).getByRole("radio", { name: "Custom measures" })).toBeChecked();
    expect(within(dialog).getByRole("spinbutton", { name: "From measure" })).toHaveValue(1);
    expect(within(dialog).getByRole("spinbutton", { name: "To measure" })).toHaveValue(8);
    const end = within(dialog).getByRole("spinbutton", { name: "To measure" });
    await userEvent.clear(end);
    await userEvent.type(end, "16");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Describe the part" }), "pad");
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(api.generateTrack).toHaveBeenCalled());
    expect(vi.mocked(api.generateTrack).mock.calls[0][0].range).toEqual({ start_measure: 1, end_measure: 16 });
    await waitFor(() => expect(lane("Piano").querySelectorAll("[data-clip-id]")).toHaveLength(1));
  });

  it("offers the whole song for a song of at most 32 measures", async () => {
    await renderStudio(songOf(32));
    const dialog = await openGenerate("Piano");
    expect(within(dialog).getByRole("radio", { name: /Whole song/ })).toBeChecked();
  });

  it("offers the loop range when looping is on and the region covers measures 9-16", async () => {
    vi.mocked(api.generateTrack).mockResolvedValue(response({ start_measure: 9, end_measure: 16 }));
    await renderStudio(songOf(48, { enabled: true, region: { start_measure: 9, end_measure: 16 } }));
    const dialog = await openGenerate("Piano");
    const option = within(dialog).getByRole("radio", { name: "Loop range (measures 9–16)" });
    expect(option).toBeChecked();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Describe the part" }), "pad");
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(api.generateTrack).toHaveBeenCalled());
    expect(vi.mocked(api.generateTrack).mock.calls[0][0]).toMatchObject({
      prompt: "pad",
      range: { start_measure: 9, end_measure: 16 },
    });
  }, SLOW);

  it("does not offer the loop range while looping is off", async () => {
    await renderStudio(songOf(48, { enabled: false, region: { start_measure: 9, end_measure: 16 } }));
    const dialog = await openGenerate("Piano");
    expect(within(dialog).queryByRole("radio", { name: /Loop range/ })).not.toBeInTheDocument();
  }, SLOW);

  it("does not offer the loop range when looping has no region", async () => {
    await renderStudio(songOf(48, { enabled: true, region: null }));
    const dialog = await openGenerate("Piano");
    expect(within(dialog).queryByRole("radio", { name: /Loop range/ })).not.toBeInTheDocument();
  }, SLOW);

  it("does not offer a region that covers the whole song", async () => {
    await renderStudio(songOf(16, { enabled: true, region: { start_measure: 1, end_measure: 16 } }));
    const dialog = await openGenerate("Piano");
    expect(within(dialog).queryByRole("radio", { name: /Loop range/ })).not.toBeInTheDocument();
  }, SLOW);

  it("rejects a custom span over 32 measures", async () => {
    await renderStudio(songOf(48));
    const dialog = await openGenerate("Piano");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Describe the part" }), "pad");
    const end = within(dialog).getByRole("spinbutton", { name: "To measure" });
    await userEvent.clear(end);
    await userEvent.type(end, "40");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("at most 32");
    expect(within(dialog).getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("blocks submission over the token limit", async () => {
    await renderStudio(songOf(8));
    const dialog = await openGenerate("Piano");
    await userEvent.click(within(dialog).getByRole("textbox", { name: "Describe the part" }));
    await userEvent.paste("x".repeat(1100));
    expect(within(dialog).getByText(/Too long/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("closes on Cancel without generating", async () => {
    await renderStudio(songOf(8));
    const dialog = await openGenerate("Piano");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Describe the part" })).not.toBeInTheDocument());
    expect(api.generateTrack).not.toHaveBeenCalled();
  });

  it("locks the target track while in flight and keeps other tracks editable, then applies the result", async () => {
    let resolve!: (r: TrackGenerateResponse) => void;
    vi.mocked(api.generateTrack).mockReturnValue(new Promise((r) => (resolve = r)));
    await renderStudio(songOf(8));
    await userEvent.click(screen.getByRole("button", { name: /^Select Piano track/ }));
    const dialog = await openGenerate("Piano");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Describe the part" }), "pad");
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(within(lane("Piano")).getByText("Generating…")).toBeInTheDocument());
    const pianoClips = lane("Piano").querySelector("[aria-busy='true']");
    expect(pianoClips).toHaveAttribute("inert");
    expect(lane("Drums").querySelector("[inert]")).toBeNull();
    expect(screen.getByRole("region", { name: /^Editor: .* on Piano/ }).querySelector("[inert]")).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Track options for Drums" }));
    expect(screen.getByRole("menuitem", { name: /Generate part with AI/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");

    await act(async () => resolve(response({ start_measure: 1, end_measure: 4 })));
    await waitFor(() => expect(within(lane("Piano")).queryByText("Generating…")).not.toBeInTheDocument());
    expect(lane("Piano").querySelectorAll("[data-clip-id]")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("keeps the track's sound when a part is generated into it", async () => {
    vi.mocked(api.generateTrack).mockResolvedValue(response());
    const song = songOf(8);
    const sound = { tone: { filter_cutoff_hz: 400 } };
    song.tracks = song.tracks.map((t) => (t.instrument === "piano" ? { ...t, sound } : t));
    await renderStudio(song);
    const dialog = await openGenerate("Piano");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Describe the part" }), "a bass line");
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());

    const saved = await library.peek(song.id);
    expect(saved?.tracks.find((t) => t.instrument === "piano")?.sound).toEqual(sound);
  });
});
