import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Note } from "@/generated/Note";
import { gridOf } from "@/lib/patternOps";
import { clearClipboard } from "@/lib/noteClipboard";
import { getPatternStore, usePatternStore } from "@/lib/patternStore";
import { cellLabel } from "@/lib/pianoRoll";
import { drums, note, patternWith } from "@/test/fixtures";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { PianoRoll } from "./PianoRoll";

const store = () => getPatternStore("drums");

function Harness() {
  useEditorShortcuts("drums");
  const pattern = usePatternStore("drums", (s) => s.pattern)!;
  const loadId = usePatternStore("drums", (s) => s.loadId);
  const actions = getPatternStore("drums").getState();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <>
      <div ref={setSlot} />
      <PianoRoll
        instrumentName="Drums"
        grid={gridOf(pattern)}
        timeSignature={pattern.time_signature}
        stepsPerMeasure={pattern.steps_per_measure}
        resetKey={loadId}
        onToggleNote={actions.toggleNote}
        onSetVelocity={actions.setVelocity}
        onResizeNote={actions.resizeNote}
        onEditNotes={actions.editNotes}
        onBeginGesture={actions.beginGesture}
        onEndGesture={actions.commitGesture}
        onCancelGesture={actions.cancelGesture}
        inspectorTarget={slot}
        loop={{ region: null, enabled: false }}
        follow
        isPlaying={false}
        onManualScroll={() => {}}
        subscribePosition={() => () => {}}
      />
    </>
  );
}

const sung = (row: string, step: number, lyric: string): Note => ({ ...note(row, step), lyric });
const rowName = (id: string) => drums.rows.find((r) => r.id === id)!.name;

function setup(notes: Note[]) {
  store().setState({ pattern: patternWith(notes), prompt: "", past: [], future: [] });
  return render(<Harness />);
}

const selectAll = async () => {
  screen.getByRole("button", { name: cellLabel(rowName("snare"), 0, 16) }).focus();
  await userEvent.keyboard("{Control>}a{/Control}");
};
const lyrics = () => store().getState().pattern!.notes.map((n) => n.lyric);
const lyricField = () => screen.getByLabelText("Lyric") as HTMLInputElement;

beforeEach(() => {
  clearClipboard();
  localStorage.clear();
});

describe("syllables on notes", () => {
  it("shows each note's syllable and names the first one in its accessible label", () => {
    setup([sung("kick", 0, "hold"), sung("kick", 4, "me"), sung("kick", 8, "close")]);
    expect(screen.getAllByTestId("note-lyric").map((e) => e.textContent)).toEqual(["hold", "me", "close"]);
    const cell = screen.getByRole("button", { name: /lyric hold/ });
    expect(cell).toBeInTheDocument();
    expect(cell.getAttribute("aria-description")).not.toMatch(/hold/);
  });

  it("draws a note without a lyric as before", () => {
    setup([note("kick", 0)]);
    expect(screen.queryByTestId("note-lyric")).not.toBeInTheDocument();
  });
});

describe("lyric field", () => {
  it("edits a syllable and restores it with one undo", async () => {
    setup([sung("kick", 0, "me")]);
    await selectAll();
    expect(lyricField()).toHaveValue("me");
    await userEvent.clear(lyricField());
    await userEvent.type(lyricField(), "you{Enter}");
    expect(lyrics()).toEqual(["you"]);
    expect(store().getState().past).toHaveLength(1);
    store().getState().undo();
    expect(lyrics()).toEqual(["me"]);
  });

  it("removes the lyric when the field is emptied", async () => {
    setup([sung("kick", 0, "me")]);
    await selectAll();
    await userEvent.clear(lyricField());
    await userEvent.keyboard("{Enter}");
    expect(store().getState().pattern!.notes[0]).not.toHaveProperty("lyric");
  });

  it("refuses 17 characters and says why", async () => {
    setup([sung("kick", 0, "me")]);
    await selectAll();
    await userEvent.clear(lyricField());
    await userEvent.type(lyricField(), "a".repeat(17));
    expect(lyricField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/at most 16 characters/);
    await userEvent.keyboard("{Enter}");
    expect(lyrics()).toEqual(["me"]);
    expect(store().getState().past).toHaveLength(0);
  });

  it("keeps an invalid draft and its alert when the field loses focus", async () => {
    setup([sung("kick", 0, "me")]);
    await selectAll();
    await userEvent.clear(lyricField());
    await userEvent.type(lyricField(), "a".repeat(17));
    await userEvent.tab();
    expect(lyricField()).toHaveValue("a".repeat(17));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(lyrics()).toEqual(["me"]);
  });

  it("trims the lyric, and clears it when only spaces remain", async () => {
    setup([sung("kick", 0, "me")]);
    await selectAll();
    await userEvent.clear(lyricField());
    await userEvent.type(lyricField(), "  you  {Enter}");
    expect(lyrics()).toEqual(["you"]);
    await userEvent.clear(lyricField());
    await userEvent.type(lyricField(), "   {Enter}");
    expect(store().getState().pattern!.notes[0]).not.toHaveProperty("lyric");
  });

  it("accepts exactly 16 characters", async () => {
    setup([sung("kick", 0, "me")]);
    await selectAll();
    await userEvent.clear(lyricField());
    await userEvent.type(lyricField(), "b".repeat(16));
    await userEvent.keyboard("{Enter}");
    expect(lyrics()).toEqual(["b".repeat(16)]);
  });

  it("is hidden when several notes are selected", async () => {
    setup([sung("kick", 0, "a"), sung("kick", 4, "b")]);
    await selectAll();
    expect(screen.queryByLabelText("Lyric")).not.toBeInTheDocument();
  });
});

describe("Clear lyrics", () => {
  it("removes every selected lyric as one undo step", async () => {
    setup([sung("kick", 0, "a"), sung("kick", 4, "b"), note("kick", 8)]);
    await selectAll();
    await userEvent.click(screen.getByRole("button", { name: "Clear lyrics" }));
    expect(lyrics()).toEqual([undefined, undefined, undefined]);
    expect(store().getState().past).toHaveLength(1);
    store().getState().undo();
    expect(lyrics()).toEqual(["a", "b", undefined]);
  });

  it("is not offered when no selected note has a lyric", async () => {
    setup([note("kick", 0), note("kick", 4)]);
    await selectAll();
    expect(screen.queryByRole("button", { name: "Clear lyrics" })).not.toBeInTheDocument();
  });
});
