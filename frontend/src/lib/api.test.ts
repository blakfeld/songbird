import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pattern } from "@/generated/Pattern";
import {
  ApiError,
  exportMidi,
  generatePattern,
  getInstruments,
  getLimits,
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
