import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareApi, ShareLink } from "@/lib/share/shareApi";
import { newSong, newTrack, type Song } from "@/lib/song/types";
import { AUDIO_WARNING, ShareDialog } from "./ShareDialog";

const NOW = 1_700_000_000_000;

const link = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: "s1",
  token_prefix: "abcdef",
  mode: "live",
  label: "",
  allow_comments: true,
  allow_downloads: false,
  expires_at: null,
  created_at: NOW,
  revoked_at: null,
  status: "active",
  unresolved_comments: 0,
  ...over,
});

let links: ShareLink[];
const api = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  revoke: vi.fn(),
  listComments: vi.fn(),
  setResolved: vi.fn(),
  removeComment: vi.fn(),
} satisfies Record<keyof ShareApi, unknown>;

function show(song: Song = newSong()) {
  render(<ShareDialog open onClose={() => {}} projectId="p1" song={song} api={api as unknown as ShareApi} now={() => NOW} />);
}

beforeEach(() => {
  links = [];
  api.list.mockImplementation(async () => structuredClone(links));
  api.create.mockImplementation(async (_p: string, body: Record<string, unknown>) => {
    const created = link({ id: "new", mode: body.mode as ShareLink["mode"] });
    links = [created, ...links];
    return { share: created, token: "tok", url: "/listen/tok" };
  });
  api.update.mockImplementation(async (_p: string, id: string, edit: Partial<ShareLink>) => {
    links = links.map((l) => (l.id === id ? { ...l, ...edit } : l));
    return links.find((l) => l.id === id);
  });
  api.revoke.mockImplementation(async (_p: string, id: string) => {
    links = links.map((l) => (l.id === id ? { ...l, status: "revoked", revoked_at: NOW } : l));
  });
});
afterEach(() => {
  cleanup();
  Object.values(api).forEach((m) => m.mockReset());
  vi.unstubAllGlobals();
});

describe("Share dialog", () => {
  it("creates a live link with the defaults, shows the URL once, and copies it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    show();
    await screen.findByText("No links yet.");
    expect(screen.getByRole("switch", { name: "Allow comments" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Allow downloads" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Listeners can still record what they hear/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(api.create).toHaveBeenCalledWith("p1", {
      mode: "live",
      expires_at: null,
      allow_comments: true,
      allow_downloads: false,
    });
    const url = `${window.location.origin}/listen/tok`;
    expect(await screen.findByDisplayValue(url)).toBeInTheDocument();
    expect(screen.getByText("Copy this link now. It won't be shown again.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(url);
    const row = await screen.findByRole("group", { name: "Link abcdef…" });
    expect(row).toHaveTextContent("Live · Active");
  });

  it("sends a chosen expiry, mode and label", async () => {
    show();
    await screen.findByText("No links yet.");
    await userEvent.click(screen.getByRole("radio", { name: /Snapshot/ }));
    await userEvent.selectOptions(screen.getByLabelText("Expires"), "7");
    await userEvent.type(screen.getByLabelText("Label (only you see it)"), "For Sam");
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(api.create).toHaveBeenCalledWith("p1", {
      mode: "snapshot",
      expires_at: NOW + 7 * 24 * 60 * 60 * 1000,
      allow_comments: true,
      allow_downloads: false,
      label: "For Sam",
    });
  });

  it("warns that audio tracks will be silent only when there are clips", async () => {
    const song = newSong();
    const vocal = newTrack("audio", "Vocal");
    vocal.audio_clips = [{ id: "a" } as never];
    song.tracks = [vocal];
    show(song);
    expect(await screen.findByRole("note")).toHaveTextContent(AUDIO_WARNING);
    cleanup();
    show();
    await screen.findByText("No links yet.");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("lists links with status and unresolved counts, and edits toggles and expiry", async () => {
    links = [link({ label: "For Sam", unresolved_comments: 2 })];
    show();
    const row = await screen.findByRole("group", { name: "For Sam" });
    expect(row).toHaveTextContent("2 unresolved comments");
    await userEvent.click(within(row).getByRole("switch", { name: "Allow downloads" }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("p1", "s1", {
        label: "For Sam",
        expires_at: null,
        allow_comments: true,
        allow_downloads: true,
      }),
    );
    await userEvent.selectOptions(within(row).getByLabelText("Change expiry"), "1");
    await waitFor(() =>
      expect(api.update).toHaveBeenLastCalledWith("p1", "s1", expect.objectContaining({ expires_at: NOW + 24 * 60 * 60 * 1000 })),
    );
  });

  it("revokes only after confirming, then shows the link as revoked", async () => {
    links = [link({ label: "For Sam" })];
    show();
    const row = await screen.findByRole("group", { name: "For Sam" });
    await userEvent.click(within(row).getByRole("button", { name: "Revoke" }));
    expect(api.revoke).not.toHaveBeenCalled();
    await userEvent.click(within(row).getByRole("button", { name: "Confirm revoke" }));
    expect(api.revoke).toHaveBeenCalledWith("p1", "s1");
    await waitFor(() => expect(screen.getByRole("group", { name: "For Sam" })).toHaveTextContent("Revoked"));
    expect(within(screen.getByRole("group", { name: "For Sam" })).queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("keeps a link when revoking is cancelled", async () => {
    links = [link({ label: "For Sam" })];
    show();
    const row = await screen.findByRole("group", { name: "For Sam" });
    await userEvent.click(within(row).getByRole("button", { name: "Revoke" }));
    await userEvent.click(within(row).getByRole("button", { name: "Keep link" }));
    expect(api.revoke).not.toHaveBeenCalled();
    expect(within(row).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  it("shows the server's reason when a change fails", async () => {
    api.create.mockRejectedValue(new Error("This project has too many links."));
    show();
    await screen.findByText("No links yet.");
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This project has too many links.");
  });
});
