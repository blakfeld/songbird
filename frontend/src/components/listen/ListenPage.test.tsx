import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListenResponse } from "@/lib/listen/api";
import type { SongStore } from "@/lib/song/songStore";
import { newSong, newTrack, type Section, type Song } from "@/lib/song/types";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { ListenPage } from "./ListenPage";

const playback = vi.hoisted(() => ({
  toggle: vi.fn(),
  seek: vi.fn(),
  listeners: new Set<(step: number | null) => void>(),
  store: null as unknown,
  isPlaying: false,
}));
vi.mock("@/lib/audio/useSongPlayback", () => ({
  useSongPlayback: (store: unknown) => {
    playback.store = store;
    return {
      isPlaying: playback.isPlaying,
      status: "idle",
      error: null,
      toggle: playback.toggle,
      stop: vi.fn(),
      seek: playback.seek,
      preload: vi.fn(),
      subscribePosition: (cb: (step: number | null) => void) => {
        playback.listeners.add(cb);
        return () => playback.listeners.delete(cb);
      },
      audition: vi.fn(),
      engine: {},
    };
  },
}));

const sampleStore = vi.hoisted(() => ({ readSamplePcm: vi.fn(), anything: vi.fn() }));
vi.mock("@/lib/audio/sampleStore", () => sampleStore);

const renderMixdown = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audio/mixdown", () => ({ renderMixdown, isMixdownCancelled: () => false }));
vi.mock("@/lib/download", () => ({ saveBlob: vi.fn() }));

const TOKEN = "abcdef0123456789abcdef0123456789abcdef01234";

const section = (id: string, name: string, kind: Section["kind"], measures: number): Section => ({
  id,
  name,
  kind,
  measures,
  notes: "",
});

function sharedSong(extra: Partial<Song> = {}): Song {
  const song = newSong();
  const track = trackWithNotes(newTrack("drums", "Drums"), [note("kick", 0)], 8);
  song.name = "Night Drive";
  song.tempo_bpm = 120;
  song.tracks = [track];
  song.measures = 8;
  song.sections = [section("v", "Verse", "verse", 4), section("c", "Chorus", "chorus", 4)];
  song.lyrics = "[Verse]\nHello there\n\n[Chorus]\n<b>Sing</b> along";
  return { ...song, ...extra };
}

const respond = (overrides: Partial<ListenResponse> = {}): ListenResponse => ({
  share: { mode: "live", allow_comments: true, allow_downloads: false, expires_at: null },
  song: sharedSong(),
  instruments: [drums],
  shared_at: 1,
  ...overrides,
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const fetchMock = vi.fn();
const calls = () => fetchMock.mock.calls.map(([url]) => String(url));

async function open(data: ListenResponse = respond()) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `/api/v1/listen/${TOKEN}`) return json(200, data);
    if (url.endsWith("/comments")) return json(201, { comment: posted });
    if (url.endsWith("/midi")) return new Response(new Uint8Array([1]), { status: 200 });
    return json(404, { error: { code: "not_found", message: "x" } });
  });
  render(<ListenPage token={TOKEN} />);
  await screen.findByRole("heading", { level: 1 });
}

let posted = { id: "c1", name: "Sam", body: "Love this", at_step: 80, section_name: "Chorus", created_at: 1 };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  playback.isPlaying = false;
  posted = { id: "c1", name: "Sam", body: "Love this", at_step: 80, section_name: "Chorus", created_at: 1 };
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  playback.toggle.mockClear();
  playback.seek.mockClear();
  playback.listeners.clear();
  renderMixdown.mockReset();
  sampleStore.readSamplePcm.mockClear();
  vi.unstubAllGlobals();
});

const emit = (step: number) => act(() => playback.listeners.forEach((cb) => cb(step)));

describe("Listen page", () => {
  it("shows the song and plays it for a visitor with no account", async () => {
    await open();
    expect(screen.getByRole("heading", { level: 1, name: "Night Drive" })).toBeInTheDocument();
    expect(screen.getByText(/120 BPM · 4\/4 · C major/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Play/ }));
    expect(playback.toggle).toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Sections" })).toBeInTheDocument();
    expect(calls()).toEqual([`/api/v1/listen/${TOKEN}`]);
  });

  it("names the section under the playhead", async () => {
    await open();
    expect(screen.getByText("Verse", { selector: "span.font-medium" })).toBeInTheDocument();
    emit(70);
    expect(screen.getByText("Chorus", { selector: "span.font-medium" })).toBeInTheDocument();
  });

  it("seeks to a section's first measure when it is chosen from the keyboard", async () => {
    await open();
    screen.getByRole("button", { name: "Chorus, measures 5 to 8" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(playback.seek).toHaveBeenCalledWith(5);
  });

  it("offers no editing, menus or account", async () => {
    await open();
    expect(screen.queryByRole("button", { name: /Section actions/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add section/ })).toBeNull();
    expect(screen.queryByText(/Log out/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Account/ })).toBeNull();
  });

  it("shows lyrics read-only with headings as headings, and no markup interpreted", async () => {
    await open();
    expect(screen.getByRole("heading", { level: 3, name: "Verse" })).toBeInTheDocument();
    expect(screen.getByText("<b>Sing</b> along")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Lyrics" })).toBeNull();
  });

  it("says only that an unavailable link isn't available", async () => {
    fetchMock.mockResolvedValue(json(404, { error: { code: "not_found", message: "revoked" } }));
    render(<ListenPage token={TOKEN} />);
    expect(await screen.findByRole("heading", { name: "This link isn't available" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/revoked|expired/i)).toBeNull();
  });

  it("asks a throttled visitor to try again shortly, and retries on request", async () => {
    fetchMock.mockResolvedValueOnce(json(429, { error: { code: "too_many_requests", message: "x" } }, { "Retry-After": "5" }));
    render(<ListenPage token={TOKEN} />);
    expect(await screen.findByRole("heading", { name: "Please try again shortly" })).toBeInTheDocument();
    fetchMock.mockResolvedValue(json(200, respond()));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Night Drive" })).toBeInTheDocument();
  });

  it("never signs anyone out when the link is unavailable", async () => {
    localStorage.setItem("songbird.studio.rightTab", "lyrics");
    fetchMock.mockResolvedValue(json(404, { error: { code: "not_found", message: "x" } }));
    render(<ListenPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "This link isn't available" });
    expect(localStorage.getItem("songbird.studio.rightTab")).toBe("lyrics");
  });
});

describe("Audio tracks on the listen page", () => {
  function withVocal(): Song {
    const song = sharedSong();
    const vocal = newTrack("audio", "Vocal");
    vocal.audio_clips = [
      { id: "a1", sample_id: "s1", start_ticks: 0, offset_frames: 0, length_frames: 1000, gain_db: 0, fade_in_frames: 0, fade_out_frames: 0, loop: false } as never,
    ];
    song.tracks = [...song.tracks, vocal];
    song.samples = [{ id: "s1", name: "Take 1", sample_rate: 44100, frames: 1000, channels: 1 } as never];
    return song;
  }

  it("marks the audio track unavailable and shows the notice, while the drums stay listed", async () => {
    await open(respond({ song: withVocal() }));
    const tracks = screen.getByRole("list");
    const vocal = within(tracks).getByText("Vocal").closest("li")!;
    expect(within(vocal).getByText("Unavailable")).toBeInTheDocument();
    expect(within(within(tracks).getByText("Drums").closest("li")!).queryByText("Unavailable")).toBeNull();
    expect(screen.getByText(/Some audio tracks aren't included/)).toBeInTheDocument();
  });

  it("gives playback a copy with no samples, so the sample store is never read", async () => {
    await open(respond({ song: withVocal() }));
    const played = (playback.store as SongStore).getState().song!;
    expect(played.samples).toEqual([]);
    expect(played.tracks.map((t) => t.name)).toEqual(["Drums", "Vocal"]);
    expect(sampleStore.readSamplePcm).not.toHaveBeenCalled();
  });

  it("shows no notice when every track is playable", async () => {
    await open();
    expect(screen.queryByText(/aren't included/)).toBeNull();
  });
});

describe("Downloads", () => {
  it("hides both downloads when they are off", async () => {
    await open();
    expect(screen.queryByRole("button", { name: "Download MIDI" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download WAV" })).toBeNull();
  });

  it("renders the WAV in the browser from the song without audio tracks, with no audio fetched", async () => {
    const song = sharedSong();
    song.tracks = [...song.tracks, newTrack("audio", "Vocal")];
    renderMixdown.mockResolvedValue({ wav: new Blob(["x"]), clipped: false, seconds: 1 });
    await open(respond({ song, share: { mode: "live", allow_comments: true, allow_downloads: true, expires_at: null } }));
    await userEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    await waitFor(() => expect(renderMixdown).toHaveBeenCalled());
    const rendered = renderMixdown.mock.calls[0][0] as Song;
    expect(rendered.tracks.map((t) => t.instrument)).toEqual(["drums"]);
    expect(calls()).toEqual([`/api/v1/listen/${TOKEN}`]);
  });

  it("fetches the MIDI file from the listen API", async () => {
    await open(respond({ share: { mode: "live", allow_comments: true, allow_downloads: true, expires_at: null } }));
    await userEvent.click(screen.getByRole("button", { name: "Download MIDI" }));
    await waitFor(() => expect(calls()).toContain(`/api/v1/listen/${TOKEN}/midi`));
  });
});

describe("Comments", () => {
  const name = () => screen.getByLabelText("Your name");
  const text = () => screen.getByLabelText("Comment");

  it("shows no form when comments are off", async () => {
    await open(respond({ share: { mode: "live", allow_comments: false, allow_downloads: false, expires_at: null } }));
    expect(screen.queryByRole("form", { name: "Leave a comment" })).toBeNull();
  });

  it("pins the comment to the playhead when writing starts, and posts that step", async () => {
    await open();
    emit(80);
    await userEvent.type(text(), "Love this");
    expect(screen.getByText(/pinned at 0:10 in Chorus/)).toBeInTheDocument();
    await userEvent.type(name(), "Sam");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await screen.findByText("Comment posted.");
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/comments"))!;
    expect(JSON.parse(init.body)).toEqual({ name: "Sam", body: "Love this", at_step: 80 });
  });

  it("renders a hidden honeypot field that a person never fills, and sends no website key", async () => {
    await open();
    const trap = document.querySelector<HTMLInputElement>("input[data-form-type='other']")!;
    expect(trap).toHaveAttribute("tabindex", "-1");
    expect(trap).toHaveAttribute("autocomplete", "one-time-code");
    expect(trap).toHaveAttribute("data-1p-ignore");
    expect(trap).toHaveAttribute("data-lpignore", "true");
    expect(trap).toHaveAttribute("data-bwignore");
    expect(trap.name).not.toMatch(/website|url|site/i);
    expect(trap.id).not.toMatch(/website|url|site/i);
    expect(trap.closest("[aria-hidden='true']")).not.toBeNull();
    emit(80);
    await userEvent.type(name(), "Sam");
    await userEvent.type(text(), "Love this");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await screen.findByText("Comment posted.");
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/comments"))!;
    expect(JSON.parse(init.body)).not.toHaveProperty("website");
  });

  it("sends a filled honeypot, and treats the fake success like any other", async () => {
    await open();
    const trap = document.querySelector<HTMLInputElement>("input[data-form-type='other']")!;
    await userEvent.type(trap, "http://spam.example");
    await userEvent.type(name(), "Bot");
    await userEvent.type(text(), "Buy now");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await screen.findByText("Comment posted.");
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/comments"))!;
    expect(JSON.parse(init.body).website).toBe("http://spam.example");
  });

  it("moves the pin when the timeline is clicked before posting", async () => {
    await open();
    emit(80);
    await userEvent.type(text(), "x");
    screen.getByRole("button", { name: "Verse, measures 1 to 4" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText(/pinned at 0:00 in Verse/)).toBeInTheDocument();
  });

  it("refuses an empty name or comment before sending anything", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    expect(screen.getByText("Enter your name.")).toBeInTheDocument();
    expect(screen.getByText("Write a comment.")).toBeInTheDocument();
    expect(calls().some((u) => u.endsWith("/comments"))).toBe(false);
  });

  it("counts a long name in code points", async () => {
    await open();
    await userEvent.type(name(), "🎵".repeat(41));
    await userEvent.type(text(), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    expect(screen.getByText(/at most 40 characters/)).toBeInTheDocument();
  });

  it("keeps the text and asks to try later when rate limited", async () => {
    await open();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/comments")
        ? json(429, { error: { code: "too_many_requests", message: "x" } }, { "Retry-After": "90" })
        : json(200, respond()),
    );
    await userEvent.type(name(), "Sam");
    await userEvent.type(text(), "Please keep me");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Your text is kept; try again in about a minute/);
    expect(text()).toHaveValue("Please keep me");
  });

  it("shows the server's reason when a comment is refused", async () => {
    await open();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/comments")
        ? json(422, { error: { code: "invalid_comment", message: "That position is past the end of the song." } })
        : json(200, respond()),
    );
    await userEvent.type(name(), "Sam");
    await userEvent.type(text(), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That position is past the end of the song.");
  });

  it("remembers the name and lists the listener's own comments after a reload", async () => {
    await open();
    emit(80);
    await userEvent.type(name(), "Sam");
    await userEvent.type(text(), "Love this");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await screen.findByText("Comment posted.");
    expect(localStorage.getItem(`songbird-listen.${TOKEN.slice(0, 6)}.name`)).toBe("Sam");
    cleanup();

    await open();
    const own = screen.getByRole("region", { name: "Your comments" });
    expect(within(own).getByText("Love this")).toBeInTheDocument();
    expect(within(own).getByText(/at 0:10 in Chorus/)).toBeInTheDocument();
    expect(name()).toHaveValue("Sam");
  });

  it("does not show comments another listener left, and never asks the server for any", async () => {
    localStorage.setItem(
      "songbird-listen.zzzzzz.comments",
      JSON.stringify([{ id: "x", name: "Alex", body: "Not yours", at_step: 0, section_name: null, created_at: 1 }]),
    );
    await open();
    expect(screen.queryByText("Not yours")).toBeNull();
    expect(screen.queryByRole("region", { name: "Your comments" })).toBeNull();
    expect(calls()).toEqual([`/api/v1/listen/${TOKEN}`]);
  });

  it("renders comment text literally", async () => {
    posted = { ...posted, name: "<i>Sam</i>", body: "<script>alert(1)</script>\nsee https://example.com" };
    await open();
    await userEvent.type(name(), "<i>Sam</i>");
    await userEvent.type(text(), "x");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    const own = await screen.findByRole("region", { name: "Your comments" });
    expect(within(own).getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(own.querySelector("script")).toBeNull();
    expect(within(own).queryByRole("link")).toBeNull();
    expect(within(own).getByText("<i>Sam</i>")).toBeInTheDocument();
  });
});

describe("Served song shape", () => {
  it("defaults section notes to an empty string when the server omits them", async () => {
    const song = sharedSong();
    song.sections = song.sections!.map((s) => {
      const copy: Partial<Section> = { ...s };
      delete copy.notes;
      return copy as Section;
    });
    await open(respond({ song }));
    const played = (playback.store as SongStore).getState().song!;
    expect(played.sections!.map((s) => s.notes)).toEqual(["", ""]);
  });
});
