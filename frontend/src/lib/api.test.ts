import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pattern } from "@/generated/Pattern";
import type { Song } from "@/generated/Song";
import {
  ApiError,
  exportMidi,
  generateTrack,
  generatePattern,
  getAiKeys,
  getInstruments,
  getLimits,
  getSongLimits,
  removeAiKey,
  saveAiKey,
  sendChat,
  setAiProvider,
} from "./api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const errorBody = (code: string, message = "server text") => ({
  error: { code, message },
});

function mockFetch(res: Response | Error) {
  const fn = vi.fn<typeof fetch>(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const pattern = { name: "Boom Bap!", tempo_bpm: 90, instrument: "drums" } as unknown as Pattern;

describe("api client", () => {
  it("getInstruments fetches the instrument list", async () => {
    const fn = mockFetch(json([{ id: "drums" }]));
    expect(await getInstruments()).toEqual([{ id: "drums" }]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("getLimits fetches the limits", async () => {
    const limits = { max_input_tokens: 256, measure_options: [4, 8] };
    const fn = mockFetch(json(limits));
    expect(await getLimits()).toEqual(limits);
    expect(fn.mock.calls[0][0]).toBe("/api/v1/patterns/limits");
  });

  it("generatePattern posts the body as JSON", async () => {
    const fn = mockFetch(json(pattern));
    const body = { instrument: "drums", prompt: "boom bap", measures: 4 };
    expect(await generatePattern(body)).toEqual(pattern);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("/api/v1/patterns/generate");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual(body);
  });

  it("getSongLimits fetches the song limits", async () => {
    const limits = { max_input_tokens: 256, max_range_measures: 32, max_song_measures: 128, max_tracks: 16, max_chat_messages: 20 };
    const fn = mockFetch(json(limits));
    expect(await getSongLimits()).toEqual(limits);
    expect(fn.mock.calls[0][0]).toBe("/api/v1/songs/limits");
  });

  it("generateTrack posts the body as JSON", async () => {
    const response = { track_id: "t1", range: { start_measure: 1, end_measure: 4 }, notes: [] };
    const fn = mockFetch(json(response));
    const body = {
      song: { name: "s" } as unknown as Song,
      track_id: "t1",
      prompt: "walking bass",
      range: { start_measure: 1, end_measure: 4 },
    };
    expect(await generateTrack(body)).toEqual(response);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("/api/v1/songs/tracks/generate");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual(body);
  });

  it.each([
    ["generation_failed", 502, "could not generate"],
    ["generation_timeout", 504, "too long"],
    ["prompt_too_long", 422, "too long"],
    ["invalid_range", 422, "measure range"],
    ["invalid_track", 422, "no longer in the song"],
    ["generation_busy", 503, "busy"],
  ])("generateTrack maps %s to a friendly message", async (code, status, fragment) => {
    mockFetch(json(errorBody(code), status));
    const err = await generateTrack({
      song: {} as unknown as Song,
      track_id: "t",
      prompt: "p",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toContain(fragment);
  });

  it("getAiKeys fetches the summary", async () => {
    const summary = { keys_required: true, active_provider: null, keys: [] };
    const fn = mockFetch(json(summary));
    expect(await getAiKeys()).toEqual(summary);
    expect(fn.mock.calls[0][0]).toBe("/api/v1/account/ai-keys");
  });

  it("saveAiKey puts the key in the body, never the URL", async () => {
    const fn = mockFetch(json({ keys_required: true, active_provider: "openai", keys: [] }));
    await saveAiKey("openai", "sk-secret");
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("/api/v1/account/ai-keys/openai");
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(init!.body as string)).toEqual({ key: "sk-secret" });
  });

  it("removeAiKey deletes the provider's key", async () => {
    const fn = mockFetch(json({ keys_required: true, active_provider: null, keys: [] }));
    await removeAiKey("anthropic");
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("/api/v1/account/ai-keys/anthropic");
    expect(init!.method).toBe("DELETE");
  });

  it("setAiProvider puts the provider", async () => {
    const fn = mockFetch(json({ keys_required: true, active_provider: "openai", keys: [] }));
    await setAiProvider("openai");
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("/api/v1/account/ai-provider");
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(init!.body as string)).toEqual({ provider: "openai" });
  });

  it.each([
    ["api_key_required", 409, "Anthropic or OpenAI key"],
    ["invalid_api_key_format", 422, "valid API key"],
  ])("maps %s to its own message, ignoring the server text", async (code, status, fragment) => {
    mockFetch(json(errorBody(code, "internal detail"), status));
    const err = await saveAiKey("openai", "x").catch((e) => e);
    expect(err.code).toBe(code);
    expect(err.message).toContain(fragment);
    expect(err.message).not.toContain("internal detail");
  });

  it.each([
    ["api_key_invalid", 409],
    ["api_key_quota_exhausted", 409],
    ["api_key_rate_limited", 429],
    ["api_key_rejected", 422],
  ])("shows the provider-naming server message for %s", async (code, status) => {
    mockFetch(json(errorBody(code, "Anthropic said no."), status));
    const err = await saveAiKey("anthropic", "x").catch((e) => e);
    expect(err.code).toBe(code);
    expect(err.message).toBe("Anthropic said no.");
  });

  it("generateTrack surfaces the server's reason for other 422 codes", async () => {
    mockFetch(json(errorBody("invalid_song", "song has no tracks"), 422));
    const err = await generateTrack({
      song: {} as unknown as Song,
      track_id: "t",
      prompt: "p",
    }).catch((e) => e);
    expect(err.message).toBe("song has no tracks");
  });

  it("generateTrack reports a network failure", async () => {
    mockFetch(new Error("offline"));
    const err = await generateTrack({
      song: {} as unknown as Song,
      track_id: "t",
      prompt: "p",
    }).catch((e) => e);
    expect(err.code).toBe("network_error");
  });

  it("sendChat posts the history and range as JSON", async () => {
    const response = { reply: "Added a Bass track.", track: null };
    const fn = mockFetch(json(response));
    const body = {
      song: { name: "s" } as unknown as Song,
      messages: [{ role: "user" as const, content: "now the bass" }],
      range: { start_measure: 1, end_measure: 8 },
    };
    expect(await sendChat(body)).toEqual(response);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("/api/v1/songs/chat");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual(body);
  });

  it.each([
    [502, "generation_failed", "could not generate"],
    [504, "generation_timeout", "too long"],
    [503, "generation_busy", "busy"],
    [400, "invalid_request", "Something went wrong"],
    [400, "prompt_too_long", "too long"],
    [400, "invalid_instrument", "not supported"],
    [400, "invalid_range", "measure range"],
  ])("sendChat maps a %s %s error", async (status, code, fragment) => {
    mockFetch(json(errorBody(code), status));
    const err = await sendChat({ song: {} as unknown as Song, messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(code);
    expect(err.message).toContain(fragment);
  });

  it("sendChat surfaces the server's reason for a 400 invalid_song or invalid_prompt", async () => {
    for (const code of ["invalid_song", "invalid_prompt"]) {
      mockFetch(json(errorBody(code, `reason for ${code}`), 400));
      const err = await sendChat({ song: {} as unknown as Song, messages: [] }).catch((e) => e);
      expect(err.message).toBe(`reason for ${code}`);
    }
  });

  it("exportMidi returns the blob and the server filename", async () => {
    mockFetch(
      new Response(new Uint8Array([77, 84, 104, 100]), {
        headers: {
          "Content-Type": "audio/midi",
          "Content-Disposition": 'attachment; filename="songbird-boom-bap-90bpm.mid"',
        },
      }),
    );
    const out = await exportMidi(pattern);
    expect(out.filename).toBe("songbird-boom-bap-90bpm.mid");
    expect(out.blob.size).toBe(4);
  });

  it("exportMidi falls back to a default filename", async () => {
    mockFetch(new Response(new Uint8Array([1])));
    expect((await exportMidi(pattern)).filename).toBe("songbird-boom-bap-90bpm.mid");
  });

  it.each([
    ["prompt_too_long", 422, /too long/i],
    ["invalid_instrument", 422, /instrument/i],
    ["generation_failed", 502, /could not generate/i],
    ["generation_timeout", 504, /too long|took/i],
    ["generation_busy", 503, /busy.*try again in a moment/i],
    ["payload_too_large", 413, /too large/i],
    ["invalid_json", 400, /understood/i],
    ["not_found", 404, /not found/i],
  ])("maps %s to a friendly message", async (code, status, re) => {
    mockFetch(json(errorBody(code), status));
    const err = await generatePattern({ instrument: "drums", prompt: "a", measures: 4 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toMatch(re);
    expect(err.message).not.toBe("server text");
  });

  it("surfaces the server message for other 422 validation codes", async () => {
    mockFetch(json(errorBody("invalid_tempo", "tempo must be 40-240"), 422));
    await expect(getLimits()).rejects.toThrow("tempo must be 40-240");
  });

  it("uses a generic message for non-JSON error responses", async () => {
    mockFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    const err = await getLimits().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("unknown");
    expect(err.message).toMatch(/something went wrong/i);
  });

  it("reports network failures distinctly", async () => {
    mockFetch(new TypeError("Failed to fetch"));
    const err = await getInstruments().catch((e) => e);
    expect(err.code).toBe("network_error");
    expect(err.message).toMatch(/could not reach/i);
  });
});
