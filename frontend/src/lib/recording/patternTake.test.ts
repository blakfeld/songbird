import { beforeEach, describe, expect, it } from "vitest";
import { drums, note } from "@/test/fixtures";
import { createPatternStore } from "../patternStore";
import { createPatternTake } from "./patternTake";

function setup(initial = [note("kick", 0), note("kick", 8)]) {
  const store = createPatternStore("drums");
  store.getState().newEmptyPattern(drums, 4);
  store.getState().editNotes(() => initial);
  return store;
}
const notes = (s: ReturnType<typeof setup>) => s.getState().pattern!.notes;

beforeEach(() => localStorage.clear());

describe("pattern take", () => {
  it("records a take as one undo step", () => {
    const store = setup();
    const before = notes(store);
    const pastLength = store.getState().past.length;
    const take = createPatternTake(store);
    take.begin();
    for (let i = 0; i < 12; i++) take.add(note("snare", 2 + i * 5));
    expect(store.getState().past).toHaveLength(pastLength);
    expect(take.end().recorded).toBe(12);
    expect(store.getState().past).toHaveLength(pastLength + 1);
    store.getState().undo();
    expect(notes(store)).toEqual(before);
  });

  it("hears the first pass during the second pass", () => {
    const store = setup();
    const take = createPatternTake(store);
    take.begin();
    take.add(note("snare", 4));
    expect(notes(store)).toContainEqual(note("snare", 4));
    expect(notes(store)).toContainEqual(note("kick", 0));
    take.add(note("snare", 12));
    expect(notes(store).filter((n) => n.row_id === "snare")).toHaveLength(2);
    take.end();
    expect(notes(store)).toHaveLength(4);
  });

  it("leaves history unchanged for an empty take", () => {
    const store = setup();
    const past = store.getState().past;
    const take = createPatternTake(store);
    take.begin();
    expect(take.end().recorded).toBe(0);
    expect(store.getState().past).toBe(past);
  });

  it("never changes the pattern length", () => {
    const store = setup();
    const take = createPatternTake(store);
    take.begin();
    take.add(note("snare", 60, 10));
    take.add(note("snare", 64));
    take.end();
    expect(store.getState().pattern!.measures).toBe(4);
    expect(notes(store)).toContainEqual(note("snare", 60, 4));
    expect(notes(store).some((n) => n.step >= 64)).toBe(false);
  });

  it("restores the base notes on discard without history", () => {
    const store = setup();
    const before = notes(store);
    const past = store.getState().past;
    const take = createPatternTake(store);
    take.begin();
    take.add(note("snare", 4));
    take.discard();
    expect(notes(store)).toBe(before);
    expect(store.getState().past).toBe(past);
  });

  it("clears redo when a take commits", () => {
    const store = setup();
    store.getState().toggleNote("hat_closed", 2);
    store.getState().undo();
    const take = createPatternTake(store);
    take.begin();
    take.add(note("snare", 4));
    take.end();
    expect(store.getState().future).toHaveLength(0);
  });
});

describe("pattern take under other edits", () => {
  it("keeps an edit made mid-take and does not overwrite it with the next note", () => {
    const store = setup();
    const take = createPatternTake(store);
    take.begin();
    take.add(note("snare", 4));
    store.getState().toggleNote("hat_closed", 2);
    take.add(note("snare", 12));
    const rows = notes(store).map((n) => `${n.row_id}@${n.step}`);
    expect(rows).toContain("hat_closed@2");
    expect(rows).toContain("snare@4");
    expect(rows).toContain("snare@12");
    expect(take.end().recorded).toBe(2);
  });

  it("keeps history coherent so each undo step restores a state that existed", () => {
    const store = setup();
    const before = notes(store);
    const take = createPatternTake(store);
    take.begin();
    take.add(note("snare", 4));
    store.getState().toggleNote("hat_closed", 2);
    take.add(note("snare", 12));
    take.end();
    const final = notes(store);
    store.getState().undo();
    expect(notes(store).some((n) => n.row_id === "snare" && n.step === 12)).toBe(false);
    expect(notes(store).some((n) => n.row_id === "hat_closed")).toBe(true);
    store.getState().undo();
    expect(notes(store)).toEqual(before);
    store.getState().redo();
    store.getState().redo();
    expect(notes(store)).toEqual(final);
  });

  it("commits the take before an undo, which then keeps the take redoable", () => {
    const store = setup();
    const before = notes(store);
    const take = createPatternTake(store);
    take.begin();
    take.add(note("snare", 4));
    const withTake = notes(store);
    take.end();
    store.getState().undo();
    expect(notes(store)).toEqual(before);
    store.getState().redo();
    expect(notes(store)).toEqual(withTake);
    take.begin();
    take.add(note("snare", 12));
    expect(notes(store)).toContainEqual(note("snare", 4));
  });

  it("does not lose a note recorded after an undo ran mid-take", () => {
    const store = setup();
    store.getState().toggleNote("hat_closed", 2);
    const take = createPatternTake(store);
    take.begin();
    store.getState().undo();
    take.add(note("snare", 4));
    expect(notes(store)).toContainEqual(note("snare", 4));
    expect(notes(store).some((n) => n.row_id === "hat_closed")).toBe(false);
    take.end();
    expect(notes(store)).toContainEqual(note("snare", 4));
  });

  it("re-bases when a drag's gesture replaced the cleared one, so the edit is not overwritten", () => {
    const store = setup();
    const take = createPatternTake(store);
    take.begin();
    take.add(note("snare", 4));
    store.getState().toggleNote("hat_closed", 2);
    store.getState().beginGesture();
    take.add(note("snare", 12));
    const rows = notes(store).map((n) => `${n.row_id}@${n.step}`);
    expect(rows).toEqual(expect.arrayContaining(["hat_closed@2", "snare@4", "snare@12"]));
  });
});
