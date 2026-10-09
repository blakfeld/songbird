import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { OwnerComment } from "@/lib/share/shareApi";
import { createServerSongLibrary, type SongLibrary } from "@/lib/song/songLibrary";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import { type Section, type Song } from "@/lib/song/types";
import { clearStoredValueCache } from "@/lib/useStoredValue";
import { createFakeProjectsApi } from "@/test/fakeProjectsApi";
import { drums, trackWithNotes } from "@/test/fixtures";
import { StudioPage } from "./StudioPage";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getInstruments: vi.fn(),
}));

const shares = vi.hoisted(() => ({
  listComments: vi.fn(),
  setResolved: vi.fn(),
  removeComment: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("@/lib/share/shareApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/share/shareApi")>()),
  shareApi: shares,
}));

const seekTo = vi.fn();
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
    seek: seekTo,
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

function songOf(): Song {
  const song = newSongWithTracks();
  song.measures = 8;
  song.tracks = song.tracks.map((t) => trackWithNotes(t, [], 8));
  song.sections = [section("v", "Verse", "verse", 4), section("c", "Chorus", "chorus", 4)];
  return song;
}

const comment = (id: string, over: Partial<OwnerComment> = {}): OwnerComment => ({
  id,
  share_id: "s1",
  share_label: "For Sam",
  token_prefix: "abcdef",
  name: "Sam",
  body: "Love this lift",
  at_step: 80,
  section_id: "c",
  section_name: "Chorus",
  project_revision: 1,
  created_at: 10,
  resolved_at: null,
  ...over,
});

let library: SongLibrary;
let stored: OwnerComment[];

async function renderStudio(song: Song = songOf()) {
  await library.create(song);
  render(<StudioPage library={library} />);
  await screen.findByRole("region", { name: "Arrangement" });
}

const commentsButton = (unresolved: number) => screen.findByRole("button", { name: `Comments, ${unresolved} unresolved` });

beforeEach(() => {
  localStorage.clear();
  clearStoredValueCache();
  library = createServerSongLibrary(createFakeProjectsApi().api);
  stored = [comment("c1"), comment("c2", { name: "Alex", at_step: 16, body: "Too busy here" })];
  shares.listComments.mockImplementation(async () => structuredClone(stored));
  shares.setResolved.mockImplementation(async (_p: string, id: string, resolved: boolean) => {
    const found = stored.find((c) => c.id === id)!;
    found.resolved_at = resolved ? 99 : null;
    return structuredClone(found);
  });
  shares.removeComment.mockImplementation(async (_p: string, id: string) => {
    stored = stored.filter((c) => c.id !== id);
  });
  vi.mocked(api.getInstruments).mockResolvedValue([drums]);
});
afterEach(() => {
  cleanup();
  Object.values(shares).forEach((m) => m.mockReset());
  seekTo.mockClear();
});

describe("comments in the Studio", () => {
  it("loads comments when the project opens and counts the unresolved ones", async () => {
    await renderStudio();
    await commentsButton(2);
    expect(shares.listComments).toHaveBeenCalledTimes(1);
  });

  it("shows a marker on the ruler for each unresolved comment", async () => {
    await renderStudio();
    await commentsButton(2);
    expect(screen.getAllByRole("button", { name: /^Comment from / })).toHaveLength(2);
  });

  it("fetches again when the panel opens and when Refresh is chosen", async () => {
    await renderStudio();
    await commentsButton(2);
    await userEvent.click(screen.getByRole("button", { name: "Comments, 2 unresolved" }));
    await waitFor(() => expect(shares.listComments).toHaveBeenCalledTimes(2));
    await userEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(shares.listComments).toHaveBeenCalledTimes(3));
  });

  it("lists unresolved comments by position and hides resolved ones until asked", async () => {
    stored = [comment("c1"), comment("c2", { name: "Alex", at_step: 16 }), comment("c3", { name: "Robin", resolved_at: 5 })];
    await renderStudio();
    await userEvent.click(await commentsButton(2));
    const items = within(await screen.findByRole("tabpanel")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Alex");
    expect(items[1]).toHaveTextContent("Sam");
    await userEvent.click(screen.getByRole("checkbox", { name: "Show resolved" }));
    const all = within(screen.getByRole("tabpanel")).getAllByRole("listitem");
    expect(all).toHaveLength(3);
    expect(all[2]).toHaveTextContent("Robin");
    expect(all[2]).toHaveTextContent("Resolved");
  });

  it("shows the section, the link label and the text as plain text, with no links", async () => {
    stored = [comment("c1", { body: "<script>alert(1)</script>\nsee https://example.com", name: "<b>Sam</b>" })];
    await renderStudio();
    await userEvent.click(await commentsButton(1));
    const panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(within(panel).getByText("<b>Sam</b>")).toBeInTheDocument();
    expect(within(panel).getByText(/in Chorus/)).toBeInTheDocument();
    expect(within(panel).getByText("For Sam")).toBeInTheDocument();
    expect(panel.querySelector("script")).toBeNull();
    expect(within(panel).queryByRole("link")).toBeNull();
  });

  it("resolves a comment: the marker goes and the count drops", async () => {
    await renderStudio();
    await userEvent.click(await commentsButton(2));
    await userEvent.click(await screen.findByRole("button", { name: "Resolve comment from Sam" }));
    await commentsButton(1);
    expect(shares.setResolved).toHaveBeenCalledWith(expect.any(String), "c1", true);
    expect(screen.getAllByRole("button", { name: /^Comment from / })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Comment from Sam/ })).toBeNull();
  });

  it("reopens a resolved comment", async () => {
    stored = [comment("c1", { resolved_at: 5 })];
    await renderStudio();
    await userEvent.click(await commentsButton(0));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Show resolved" }));
    await userEvent.click(screen.getByRole("button", { name: "Reopen comment from Sam" }));
    await commentsButton(1);
  });

  it("deletes a comment only after confirming", async () => {
    await renderStudio();
    await userEvent.click(await commentsButton(2));
    await userEvent.click(await screen.findByRole("button", { name: "Delete comment from Sam" }));
    expect(shares.removeComment).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await commentsButton(1);
    expect(shares.removeComment).toHaveBeenCalledWith(expect.any(String), "c1");
  });

  it("jumps to a comment's position", async () => {
    await renderStudio();
    await userEvent.click(await commentsButton(2));
    await userEvent.click(await screen.findByRole("button", { name: "Jump to comment from Sam" }));
    expect(seekTo).toHaveBeenCalledWith(6);
  });

  it("selecting a marker moves the playhead and opens the comment in the panel", async () => {
    await renderStudio();
    await commentsButton(2);
    await userEvent.click(screen.getByRole("button", { name: /^Comment from Sam/ }));
    expect(seekTo).toHaveBeenCalledWith(6);
    const panel = await screen.findByRole("tabpanel");
    const item = within(panel).getAllByRole("listitem").find((li) => li.textContent?.includes("Love this lift"))!;
    expect(item).toHaveAttribute("aria-current", "true");
    await waitFor(() => expect(item).toHaveFocus());
  });

  it("clamps a marker past the end of the song and flags it", async () => {
    stored = [comment("c1", { at_step: 500, name: "Late" })];
    await renderStudio();
    const marker = await screen.findByRole("button", { name: /^Comment from Late/ });
    expect(marker).toHaveAccessibleName(/no longer in the song/);
    expect(marker.style.left).toBe("calc(var(--cell-w) * 128)");
    await userEvent.click(marker);
    expect(await screen.findByText("This position is no longer in the song.")).toBeInTheDocument();
    expect(seekTo).toHaveBeenCalledWith(8);
  });

  it("keeps the song document and its undo history out of it", async () => {
    await renderStudio();
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toBeDisabled();
    await userEvent.click(await commentsButton(2));
    await userEvent.click(await screen.findByRole("button", { name: "Resolve comment from Sam" }));
    await commentsButton(1);
    await userEvent.click(screen.getByRole("button", { name: "Delete comment from Alex" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await commentsButton(0);
    expect(undo).toBeDisabled();
  });

  it("undoes the song's last edit, not a resolved comment", async () => {
    await renderStudio();
    await userEvent.click(await commentsButton(2));
    await userEvent.click(await screen.findByRole("button", { name: "Track options for Piano" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete track" }));
    expect(screen.queryByRole("group", { name: /^Track \d+: Piano/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Resolve comment from Sam" }));
    await commentsButton(1);
    await userEvent.keyboard("{Meta>}z{/Meta}");
    expect(screen.getByRole("group", { name: /^Track \d+: Piano/ })).toBeInTheDocument();
    await commentsButton(1);
    expect(shares.setResolved).toHaveBeenCalledTimes(1);
  });

  it("says so when comments cannot be loaded, and retries", async () => {
    shares.listComments.mockRejectedValue(new Error("offline"));
    await renderStudio();
    await userEvent.click(screen.getByRole("button", { name: /^Comments, 0 unresolved/ }));
    expect(await screen.findByText("Couldn't load comments.")).toBeInTheDocument();
    shares.listComments.mockImplementation(async () => structuredClone(stored));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await commentsButton(2);
  });

  it("offers Share for a project stored on the server", async () => {
    await renderStudio();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("neither fetches comments nor offers Share and Comments until the song is stored, then does", async () => {
    let stored = false;
    vi.spyOn(library, "isOnServer").mockImplementation(() => stored);
    await renderStudio();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Comments, / })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Comments" })).toBeNull();
    expect(shares.listComments).not.toHaveBeenCalled();

    stored = true;
    act(() => library.status.setState({ saving: true }));
    act(() => library.status.setState({ saving: false }));
    await commentsButton(2);
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Comments" })).toBeInTheDocument();
    expect(shares.listComments).toHaveBeenCalledTimes(1);
  });
});
