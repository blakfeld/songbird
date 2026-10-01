import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import {
  MAX_PROJECT_BYTES,
  parseProjectFile,
  projectFilename,
  readProjectFile,
  serializeProject,
} from "./projectFile";
import type { Song } from "./types";

interface Case {
  name: string;
  song: Song;
  error: string | null;
}

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../fixtures/song_validation.json"), "utf8"),
);

// The registry the server really serves, so a row or instrument the stub forgot cannot hide a mismatch.
const instruments: InstrumentInfo[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../fixtures/instruments.json"), "utf8"),
);

const file = (song: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: "songbird-song", version: 1, song, ...over });

const valid = fixture.cases.filter((c) => c.error === null);
const invalid = fixture.cases.filter((c) => c.error !== null);
const base = valid[0].song;

const failure = (text: string) => {
  const r = parseProjectFile(text, instruments);
  return "error" in r ? r : null;
};
const error = (text: string) => failure(text)?.error ?? null;

describe("parseProjectFile against the shared song fixture", () => {
  it.each(valid)("accepts: $name", (c) => {
    expect(error(file(c.song))).toBeNull();
  });

  it.each(invalid)("rejects ($error): $name", (c) => {
    expect(failure(file(c.song))?.kind).toBe(c.error);
  });
});

describe("parseProjectFile", () => {
  it("round-trips a song", () => {
    const r = parseProjectFile(serializeProject(base), instruments);
    expect(r).toEqual({ ok: expect.objectContaining({ id: base.id, name: base.name, tracks: base.tracks }) });
  });

  it("writes the envelope with loops and clips as they are", () => {
    const doc = JSON.parse(serializeProject(base));
    expect(doc).toMatchObject({ format: "songbird-song", version: 1 });
    expect(doc.song).toEqual(base);
  });

  it("keeps unknown fields inside sound", () => {
    const sound = { tone: { filter_cutoff_hz: 800, future_knob: 1 }, future_group: true };
    const song = { ...base, tracks: [{ ...base.tracks[0], sound }, ...base.tracks.slice(1)] };
    const r = parseProjectFile(file(song), instruments);
    expect("ok" in r && r.ok.tracks[0].sound).toEqual(sound);
  });

  it("rejects a bad sound with the track and setting named", () => {
    const sound = { effects: { delay: { feedback: 1.5 } } };
    const song = { ...base, tracks: [{ ...base.tracks[0], sound }, ...base.tracks.slice(1)] };
    expect(error(file(song))).toMatch(/Track 1 "Drums": feedback must be 0-0.9, got 1.5/);
  });

  it("rejects a newer project version", () => {
    expect(error(file(base, { version: 2 }))).toMatch(/newer version of Songbird/);
  });

  it("rejects an unknown instrument by name", () => {
    const song = { ...base, tracks: [{ ...base.tracks[0], instrument: "theremin" }] };
    expect(error(file(song))).toMatch(/theremin/);
  });

  it("rejects invalid JSON and other formats", () => {
    expect(error("{nope")).toMatch(/valid JSON/);
    expect(error(file(base, { format: "other" }))).toMatch(/isn't a Songbird project/);
  });

  it("names the track with overlapping clips", () => {
    const [drumsTrack, ...rest] = base.tracks;
    const clips = [
      { id: "a", loop_id: drumsTrack.loops[0].id, start_measure: 1, measures: 3 },
      { id: "b", loop_id: drumsTrack.loops[0].id, start_measure: 3, measures: 2 },
    ];
    const song = { ...base, tracks: [{ ...drumsTrack, clips }, ...rest] };
    expect(error(file(song))).toMatch(/"Drums".*overlapping/);
  });

  it("keeps an unrecognised optional field", () => {
    const song = { ...base, mood: "wistful" };
    const r = parseProjectFile(file(song), instruments);
    expect(r).toHaveProperty("ok");
    expect(JSON.parse(serializeProject((r as { ok: Song }).ok)).song.mood).toBe("wistful");
  });

  it("converts an older song document as the library does", () => {
    const track = { ...base.tracks[0], loops: undefined, clips: undefined };
    const v1 = {
      ...base,
      version: 1,
      tracks: [{ ...track, notes: [{ row_id: "kick", step: 0, length_steps: 1, velocity: 100 }] }],
    };
    const r = parseProjectFile(file(v1), instruments);
    expect(r).toHaveProperty("ok");
    expect((r as { ok: Song }).ok.version).toBe(2);
    expect((r as { ok: Song }).ok.tracks[0].clips).toHaveLength(1);
  });

  it("refuses a file over 5 MB before reading it", async () => {
    const big = { size: MAX_PROJECT_BYTES + 1, text: () => Promise.reject(new Error("read")) } as unknown as File;
    expect(await readProjectFile(big, instruments)).toMatchObject({ kind: "size", error: expect.stringMatching(/5 MB/) });
  });

  it("names the download after the song", () => {
    expect(projectFilename({ name: "Late Train" })).toBe("late-train.songbird.json");
  });
});
