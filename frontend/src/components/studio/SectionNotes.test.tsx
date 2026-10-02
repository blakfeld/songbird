import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import type { Section, Song } from "@/lib/song/types";
import { SectionNotes } from "./SectionNotes";
import type { SectionActions } from "./SectionMenu";

const section = (id: string, name: string, kind: Section["kind"], measures: number, notes = ""): Section => ({
  id,
  name,
  kind,
  measures,
  notes,
});

const song = (): Song => {
  const sections = [section("v", "Verse", "verse", 8, "verse words"), section("c", "Chorus", "chorus", 8)];
  return { ...newSongWithTracks(), measures: 16, sections };
};

const actions = (): SectionActions => ({
  toggle: vi.fn(),
  clear: vi.fn(),
  add: vi.fn(),
  insert: vi.fn(),
  edit: vi.fn(),
  duplicate: vi.fn(),
  remove: vi.fn(),
  openNotes: vi.fn(),
});

// Mirrors the page: the selection and the stored notes live above the panel.
function Harness({ onChange, a }: { onChange: (text: string, songId: string, sectionId: string) => void; a: SectionActions }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [current, setCurrent] = useState(song());
  const actionsWithSelect = { ...a, toggle: (id: string) => setSelected(id) };
  return (
    <>
      <button onClick={() => setSelected("c")}>pick chorus</button>
      <button onClick={() => setSelected("v")}>pick verse</button>
      <SectionNotes fieldId="notes"
        song={current}
        selectedId={selected}
        actions={actionsWithSelect}
        onChange={(text, songId, id) => {
          onChange(text, songId, id);
          setCurrent((s) => ({ ...s, sections: s.sections!.map((x) => (x.id === id ? { ...x, notes: text } : x)) }));
        }}
      />
    </>
  );
};

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SectionNotes", () => {
  it("lists the sections when none is selected and selects from the list", async () => {
    const a = actions();
    render(<SectionNotes fieldId="notes" song={song()} selectedId={null} actions={a} onChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "No section selected" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Select Chorus, measures 9 to 16" }));
    expect(a.toggle).toHaveBeenCalledWith("c");
  });

  it("shows the selected section's notes with a counter and a header", () => {
    render(<SectionNotes fieldId="notes" song={song()} selectedId="v" actions={actions()} onChange={vi.fn()} />);
    const field = screen.getByRole("textbox", { name: "Notes for Verse" });
    expect(field).toHaveValue("verse words");
    expect(field).toHaveAccessibleDescription("11 / 5,000 characters");
    expect(screen.getByText("Verse · measures 1–8 · 8 measures")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Section actions" })).toBeInTheDocument();
  });

  it("debounces typing into onChange", async () => {
    const onChange = vi.fn();
    render(<SectionNotes fieldId="notes" song={song()} selectedId="c" actions={actions()} onChange={onChange} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Notes for Chorus" }), "hi");
    expect(onChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledWith("hi", expect.any(String), "c");
  });

  it("accepts a space as text", async () => {
    render(<SectionNotes fieldId="notes" song={song()} selectedId="c" actions={actions()} onChange={vi.fn()} />);
    const field = screen.getByRole("textbox", { name: "Notes for Chorus" });
    await userEvent.type(field, "a b");
    expect(field).toHaveValue("a b");
  });

  it("keeps notes per section when the selection switches, flushing the one being left", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} a={actions()} />);
    await userEvent.click(screen.getByRole("button", { name: "pick chorus" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Notes for Chorus" }), "call and response with the guitar");
    await userEvent.click(screen.getByRole("button", { name: "pick verse" }));
    expect(onChange).toHaveBeenCalledWith("call and response with the guitar", expect.any(String), "c");
    expect(screen.getByRole("textbox", { name: "Notes for Verse" })).toHaveValue("verse words");
    await userEvent.click(screen.getByRole("button", { name: "pick chorus" }));
    expect(screen.getByRole("textbox", { name: "Notes for Chorus" })).toHaveValue("call and response with the guitar");
  });

  it("flushes on blur", async () => {
    const onChange = vi.fn();
    render(<SectionNotes fieldId="notes" song={song()} selectedId="c" actions={actions()} onChange={onChange} />);
    const field = screen.getByRole("textbox", { name: "Notes for Chorus" });
    await userEvent.type(field, "x");
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith("x", expect.any(String), "c");
  });

  it("stops at 5,000 characters and says so", () => {
    const onChange = vi.fn();
    render(<SectionNotes fieldId="notes" song={song()} selectedId="c" actions={actions()} onChange={onChange} />);
    const field = screen.getByRole("textbox", { name: "Notes for Chorus" });
    fireEvent.change(field, { target: { value: "♪".repeat(5001) } });
    expect([...(field as HTMLTextAreaElement).value]).toHaveLength(5000);
    expect(screen.getByText(/Notes limit reached \(5,000 characters\)\. That edit wasn't added\./)).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription("5,000 / 5,000 characters");
  });
});
