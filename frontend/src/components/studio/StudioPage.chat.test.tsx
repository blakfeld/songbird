import "fake-indexeddb/auto";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clear } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { ChatResponse } from "@/generated/ChatResponse";
import * as api from "@/lib/api";
import { createSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { newSong, type Song } from "@/lib/song/types";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
  getSongLimits: vi.fn(),
  sendChat: vi.fn(),
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


async function say(text: string) {
  await userEvent.type(screen.getByRole("textbox", { name: "Message the assistant" }), text);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
}

const part = (name: string, instrument: string, end = 4): ChatResponse => ({
  reply: `Added a ${name} track.`,
  track: { name, instrument, range: { start_measure: 1, end_measure: end }, notes: [note("c3", 0, 4)] },
});

beforeEach(async () => {
  localStorage.clear();
  await clear();
  library = createSongLibrary();
  vi.mocked(api.getInstruments).mockResolvedValue([drums, piano]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("assistant chat", () => {
  it("builds a song one part at a time, sending the history each time", async () => {
    vi.mocked(api.sendChat)
      .mockResolvedValueOnce(part("Piano", "piano"))
      .mockResolvedValueOnce(part("Drums", "drums"));
    await renderStudio(songOf(4));
    await say("a piano that plays chords");
    expect(await screen.findByText("Added a Piano track.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toHaveValue("");
    expect(screen.getAllByRole("group", { name: /^Track \d+: Piano/ })).toHaveLength(2);

    await say("now the drums");
    await waitFor(() => expect(screen.getAllByRole("group", { name: /^Track \d+: Drums/ })).toHaveLength(2));
    const second = vi.mocked(api.sendChat).mock.calls[1][0];
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[2].content).toBe("now the drums");
    expect(second.range).toBeUndefined();
    expect(screen.getAllByText(/^Added track:/)).toHaveLength(2);
  });

  it("disables the input while a request is in flight", async () => {
    let resolve!: (r: ChatResponse) => void;
    vi.mocked(api.sendChat).mockReturnValue(new Promise((r) => (resolve = r)));
    await renderStudio(songOf(4));
    await say("a bass");
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await act(async () => resolve(part("Bass", "bass")));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message the assistant" })).toBeEnabled());
  });

  it("shows a reply that says the track limit is reached without adding a track", async () => {
    vi.mocked(api.sendChat).mockResolvedValue({ reply: "The song already has 16 tracks.", track: null });
    await renderStudio(songOf(4));
    await say("one more");
    expect(await screen.findByText("The song already has 16 tracks.")).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(2);
  });

  it("leaves the song unchanged on failure, shows the error and keeps the message to retry", async () => {
    vi.mocked(api.sendChat).mockRejectedValue(
      new api.ApiError("generation_failed", "The AI could not generate a pattern. Please try again.", 502),
    );
    await renderStudio(songOf(4));
    await say("a bass");
    expect(await screen.findByRole("alert")).toHaveTextContent("could not generate");
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(2);
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toHaveValue("a bass");
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("sends the loop range of a long song and shows the server's request for one when absent", async () => {
    vi.mocked(api.sendChat)
      .mockResolvedValueOnce({ reply: "Turn on looping and draw a loop region of 32 measures or fewer.", track: null })
      .mockResolvedValueOnce(part("Bass", "bass", 16));
    await renderStudio(songOf(48));
    await say("a bass");
    expect(await screen.findByText(/Turn on looping/)).toBeInTheDocument();
    expect(vi.mocked(api.sendChat).mock.calls[0][0].range).toBeUndefined();
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(2);
  }, SLOW);

  it("sends the active loop region as the range", async () => {
    vi.mocked(api.sendChat).mockResolvedValue({ reply: "ok", track: null });
    await renderStudio(songOf(48, { enabled: true, region: { start_measure: 9, end_measure: 16 } }));
    await say("a bass");
    await waitFor(() => expect(api.sendChat).toHaveBeenCalled());
    expect(vi.mocked(api.sendChat).mock.calls[0][0].range).toEqual({ start_measure: 9, end_measure: 16 });
  }, SLOW);

  it("names the instrument the assistant chose when the track name differs", async () => {
    vi.mocked(api.sendChat).mockResolvedValue(part("Keys", "piano"));
    await renderStudio(songOf(4));
    await say("some keys");
    expect(await screen.findByText("Added track: Keys (Piano)")).toBeInTheDocument();
  });

  it("marks the reply when undo removes its track", async () => {
    vi.mocked(api.sendChat).mockResolvedValue(part("Bass", "bass"));
    await renderStudio(songOf(4));
    await say("a bass");
    expect(await screen.findByText("Added track: Bass")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Track removed")).toBeInTheDocument();
    expect(screen.getByText("Added a Bass track.")).toBeInTheDocument();
  });

  it("restores the conversation after a reload", async () => {
    vi.mocked(api.sendChat)
      .mockResolvedValueOnce({ reply: "one", track: null })
      .mockResolvedValueOnce({ reply: "two", track: null })
      .mockResolvedValueOnce({ reply: "three", track: null });
    await renderStudio(songOf(4));
    for (const m of ["a", "b", "c"]) {
      await say(m);
      await screen.findByText(m === "a" ? "one" : m === "b" ? "two" : "three");
    }
    await act(async () => void (await library.flush()));
    cleanup();
    render(<StudioPage library={library} />);
    await screen.findByRole("region", { name: "Arrangement" });
    const log = await screen.findByRole("log", { name: "Conversation" });
    expect(within(log).getAllByRole("listitem")).toHaveLength(6);
    expect(within(log).getByText("three")).toBeInTheDocument();
  });
});
