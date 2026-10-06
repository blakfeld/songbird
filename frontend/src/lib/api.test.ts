import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@/generated/ChatEvent";
import type { Pattern } from "@/generated/Pattern";
import type { Song } from "@/generated/Song";
import {
  ApiError,
  assistLyrics,
  exportMidi,
  generateTopline,
  generateTrack,
  generatePattern,
  getAiKeys,
  getInstruments,
  getLimits,
  getSongLimits,
  removeAiKey,
  saveAiKey,
  setAiProvider,
  streamChat,
} from "./api";
import { signOutLocally } from "./auth/signOut";

vi.mock("./auth/signOut", () => ({ signOutLocally: vi.fn(async () => undefined) }));

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

  describe("generateTopline", () => {
    const body = {
      song: { name: "s" } as unknown as Song,
      track_id: "t1",
      range: { start_measure: 5, end_measure: 8 },
      section_name: "Chorus",
      lines: [{ text: "hold me", syllables: [{ text: "hold", stressed: true }, { text: "me", stressed: false }] }],
      voice: "tenor" as const,
      prompt: "",
    };

    it("posts the body as JSON and returns the notes and prosody", async () => {
      const response = {
        track_id: "t1",
        range: body.range,
        notes: [],
        prosody: { stressed_syllables: 1, stressed_on_beat: 1 },
      };
      const fn = mockFetch(json(response));
      expect(await generateTopline(body)).toEqual(response);
      const [url, init] = fn.mock.calls[0];
      expect(url).toBe("/api/v1/songs/topline/generate");
      expect(init!.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual(body);
    });

    it.each([
      ["generation_failed", 502, "could not generate"],
      ["generation_timeout", 504, "too long"],
      ["generation_busy", 503, "busy"],
      ["invalid_range", 422, "measure range"],
      ["invalid_track", 422, "no longer in the song"],
      ["prompt_too_long", 422, "too long"],
      ["api_key_required", 409, "key"],
      ["unauthenticated", 401, "sign in"],
      ["too_many_requests", 429, "Too many"],
    ])("maps %s to a friendly message", async (code, status, fragment) => {
      mockFetch(json(errorBody(code), status));
      const err = await generateTopline(body).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message).toContain(fragment);
    });

    it.each(["invalid_lyrics", "lyrics_do_not_fit", "invalid_voice", "invalid_song"])(
      "surfaces the server's reason for %s",
      async (code) => {
        mockFetch(json(errorBody(code, "specific reason"), 422));
        const err = await generateTopline(body).catch((e) => e);
        expect(err.message).toBe("specific reason");
      },
    );

    it("keeps the provider's message for a key problem", async () => {
      mockFetch(json(errorBody("api_key_quota_exhausted", "Anthropic is out of credit."), 409));
      const err = await generateTopline(body).catch((e) => e);
      expect(err.message).toBe("Anthropic is out of credit.");
    });

    it("reports a network failure", async () => {
      mockFetch(new Error("offline"));
      expect((await generateTopline(body).catch((e) => e)).code).toBe("network_error");
    });
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

  it("streamChat posts the history and range as JSON", async () => {
    const response = { reply: "Added a Bass track.", track: null };
    const fn = mockFetch(json(response));
    const body = {
      song: { name: "s" } as unknown as Song,
      messages: [{ role: "user" as const, content: "now the bass" }],
      range: { start_measure: 1, end_measure: 8 },
    };
    const onEvent = vi.fn();
    await streamChat(body, { onEvent });
    expect(onEvent).toHaveBeenCalledWith({ event: "result", data: response });
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
  ])("streamChat maps a %s %s error", async (status, code, fragment) => {
    mockFetch(json(errorBody(code), status));
    const err = await streamChat({ song: {} as unknown as Song, messages: [] }, { onEvent: vi.fn() }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(code);
    expect(err.message).toContain(fragment);
  });

  it("streamChat surfaces the server's reason for a 400 invalid_song or invalid_prompt", async () => {
    for (const code of ["invalid_song", "invalid_prompt"]) {
      mockFetch(json(errorBody(code, `reason for ${code}`), 400));
      const err = await streamChat({ song: {} as unknown as Song, messages: [] }, { onEvent: vi.fn() }).catch((e) => e);
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

describe("assistLyrics", () => {
  const body = {
    song_context: { name: "S", tempo_bpm: 100, time_signature: "4/4", sections: [] },
    lyrics: "",
    messages: [{ role: "user", content: "hi" }],
  } as unknown as Parameters<typeof assistLyrics>[0];

  it("posts to the lyrics endpoint and returns the reply", async () => {
    const fn = mockFetch(json({ reply: "ok", suggestions: [] }));
    expect(await assistLyrics(body)).toEqual({ reply: "ok", suggestions: [] });
    expect(fn.mock.calls[0][0]).toBe("/api/v1/lyrics/assist");
    expect(fn.mock.calls[0][1]?.method).toBe("POST");
  });

  it.each(["invalid_messages", "invalid_selection", "invalid_song_context", "lyrics_too_long"])(
    "surfaces the server's message for a 422 %s",
    async (code) => {
      mockFetch(json(errorBody(code, "the selection is outside the lyrics"), 422));
      const err = await assistLyrics(body).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).toBe("the selection is outside the lyrics");
    },
  );
});

describe("streamChat", () => {
  const body = { song: {} as unknown as Song, messages: [] };
  const encoder = new TextEncoder();
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const result = { reply: "done", track: null };

  function sseResponse(chunks: string[], onCancel?: () => void) {
    return new Response(
      new ReadableStream({
        start(c) {
          for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
          // Left open after a terminal event, as a live connection would be, so only a cancel can release it.
          if (!onCancel) c.close();
        },
        cancel: onCancel,
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }

  // Stays open until the test pushes, closes or aborts it, so idleness is the only other way it ends.
  function openStream(signal?: AbortSignal) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const res = new Response(
      new ReadableStream({
        start: (c) => void (controller = c),
        cancel: () => void (cancelled = true),
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    // A real fetch body errors when its signal aborts; the mock has to do the same.
    signal?.addEventListener("abort", () => controller.error(signal.reason));
    return { res, push: (t: string) => controller.enqueue(encoder.encode(t)), wasCancelled: () => cancelled };
  }

  it("sends an event-stream Accept header and delivers events in order", async () => {
    const fn = mockFetch(
      sseResponse([
        ": keepalive\n\n",
        frame("progress", { stage: "planning" }),
        frame("reply_delta", { text: "Hi" }),
        frame("result", result),
      ]),
    );
    const events: ChatEvent[] = [];
    await streamChat(body, { onEvent: (e) => events.push(e) });
    expect(events).toEqual([
      { event: "progress", data: { stage: "planning" } },
      { event: "reply_delta", data: { text: "Hi" } },
      { event: "result", data: result },
    ]);
    const init = fn.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
  });

  it("maps a non-2xx response through toApiError", async () => {
    mockFetch(json(errorBody("generation_busy"), 503));
    const err = await streamChat(body, { onEvent: vi.fn() }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("generation_busy");
  });

  it("treats a 2xx JSON response as a single result", async () => {
    mockFetch(json(result));
    const events: ChatEvent[] = [];
    await streamChat(body, { onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ event: "result", data: result }]);
  });

  it("turns an error event into an ApiError with retry_after", async () => {
    mockFetch(
      sseResponse([
        frame("error", { code: "api_key_rate_limited", message: "Anthropic is rate limiting", retry_after: 30 }),
      ]),
    );
    const err = await streamChat(body, { onEvent: vi.fn() }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("api_key_rate_limited");
    expect(err.message).toBe("Anthropic is rate limiting");
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("signs out on an unauthenticated error event", async () => {
    vi.mocked(signOutLocally).mockClear();
    mockFetch(sseResponse([frame("error", { code: "unauthenticated", message: "x" })]));
    await streamChat(body, { onEvent: vi.fn() }).catch(() => undefined);
    expect(signOutLocally).toHaveBeenCalledOnce();
  });

  it("signs out on an unauthenticated HTTP response", async () => {
    vi.mocked(signOutLocally).mockClear();
    mockFetch(json(errorBody("unauthenticated"), 401));
    await streamChat(body, { onEvent: vi.fn() }).catch(() => undefined);
    expect(signOutLocally).toHaveBeenCalledOnce();
  });

  it("fails with network_error when the stream ends without a result", async () => {
    mockFetch(sseResponse([frame("progress", { stage: "planning" }), "event: result\ndata: {"]));
    const err = await streamChat(body, { onEvent: vi.fn() }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("network_error");
  });

  it("propagates an exception thrown by onEvent unchanged", async () => {
    mockFetch(sseResponse([frame("progress", { stage: "planning" }), frame("result", result)]));
    const bug = new Error("handler bug");
    const err = await streamChat(body, {
      onEvent: () => {
        throw bug;
      },
    }).catch((e) => e);
    expect(err).toBe(bug);
  });

  it("ignores unknown events and the default message event", async () => {
    mockFetch(
      sseResponse([
        frame("message", { a: 1 }),
        frame("mystery", { b: 2 }),
        frame("progress", { stage: "planning" }),
        frame("result", result),
      ]),
    );
    const events: ChatEvent[] = [];
    await streamChat(body, { onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.event)).toEqual(["progress", "result"]);
  });

  describe("cleanup", () => {
    afterEach(() => vi.useRealTimers());

    it("cancels the body and leaves no timers after a result", async () => {
      vi.useFakeTimers();
      let cancelled = false;
      mockFetch(sseResponse([frame("result", result)], () => void (cancelled = true)));
      await streamChat(body, { onEvent: vi.fn() });
      expect(cancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves no timers after an error event", async () => {
      vi.useFakeTimers();
      let cancelled = false;
      mockFetch(sseResponse([frame("error", { code: "generation_failed", message: "x" })], () => void (cancelled = true)));
      await streamChat(body, { onEvent: vi.fn() }).catch(() => undefined);
      expect(cancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves no timers when the stream ends without a result", async () => {
      vi.useFakeTimers();
      mockFetch(sseResponse([frame("progress", { stage: "planning" })]));
      await streamChat(body, { onEvent: vi.fn() }).catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels the body and leaves no timers after an idle timeout", async () => {
      vi.useFakeTimers();
      const stream = openStream();
      mockFetch(stream.res);
      const pending = streamChat(body, { onEvent: vi.fn() }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(45_000);
      await pending;
      expect(stream.wasCancelled()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves no timers after an abort", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      mockFetch(openStream(controller.signal).res);
      const pending = streamChat(body, { signal: controller.signal, onEvent: vi.fn() }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("fails with network_error when fetch rejects", async () => {
    mockFetch(new TypeError("offline"));
    const err = await streamChat(body, { onEvent: vi.fn() }).catch((e) => e);
    expect(err.code).toBe("network_error");
  });

  describe("idle timeout", () => {
    afterEach(() => vi.useRealTimers());

    it("fails with network_error after 45 s without bytes", async () => {
      vi.useFakeTimers();
      mockFetch(openStream().res);
      const pending = streamChat(body, { onEvent: vi.fn() }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(45_000);
      const err = await pending;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("network_error");
    });

    it("counts keepalive comments as bytes", async () => {
      vi.useFakeTimers();
      const { res, push } = openStream();
      mockFetch(res);
      const events: ChatEvent[] = [];
      const pending = streamChat(body, { onEvent: (e) => events.push(e) }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(40_000);
      push(": keepalive\n\n");
      await vi.advanceTimersByTimeAsync(40_000);
      push(frame("result", result));
      expect(await pending).toBeUndefined();
      expect(events).toEqual([{ event: "result", data: result }]);
    });
  });

  describe("abort", () => {
    it("rethrows the AbortError when aborted before the response", async () => {
      const controller = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          controller.abort();
          throw init!.signal!.reason;
        }),
      );
      const err = await streamChat(body, { signal: controller.signal, onEvent: vi.fn() }).catch((e) => e);
      expect(err).not.toBeInstanceOf(ApiError);
      expect(err.name).toBe("AbortError");
    });

    it("rethrows the AbortError when aborted mid-stream", async () => {
      const controller = new AbortController();
      mockFetch(openStream(controller.signal).res);
      const pending = streamChat(body, { signal: controller.signal, onEvent: vi.fn() }).catch((e) => e);
      await Promise.resolve();
      controller.abort();
      const err = await pending;
      expect(err).not.toBeInstanceOf(ApiError);
      expect(err.name).toBe("AbortError");
    });
  });
});
