import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListenResponse } from "@/lib/listen/api";
import type { SongStore } from "@/lib/song/songStore";
import { newSong, newTrack, type Section, type Song } from "@/lib/song/types";
import { drums, note, trackWithNotes } from "@/test/fixtures";
import { navigateTo } from "@/lib/auth/navigation";
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

vi.mock("@/lib/auth/navigation", () => ({ navigateTo: vi.fn() }));

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

const shareOf = (over: Partial<ListenResponse["share"]> = {}): ListenResponse["share"] => ({
  mode: "live",
  allow_comments: true,
  allow_downloads: false,
  allow_remix: false,
  expires_at: null,
  ...over,
});

const respond = (overrides: Partial<ListenResponse> = {}): ListenResponse => ({
  share: shareOf(),
  song: sharedSong(),
  instruments: [drums],
  shared_at: 1,
  ...overrides,
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const fetchMock = vi.fn();
const calls = () => fetchMock.mock.calls.map(([url]) => String(url));

const signedIn = (username: string | null = "sam") =>
  json(200, { user: { id: "u1", email: "sam@example.com", username } });
const signedOut = () => json(401, { error: { code: "unauthenticated", message: "x" } });

async function open(data: ListenResponse = respond(), me: () => Response = signedIn) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `/api/v1/listen/${TOKEN}`) return json(200, data);
    if (url === "/api/v1/auth/me") return me();
    if (url.endsWith("/remix")) return json(201, { project: { id: "new-1", revision: 1, updated_at: 1, song: {} } });
    if (url.endsWith("/comments")) return json(201, { comment: posted });
    if (url.endsWith("/midi")) return new Response(new Uint8Array([1]), { status: 200 });
    return json(404, { error: { code: "not_found", message: "x" } });
  });
  render(<ListenPage token={TOKEN} />);
  await screen.findByRole("heading", { level: 1 });
}

let posted = { id: "c1", name: "sam", body: "Love this", at_step: 80, section_name: "Chorus", created_at: 1 };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  playback.isPlaying = false;
  posted = { id: "c1", name: "sam", body: "Love this", at_step: 80, section_name: "Chorus", created_at: 1 };
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
    expect(calls()).toEqual([`/api/v1/listen/${TOKEN}`, "/api/v1/auth/me"]);
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
    await open(respond({ song, share: shareOf({ allow_comments: false, allow_downloads: true }) }));
    await userEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    await waitFor(() => expect(renderMixdown).toHaveBeenCalled());
    const rendered = renderMixdown.mock.calls[0][0] as Song;
    expect(rendered.tracks.map((t) => t.instrument)).toEqual(["drums"]);
    expect(calls()).toEqual([`/api/v1/listen/${TOKEN}`]);
  });

  it("fetches the MIDI file from the listen API", async () => {
    await open(respond({ share: shareOf({ allow_comments: false, allow_downloads: true }) }));
    await userEvent.click(screen.getByRole("button", { name: "Download MIDI" }));
    await waitFor(() => expect(calls()).toContain(`/api/v1/listen/${TOKEN}/midi`));
  });
});

describe("Session probe", () => {
  it("does not look for a session when neither comments nor remixing are on", async () => {
    await open(respond({ share: shareOf({ allow_comments: false, allow_remix: false }) }));
    expect(calls()).toEqual([`/api/v1/listen/${TOKEN}`]);
  });

  it.each([
    ["comments", { allow_comments: true, allow_remix: false }],
    ["remixing", { allow_comments: false, allow_remix: true }],
  ])("looks for a session when %s is on, and sends the cookie", async (_n, flags) => {
    await open(respond({ share: shareOf(flags) }));
    await waitFor(() => expect(calls()).toContain("/api/v1/auth/me"));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/v1/auth/me")!;
    expect(init?.credentials).not.toBe("omit");
  });

  it("a 401 shows the sign-in links but never signs anyone out or clears storage", async () => {
    localStorage.setItem("songbird.studio.rightTab", "lyrics");
    await open(respond({ share: shareOf({ allow_remix: true }) }), signedOut);
    expect(await screen.findByRole("link", { name: "Sign in to remix" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in to comment" })).toBeInTheDocument();
    expect(localStorage.getItem("songbird.studio.rightTab")).toBe("lyrics");
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.queryByText(/sam@example.com|Log out/)).toBeNull();
  });

  it("treats a failed check like being signed out", async () => {
    await open(respond(), () => json(500, {}));
    expect(await screen.findByRole("link", { name: "Sign in to comment" })).toBeInTheDocument();
  });

  it("still plays the song while the session is unknown", async () => {
    await open(respond(), signedOut);
    await userEvent.click(screen.getByRole("button", { name: /Play/ }));
    expect(playback.toggle).toHaveBeenCalled();
  });
});

describe("Comments", () => {
  const text = () => screen.getByLabelText("Comment");
  const post = () => userEvent.click(screen.getByRole("button", { name: "Post comment" }));
  const commentCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/comments"));
  const failComments = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/comments")) return json(status, body, headers);
      if (url === "/api/v1/auth/me") return signedIn();
      return json(200, respond());
    });

  it("shows no form and no prompt when comments are off", async () => {
    await open(respond({ share: shareOf({ allow_comments: false }) }));
    expect(screen.queryByRole("form", { name: "Leave a comment" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in to comment" })).toBeNull();
  });

  it("offers a sign-in link back to this page when signed out, with no form", async () => {
    await open(respond(), signedOut);
    const link = await screen.findByRole("link", { name: "Sign in to comment" });
    expect(link).toHaveAttribute("href", `/login?next=${encodeURIComponent(`/listen/${TOKEN}`)}`);
    expect(screen.queryByLabelText("Comment")).toBeNull();
  });

  it("says who is commenting, has no name field, and pins to the playhead", async () => {
    await open();
    expect(await screen.findByText("Commenting as sam")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    emit(80);
    await userEvent.type(text(), "Love this");
    expect(screen.getByText(/pinned at 0:10 in Chorus/)).toBeInTheDocument();
    await post();
    await screen.findByText("Comment posted.");
    expect(JSON.parse(commentCalls()[0][1].body)).toEqual({ body: "Love this", at_step: 80 });
  });

  it("has no honeypot field and remembers no name", async () => {
    await open();
    await screen.findByText("Commenting as sam");
    expect(document.querySelector("input[data-form-type='other']")).toBeNull();
    emit(80);
    await userEvent.type(text(), "Love this");
    await post();
    await screen.findByText("Comment posted.");
    expect(localStorage.getItem(`songbird-listen.${TOKEN.slice(0, 6)}.name`)).toBeNull();
    expect(JSON.parse(commentCalls()[0][1].body)).not.toHaveProperty("website");
  });

  it("tells a signed-in user without a username to set one in their profile, with no username field", async () => {
    await open(respond(), () => signedIn(null));
    expect(await screen.findByText(/Commenting needs a username/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set a username in your profile" })).toHaveAttribute("href", "/settings/profile");
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByLabelText("Comment")).toBeNull();
    expect(calls().some((u) => u.includes("account/username"))).toBe(false);
  });

  it("keeps the text and switches to sign-in when the session has expired", async () => {
    await open();
    await screen.findByText("Commenting as sam");
    emit(80);
    await userEvent.type(text(), "Please keep me");
    failComments(401, { error: { code: "unauthenticated", message: "x" } });
    await post();
    expect(await screen.findByRole("link", { name: "Sign in to comment" })).toBeInTheDocument();
    expect(text()).toHaveValue("Please keep me");
    expect(screen.queryByRole("button", { name: "Post comment" })).toBeNull();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("keeps the text and shows the profile note when the server says a username is required", async () => {
    await open();
    await screen.findByText("Commenting as sam");
    emit(80);
    await userEvent.type(text(), "Mine");
    failComments(409, { error: { code: "username_required", message: "x" } });
    await post();
    expect(await screen.findByText(/Commenting needs a username/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set a username in your profile" })).toHaveAttribute("href", "/settings/profile");
    expect(text()).toHaveValue("Mine");
    expect(screen.queryByRole("button", { name: "Post comment" })).toBeNull();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("moves the pin when the timeline is clicked before posting", async () => {
    await open();
    await screen.findByText("Commenting as sam");
    emit(80);
    await userEvent.type(text(), "x");
    screen.getByRole("button", { name: "Verse, measures 1 to 4" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText(/pinned at 0:00 in Verse/)).toBeInTheDocument();
  });

  it("refuses an empty comment before sending anything", async () => {
    await open();
    await screen.findByText("Commenting as sam");
    await post();
    expect(screen.getByText("Write a comment.")).toBeInTheDocument();
    expect(commentCalls()).toHaveLength(0);
  });

  it("keeps the text and asks to try later when rate limited", async () => {
    await open();
    await screen.findByText("Commenting as sam");
    failComments(429, { error: { code: "too_many_requests", message: "x" } }, { "Retry-After": "90" });
    await userEvent.type(text(), "Please keep me");
    await post();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Your text is kept; try again in about a minute/);
    expect(text()).toHaveValue("Please keep me");
  });

  it("shows the server's reason when a comment is refused", async () => {
    await open();
    await screen.findByText("Commenting as sam");
    failComments(422, { error: { code: "invalid_comment", message: "That position is past the end of the song." } });
    await userEvent.type(text(), "hi");
    await post();
    expect(await screen.findByRole("alert")).toHaveTextContent("That position is past the end of the song.");
  });

  it("lists the listener's own comments after a reload", async () => {
    await open();
    await screen.findByText("Commenting as sam");
    emit(80);
    await userEvent.type(text(), "Love this");
    await post();
    await screen.findByText("Comment posted.");
    cleanup();

    await open();
    const own = screen.getByRole("region", { name: "Your comments" });
    expect(within(own).getByText("Love this")).toBeInTheDocument();
    expect(within(own).getByText(/at 0:10 in Chorus/)).toBeInTheDocument();
  });

  it("does not show comments another listener left, and never asks the server for any", async () => {
    localStorage.setItem(
      "songbird-listen.zzzzzz.comments",
      JSON.stringify([{ id: "x", name: "Alex", body: "Not yours", at_step: 0, section_name: null, created_at: 1 }]),
    );
    await open();
    expect(screen.queryByText("Not yours")).toBeNull();
    expect(screen.queryByRole("region", { name: "Your comments" })).toBeNull();
    expect(calls().filter((u) => u.includes("comments"))).toEqual([]);
  });

  it("renders comment text literally", async () => {
    posted = { ...posted, name: "<i>sam</i>", body: "<script>alert(1)</script>\nsee https://example.com" };
    await open();
    await screen.findByText("Commenting as sam");
    await userEvent.type(text(), "x");
    await post();
    const own = await screen.findByRole("region", { name: "Your comments" });
    expect(within(own).getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(own.querySelector("script")).toBeNull();
    expect(within(own).queryByRole("link")).toBeNull();
    expect(within(own).getByText("<i>sam</i>")).toBeInTheDocument();
  });
});

describe("Remix", () => {
  const remixShareOf = () => respond({ share: shareOf({ allow_comments: false, allow_remix: true }) });
  const remixButton = () => screen.findByRole("button", { name: "Remix" });
  const remixCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/remix"));

  it("shows no control when remixing is off, signed in or not", async () => {
    await open(respond({ share: shareOf({ allow_comments: true, allow_remix: false }) }));
    await screen.findByText("Commenting as sam");
    expect(screen.queryByRole("button", { name: "Remix" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in to remix" })).toBeNull();
    cleanup();
    await open(respond({ share: shareOf({ allow_comments: true, allow_remix: false }) }), signedOut);
    await screen.findByRole("link", { name: "Sign in to comment" });
    expect(screen.queryByRole("link", { name: "Sign in to remix" })).toBeNull();
  });

  it("offers a sign-in link back to this page when signed out", async () => {
    await open(remixShareOf(), signedOut);
    const link = await screen.findByRole("link", { name: "Sign in to remix" });
    expect(link).toHaveAttribute("href", `/login?next=${encodeURIComponent(`/listen/${TOKEN}`)}`);
    expect(screen.queryByRole("button", { name: "Remix" })).toBeNull();
    expect(remixCalls()).toHaveLength(0);
  });

  it("creates nothing until the signed-in visitor chooses Remix, then opens the Studio with the new project", async () => {
    await open(remixShareOf());
    const button = await remixButton();
    expect(remixCalls()).toHaveLength(0);
    await userEvent.click(button);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/?song=new-1"));
    expect(remixCalls()).toHaveLength(1);
    expect(remixCalls()[0][1].method).toBe("POST");
  });

  it("is disabled while the request is in flight, and only sends it once", async () => {
    await open(remixShareOf());
    const button = await remixButton();
    let finish: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (finish = r)));
    await userEvent.click(button);
    expect(screen.getByRole("button", { name: /Remixing/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Remixing/ }));
    expect(remixCalls()).toHaveLength(1);
    finish(json(201, { project: { id: "p2" } }));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/?song=p2"));
  });

  it("warns that audio tracks arrive without their audio, only when there are clips", async () => {
    const song = sharedSong();
    const vocal = newTrack("audio", "Vocal");
    vocal.audio_clips = [{ id: "a1" } as never];
    song.tracks = [...song.tracks, vocal];
    await open(respond({ song, share: shareOf({ allow_comments: false, allow_remix: true }) }));
    await remixButton();
    expect(screen.getByRole("note")).toHaveTextContent(/Audio tracks will be copied without their audio/);
    cleanup();
    await open(remixShareOf());
    await remixButton();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it.each([
    ["the project limit", 409, { error: { code: "project_limit", message: "x" } }, /limit for stored songs/],
    ["a throttle", 429, { error: { code: "too_many_requests", message: "x" } }, /Try again shortly/],
    ["a missing link", 404, { error: { code: "not_found", message: "x" } }, /Remixing isn't available for this link/],
  ])("stays on the page and explains %s", async (_n, status, body, message) => {
    await open(remixShareOf());
    const button = await remixButton();
    fetchMock.mockImplementation(async () => json(status, body));
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remix" })).toBeEnabled();
  });

  it("switches to the sign-in link on a 401, without signing out", async () => {
    localStorage.setItem("songbird.studio.rightTab", "lyrics");
    await open(remixShareOf());
    const button = await remixButton();
    fetchMock.mockImplementation(async () => signedOut());
    await userEvent.click(button);
    expect(await screen.findByRole("link", { name: "Sign in to remix" })).toBeInTheDocument();
    expect(localStorage.getItem("songbird.studio.rightTab")).toBe("lyrics");
    expect(navigateTo).not.toHaveBeenCalled();
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
