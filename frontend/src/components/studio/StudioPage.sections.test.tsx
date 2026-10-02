import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createServerSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { newSong, newTrack, type Section, type Song } from "@/lib/song/types";
import { clearStoredValueCache } from "@/lib/useStoredValue";
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { RIGHT_TAB_KEY } from "./RightColumnTabs";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
  getSongLimits: vi.fn(),
  streamChat: vi.fn(),
  generateTrack: vi.fn(),
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

const section = (id: string, name: string, kind: Section["kind"], measures: number): Section => ({
  id,
  name,
  kind,
  measures,
  notes: "",
});

// Drums play in the Verse and the Chorus, so structural edits have clips to move.
function songOf(sections: Section[] | null, measures = 16): Song {
  const song = newSong();
  const drumsTrack = trackWithNotes(newTrack("drums", "Drums"), [note("kick", 0)], 1);
  drumsTrack.clips = [
    { id: "d1", loop_id: drumsTrack.loops[0].id, start_measure: 1, measures: 1 },
    { id: "d2", loop_id: drumsTrack.loops[0].id, start_measure: measures !== 16 ? 2 : sections ? 9 : 16, measures: 1 },
  ];
  song.tracks = [drumsTrack];
  song.measures = measures;
  if (sections) song.sections = sections;
  return song;
}

const SECTIONS = [section("v", "Verse", "verse", 8), section("c", "Chorus", "chorus", 8)];

let library: SongLibrary;
let fake: ReturnType<typeof createFakeProjectsApi>;

async function renderStudio(song: Song = songOf(SECTIONS)) {
  const created = await library.create(song);
  render(<StudioPage library={library} />);
  await screen.findByRole("region", { name: "Arrangement" });
  return created;
}

const label = (name: string) => screen.getByRole("button", { name });
const loopLabel = (text: RegExp) => screen.queryByLabelText(text);

beforeEach(() => {
  localStorage.clear();
  clearStoredValueCache();
  fake = createFakeProjectsApi();
  library = createServerSongLibrary(fake.api);
  toggle.mockClear();
  vi.mocked(api.getInstruments).mockResolvedValue([drums]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("section selection on the song page", () => {
  it("selecting a section with looping off sets the region to its measures and turns looping on", async () => {
    await renderStudio();
    expect(loopLabel(/Loop region, .*looping/)).toBeNull();
    await userEvent.click(label("Chorus, measures 9 to 16"));
    expect(label("Chorus, measures 9 to 16")).toHaveAttribute("aria-pressed", "true");
    expect(loopLabel(/Loop region, measures 9 to 16, looping on/)).toBeInTheDocument();
    expect(screen.getByText("Chorus selected. Looping measures 9 to 16.")).toBeInTheDocument();
  });

  it("selecting is not an undo step", async () => {
    await renderStudio();
    await userEvent.click(label("Chorus, measures 9 to 16"));
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("clearing the selection leaves the loop as it was", async () => {
    await renderStudio();
    await userEvent.click(label("Chorus, measures 9 to 16"));
    await userEvent.click(label("Chorus, measures 9 to 16"));
    expect(label("Chorus, measures 9 to 16")).toHaveAttribute("aria-pressed", "false");
    expect(loopLabel(/Loop region, measures 9 to 16, looping on/)).toBeInTheDocument();
    expect(screen.getByText("Chorus deselected. Loop unchanged.")).toBeInTheDocument();
  });

  it("Escape clears the selection and keeps the loop", async () => {
    await renderStudio();
    await userEvent.click(label("Verse, measures 1 to 8"));
    await userEvent.keyboard("{Escape}");
    expect(label("Verse, measures 1 to 8")).toHaveAttribute("aria-pressed", "false");
    expect(loopLabel(/Loop region, measures 1 to 8, looping on/)).toBeInTheDocument();
  });

  it("deleting a section clamps the loop region to the shorter timeline and clears the selection", async () => {
    await renderStudio(songOf([section("v", "Verse", "verse", 8), section("c", "Chorus", "chorus", 32)], 40));
    await userEvent.click(label("Chorus, measures 9 to 40"));
    expect(loopLabel(/Loop region, measures 9 to 40, looping on/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Chorus" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete section" }));
    expect(loopLabel(/Loop region, measures 9 to 16, looping on/)).toBeInTheDocument();
    expect(screen.getByText("Deleted Chorus. Undo to restore it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Chorus/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });
});

describe("section edits on the song page", () => {
  it("adds a section from the gutter button and focuses the invoker afterwards", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Add section" }));
    const dialog = screen.getByRole("dialog", { name: "Add section" });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Kind" }), "outro");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Length" }), "4");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add section" }));
    expect(await screen.findByRole("button", { name: "Outro, measures 17 to 20" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add section" })).toHaveFocus());
  });

  it("edits name, kind and length in one undo step", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Verse" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Edit section/ }));
    const dialog = screen.getByRole("dialog", { name: "Edit Verse" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Hook");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Kind" }), "chorus");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Length" }), "12");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Hook (chorus), measures 1 to 12" })).toBeInTheDocument();
    expect(label("Chorus, measures 13 to 20")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: "Verse, measures 1 to 8" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("duplicates a section and announces it", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Chorus" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(await screen.findByRole("button", { name: "Chorus 2 (chorus), measures 17 to 24" })).toBeInTheDocument();
    expect(screen.getByText("Duplicated Chorus as Chorus 2.")).toBeInTheDocument();
  });

  it("an old song shows one Song section and the first edit makes it real", async () => {
    await renderStudio(songOf(null));
    expect(label("Song (other), measures 1 to 16")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Song" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Insert section before…" }));
    await userEvent.click(screen.getByRole("button", { name: "Insert section" }));
    expect(await screen.findByRole("button", { name: "Verse, measures 1 to 8" })).toBeInTheDocument();
    expect(label("Song (other), measures 9 to 24")).toBeInTheDocument();
  });
});

describe("section notes on the song page", () => {
  const openNotes = async (name: string) => {
    await userEvent.click(screen.getByRole("button", { name: `Section actions for ${name}` }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Notes…" }));
  };

  it("Notes… opens the Section tab on the selected section and focuses the field", async () => {
    await renderStudio();
    await openNotes("Chorus");
    expect(screen.getByRole("tab", { name: "Section" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Notes for Chorus" })).toHaveFocus());
    expect(localStorage.getItem(RIGHT_TAB_KEY)).toBe("section");
  });

  it("types a space into the notes without starting playback, and keeps notes per section", async () => {
    await renderStudio();
    await openNotes("Chorus");
    const field = await screen.findByRole("textbox", { name: "Notes for Chorus" });
    await userEvent.type(field, "call and response with the guitar");
    expect(field).toHaveValue("call and response with the guitar");
    expect(toggle).not.toHaveBeenCalled();
    await userEvent.click(label("Verse, measures 1 to 8"));
    expect(screen.getByRole("textbox", { name: "Notes for Verse" })).toHaveValue("");
    await userEvent.click(label("Chorus, measures 9 to 16"));
    expect(screen.getByRole("textbox", { name: "Notes for Chorus" })).toHaveValue("call and response with the guitar");
  });

  it("lists the sections in the empty state and selecting one behaves like the ruler", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("tab", { name: "Section" }));
    expect(screen.getByRole("heading", { name: "No section selected" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Select Chorus, measures 9 to 16" }));
    expect(loopLabel(/Loop region, measures 9 to 16, looping on/)).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Notes for Chorus" })).toBeInTheDocument();
  });

  it("keeps the typed notes through an undo of a structural edit", async () => {
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Verse" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await openNotes("Chorus");
    const field = await screen.findByRole("textbox", { name: "Notes for Chorus" });
    await userEvent.type(field, "keep me");
    await userEvent.tab();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("textbox", { name: "Notes for Chorus" })).toHaveValue("keep me");
  });
});

const LIMITS = { max_input_tokens: 256, max_range_measures: 32, max_song_measures: 128, max_tracks: 16, max_chat_messages: 20 };

describe("section selection feeds generation", () => {
  const open = async () => {
    await userEvent.click(screen.getByRole("button", { name: /^Track options for Drums/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Generate part with AI/ }));
    return screen.findByRole("dialog", { name: "Generate Drums" });
  };

  it("offers the selected section as the default range", async () => {
    vi.mocked(api.getSongLimits).mockResolvedValue(LIMITS);
    await renderStudio();
    await userEvent.click(label("Chorus, measures 9 to 16"));
    const dialog = await open();
    expect(within(dialog).getByRole("radio", { name: "Selected section: Chorus (measures 9–16)" })).toBeChecked();
  });

  it("offers no section range when nothing is selected", async () => {
    vi.mocked(api.getSongLimits).mockResolvedValue(LIMITS);
    await renderStudio();
    const dialog = await open();
    expect(within(dialog).queryByRole("radio", { name: /^Selected section/ })).not.toBeInTheDocument();
  });
});

describe("notes on a narrow screen", () => {
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("opens the drawer's field, focuses it, and has no second editor", async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    localStorage.setItem(RIGHT_TAB_KEY, "section");
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Chorus" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Notes…" }));
    const dialog = await screen.findByRole("dialog", { name: "Section" });
    const field = await within(dialog).findByRole("textbox", { name: "Notes for Chorus" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getAllByRole("textbox", { name: "Notes for Chorus" })).toHaveLength(1);
  });
});
