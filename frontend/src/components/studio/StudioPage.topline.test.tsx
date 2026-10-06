import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Note } from "@/generated/Note";
import type { ToplineResponse } from "@/generated/ToplineResponse";
import type { ToplineSource } from "@/generated/ToplineSource";
import * as api from "@/lib/api";
import { createServerSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { newSong, newTrack, type Section, type Song } from "@/lib/song/types";
import { syllabifyLine } from "@/lib/topline/syllabify";
import { clearStoredValueCache } from "@/lib/useStoredValue";
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
  getSongLimits: vi.fn(),
  generateTopline: vi.fn(),
}));

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

const melodic = (id: string, name: string, low: number, high: number): InstrumentInfo => ({
  id,
  name,
  kind: "melodic",
  midi_program: 0,
  range: { low, high },
  midi_channel: 1,
  sustained: true,
  rows: [
    { id: "e4", name: "E4", midi_note: 64 },
    { id: "c4", name: "C4", midi_note: 60 },
  ],
});
const piano = melodic("piano", "Piano", 48, 84);
const vocal = melodic("vocal", "Vocal Guide", 40, 84);

const section = (id: string, name: string, measures: number): Section => ({
  id,
  name,
  kind: "other",
  measures,
  notes: "",
});

const LYRICS = "[Verse]\nsome words here\n\n[Chorus]\nhold me close\nnever let go\n";

function songOf(over: Partial<Song> = {}): Song {
  const song = newSong();
  song.measures = 12;
  song.sections = [section("v", "Verse", 4), section("c", "Chorus", 4), section("b", "Bridge", 4)];
  song.lyrics = LYRICS;
  song.tracks = [newTrack("drums", "Drums"), newTrack("piano", "Piano")].map((t) =>
    trackWithNotes(t, [note(t.instrument === "drums" ? "kick" : "c4", 0)], 12),
  );
  return { ...song, ...over };
}

let library: SongLibrary;
let fake: ReturnType<typeof createFakeProjectsApi>;

async function renderStudio(song: Song = songOf()) {
  const created = await library.create(song);
  render(<StudioPage library={library} />);
  await screen.findByRole("region", { name: "Arrangement" });
  return created;
}

const menuFor = async (name: string) => {
  await userEvent.click(screen.getAllByRole("button", { name: `Section actions for ${name}` })[0]);
  return screen.getByRole("menu", { name: `Section actions for ${name}` });
};

async function openDialog(name = "Chorus") {
  const menu = await menuFor(name);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Generate topline…" }));
  return screen.findByRole("dialog", { name: "Generate topline" });
}

const syllableCount = (text: string) => syllabifyLine(text).length;

const lyricNote = (row: string, step: number, lyric: string): Note => ({ ...note(row, step, 2), lyric });

function responseFor(): ToplineResponse {
  const syl = syllabifyLine("hold me close never let go");
  return {
    track_id: "x",
    range: { start_measure: 5, end_measure: 8 },
    notes: syl.map((s, i) => lyricNote("c4", i * 2, s.text)),
    prosody: { stressed_syllables: 4, stressed_on_beat: 3 },
  };
}

beforeEach(() => {
  localStorage.clear();
  clearStoredValueCache();
  fake = createFakeProjectsApi();
  library = createServerSongLibrary(fake.api);
  vi.mocked(api.getInstruments).mockResolvedValue([drums, piano, vocal]);
  vi.mocked(api.getSongLimits).mockResolvedValue({ max_input_tokens: 256 } as Awaited<ReturnType<typeof api.getSongLimits>>);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("topline entry points", () => {
  it("offers the action in the menu of a section with a heading", async () => {
    await renderStudio();
    const menu = await menuFor("Chorus");
    expect(within(menu).getByRole("menuitem", { name: "Generate topline…" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("disables it with a hint for a section without a heading", async () => {
    await renderStudio();
    const menu = await menuFor("Bridge");
    const item = within(menu).getByRole("menuitem", { name: "Generate topline…" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByText(/Add a \[Bridge\] heading/)).toBeInTheDocument();
    await userEvent.click(item);
    expect(screen.queryByRole("dialog", { name: "Generate topline" })).not.toBeInTheDocument();
  });
});

describe("topline dialog", () => {
  it("shows the section, its syllables with stress marks, and the voice defaulting to Tenor", async () => {
    await renderStudio();
    const dialog = await openDialog();
    expect(within(dialog).getByText(/Chorus, measures 5 to 8/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "hold", pressed: true })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: "me", pressed: false })).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).getByRole("combobox", { name: "Voice" })).toHaveValue("tenor");
  });

  it("toggles a syllable's stress and re-splits a word", async () => {
    vi.mocked(api.generateTopline).mockResolvedValue(responseFor());
    await renderStudio(songOf({ lyrics: "[Chorus]\nevery night\n" }));
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "night", pressed: true }));
    expect(within(dialog).getByRole("button", { name: "night", pressed: false })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit split of every" }));
    const input = within(dialog).getByRole("textbox", { name: "Split every with hyphens" });
    await userEvent.clear(input);
    await userEvent.type(input, "ev-ry{Enter}");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/letters must stay the same/);
    await userEvent.clear(input);
    await userEvent.type(input, "ev-ery{Enter}");
    expect(within(dialog).getByRole("button", { name: "ev-", pressed: true })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "ery", pressed: false })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(api.generateTopline).toHaveBeenCalled());
    const sent = vi.mocked(api.generateTopline).mock.calls[0][0];
    expect(sent.lines[0].syllables).toEqual([
      { text: "ev-", stressed: true },
      { text: "ery", stressed: false },
      { text: "night", stressed: false },
    ]);
  });

  it("warns and disables Generate when the syllables do not fit the section", async () => {
    const lines = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen";
    expect(syllableCount(lines)).toBeGreaterThan(16);
    await renderStudio(songOf({ sections: [section("c", "Chorus", 1), section("v", "Verse", 11)], lyrics: `[Chorus]\n${lines}\n` }));
    const dialog = await openDialog();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/do not fit/);
    expect(within(dialog).getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("offers melodic tracks and a new Vocal track but not drums", async () => {
    await renderStudio();
    const dialog = await openDialog();
    const options = within(within(dialog).getByRole("combobox", { name: "Target track" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["New Vocal track", "Piano"]);
  });

  it("generates onto a new Vocal track in one undo step and reports the prosody", async () => {
    vi.mocked(api.generateTopline).mockResolvedValue(responseFor());
    await renderStudio();
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Generate topline" })).not.toBeInTheDocument());
    expect(screen.getByText(/3 of 4 stressed syllables on the beat/)).toBeInTheDocument();
    const sent = vi.mocked(api.generateTopline).mock.calls[0][0];
    expect(sent).toMatchObject({ section_name: "Chorus", voice: "tenor", range: { start_measure: 5, end_measure: 8 }, prompt: "" });
    expect(sent.song.tracks.some((t) => t.id === sent.track_id)).toBe(true);
    expect(screen.getByRole("group", { name: /^Track 3: Vocal/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByRole("group", { name: /^Track 3: Vocal/ })).not.toBeInTheDocument();
  });

  it("shows the failure and leaves the song unchanged", async () => {
    vi.mocked(api.generateTopline).mockRejectedValue(
      new api.ApiError("generation_failed", "The AI could not generate a pattern. Please try again.", 502),
    );
    await renderStudio();
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/could not generate/);
    expect(screen.queryByRole("group", { name: /^Track 3: Vocal/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("returns focus to the word's edit button after a re-split and after Escape", async () => {
    await renderStudio(songOf({ lyrics: "[Chorus]\nevery night\n" }));
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit split of every" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Split every with hyphens" }), "{Enter}");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Edit split of every" })).toHaveFocus());
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit split of every" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Edit split of every" })).toHaveFocus());
    expect(dialog).toBeVisible();
  });

  it("refuses before sending when a line is longer than the server accepts", async () => {
    await renderStudio(songOf({ lyrics: `[Chorus]\n${"strengths ".repeat(21)}\n` }));
    const dialog = await openDialog();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/at most 200 characters/);
    expect(within(dialog).getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(api.generateTopline).not.toHaveBeenCalled();
  });

  it("aborts the request, releases the track and says so when the dialog is cancelled mid-request", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(api.generateTopline).mockImplementationOnce(
      (_body, s) =>
        new Promise((_, reject) => {
          signal = s;
          s?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await renderStudio();
    const dialog = await openDialog();
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Target track" }), "Piano");
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(signal).toBeDefined());
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText("Topline generation cancelled.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Generate topline" })).not.toBeInTheDocument();

    // The lock is gone, so the same track can be generated again at once.
    vi.mocked(api.generateTopline).mockResolvedValue(responseFor());
    const again = await openDialog();
    await userEvent.selectOptions(within(again).getByRole("combobox", { name: "Target track" }), "Piano");
    await userEvent.click(within(again).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Generate topline" })).not.toBeInTheDocument());
    expect(screen.queryByText(/already being generated/)).not.toBeInTheDocument();
  });

  it("replaces the generating message with the failure in the status line", async () => {
    vi.mocked(api.generateTopline).mockRejectedValue(
      new api.ApiError("generation_failed", "The AI could not generate a pattern. Please try again.", 502),
    );
    await renderStudio();
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    await within(dialog).findByRole("alert");
    expect(screen.getByText(/Topline generation failed\. The AI could not generate/)).toBeInTheDocument();
    expect(screen.queryByText(/Generating a topline/)).not.toBeInTheDocument();
  });

  it("places the melody on every same-named section when asked", async () => {
    vi.mocked(api.generateTopline).mockResolvedValue(responseFor());
    const song = songOf({ sections: [section("v", "Verse", 4), section("c", "Chorus", 4), section("c2", "Chorus", 4)] });
    await renderStudio(song);
    const dialog = await openDialog();
    expect(within(dialog).getByRole("checkbox", { name: /Place on every Chorus/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Generate topline" })).not.toBeInTheDocument());
    const lane = screen.getByRole("group", { name: /^Track 3: Vocal/ });
    await waitFor(() => expect(lane.querySelectorAll("[data-clip-id]")).toHaveLength(2));
  });
});

describe("topline loops in the dock", () => {
  const source: ToplineSource = {
    section_name: "Chorus",
    voice: "tenor",
    lines: [
      { text: "hold me close", syllables: syllabifyLine("hold me close") },
      { text: "never let go", syllables: syllabifyLine("never let go") },
    ],
  };

  function withVocalLoop(lyrics: string, notes: Note[]): Song {
    const song = songOf({ lyrics });
    const vocalTrack = trackWithNotes(newTrack("vocal", "Vocal"), notes, 4);
    vocalTrack.loops = [{ ...vocalTrack.loops[0], topline: source }];
    vocalTrack.clips = [{ ...vocalTrack.clips[0], start_measure: 5 }];
    return { ...song, tracks: [vocalTrack, ...song.tracks] };
  }

  const placed = syllabifyLine("hold me close never let go").map((s, i) => lyricNote("c4", i * 2, s.text));

  it("shows no stale notice while the lyrics match the source", async () => {
    await renderStudio(withVocalLoop(LYRICS, placed));
    await screen.findByRole("button", { name: "Re-flow lyrics" });
    expect(screen.queryByText(/lyrics have changed/)).not.toBeInTheDocument();
  });

  it("flags changed lyrics and offers Regenerate with the earlier corrections kept", async () => {
    const corrected: ToplineSource = {
      ...source,
      lines: [{ text: "every night", syllables: [{ text: "ev-", stressed: true }, { text: "ery", stressed: false }, ...syllabifyLine("night")] }],
    };
    const song = withVocalLoop("[Chorus]\nevery night\nand something new\n", placed);
    song.tracks[0].loops[0].topline = corrected;
    await renderStudio(song);
    expect(await screen.findByText(/Chorus lyrics have changed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    const dialog = await screen.findByRole("dialog", { name: "Generate topline" });
    expect(within(dialog).getByRole("button", { name: "ev-", pressed: true })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "ery", pressed: false })).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Target track" })).toHaveDisplayValue("Vocal");
  });

  it("re-flows the syllables and reports how many found no note", async () => {
    await renderStudio(withVocalLoop(LYRICS, placed.slice(0, 4).map((n) => ({ ...n, lyric: undefined }))));
    await userEvent.click(await screen.findByRole("button", { name: "Re-flow lyrics" }));
    const strip = screen.getByRole("button", { name: "Re-flow lyrics" }).parentElement!;
    expect(strip).toHaveTextContent("Lyrics re-flowed. 3 syllables have no note.");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });
});
