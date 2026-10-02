import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { LyricsAssistResponse } from "@/generated/LyricsAssistResponse";
import { parseProjectFile, serializeProject } from "./projectFile";
import { createSongStore } from "./songStore";
import { newSongWithTracks } from "./testFixtures";

const instruments: InstrumentInfo[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../fixtures/instruments.json"), "utf8"),
);

const setup = () => createSongStore(newSongWithTracks());
const reply = (text = "ok", suggestions: LyricsAssistResponse["suggestions"] = []): LyricsAssistResponse => ({
  reply: text,
  suggestions,
});

describe("applyLyricReply", () => {
  it("is not an undo step", () => {
    const store = setup();
    store.getState().applyLyricReply("help", null, reply(), {});
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().song!.lyric_chat).toHaveLength(2);
  });

  it("keeps the conversation through song undo and redo", () => {
    const store = setup();
    store.getState().setTempo(100);
    store.getState().applyLyricReply("help", null, reply(), {});
    store.getState().undo();
    expect(store.getState().song!.lyric_chat).toHaveLength(2);
    store.getState().redo();
    expect(store.getState().song!.lyric_chat).toHaveLength(2);
  });

  it("trims past 20 messages to the latest 20", () => {
    const store = setup();
    for (let i = 0; i < 10; i++) store.getState().applyLyricReply(`q${i}`, null, reply(`a${i}`), {});
    store.getState().applyLyricReply("q10", null, reply("a10"), {});
    const chat = store.getState().song!.lyric_chat!;
    expect(chat).toHaveLength(20);
    expect(chat[0]).toMatchObject({ role: "user", content: "q1" });
    expect(chat[19].content).toBe("a10");
  });

  it("clips long content to 4,000 characters", () => {
    const store = setup();
    store.getState().applyLyricReply("x".repeat(5000), null, reply("y".repeat(5000)), {});
    expect(store.getState().song!.lyric_chat!.map((e) => [...e.content].length)).toEqual([4000, 4000]);
  });

  it("stores the selection and each suggestion's section name on the assistant entry", () => {
    const store = setup();
    const suggestions: LyricsAssistResponse["suggestions"] = [
      { id: "1", label: "A", text: "t", action: "replace_section", section_id: "s1" },
      { id: "2", label: "B", text: "t", action: "insert" },
    ];
    store.getState().applyLyricReply("go", { from: 1, to: 4, text: "abc" }, reply("r", suggestions), { s1: "Chorus" });
    const [user, assistant] = store.getState().song!.lyric_chat!;
    expect(user.selection).toBeUndefined();
    expect(assistant.selection).toEqual({ from: 1, to: 4, text: "abc" });
    expect(assistant.suggestions![0].section_name).toBe("Chorus");
    expect(assistant.suggestions![1]).not.toHaveProperty("section_name");
  });

  it("does not record an empty selection", () => {
    const store = setup();
    store.getState().applyLyricReply("go", { from: 3, to: 3, text: "" }, reply(), {});
    expect(store.getState().song!.lyric_chat![1]).not.toHaveProperty("selection");
  });
});

describe("clearLyricChat", () => {
  it("leaves lyrics and the arrangement chat alone and omits the field", () => {
    const store = setup();
    store.getState().applyChatResult("hi", { reply: "hello", track: null });
    store.getState().setLyrics("[Chorus]\nla");
    store.getState().applyLyricReply("help", null, reply(), {});
    store.getState().clearLyricChat();
    const song = store.getState().song!;
    expect(song).not.toHaveProperty("lyric_chat");
    expect(song.lyrics).toBe("[Chorus]\nla");
    expect(song.chat).toHaveLength(2);
    expect(store.getState().past).toHaveLength(0);
  });
});

describe("lyric chat in project files", () => {
  it("round-trips the conversation with its suggestions", () => {
    const store = setup();
    const suggestions: LyricsAssistResponse["suggestions"] = [
      { id: "1", label: "A", text: "t", action: "replace_section", section_id: "s1" },
    ];
    store.getState().applyLyricReply("go", { from: 0, to: 2, text: "la" }, reply("r", suggestions), { s1: "Chorus" });
    const song = store.getState().song!;
    const parsed = parseProjectFile(serializeProject(song), instruments);
    expect("ok" in parsed && parsed.ok.lyric_chat).toEqual(song.lyric_chat);
  });

  it("opens an old song with no conversation", () => {
    const parsed = parseProjectFile(serializeProject(newSongWithTracks()), instruments);
    expect("ok" in parsed && parsed.ok.lyric_chat).toBeUndefined();
  });
});
