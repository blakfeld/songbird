import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import type { Section, Song } from "@/lib/song/types";
import { SectionRuler } from "./SectionRuler";
import type { SectionActions } from "./SectionMenu";

const section = (id: string, name: string, kind: Section["kind"], measures: number): Section => ({
  id,
  name,
  kind,
  measures,
  notes: "",
});

const songWith = (sections?: Section[]): Song => ({
  ...newSongWithTracks(),
  measures: sections ? sections.reduce((n, s) => n + s.measures, 0) : 16,
  ...(sections && { sections }),
});

const SECTIONS = [section("i", "Intro", "intro", 4), section("v", "Verse", "verse", 8), section("h", "Hook", "chorus", 8)];

const actions = (): SectionActions => ({
  toggle: vi.fn(),
  clear: vi.fn(),
  add: vi.fn(),
  insert: vi.fn(),
  edit: vi.fn(),
  duplicate: vi.fn(),
  remove: vi.fn(),
  openNotes: vi.fn(),
  generateTopline: vi.fn(),
});

const show = (song: Song, selectedId: string | null = null, a = actions()) => {
  render(<SectionRuler song={song} selectedId={selectedId} actions={a} />);
  return a;
};
afterEach(cleanup);

describe("SectionRuler", () => {
  it("starts each label at its section's first measure", () => {
    show(songWith(SECTIONS));
    const left = (name: string) => screen.getByRole("button", { name }).parentElement!.style.left;
    expect(left("Intro, measures 1 to 4")).toBe("calc(var(--cell-w) * 0)");
    expect(left("Verse, measures 5 to 12")).toBe("calc(var(--cell-w) * 64)");
    expect(left("Hook (chorus), measures 13 to 20")).toBe("calc(var(--cell-w) * 192)");
    expect(screen.getByRole("button", { name: "Verse, measures 5 to 12" }).parentElement!.style.width).toBe(
      "calc(var(--cell-w) * 128 - 1px)",
    );
  });

  it("shows an unsectioned song as one Song section and names a single measure", () => {
    show(songWith());
    expect(screen.getByRole("group", { name: "Sections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Song (other), measures 1 to 16" })).toBeInTheDocument();
    cleanup();
    show(songWith([section("a", "Intro", "intro", 1), section("b", "Verse", "verse", 3)]));
    expect(screen.getByRole("button", { name: "Intro, measure 1" })).toBeInTheDocument();
  });

  it("marks the selected section pressed and gives the row one tab stop on it", () => {
    show(songWith(SECTIONS), "v");
    expect(screen.getByRole("button", { name: "Verse, measures 5 to 12" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Intro, measures 1 to 4" })).toHaveAttribute("aria-pressed", "false");
    const stops = screen.getAllByRole("button").filter((b) => b.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAccessibleName("Verse, measures 5 to 12");
  });

  it("moves focus with the arrow keys without selecting", async () => {
    const a = show(songWith(SECTIONS));
    screen.getByRole("button", { name: "Intro, measures 1 to 4" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Verse, measures 5 to 12" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("button", { name: "Hook (chorus), measures 13 to 20" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("button", { name: "Intro, measures 1 to 4" })).toHaveFocus();
    expect(a.toggle).not.toHaveBeenCalled();
  });

  it("toggles on click and Enter, and clears on Escape only while something is selected", async () => {
    const a = show(songWith(SECTIONS));
    await userEvent.click(screen.getByRole("button", { name: "Verse, measures 5 to 12" }));
    expect(a.toggle).toHaveBeenCalledWith("v");
    await userEvent.keyboard("{Enter}");
    expect(a.toggle).toHaveBeenCalledTimes(2);
    await userEvent.keyboard("{Escape}");
    expect(a.clear).not.toHaveBeenCalled();
    cleanup();
    const b = show(songWith(SECTIONS), "v");
    screen.getByRole("button", { name: "Verse, measures 5 to 12" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(b.clear).toHaveBeenCalled();
  });

  it("opens the edit dialog on F2", async () => {
    const a = show(songWith(SECTIONS));
    const label = screen.getByRole("button", { name: "Verse, measures 5 to 12" });
    label.focus();
    await userEvent.keyboard("{F2}");
    expect(a.edit).toHaveBeenCalledWith("v", label);
  });

  it("opens the per-section menu from its button, right-click and Shift+F10", async () => {
    const a = show(songWith(SECTIONS));
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Verse" }));
    const menu = screen.getByRole("menu", { name: "Section actions for Verse" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.replace("F2", ""))).toEqual([
      "Edit section…",
      "Insert section before…",
      "Insert section after…",
      "Duplicate",
      "Notes…",
      "Generate topline…",
      "Delete section",
    ]);
    expect(a.toggle).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Hook (chorus), measures 13 to 20" }) });
    expect(screen.getByRole("menu", { name: "Section actions for Hook" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    screen.getByRole("button", { name: "Intro, measures 1 to 4" }).focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "Section actions for Intro" })).toBeInTheDocument();
  });

  it("runs menu actions and closes", async () => {
    const a = show(songWith(SECTIONS));
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Verse" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Insert section after…" }));
    expect(a.insert).toHaveBeenCalledWith("v", "after", expect.any(HTMLElement));
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Verse" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete section" }));
    expect(a.remove).toHaveBeenCalledWith("v");
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Verse" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(a.duplicate).toHaveBeenCalledWith("v");
  });

  it("disables Delete for the only section and says why", async () => {
    const a = show(songWith());
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Song" }));
    const del = screen.getByRole("menuitem", { name: "Delete section" });
    expect(del).toHaveAttribute("aria-disabled", "true");
    expect(del).toHaveAccessibleDescription("A song needs at least one section");
    await userEvent.click(del);
    expect(a.remove).not.toHaveBeenCalled();
  });

  it("disables Insert and Duplicate at the 128 measure cap", async () => {
    const full = songWith([section("a", "A", "verse", 32), section("b", "B", "verse", 32), section("c", "C", "verse", 32), section("d", "D", "verse", 32)]);
    show(full);
    await userEvent.click(screen.getByRole("button", { name: "Section actions for A" }));
    expect(screen.getByRole("menuitem", { name: "Insert section before…" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveAccessibleDescription(
      "Duplicating would make the song longer than 128 measures",
    );
  });
});

describe("SectionRuler read-only", () => {
  it("offers no menus or toggle state, and seeks to a section start from the keyboard", async () => {
    const onSeek = vi.fn();
    render(<SectionRuler song={songWith(SECTIONS)} selectedId={null} onSeek={onSeek} />);
    expect(screen.queryByRole("button", { name: /Section actions/ })).toBeNull();
    const verse = screen.getByRole("button", { name: "Verse, measures 5 to 12" });
    expect(verse).not.toHaveAttribute("aria-pressed");
    verse.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSeek).toHaveBeenCalledWith(64);
    await userEvent.keyboard("{F2}{ContextMenu}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
