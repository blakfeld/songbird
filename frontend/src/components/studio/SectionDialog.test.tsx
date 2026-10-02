import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSongWithTracks } from "@/lib/song/testFixtures";
import type { Section, Song } from "@/lib/song/types";
import { SectionDialog, type SectionDialogRequest } from "./SectionDialog";

const section = (id: string, name: string, kind: Section["kind"], measures: number): Section => ({
  id,
  name,
  kind,
  measures,
  notes: "",
});

const songWith = (sections: Section[]): Song => ({
  ...newSongWithTracks(),
  measures: sections.reduce((n, s) => n + s.measures, 0),
  sections,
});

const BASE = [section("v", "Verse", "verse", 8), section("c", "Chorus", "chorus", 8)];

function open(request: SectionDialogRequest, song = songWith(BASE), result: string | null = null) {
  const onSubmit = vi.fn(() => result);
  const onClose = vi.fn();
  render(<SectionDialog request={request} song={song} onSubmit={onSubmit} onClose={onClose} />);
  return { onSubmit, onClose };
}
afterEach(cleanup);

const length = () => screen.getByRole("combobox", { name: "Length" }) as HTMLSelectElement;

describe("SectionDialog", () => {
  it("adds with a numbered default name and 8 measures", async () => {
    const { onSubmit } = open({ mode: "add" });
    expect(screen.getByRole("dialog", { name: "Add section" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Verse 2");
    expect(length().value).toBe("8");
    expect(screen.getByText("Starts at measure 17.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add section" }));
    expect(onSubmit).toHaveBeenCalledWith({ mode: "add" }, { kind: "verse", name: "Verse 2", measures: 8 });
  });

  it("regenerates the name from the kind until the user types one", async () => {
    const { onSubmit } = open({ mode: "add" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "bridge");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Bridge");
    await userEvent.clear(screen.getByRole("textbox", { name: "Name" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Break");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "outro");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Break");
    await userEvent.click(screen.getByRole("button", { name: "Add section" }));
    expect(onSubmit).toHaveBeenCalledWith({ mode: "add" }, { kind: "outro", name: "Break", measures: 8 });
  });

  it("requires a name", async () => {
    const { onSubmit } = open({ mode: "add" });
    await userEvent.clear(screen.getByRole("textbox", { name: "Name" }));
    await userEvent.click(screen.getByRole("button", { name: "Add section" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name.");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("titles insert and edit dialogs with the section they act on", () => {
    open({ mode: "insert", sectionId: "c", where: "after" });
    expect(screen.getByRole("dialog", { name: "Insert section after Chorus" })).toBeInTheDocument();
    expect(screen.getByText("Starts at measure 17.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Insert section" })).toBeInTheDocument();
    cleanup();
    open({ mode: "insert", sectionId: "c", where: "before" });
    expect(screen.getByText("Starts at measure 9.")).toBeInTheDocument();
    cleanup();
    open({ mode: "edit", sectionId: "c" });
    expect(screen.getByRole("dialog", { name: "Edit Chorus" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Chorus");
  });

  it("disables lengths that would pass 128 measures and explains why", () => {
    const near = songWith([section("a", "A", "verse", 32), section("b", "B", "verse", 32), section("c", "C", "verse", 32), section("d", "D", "verse", 24)]);
    open({ mode: "add" }, near);
    const option = (n: number) => screen.getByRole("option", { name: n === 1 ? "1 measure" : `${n} measures` }) as HTMLOptionElement;
    expect(option(8).disabled).toBe(false);
    expect(option(9).disabled).toBe(true);
    expect(length()).toHaveAccessibleDescription(/Up to 8 measures here, because a song can be at most 128 measures\./);
  });

  it("counts the edited section's own length as available when editing", () => {
    const full = songWith([section("a", "A", "verse", 32), section("b", "B", "verse", 32), section("c", "C", "verse", 32), section("d", "D", "verse", 32)]);
    open({ mode: "edit", sectionId: "d" }, full);
    expect(screen.getByRole("option", { name: "32 measures" })).not.toBeDisabled();
  });

  it("describes what a length change does to every track", async () => {
    open({ mode: "edit", sectionId: "v" });
    await userEvent.selectOptions(length(), "6");
    expect(screen.getByText("Removes measures 7–8 from every track. Undo restores them.")).toBeInTheDocument();
    await userEvent.selectOptions(length(), "12");
    expect(
      screen.getByText("Adds 4 empty measures after measure 8 in every track. Later sections move later."),
    ).toBeInTheDocument();
  });

  it("shows a refusal in the dialog and keeps it open", async () => {
    const { onClose } = open({ mode: "edit", sectionId: "v" }, undefined, "Drums is full (256 clips), so the section wasn't changed.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Drums is full");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels", async () => {
    const { onClose } = open({ mode: "add" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
