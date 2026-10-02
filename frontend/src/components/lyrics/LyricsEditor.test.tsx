import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import LyricsEditor from "./LyricsEditor";

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
