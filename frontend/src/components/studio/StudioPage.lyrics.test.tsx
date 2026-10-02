import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResponse } from "@/generated/ChatResponse";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import * as api from "@/lib/api";
import { createServerSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { newSong, newTrack, type Song } from "@/lib/song/types";
import { clearStoredValueCache } from "@/lib/useStoredValue";
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { RIGHT_TAB_KEY } from "./RightColumnTabs";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
  getSongLimits: vi.fn(),
  sendChat: vi.fn(),
}));

const toggle = vi.fn();
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
    toggle,
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

let library: SongLibrary;
let fake: ReturnType<typeof createFakeProjectsApi>;

function songOf(): Song {
  const song = newSong();
  song.measures = 4;
  song.tracks = [newTrack("drums", "Drums"), newTrack("piano", "Piano")].map((t) =>
    trackWithNotes(t, [note(t.instrument === "drums" ? "kick" : "c4", 0)], 4),
  );
  return song;
}

async function renderStudio(tab?: "lyrics") {
  if (tab) localStorage.setItem(RIGHT_TAB_KEY, tab);
  const song = await library.create(songOf());
  render(<StudioPage library={library} />);
  await screen.findByRole("region", { name: "Arrangement" });
  return song;
}

const notepad = () => screen.findByRole("textbox", { name: "Lyrics" });
const viewOf = (el: HTMLElement) => EditorView.findFromDOM(el.closest(".cm-editor") as HTMLElement)!;

// jsdom cannot produce the input events CodeMirror reads typed characters from, so edits go in as the
// transactions those events would become.
function type(el: HTMLElement, insert: string) {
  const view = viewOf(el);
  act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert }, userEvent: "input.type" });
  });
}

const tonic = () => screen.getByRole("combobox", { name: "Key tonic" });

beforeEach(() => {
  localStorage.clear();
  clearStoredValueCache();
  fake = createFakeProjectsApi();
  library = createServerSongLibrary(fake.api);
  toggle.mockClear();
  vi.mocked(api.getInstruments).mockResolvedValue([drums, piano]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("right column tabs", () => {
  it("shows the assistant first and swaps to the notepad, keeping chat history", async () => {
    const reply: ChatResponse = { reply: "Added a Bass track.", track: null };
    vi.mocked(api.sendChat).mockResolvedValue(reply);
    await renderStudio();
    expect(screen.getByRole("tab", { name: "Assistant" })).toHaveAttribute("aria-selected", "true");
    await userEvent.type(screen.getByRole("textbox", { name: "Message the assistant" }), "a bass");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Added a Bass track.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    expect(await notepad()).toBeInTheDocument();
    expect(screen.queryByText("Added a Bass track.")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Assistant" }));
    expect(screen.getByText("Added a Bass track.")).toBeInTheDocument();
    expect(localStorage.getItem(RIGHT_TAB_KEY)).toBe("assistant");
  });

  it("moves between tabs with the arrow keys", async () => {
    await renderStudio();
    screen.getByRole("tab", { name: "Assistant" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Lyrics" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Lyrics" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Section" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Assistant" })).toHaveAttribute("aria-selected", "true");
  });

  it("restores the selected tab from storage", async () => {
    await renderStudio("lyrics");
    expect(screen.getByRole("tab", { name: "Lyrics" })).toHaveAttribute("aria-selected", "true");
    expect(await notepad()).toBeInTheDocument();
  });

  it("falls back to the assistant when storage throws", async () => {
    const real = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key === RIGHT_TAB_KEY) throw new Error("blocked");
      return real.call(this, key);
    });
    await renderStudio();
    expect(screen.getByRole("tab", { name: "Assistant" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("lyrics drawer", () => {
  it("keeps typed text across closing and reopening", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Lyrics" }));
    const dialog = screen.getByRole("dialog", { name: "Lyrics" });
    type(await within(dialog).findByRole("textbox", { name: "Lyrics" }), "a line");

    // The native dialog's own close event, which Escape and the backdrop raise.
    fireEvent(dialog, new Event("close"));
    await waitFor(() => expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Lyrics" }));
    const reopened = await within(screen.getByRole("dialog", { name: "Lyrics" })).findByRole("textbox", {
      name: "Lyrics",
    });
    expect(viewOf(reopened).state.doc.toString()).toBe("a line");
  });
});

describe("lyrics and the song", () => {
  it("keeps lyrics when the Undo button reverts an arrangement edit", async () => {
    await renderStudio("lyrics");
    await userEvent.selectOptions(tonic(), "A");
    type(await notepad(), "[Chorus]\nla la");
    fireEvent.blur(await notepad());
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(tonic()).toHaveValue("C");
    expect(viewOf(await notepad()).state.doc.toString()).toBe("[Chorus]\nla la");
  });

  it("autosaves lyrics with the song", async () => {
    const song = await renderStudio("lyrics");
    type(await notepad(), "saved words");
    fireEvent.blur(await notepad());
    await library.flush();
    expect((await library.open(song.id))!.lyrics).toBe("saved words");
  });
});

describe("switching songs", () => {
  it("saves typing that has not yet synced to the song it was typed in", async () => {
    const first = await renderStudio("lyrics");
    // The debounce would otherwise sync the text during the awaits below, which is the case that needs no flush.
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
      typeof fn === "function" && fn.name === "flush" ? 0 : realSetTimeout(fn, ms, ...args)) as typeof setTimeout);
    const other = await library.create({ ...songOf(), name: "Other song" });
    type(await notepad(), "last words");

    await userEvent.click(screen.getByRole("button", { name: "Songs" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Other song/ }));
    await screen.findByRole("button", { name: "Rename song Other song" });

    await library.flush();
    expect((await library.open(first.id))!.lyrics).toBe("last words");
    expect((await library.open(other.id))!.lyrics).toBeUndefined();
    expect(viewOf(await notepad()).state.doc.toString()).toBe("");
  });
});

describe("notepad keyboard isolation", () => {
  // fireEvent returns false when a handler called preventDefault, which is how a shortcut claims a key.
  it("types Space and r instead of toggling playback or recording", async () => {
    await renderStudio("lyrics");
    expect(fireEvent.keyDown(document.body, { key: " ", code: "Space" })).toBe(false);
    expect(toggle).toHaveBeenCalledTimes(1);
    toggle.mockClear();
    expect(fireEvent.keyDown(document.body, { key: "r" })).toBe(false);

    const el = await notepad();
    el.focus();
    expect(fireEvent.keyDown(el, { key: " ", code: "Space" })).toBe(true);
    expect(fireEvent.keyDown(el, { key: "r" })).toBe(true);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("does not duplicate a clip with Ctrl+D", async () => {
    await renderStudio("lyrics");
    const el = await notepad();
    el.focus();
    const clips = () => document.querySelectorAll("[data-clip-id]").length;
    const before = clips();
    expect(before).toBeGreaterThan(0);
    await userEvent.click(document.querySelector("[data-clip-id]")!);
    el.focus();
    expect(fireEvent.keyDown(el, { key: "d", ctrlKey: true })).toBe(true);
    expect(clips()).toBe(before);
  });

  it("undoes text with Ctrl+Z without changing the arrangement", async () => {
    await renderStudio("lyrics");
    await userEvent.selectOptions(tonic(), "A");
    const el = await notepad();
    type(el, "typed");
    el.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(viewOf(el).state.doc.toString()).toBe("");
    expect(tonic()).toHaveValue("A");
  });

  it("moves focus out with Tab and leaves the lyrics alone", async () => {
    await renderStudio("lyrics");
    const el = await notepad();
    type(el, "kept");
    el.focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("tab", { name: "Lyrics" })).toHaveFocus();
    el.focus();
    await userEvent.tab();
    expect(el).not.toHaveFocus();
    expect(viewOf(el).state.doc.toString()).toBe("kept");
  });
});
