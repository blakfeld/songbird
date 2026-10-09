import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { missingHeadings } from "@/lib/lyrics/sectionLinks";
import LyricsEditor, { type LyricsEditorHandle } from "./LyricsEditor";

afterEach(cleanup);

const editable = () => screen.getByRole("textbox", { name: "Lyrics" });
const viewOf = () => EditorView.findFromDOM(editable().closest(".cm-editor") as HTMLElement)!;
const text = () => viewOf().state.doc.toString();

// jsdom cannot produce the input events CodeMirror reads typed characters from, so edits go in as the
// transactions those events would become.
function type(insert: string) {
  const view = viewOf();
  act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert }, userEvent: "input.type" });
  });
}

function setup(lyrics = "", songId = "a") {
  const onChange = vi.fn();
  const utils = render(<LyricsEditor songId={songId} lyrics={lyrics} onChange={onChange} />);
  return { onChange, ...utils };
}

describe("LyricsEditor", () => {
  it("is named Lyrics and shows the placeholder when empty", () => {
    setup();
    expect(editable()).toBeInTheDocument();
    expect(screen.getByText(/Write your lyrics here/)).toBeInTheDocument();
  });

  it("syncs typing to the store only after the debounce", async () => {
    const { onChange } = setup();
    type("[Chorus]\nla la");
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("[Chorus]\nla la", "a"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("flushes pending typing on blur", () => {
    const { onChange } = setup();
    type("words");
    fireEvent.blur(editable());
    expect(onChange).toHaveBeenCalledWith("words", "a");
  });

  it("flushes pending typing on unmount", () => {
    const { onChange, unmount } = setup();
    type("words");
    unmount();
    expect(onChange).toHaveBeenCalledWith("words", "a");
  });

  it("flushes pending typing when the page is hidden", () => {
    const { onChange } = setup();
    type("words");
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    state.mockRestore();
    expect(onChange).toHaveBeenCalledWith("words", "a");
  });

  it("flushes pending typing on pagehide, which a reload fires without a blur", () => {
    const { onChange } = setup();
    type("words");
    window.dispatchEvent(new Event("pagehide"));
    expect(onChange).toHaveBeenCalledWith("words", "a");
  });

  it("reports pending typing until it syncs", () => {
    const onPendingChange = vi.fn();
    render(<LyricsEditor songId="a" lyrics="" onChange={vi.fn()} onPendingChange={onPendingChange} />);
    type("words");
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    fireEvent.blur(editable());
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it("refuses a paste past the limit whole and says so", async () => {
    setup("a".repeat(19_990));
    const view = viewOf();
    act(() => {
      view.dispatch({ changes: { from: 19_990, insert: "b".repeat(50) }, userEvent: "input.paste" });
    });
    expect(text()).toHaveLength(19_990);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/limit reached/i));
  });

  it("counts characters as code points, so 20,000 emoji fit", () => {
    setup("😀".repeat(19_999));
    type("😀");
    expect([...text()]).toHaveLength(20_000);
    type("😀");
    expect([...text()]).toHaveLength(20_000);
  });

  it("shows the counter only past 18,000 characters", () => {
    setup("a".repeat(18_000));
    expect(screen.queryByText(/characters$/)).not.toBeInTheDocument();
    type("a");
    expect(screen.getByText("18,001 / 20,000 characters")).toBeInTheDocument();
    expect(editable()).toHaveAttribute("aria-describedby", screen.getByText(/18,001/).id);
  });

  it("counts the counter threshold in code points, so 9,001 emoji show no counter", () => {
    setup("😀".repeat(9_001));
    expect(screen.queryByText(/characters$/)).not.toBeInTheDocument();
    expect(editable()).not.toHaveAttribute("aria-describedby");
    type("😀".repeat(8_999));
    expect(screen.queryByText(/characters$/)).not.toBeInTheDocument();
    type("😀");
    expect(screen.getByText("18,001 / 20,000 characters")).toBeInTheDocument();
    expect(editable()).toHaveAttribute("aria-describedby", screen.getByText(/18,001/).id);
  });

  it("styles bracket-only lines as headings without changing the text", () => {
    setup("[Chorus]\nI said [softly] goodbye");
    const lines = document.querySelectorAll(".cm-line");
    expect(lines[0]).toHaveClass("cm-lyric-heading");
    expect(lines[1]).not.toHaveClass("cm-lyric-heading");
    expect(text()).toBe("[Chorus]\nI said [softly] goodbye");
  });

  it("shows the other song's lyrics when the song changes", () => {
    const onChange = vi.fn();
    const { rerender } = render(<LyricsEditor songId="a" lyrics="song A words" onChange={onChange} />);
    expect(text()).toBe("song A words");
    rerender(<LyricsEditor songId="b" lyrics="song B words" onChange={onChange} />);
    expect(text()).toBe("song B words");
    rerender(<LyricsEditor songId="a" lyrics="song A words" onChange={onChange} />);
    expect(text()).toBe("song A words");
  });

  it("keeps undo history from crossing songs", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<LyricsEditor songId="a" lyrics="" onChange={onChange} />);
    type("typed in A");
    rerender(<LyricsEditor songId="b" lyrics="song B" onChange={onChange} />);
    editable().focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(text()).toBe("song B");
  });

  it("applies a store change that did not come from typing, without echoing it back", () => {
    const onChange = vi.fn();
    const { rerender } = render(<LyricsEditor songId="a" lyrics="old" onChange={onChange} />);
    rerender(<LyricsEditor songId="a" lyrics="replaced" onChange={onChange} />);
    expect(text()).toBe("replaced");
    fireEvent.blur(editable());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("undoes its own typing with Ctrl+Z", async () => {
    setup("start");
    type(" more");
    editable().focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(text()).toBe("start");
  });
});

function withHandle(lyrics: string) {
  let handle!: LyricsEditorHandle;
  const registerEditor = (h: LyricsEditorHandle) => {
    handle = h;
    return () => {};
  };
  const onChange = vi.fn();
  const utils = render(
    <LyricsEditor songId="a" lyrics={lyrics} onChange={onChange} registerEditor={registerEditor} />,
  );
  return { ...utils, onChange, handle: () => handle };
}

describe("LyricsEditor handle", () => {
  it("reverts an applied suggestion with one undo", async () => {
    const { handle } = withHandle("start");
    act(() => void handle().apply({ from: 5, to: 5, insert: "\n[Hook]\nla\nla" }));
    expect(text()).toBe("start\n[Hook]\nla\nla");
    editable().focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(text()).toBe("start");
  });

  it("refuses an application past the limit and shows the limit notice", async () => {
    const { handle } = withHandle("a".repeat(19_990));
    let applied = true;
    act(() => {
      applied = handle().apply({ from: 19_990, to: 19_990, insert: "b".repeat(50) });
    });
    expect(applied).toBe(false);
    expect(text()).toHaveLength(19_990);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/limit reached/i));
  });

  it("shows a notice that came with an accepted application", async () => {
    const { handle } = withHandle("x");
    act(() => void handle().apply({ from: 1, to: 1, insert: "y" }, "Inserted at the cursor."));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Inserted at the cursor."));
  });

  it("snapshots typing that has not synced yet, with the selection and focus state", () => {
    const { handle, onChange } = withHandle("");
    type("[Chorus]\nla la");
    expect(onChange).not.toHaveBeenCalled();
    act(() => viewOf().dispatch({ selection: { anchor: 9, head: 14 } }));
    expect(handle().snapshot()).toEqual({
      doc: "[Chorus]\nla la",
      selection: { from: 9, to: 14, text: "la la" },
      cursor: 14,
      hasFocused: false,
    });
    act(() => {
      fireEvent.focus(editable());
    });
    expect(handle().snapshot().hasFocused).toBe(true);
  });

  it("remembers focus across a remount when the page owns the focus record", () => {
    const focusedSongs = new Set<string>();
    let handle!: LyricsEditorHandle;
    const registerEditor = (h: LyricsEditorHandle) => {
      handle = h;
      return () => {};
    };
    const mount = () =>
      render(<LyricsEditor songId="a" lyrics="x" onChange={vi.fn()} registerEditor={registerEditor} focusedSongs={focusedSongs} />);
    const first = mount();
    act(() => {
      fireEvent.focus(editable());
    });
    first.unmount();
    mount();
    expect(handle.snapshot().hasFocused).toBe(true);
  });

  it("reports no selection when the range is empty", () => {
    const { handle } = withHandle("abc");
    expect(handle().snapshot().selection).toBeNull();
  });

  it("flags unlinked headings and relinks them on a rename without losing undo history", async () => {
    const props = { songId: "a", lyrics: "[Hook]\nla", onChange: vi.fn() };
    const { rerender } = render(<LyricsEditor {...props} sectionKeys={["chorus"]} />);
    const heading = () => document.querySelector(".cm-line")!;
    expect(heading()).toHaveClass("cm-lyric-heading-unlinked");
    expect(heading()).toHaveAttribute("title", 'No song section named "Hook". Rename a section or this heading to link them.');
    expect(document.querySelector(".cm-lyric-unlinked-badge")).toHaveTextContent("no matching section");
    type(" more");
    rerender(<LyricsEditor {...props} sectionKeys={["hook"]} />);
    expect(heading()).toHaveClass("cm-lyric-heading");
    expect(heading()).not.toHaveClass("cm-lyric-heading-unlinked");
    expect(document.querySelector(".cm-lyric-unlinked-badge")).toBeNull();
    editable().focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(text()).toBe("[Hook]\nla");
  });

  it("offers Generate topline on linked headings only, without touching the lyrics", async () => {
    const onGenerateTopline = vi.fn();
    const onChange = vi.fn();
    render(
      <LyricsEditor
        songId="a"
        lyrics={"[Chorus]\nla\n[Hook]\nla"}
        onChange={onChange}
        sectionKeys={["chorus"]}
        onGenerateTopline={onGenerateTopline}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: /Generate topline/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("Generate topline for Chorus");
    await userEvent.click(buttons[0]);
    expect(onGenerateTopline).toHaveBeenCalledWith("Chorus");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("generates for the section under the cursor with Mod-Enter, without editing the lyrics", () => {
    const onGenerateTopline = vi.fn();
    const onChange = vi.fn();
    render(
      <LyricsEditor
        songId="a"
        lyrics={"[Verse]\nla\n[Chorus]\nhold me\nclose"}
        onChange={onChange}
        sectionKeys={["chorus", "verse"]}
        onGenerateTopline={onGenerateTopline}
      />,
    );
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    fireEvent.keyDown(view.contentDOM, { key: "Enter", ctrlKey: true });
    expect(onGenerateTopline).toHaveBeenCalledWith("Chorus");
    expect(view.state.doc.toString()).toBe("[Verse]\nla\n[Chorus]\nhold me\nclose");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves Mod-Enter to the editor when no handler is given", () => {
    render(<LyricsEditor songId="a" lyrics="[Chorus]\nla" onChange={vi.fn()} sectionKeys={["chorus"]} />);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    fireEvent.keyDown(view.contentDOM, { key: "Enter", ctrlKey: true });
    expect(view.state.doc.toString().length).toBeGreaterThan("[Chorus]\nla".length);
  });

  it("offers no topline action when the page gives no handler or section names", () => {
    const { unmount } = render(<LyricsEditor songId="a" lyrics="[Chorus]\nla" onChange={vi.fn()} sectionKeys={["chorus"]} />);
    expect(screen.queryByRole("button", { name: /Generate topline/ })).toBeNull();
    unmount();
    render(<LyricsEditor songId="a" lyrics="[Chorus]\nla" onChange={vi.fn()} onGenerateTopline={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Generate topline/ })).toBeNull();
  });

  it("flags nothing while the section names are unknown", () => {
    withHandle("[Hook]");
    expect(document.querySelector(".cm-lyric-heading-unlinked")).toBeNull();
  });

  it("appends scaffolded headings as one undo step", async () => {
    const { handle } = withHandle("[Verse 1]\nla");
    const sections = ["Intro", "Verse 1", "Chorus", "Outro"].map((name) => ({
      id: name,
      name,
      kind: "other" as const,
      measures: 4,
      notes: "",
    }));
    const { doc } = handle().snapshot();
    const insert = missingHeadings(doc, sections);
    act(() => void handle().apply({ from: doc.length, to: doc.length, insert }));
    expect(text()).toBe("[Verse 1]\nla\n[Intro]\n[Chorus]\n[Outro]");
    editable().focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(text()).toBe("[Verse 1]\nla");
  });
});
