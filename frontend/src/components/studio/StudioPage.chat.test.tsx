import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { ChatResponse } from "@/generated/ChatResponse";
import * as api from "@/lib/api";
import { createServerSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { newSong, newTrack, type Song } from "@/lib/song/types";
import { chatResult, heldChat } from "@/test/chatStream";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
  getSongLimits: vi.fn(),
  streamChat: vi.fn(),
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
let fake: ReturnType<typeof createFakeProjectsApi>;

function songOf(measures: number, loopRegion?: Song["loop_region"]): Song {
  const song = newSong();
  song.measures = measures;
  // Explicit tracks keep the group counts below independent of what a new song starts with.
  song.tracks = [newTrack("drums", "Drums"), newTrack("piano", "Piano")].map((t) => trackWithNotes(t, [note(t.instrument === "drums" ? "kick" : "c4", 0)], measures));
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
  fake = createFakeProjectsApi();
  library = createServerSongLibrary(fake.api);
  vi.mocked(api.getInstruments).mockResolvedValue([drums, piano]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("assistant chat", () => {
  it("builds a song one part at a time, sending the history each time", async () => {
    vi.mocked(api.streamChat)
      .mockImplementationOnce(chatResult(part("Piano", "piano")))
      .mockImplementationOnce(chatResult(part("Drums", "drums")));
    await renderStudio(songOf(4));
    await say("a piano that plays chords");
    expect(await screen.findByText("Added a Piano track.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toHaveValue("");
    expect(screen.getAllByRole("group", { name: /^Track \d+: Piano/ })).toHaveLength(2);

    await say("now the drums");
    await waitFor(() => expect(screen.getAllByRole("group", { name: /^Track \d+: Drums/ })).toHaveLength(2));
    const second = vi.mocked(api.streamChat).mock.calls[1][0];
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[2].content).toBe("now the drums");
    expect(second.range).toBeUndefined();
    expect(screen.getAllByText(/^Added track:/)).toHaveLength(2);
  });

  it("does not send on the Enter that confirms IME composition, including Safari's keyCode 229", async () => {
    await renderStudio(songOf(4));
    const input = screen.getByRole("textbox", { name: "Message the assistant" });
    await userEvent.type(input, "a bass");
    fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(input).toHaveValue("a bass");
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it("shows the sent message at once and empties the input while the reply is pending", async () => {
    const held = heldChat();
    vi.mocked(api.streamChat).mockImplementation(held.impl);
    await renderStudio(songOf(4));
    await say("a bass");
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(within(log).getByText("a bass")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toHaveValue("");
    expect(screen.getByText("Planning…")).toBeInTheDocument();
    await held.finish(part("Bass", "bass"));
    expect(await screen.findByText("Added a Bass track.")).toBeInTheDocument();
    expect(within(log).getAllByText("a bass")).toHaveLength(1);
    expect(screen.queryByText("Planning…")).not.toBeInTheDocument();
  });

  it("keeps the input usable but sends nothing while waiting", async () => {
    const held = heldChat();
    vi.mocked(api.streamChat).mockImplementation(held.impl);
    await renderStudio(songOf(4));
    await say("a bass");
    const input = screen.getByRole("textbox", { name: "Message the assistant" });
    expect(input).toBeEnabled();
    expect(input).toHaveFocus();
    await userEvent.type(input, "and drums{Enter}");
    expect(input).toHaveValue("and drums");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(api.streamChat).toHaveBeenCalledTimes(1);
    await held.finish(part("Bass", "bass"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    expect(input).toHaveValue("and drums");
  });

  it("keeps the pending message out of the song until the reply arrives", async () => {
    const held = heldChat();
    vi.mocked(api.streamChat).mockImplementation(held.impl);
    await renderStudio(songOf(4));
    await say("a bass");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    await act(async () => void (await library.flush()));
    const [saved] = await library.list();
    expect((await library.peek(saved.id))?.chat ?? []).toHaveLength(0);
    await held.finish(part("Bass", "bass"));
    await screen.findByText("Added a Bass track.");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Track removed");
    expect(screen.getAllByText("a bass")).toHaveLength(1);
  });

  it("shows a reply that says the track limit is reached without adding a track", async () => {
    vi.mocked(api.streamChat).mockImplementation(chatResult({ reply: "The song already has 16 tracks.", track: null }));
    await renderStudio(songOf(4));
    await say("one more");
    expect(await screen.findByText("The song already has 16 tracks.")).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(2);
  });

  it("leaves the song unchanged on failure, shows the error and keeps the message to retry", async () => {
    vi.mocked(api.streamChat).mockRejectedValue(
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

  it("does not overwrite text typed while waiting when the request fails", async () => {
    const held = heldChat();
    vi.mocked(api.streamChat).mockImplementation(held.impl);
    await renderStudio(songOf(4));
    await say("a bass");
    await userEvent.type(screen.getByRole("textbox", { name: "Message the assistant" }), "something else");
    await held.fail(new Error("boom"));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toHaveValue("something else");
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
  });

  it("sends the loop range of a long song and shows the server's request for one when absent", async () => {
    vi.mocked(api.streamChat)
      .mockImplementationOnce(chatResult({ reply: "Turn on looping and draw a loop region of 32 measures or fewer.", track: null }))
      .mockImplementationOnce(chatResult(part("Bass", "bass", 16)));
    await renderStudio(songOf(48));
    await say("a bass");
    expect(await screen.findByText(/Turn on looping/)).toBeInTheDocument();
    expect(vi.mocked(api.streamChat).mock.calls[0][0].range).toBeUndefined();
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(2);
  }, SLOW);

  it("sends the active loop region as the range", async () => {
    vi.mocked(api.streamChat).mockImplementation(chatResult({ reply: "ok", track: null }));
    await renderStudio(songOf(48, { enabled: true, region: { start_measure: 9, end_measure: 16 } }));
    await say("a bass");
    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    expect(vi.mocked(api.streamChat).mock.calls[0][0].range).toEqual({ start_measure: 9, end_measure: 16 });
  }, SLOW);

  it("names the instrument the assistant chose when the track name differs", async () => {
    vi.mocked(api.streamChat).mockImplementation(chatResult(part("Keys", "piano")));
    await renderStudio(songOf(4));
    await say("some keys");
    expect(await screen.findByText("Added track: Keys (Piano)")).toBeInTheDocument();
  });

  it("shows a finished message without the instrument while the instrument list is unavailable", async () => {
    vi.mocked(api.getInstruments).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.streamChat).mockImplementation(chatResult(part("Keys", "piano")));
    await renderStudio(songOf(4));
    await say("some keys");
    expect(await screen.findByText("Added track: Keys")).toBeInTheDocument();
    expect(screen.queryByText(/\(piano\)/)).not.toBeInTheDocument();
  });

  it("marks the reply when undo removes its track", async () => {
    vi.mocked(api.streamChat).mockImplementation(chatResult(part("Bass", "bass")));
    await renderStudio(songOf(4));
    await say("a bass");
    expect(await screen.findByText("Added track: Bass")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Track removed")).toBeInTheDocument();
    expect(screen.getByText("Added a Bass track.")).toBeInTheDocument();
  });

  it("restores the conversation after a reload", async () => {
    vi.mocked(api.streamChat)
      .mockImplementationOnce(chatResult({ reply: "one", track: null }))
      .mockImplementationOnce(chatResult({ reply: "two", track: null }))
      .mockImplementationOnce(chatResult({ reply: "three", track: null }));
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

  it("drops the pending message and re-enables sending when another song opens mid-request", async () => {
    const held = heldChat();
    vi.mocked(api.streamChat).mockImplementation(held.impl);
    await library.create({ ...songOf(4), name: "Alpha" });
    await library.create({ ...songOf(4), name: "Beta" });
    render(<StudioPage library={library} />);
    await screen.findByRole("region", { name: "Arrangement" });
    await say("a bass");
    expect(screen.getByText("Planning…")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Songs" }));
    const dialog = await screen.findByRole("dialog", { name: "Songs" });
    const other = within(dialog)
      .getAllByRole("button", { name: /^(Alpha|Beta)/ })
      .find((b) => !b.hasAttribute("aria-current"))!;
    await userEvent.click(other);

    await waitFor(() => expect(screen.queryByText("Planning…")).not.toBeInTheDocument());
    expect(screen.queryByText("a bass")).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Message the assistant" }), "next");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();

    expect(held.signal?.aborted).toBe(true);
    await held.finish(part("Bass", "bass"));
    expect(screen.queryByText("Added a Bass track.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    await act(async () => void (await library.flush()));
    for (const entry of await library.list()) expect((await library.peek(entry.id))?.chat ?? []).toHaveLength(0);
  });

  it("cancels the request without an error when the Studio unmounts", async () => {
    const held = heldChat();
    vi.mocked(api.streamChat).mockImplementation(held.impl);
    await renderStudio(songOf(4));
    await say("a bass");
    cleanup();
    expect(held.signal?.aborted).toBe(true);
  });
});

describe("assistant chat streaming", () => {
  const status = () => screen.getByTestId("assistant-status");

  async function startHeld() {
    const held = heldChat();
    vi.mocked(api.streamChat).mockImplementation(held.impl);
    await renderStudio(songOf(4));
    await say("some keys");
    return held;
  }

  it("shows each step and announces it without the ellipsis", async () => {
    const held = await startHeld();
    expect(screen.getByText("Planning…")).toBeInTheDocument();
    expect(status()).toHaveTextContent("Assistant is planning.");

    await held.emit({ event: "progress", data: { stage: "writing", name: "Keys", instrument: "piano" } });
    expect(screen.getByText("Writing Keys (Piano)…")).toBeInTheDocument();
    expect(screen.queryByText("Planning…")).not.toBeInTheDocument();
    expect(status()).toHaveTextContent("Assistant is writing Keys (Piano).");

    await held.finish(part("Keys", "piano"));
    expect(await screen.findByText("Added track: Keys (Piano)")).toBeInTheDocument();
    expect(status()).toBeEmptyDOMElement();
  });

  it("keeps the status region mounted while idle", async () => {
    await renderStudio(songOf(4));
    expect(status()).toBeEmptyDOMElement();
  });

  it("grows the streamed reply in place, outside the announced regions", async () => {
    const held = await startHeld();
    await held.emit({ event: "reply_delta", data: { text: "Here are " } });
    await held.emit({ event: "reply_delta", data: { text: "some keys." } });
    const text = screen.getByText("Here are some keys.");
    expect(text).toHaveAttribute("aria-live", "off");
    expect(within(screen.getByRole("log")).queryByText("Here are some keys.")).not.toBeInTheDocument();
    expect(status()).not.toHaveTextContent("some keys");
  });

  it("replaces the streamed text with the final reply when they differ", async () => {
    const held = await startHeld();
    await held.emit({ event: "reply_delta", data: { text: "Adding a seventeenth track." } });
    await held.finish({ reply: "The song already has 16 tracks.", track: null });
    expect(await screen.findByText("The song already has 16 tracks.")).toBeInTheDocument();
    expect(screen.queryByText("Adding a seventeenth track.")).not.toBeInTheDocument();
    expect(screen.queryByText("Planning…")).not.toBeInTheDocument();
  });

  it("clears the streamed text on reply_reset and says it is planning again", async () => {
    const held = await startHeld();
    await held.emit({ event: "reply_delta", data: { text: "First draft." } });
    await held.emit({ event: "reply_reset", data: {} });
    expect(screen.queryByText("First draft.")).not.toBeInTheDocument();
    expect(screen.getByText("Planning again…")).toBeInTheDocument();
    expect(status()).toHaveTextContent("Assistant is planning again.");
    await held.emit({ event: "reply_delta", data: { text: "Second draft." } });
    expect(screen.getByText("Second draft.")).toBeInTheDocument();
  });

  it("removes the pending message and streamed text when the stream fails, restoring the input", async () => {
    const held = await startHeld();
    await held.emit({ event: "reply_delta", data: { text: "Half a reply" } });
    await held.fail(new api.ApiError("network_error", "Could not reach the Songbird service.", 0));
    expect(await screen.findByRole("alert")).toHaveTextContent("The song is unchanged.");
    expect(screen.queryByText("Half a reply")).not.toBeInTheDocument();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toHaveValue("some keys");
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(2);
    expect(status()).toBeEmptyDOMElement();
  });

  it("adds no track before the result arrives", async () => {
    const held = await startHeld();
    await held.emit({ event: "progress", data: { stage: "writing", name: "Keys", instrument: "piano" } });
    expect(screen.getAllByRole("group", { name: /^Track \d+:/ })).toHaveLength(2);
    await held.finish(part("Keys", "piano"));
    await waitFor(() => expect(screen.getAllByRole("group", { name: /^Track \d+: Keys/ })).toHaveLength(1));
  });
});
