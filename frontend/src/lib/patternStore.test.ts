import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { Note } from "@/generated/Note";
import { setCurrentUserId } from "./auth/currentUser";
import { signOutLocally } from "./auth/signOut";
import { createPatternStore, getPatternStore, storageKey } from "./patternStore";

const drums: InstrumentInfo = {
  id: "drums",
  name: "Drums",
  kind: "drums",
  midi_program: null,
  range: null,
  midi_channel: 10,
  sustained: false,
  rows: [
    { id: "kick", name: "Kick", midi_note: 36 },
    { id: "snare", name: "Snare", midi_note: 38 },
  ],
};

const note = (row_id: string, step: number, length_steps = 1, velocity = 100): Note => ({
  row_id,
  step,
  length_steps,
  velocity,
});

function fresh(measures: 4 | 8 = 4) {
  const store = createPatternStore("drums");
  store.getState().newEmptyPattern(drums, measures);
  return store;
}

const notes = (s: ReturnType<typeof fresh>) => s.getState().pattern!.notes;

beforeEach(() => localStorage.clear());

describe("pattern store", () => {
  it("newEmptyPattern builds an empty grid with the instrument's rows", () => {
    const p = fresh(8).getState().pattern!;
    expect(p.measures).toBe(8);
    expect(p.steps_per_measure).toBe(16);
    expect(p.rows).toEqual(drums.rows);
    expect(p.midi_channel).toBe(10);
    expect(p.notes).toEqual([]);
  });

  it("newEmptyPattern honours time signature (3/4 is 12 steps)", () => {
    const store = createPatternStore("drums");
    store.getState().newEmptyPattern(drums, 4, "3/4", 90);
    const p = store.getState().pattern!;
    expect(p.steps_per_measure).toBe(12);
    expect(p.tempo_bpm).toBe(90);
  });

  it("toggleNote adds a length-1 velocity-100 note on an empty cell", () => {
    const s = fresh();
    s.getState().toggleNote("snare", 4);
    expect(notes(s)).toEqual([note("snare", 4)]);
  });

  it("toggleNote removes a note by clicking any cell it covers", () => {
    const s = fresh();
    s.getState().setPattern({ ...s.getState().pattern!, notes: [note("kick", 0, 4)] });
    s.getState().toggleNote("kick", 2);
    expect(notes(s)).toEqual([]);
  });

  it("toggleNote ignores unknown rows and out-of-range steps", () => {
    const s = fresh();
    s.getState().toggleNote("nope", 0);
    s.getState().toggleNote("kick", 64);
    expect(notes(s)).toEqual([]);
    expect(s.getState().past).toHaveLength(0);
  });

  it("setVelocity changes and clamps velocity", () => {
    const s = fresh();
    s.getState().toggleNote("kick", 0);
    s.getState().setVelocity("kick", 0, 40);
    expect(notes(s)[0].velocity).toBe(40);
    s.getState().setVelocity("kick", 0, 500);
    expect(notes(s)[0].velocity).toBe(127);
    s.getState().setVelocity("kick", 0, -3);
    expect(notes(s)[0].velocity).toBe(1);
  });

  it("resizeNote lengthens a note", () => {
    const s = fresh();
    s.getState().toggleNote("kick", 0);
    s.getState().resizeNote("kick", 0, 4);
    expect(notes(s)[0].length_steps).toBe(4);
  });

  it("resizeNote stops at the next note on the row", () => {
    const s = fresh();
    s.getState().toggleNote("kick", 0);
    s.getState().toggleNote("kick", 4);
    s.getState().resizeNote("kick", 0, 8);
    expect(notes(s).find((n) => n.step === 0)!.length_steps).toBe(4);
  });

  it("resizeNote is not blocked by notes on other rows and stops at the pattern end", () => {
    const s = fresh();
    s.getState().toggleNote("kick", 60);
    s.getState().toggleNote("snare", 62);
    s.getState().resizeNote("kick", 60, 20);
    expect(notes(s).find((n) => n.row_id === "kick")!.length_steps).toBe(4);
  });

  it("resizeNote enforces a minimum of 1", () => {
    const s = fresh();
    s.getState().toggleNote("kick", 0);
    s.getState().resizeNote("kick", 0, 3);
    s.getState().resizeNote("kick", 0, 0);
    expect(notes(s)[0].length_steps).toBe(1);
  });

  it("setMeasures lengthens 4 to 8 by repeating measures in order", () => {
    const s = fresh(4);
    s.getState().toggleNote("kick", 0);
    s.getState().toggleNote("snare", 20);
    s.getState().toggleNote("kick", 50);
    s.getState().setMeasures(8);
    const p = s.getState().pattern!;
    expect(p.measures).toBe(8);
    const spm = p.steps_per_measure;
    for (let m = 0; m < 4; m++) {
      const inMeasure = (k: number) =>
        p.notes
          .filter((n) => Math.floor(n.step / spm) === k)
          .map((n) => ({ ...n, step: n.step - k * spm }));
      expect(inMeasure(m + 4)).toEqual(inMeasure(m));
    }
    expect(p.notes).toHaveLength(6);
  });

  it("setMeasures shortens 8 to 4, dropping late notes and truncating a crossing note", () => {
    const s = fresh(8);
    s.getState().toggleNote("kick", 0);
    s.getState().toggleNote("kick", 60);
    s.getState().resizeNote("kick", 60, 4);
    s.getState().toggleNote("snare", 64);
    s.getState().toggleNote("snare", 100);
    s.getState().setMeasures(4);
    const p = s.getState().pattern!;
    expect(p.notes.every((n) => n.step < 64)).toBe(true);
    expect(p.notes.every((n) => n.step + n.length_steps <= 64)).toBe(true);
    expect(p.notes.find((n) => n.step === 60)!.length_steps).toBe(4);
    expect(p.notes).toHaveLength(2);
  });

  it("setMeasures truncates a note that crosses the new end", () => {
    const s = fresh(8);
    s.getState().toggleNote("kick", 62);
    s.getState().resizeNote("kick", 62, 6);
    s.getState().setMeasures(4);
    expect(notes(s)[0].length_steps).toBe(2);
  });

  it("setMeasures to a non-multiple length never overflows the end", () => {
    const s = fresh(8);
    s.getState().toggleNote("kick", 60);
    s.getState().resizeNote("kick", 60, 8);
    s.getState().setMeasures(12);
    const p = s.getState().pattern!;
    expect(p.notes.every((n) => n.step + n.length_steps <= 12 * 16)).toBe(true);
  });

  it("setTempo and setSwing clamp to their ranges", () => {
    const s = fresh();
    s.getState().setTempo(120);
    expect(s.getState().pattern!.tempo_bpm).toBe(120);
    s.getState().setTempo(999);
    expect(s.getState().pattern!.tempo_bpm).toBe(240);
    s.getState().setTempo(1);
    expect(s.getState().pattern!.tempo_bpm).toBe(40);
    s.getState().setSwing(0.5);
    expect(s.getState().pattern!.swing).toBe(0.5);
    s.getState().setSwing(2);
    expect(s.getState().pattern!.swing).toBe(0.75);
    s.getState().setSwing(-1);
    expect(s.getState().pattern!.swing).toBe(0);
  });

  it("clear removes all notes but keeps parameters", () => {
    const s = fresh();
    s.getState().setTempo(100);
    s.getState().toggleNote("kick", 0);
    s.getState().clear();
    expect(notes(s)).toEqual([]);
    expect(s.getState().pattern!.tempo_bpm).toBe(100);
  });

  it("setPattern replaces the pattern (e.g. after generation)", () => {
    const s = fresh();
    const generated = { ...s.getState().pattern!, name: "Generated", notes: [note("kick", 0)] };
    s.getState().setPattern(generated);
    expect(s.getState().pattern).toEqual(generated);
  });

  it("actions are no-ops before a pattern exists", () => {
    const s = createPatternStore("drums");
    s.getState().toggleNote("kick", 0);
    s.getState().setTempo(100);
    s.getState().clear();
    expect(s.getState().pattern).toBeNull();
    expect(s.getState().past).toEqual([]);
  });

  describe("undo and redo", () => {
    it("undo restores a removed note and redo removes it again", () => {
      const s = fresh();
      s.getState().toggleNote("kick", 0);
      s.getState().toggleNote("kick", 0);
      expect(notes(s)).toEqual([]);
      s.getState().undo();
      expect(notes(s)).toEqual([note("kick", 0)]);
      s.getState().redo();
      expect(notes(s)).toEqual([]);
    });

    it("undoes resizes and parameter changes", () => {
      const s = fresh();
      s.getState().toggleNote("kick", 0);
      s.getState().resizeNote("kick", 0, 4);
      s.getState().setTempo(150);
      s.getState().undo();
      expect(s.getState().pattern!.tempo_bpm).toBe(120);
      s.getState().undo();
      expect(notes(s)[0].length_steps).toBe(1);
      s.getState().setMeasures(8);
      s.getState().undo();
      expect(s.getState().pattern!.measures).toBe(4);
    });

    it("a new edit clears the redo stack", () => {
      const s = fresh();
      s.getState().toggleNote("kick", 0);
      s.getState().undo();
      s.getState().toggleNote("kick", 4);
      expect(s.getState().future).toEqual([]);
      s.getState().redo();
      expect(notes(s)).toEqual([note("kick", 4)]);
    });

    it("undo and redo with empty stacks do nothing", () => {
      const s = fresh();
      const before = s.getState().pattern;
      s.getState().redo();
      s.getState().undo();
      s.getState().undo();
      expect(s.getState().pattern).toBe(before);
    });

    it("no-op edits do not create history entries", () => {
      const s = fresh();
      s.getState().setTempo(120);
      s.getState().clear();
      expect(s.getState().past).toHaveLength(0);
    });
  });

  describe("persistence", () => {
    it("stores under songbird.patterns.<user>.<instrument>.v1 and restores on recreate", () => {
      const s = fresh();
      s.getState().toggleNote("snare", 4);
      s.getState().setPrompt("boom bap");
      expect(localStorage.getItem(storageKey("drums", "test-user"))).not.toBeNull();
      expect(storageKey("drums", "test-user")).toBe("songbird.patterns.test-user.drums.v1");

      const reloaded = createPatternStore("drums");
      expect(reloaded.getState().pattern).toEqual(s.getState().pattern);
      expect(reloaded.getState().prompt).toBe("boom bap");
      expect(reloaded.getState().past).toEqual([]);
    });

    it("keeps instruments separate", () => {
      fresh().getState().toggleNote("kick", 0);
      expect(createPatternStore("bass").getState().pattern).toBeNull();
    });

    it("restores the region and looping setting after a reload", () => {
      const s = fresh(8);
      s.getState().setLoop({ region: { start: 3, end: 4 }, enabled: false });
      const reloaded = createPatternStore("drums");
      expect(reloaded.getState().loop).toEqual({ region: { start: 3, end: 4 }, enabled: false });
    });

    it("restores looping on with no region", () => {
      const s = fresh(8);
      s.getState().setLoop({ region: null, enabled: true });
      expect(createPatternStore("drums").getState().loop).toEqual({ region: null, enabled: true });
    });

    it("loads stored work without loop data as no region and looping off", () => {
      const s = fresh(8);
      const raw = JSON.parse(localStorage.getItem(storageKey("drums", "test-user"))!);
      delete raw.state.loop;
      localStorage.setItem(storageKey("drums", "test-user"), JSON.stringify(raw));
      const reloaded = createPatternStore("drums");
      expect(reloaded.getState().loop).toEqual({ region: null, enabled: false });
      expect(s.getState().pattern).toEqual(reloaded.getState().pattern);
    });

    it("treats the flat shape from earlier builds as the default", () => {
      fresh(8);
      const raw = JSON.parse(localStorage.getItem(storageKey("drums", "test-user"))!);
      raw.state.loop = { start: 3, end: 4, enabled: true };
      localStorage.setItem(storageKey("drums", "test-user"), JSON.stringify(raw));
      expect(createPatternStore("drums").getState().loop).toEqual({ region: null, enabled: false });
    });

    it("clamps a stored region that no longer fits its pattern", () => {
      fresh(4);
      const raw = JSON.parse(localStorage.getItem(storageKey("drums", "test-user"))!);
      raw.state.loop = { region: { start: 3, end: 40 }, enabled: true };
      localStorage.setItem(storageKey("drums", "test-user"), JSON.stringify(raw));
      expect(createPatternStore("drums").getState().loop).toEqual({ region: { start: 3, end: 4 }, enabled: true });
    });
  });

  describe("loop", () => {
    it("starts with no region and looping off", () => {
      expect(fresh(8).getState().loop).toEqual({ region: null, enabled: false });
    });

    it("is not an undo step and is left alone by undo and redo", () => {
      const s = fresh(8);
      s.getState().toggleNote("kick", 0);
      s.getState().setLoop({ region: { start: 2, end: 3 }, enabled: false });
      expect(s.getState().past).toHaveLength(1);
      s.getState().undo();
      expect(s.getState().pattern!.notes).toHaveLength(0);
      expect(s.getState().loop).toEqual({ region: { start: 2, end: 3 }, enabled: false });
      s.getState().redo();
      expect(s.getState().loop).toEqual({ region: { start: 2, end: 3 }, enabled: false });
    });

    it("keeps a drawn region when lengthened and clamps it when shortened", () => {
      const s = fresh(4);
      s.getState().setLoop({ region: { start: 1, end: 4 }, enabled: true });
      s.getState().setMeasures(8);
      expect(s.getState().loop.region).toEqual({ start: 1, end: 4 });
      s.getState().setLoop({ region: { start: 5, end: 8 }, enabled: false });
      s.getState().setMeasures(4);
      expect(s.getState().loop).toEqual({ region: { start: 4, end: 4 }, enabled: false });
    });

    it("leaves no region as no region when the length changes", () => {
      const s = fresh(4);
      s.getState().setLoop({ region: null, enabled: true });
      s.getState().setMeasures(8);
      expect(s.getState().loop).toEqual({ region: null, enabled: true });
    });

    it("clamps when undoing a length change", () => {
      const s = fresh(4);
      s.getState().setMeasures(8);
      s.getState().setLoop({ region: { start: 5, end: 8 }, enabled: true });
      s.getState().undo();
      expect(s.getState().pattern!.measures).toBe(4);
      expect(s.getState().loop).toEqual({ region: { start: 4, end: 4 }, enabled: true });
    });

    it("keeps the region and looping setting when a new pattern of the same length replaces it", () => {
      const s = fresh(8);
      s.getState().setMeasures(16);
      s.getState().setLoop({ region: { start: 5, end: 8 }, enabled: true });
      s.getState().setPattern({ ...s.getState().pattern!, name: "generated" });
      expect(s.getState().loop).toEqual({ region: { start: 5, end: 8 }, enabled: true });
    });

    it("clamps the region when start-blank replaces the pattern with a shorter one", () => {
      const s = fresh(8);
      s.getState().setMeasures(16);
      s.getState().setLoop({ region: { start: 5, end: 8 }, enabled: true });
      s.getState().newEmptyPattern(drums, 4);
      expect(s.getState().loop).toEqual({ region: { start: 4, end: 4 }, enabled: true });
    });

    it("keeps the loop when the pattern is replaced", () => {
      const s = fresh(4);
      s.getState().setLoop({ region: null, enabled: true });
      s.getState().newEmptyPattern(drums, 8);
      expect(s.getState().loop).toEqual({ region: null, enabled: true });
    });
  });
});

describe("note gestures", () => {
  const setNotes = (s: ReturnType<typeof fresh>, ...ns: Note[]) => {
    s.getState().editNotes(() => ns);
    return s;
  };

  it("records a whole drag of transient edits as one undo step", () => {
    const s = setNotes(fresh(), note("kick", 0));
    const before = s.getState().past.length;
    s.getState().beginGesture();
    for (let step = 1; step <= 4; step++) {
      s.getState().editNotes(() => [note("kick", step)], { transient: true });
    }
    expect(s.getState().past).toHaveLength(before);
    s.getState().commitGesture();
    expect(s.getState().past).toHaveLength(before + 1);
    s.getState().undo();
    expect(notes(s)).toEqual([note("kick", 0)]);
  });

  it("records nothing when the drag returns to its start", () => {
    const s = setNotes(fresh(), note("kick", 0));
    const original = notes(s);
    const before = s.getState().past.length;
    s.getState().beginGesture();
    s.getState().editNotes(() => [note("kick", 3)], { transient: true });
    s.getState().editNotes(() => original, { transient: true });
    s.getState().commitGesture();
    expect(s.getState().past).toHaveLength(before);
    expect(notes(s)).toBe(original);
  });

  it("restores the notes and keeps redo when a drag is cancelled", () => {
    const s = setNotes(fresh(), note("kick", 0), note("snare", 2));
    s.getState().undo();
    s.getState().beginGesture();
    s.getState().editNotes(() => [note("kick", 9)], { transient: true });
    s.getState().cancelGesture();
    expect(notes(s)).toEqual([]);
    expect(s.getState().future).toHaveLength(1);
    expect(s.getState().gestureBase).toBeNull();
  });

  it("commits an in-progress drag before undo, so undo reverts the drag rather than leaving a preview", () => {
    const s = setNotes(fresh(), note("kick", 0));
    s.getState().beginGesture();
    s.getState().editNotes(() => [note("kick", 5)], { transient: true });
    s.getState().undo();
    expect(notes(s)).toEqual([note("kick", 0)]);
    expect(s.getState().gestureBase).toBeNull();
    s.getState().redo();
    expect(notes(s)).toEqual([note("kick", 5)]);
  });

  it("records the pre-drag pattern, not a preview, when a non-transient edit lands mid-drag", () => {
    const s = setNotes(fresh(), note("kick", 0));
    s.getState().beginGesture();
    s.getState().editNotes(() => [note("kick", 5)], { transient: true });
    s.getState().setTempo(100);
    expect(s.getState().gestureBase).toBeNull();
    s.getState().undo();
    expect(notes(s)).toEqual([note("kick", 0)]);
  });

  it("applies a non-transient editNotes as one undo step and ignores a no-op", () => {
    const s = fresh();
    s.getState().editNotes(() => [note("kick", 0)]);
    expect(s.getState().past).toHaveLength(1);
    s.getState().editNotes((g) => g.notes);
    expect(s.getState().past).toHaveLength(1);
  });
});

describe("per-user pattern storage", () => {
  afterEach(() => setCurrentUserId("test-user"));

  it("does not show user A's pattern to user B on the same browser", () => {
    setCurrentUserId("a");
    getPatternStore("drums").getState().newEmptyPattern(drums, 4);
    getPatternStore("drums").getState().toggleNote("snare", 4);
    setCurrentUserId("b");
    expect(getPatternStore("drums").getState().pattern).toBeNull();
    setCurrentUserId("a");
    expect(getPatternStore("drums").getState().pattern?.notes).toHaveLength(1);
  });

  it("writes under a key containing the user id", () => {
    setCurrentUserId("a");
    getPatternStore("drums").getState().setPrompt("boom bap");
    expect(localStorage.getItem("songbird.patterns.a.drums.v1")).not.toBeNull();
    expect(localStorage.getItem("songbird.patterns.b.drums.v1")).toBeNull();
  });

  it("refuses to build a store before the user is known", () => {
    setCurrentUserId(null);
    expect(() => getPatternStore("drums")).toThrow(/No signed-in user/);
  });

  it("is removed from the browser when signing out", async () => {
    setCurrentUserId("a");
    getPatternStore("drums").getState().setPrompt("boom bap");
    window.history.replaceState(null, "", "/login");
    await signOutLocally();
    expect(localStorage.getItem("songbird.patterns.a.drums.v1")).toBeNull();
  });
});
