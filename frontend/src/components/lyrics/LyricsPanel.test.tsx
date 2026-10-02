import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { useStore } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LyricsAssistResponse } from "@/generated/LyricsAssistResponse";
import * as api from "@/lib/api";
import { createSongStore, type SongStore } from "@/lib/song/songStore";
import { newSong, type Song } from "@/lib/song/types";
import { clearStoredValueCache } from "@/lib/useStoredValue";
import type { LyricsEditorHandle } from "./LyricsEditor";
import { LyricsPanel } from "./LyricsPanel";
import { useLyricChat } from "./useLyricChat";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  assistLyrics: vi.fn(),
  getSongLimits: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  clearStoredValueCache();
  vi.mocked(api.getSongLimits).mockResolvedValue({ max_input_tokens: 50 } as Awaited<ReturnType<typeof api.getSongLimits>>);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const song = (lyrics: string, extra: Partial<Song> = {}): Song => ({ ...newSong(), measures: 40, lyrics, ...extra });

function Harness({ store, heading }: { store: SongStore; heading?: boolean }) {
  const current = useStore(store, (s) => s.song);
  const editor = useRef<LyricsEditorHandle | null>(null);
  const [focused] = useState(() => new Set<string>());
  const chat = useLyricChat(store, editor, () => {});
  return (
    <LyricsPanel
      song={current}
      store={store}
      chat={chat}
      editorRef={editor}
      focusedSongs={focused}
      onChange={(t) => store.getState().setLyrics(t)}
      heading={heading}
    />
  );
}

function setup(initial: Song, heading?: boolean) {
  const store = createSongStore(initial);
  render(<Harness store={store} heading={heading} />);
  return store;
}

const notepad = () => screen.findByRole("textbox", { name: "Lyrics" });
const viewOf = async () => EditorView.findFromDOM((await notepad()).closest(".cm-editor") as HTMLElement)!;
const text = async () => (await viewOf()).state.doc.toString();
const input = () => screen.getByRole("textbox", { name: "Message the lyric assistant" });
const send = async (message: string) => {
  await userEvent.type(input(), message);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
};
const reply = (r: Partial<LyricsAssistResponse> = {}): LyricsAssistResponse => ({
  reply: "Try this.",
  suggestions: [],
  ...r,
});

describe("Add section headings", () => {
  it("scaffolds headings for an unsectioned song in one undo step", async () => {
    setup(song(""));
    await notepad();
    await userEvent.click(screen.getByRole("button", { name: "Add section headings" }));
    expect(await text()).toBe("[Song]\n[Song 2]");
    expect(screen.getByText("Added 2 headings.")).toBeInTheDocument();
    (await notepad()).focus();
    await act(async () => {
      await userEvent.keyboard("{Control>}z{/Control}");
    });
    expect(await text()).toBe("");
  });

  it("does nothing when every section already has a heading", async () => {
    setup(song("[song]\n[Song 2]"));
    const button = screen.getByRole("button", { name: "Add section headings" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await notepad();
    await userEvent.click(button);
    expect(await text()).toBe("[song]\n[Song 2]");
  });
});

describe("lyric chat", () => {
  it("sends the editor text, selection and sections, then shows the reply without changing lyrics", async () => {
    vi.mocked(api.assistLyrics).mockResolvedValue(
      reply({ suggestions: [{ id: "1", label: "Hook", text: "NEW", action: "insert" }] }),
    );
    const store = setup(song("[Song]\nline one\nline two"));
    const view = await viewOf();
    act(() => view.dispatch({ selection: { anchor: 7, head: 15 } }));
    await send("rhyme this");
    expect(await screen.findByText("Try this.")).toBeInTheDocument();
    const body = vi.mocked(api.assistLyrics).mock.calls[0][0];
    expect(body.lyrics).toBe("[Song]\nline one\nline two");
    expect(body.selection).toEqual({ from: 7, to: 15 });
    expect(body.song_context.sections.map((s) => s.id)).toEqual(["implicit", "implicit-2"]);
    expect(body.messages).toEqual([{ role: "user", content: "rhyme this" }]);
    expect(await text()).toBe("[Song]\nline one\nline two");
    expect(store.getState().song!.lyrics).toBe("[Song]\nline one\nline two");
    expect(store.getState().song!.lyric_chat![1].selection).toMatchObject({ from: 7, to: 15, text: "line one" });
    expect(store.getState().past).toHaveLength(0);
  });

  it("applies an insert only on click, and one undo reverts it", async () => {
    vi.mocked(api.assistLyrics).mockResolvedValue(
      reply({ suggestions: [{ id: "1", label: "Hook", text: "NEW", action: "insert" }] }),
    );
    setup(song("abc"));
    await send("go");
    await userEvent.click(await screen.findByRole("button", { name: "Insert at cursor" }));
    expect(await text()).toBe("abc\nNEW");
    expect(screen.getByText("✓ Inserted at the end.")).toBeInTheDocument();
    (await notepad()).focus();
    await act(async () => {
      await userEvent.keyboard("{Control>}z{/Control}");
    });
    expect(await text()).toBe("abc");
  });

  it("replaces a section, and appends a missing one", async () => {
    vi.mocked(api.assistLyrics).mockResolvedValue(
      reply({
        suggestions: [
          { id: "1", label: "Chorus", text: "x\ny", action: "replace_section", section_id: "implicit" },
          { id: "2", label: "Other", text: "z", action: "replace_section", section_id: "gone" },
        ],
      }),
    );
    setup(song("[Song]\nold\n[Song 2]\nkept"));
    await send("go");
    await userEvent.click(await screen.findByRole("button", { name: "Replace the Song section lyrics" }));
    expect(await text()).toBe("[Song]\nx\ny\n[Song 2]\nkept");
    expect(screen.getByText("✓ Replaced.")).toBeInTheDocument();
  });

  it("falls back to an insert with an explanation when the selected text has changed", async () => {
    vi.mocked(api.assistLyrics).mockResolvedValue(
      reply({ suggestions: [{ id: "1", label: "R", text: "NEW", action: "replace_selection" }] }),
    );
    setup(song("one two"));
    const view = await viewOf();
    act(() => view.dispatch({ selection: { anchor: 0, head: 3 } }));
    await send("go");
    const button = await screen.findByRole("button", { name: "Replace selection" });
    act(() => view.dispatch({ changes: { from: 0, to: 3, insert: "uno" } }));
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    fireEvent.focus(await notepad());
    await userEvent.click(button);
    expect(await text()).toBe("NEWuno two");
    expect(screen.getByText(/selected text has changed/)).toBeInTheDocument();
  });

  it("refuses an application past the lyrics limit and says nothing changed", async () => {
    vi.mocked(api.assistLyrics).mockResolvedValue(
      reply({ suggestions: [{ id: "1", label: "Hook", text: "b".repeat(50), action: "insert" }] }),
    );
    setup(song("a".repeat(19_990)));
    await send("go");
    await userEvent.click(await screen.findByRole("button", { name: "Insert at cursor" }));
    expect(await text()).toHaveLength(19_990);
    expect(screen.getByText("Lyrics limit reached. Nothing was changed.")).toBeInTheDocument();
  });

  it("keeps the typed message and leaves conversation and lyrics alone when a request fails", async () => {
    vi.mocked(api.assistLyrics).mockRejectedValue(new api.ApiError("generation_failed", "Could not generate.", 502));
    const store = setup(song("keep me"));
    await send("help");
    expect(await screen.findByRole("alert")).toHaveTextContent(/unchanged/);
    expect(input()).toHaveValue("help");
    expect(store.getState().song!.lyric_chat).toBeUndefined();
    expect(await text()).toBe("keep me");
  });

  it("discards a reply that arrives after another song was opened", async () => {
    let resolve!: (r: LyricsAssistResponse) => void;
    vi.mocked(api.assistLyrics).mockReturnValue(new Promise((r) => (resolve = r)));
    const store = setup(song("a"));
    await send("help");
    act(() => store.getState().loadSong(song("b")));
    await act(async () => resolve(reply()));
    expect(store.getState().song!.lyric_chat).toBeUndefined();
    expect(screen.queryByText("Try this.")).not.toBeInTheDocument();
  });

  it("disables Send and flags the counter when the message is over the token limit", async () => {
    setup(song(""));
    await userEvent.type(input(), "x".repeat(250));
    expect(await screen.findByText(/Shorten your message/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("confirms before clearing, returns focus on cancel, and keeps lyrics on clear", async () => {
    vi.mocked(api.assistLyrics).mockResolvedValue(reply());
    const store = setup(song("words"));
    await send("one");
    await userEvent.click(await screen.findByRole("button", { name: "Clear conversation" }));
    expect(screen.getByText("Clear 2 messages?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear conversation" })).toHaveFocus());
    expect(store.getState().song!.lyric_chat).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Clear conversation" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(store.getState().song!.lyric_chat).toBeUndefined();
    expect(store.getState().song!.lyrics).toBe("words");
    await waitFor(() => expect(input()).toHaveFocus());
  });

  it("does not hand an applied status to another suggestion after the list is trimmed", async () => {
    const suggestions = [{ id: "1", label: "Hook", text: "NEW", action: "insert" as const }];
    vi.mocked(api.assistLyrics).mockResolvedValue(reply({ suggestions }));
    const store = setup(song("abc"));
    await send("go");
    await userEvent.click(await screen.findByRole("button", { name: "Insert at cursor" }));
    expect(screen.getByText("✓ Inserted at the end.")).toBeInTheDocument();
    act(() => {
      for (let i = 0; i < 10; i++) store.getState().applyLyricReply(`q${i}`, null, reply({ suggestions }), {});
    });
    expect(store.getState().song!.lyric_chat).toHaveLength(20);
    expect(screen.queryByText("✓ Inserted at the end.")).not.toBeInTheDocument();
  });

  it("names the panel with an h3 in the drawer and an h2 in the tab", async () => {
    setup(song(""), true);
    expect(screen.getByRole("heading", { level: 3, name: "Lyric assistant" })).toBeInTheDocument();
    cleanup();
    setup(song(""));
    expect(screen.getByRole("heading", { level: 2, name: "Lyric assistant" })).toBeInTheDocument();
  });

  // A scripted Tab order, not a manual keyboard check with a real browser and screen reader.
  it("tabs from the notepad through the clear button, suggestion buttons, input and Send", async () => {
    vi.mocked(api.assistLyrics).mockResolvedValue(
      reply({
        suggestions: [
          { id: "1", label: "A", text: "a", action: "insert" },
          { id: "2", label: "B", text: "b", action: "replace_selection" },
        ],
      }),
    );
    setup(song("words"));
    await send("go");
    await screen.findByText("Try this.");
    (await notepad()).focus();
    for (const name of ["Clear conversation", "Insert at cursor", "Replace selection"]) {
      await userEvent.tab();
      expect(screen.getByRole("button", { name })).toHaveFocus();
    }
    await userEvent.tab();
    expect(input()).toHaveFocus();
    await userEvent.type(input(), "x");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveFocus();
  });
});
