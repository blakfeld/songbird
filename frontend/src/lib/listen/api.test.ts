import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMidi, getShare, ListenError, midiUrl, postComment, remixShare } from "./api";

const signOutLocally = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/signOut", () => ({ signOutLocally, isSigningOut: () => false }));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  localStorage.setItem("songbird.studio.rightTab", "lyrics");
});
afterEach(() => {
  fetchMock.mockReset();
  signOutLocally.mockClear();
  vi.unstubAllGlobals();
});

describe("listen api", () => {
  it.each([
    [401, { error: { code: "unauthenticated", message: "x" } }],
    [404, { error: { code: "not_found", message: "x" } }],
  ])("a %s neither signs out nor touches per-user storage", async (status, body) => {
    fetchMock.mockResolvedValue(json(status, body));
    const err = await getShare("tok").catch((e) => e);
    expect(err).toBeInstanceOf(ListenError);
    expect(signOutLocally).not.toHaveBeenCalled();
    expect(localStorage.getItem("songbird.studio.rightTab")).toBe("lyrics");
    expect(localStorage.length).toBe(1);
  });

  it("turns every 404 into the same unavailable message", async () => {
    fetchMock.mockResolvedValue(json(404, { error: { code: "not_found", message: "this link was revoked" } }));
    const err = (await getShare("tok").catch((e) => e)) as ListenError;
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("This link isn't available");
  });

  it("reports a throttle with how long to wait", async () => {
    fetchMock.mockResolvedValue(json(429, { error: { code: "too_many_requests", message: "x" } }, { "Retry-After": "30" }));
    const err = (await postComment("tok", { body: "Hi", at_step: 0 }).catch((e) => e)) as ListenError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("keeps the server's reason for an invalid comment", async () => {
    fetchMock.mockResolvedValue(json(422, { error: { code: "invalid_comment", message: "Position is past the end." } }));
    const err = (await postComment("tok", { body: "Hi", at_step: 9 }).catch((e) => e)) as ListenError;
    expect(err.message).toBe("Position is past the end.");
  });

  it("sends only body and at_step, with the session cookie", async () => {
    fetchMock.mockResolvedValue(json(201, { comment: { id: "c1" } }));
    await postComment("tok", { body: "Hi", at_step: 4 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/listen/tok/comments");
    expect(JSON.parse(init.body)).toEqual({ body: "Hi", at_step: 4 });
    expect(init.credentials).not.toBe("omit");
  });

  it("never sends a name or website, even if a caller passes them", async () => {
    fetchMock.mockResolvedValue(json(201, { comment: { id: "c1" } }));
    await postComment("tok", { name: "Sam", website: "x", body: "Hi", at_step: 4 } as never);
    expect(Object.keys(JSON.parse(fetchMock.mock.calls[0][1].body)).sort()).toEqual(["at_step", "body"]);
  });

  it("keeps read calls cookie-free", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await getShare("tok");
    expect(fetchMock.mock.calls[0][1].credentials).toBe("omit");
  });

  it.each([
    ["postComment", () => postComment("tok", { body: "Hi", at_step: 0 })],
    ["remixShare", () => remixShare("tok")],
  ])("%s on a 401 reports it without signing out or touching storage", async (_name, call) => {
    fetchMock.mockResolvedValue(json(401, { error: { code: "unauthenticated", message: "x" } }));
    const err = (await call().catch((e) => e)) as ListenError;
    expect(err).toBeInstanceOf(ListenError);
    expect(err.status).toBe(401);
    expect(signOutLocally).not.toHaveBeenCalled();
    expect(localStorage.getItem("songbird.studio.rightTab")).toBe("lyrics");
  });

  it("posts the remix with the session cookie and no body, and returns the new project id", async () => {
    fetchMock.mockResolvedValue(json(201, { project: { id: "p9", revision: 1, updated_at: 1, song: {} } }));
    expect(await remixShare("a/b")).toBe("p9");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/listen/a%2Fb/remix");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.credentials).not.toBe("omit");
  });

  it("reports the project limit, a throttle and a missing link from a remix", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: "project_limit", message: "x" } }));
    expect(await remixShare("tok").catch((e) => e)).toMatchObject({ code: "project_limit", status: 409 });
    fetchMock.mockResolvedValueOnce(json(429, { error: { code: "too_many_requests", message: "x" } }, { "Retry-After": "3" }));
    expect(await remixShare("tok").catch((e) => e)).toMatchObject({ status: 429, retryAfterMs: 3000 });
    fetchMock.mockResolvedValueOnce(json(404, { error: { code: "not_found", message: "x" } }));
    expect(await remixShare("tok").catch((e) => e)).toMatchObject({ status: 404 });
  });

  it("reports username_required from a comment", async () => {
    fetchMock.mockResolvedValue(json(409, { error: { code: "username_required", message: "x" } }));
    expect(await postComment("tok", { body: "Hi", at_step: 0 }).catch((e) => e)).toMatchObject({
      code: "username_required",
      status: 409,
    });
  });

  it("encodes the token into the path", async () => {
    fetchMock.mockResolvedValue(json(404, {}));
    await getShare("a/b").catch(() => {});
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/listen/a%2Fb");
    expect(midiUrl("a/b")).toBe("/api/v1/listen/a%2Fb/midi");
  });

  it("reports a network failure without signing out", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const err = (await getShare("tok").catch((e) => e)) as ListenError;
    expect(err.code).toBe("network_error");
    expect(signOutLocally).not.toHaveBeenCalled();
  });

  it("returns the MIDI file as a blob", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    expect((await getMidi("tok")).size).toBe(3);
  });
});
