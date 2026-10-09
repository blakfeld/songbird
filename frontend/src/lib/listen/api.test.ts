import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMidi, getShare, ListenError, midiUrl, postComment } from "./api";

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
    const err = (await postComment("tok", { name: "Sam", body: "Hi", at_step: 0 }).catch((e) => e)) as ListenError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("keeps the server's reason for an invalid comment", async () => {
    fetchMock.mockResolvedValue(json(422, { error: { code: "invalid_comment", message: "Position is past the end." } }));
    const err = (await postComment("tok", { name: "Sam", body: "Hi", at_step: 9 }).catch((e) => e)) as ListenError;
    expect(err.message).toBe("Position is past the end.");
  });

  it("sends only name, body and at_step, and no credentials", async () => {
    fetchMock.mockResolvedValue(json(201, { comment: { id: "c1" } }));
    await postComment("tok", { name: "Sam", body: "Hi", at_step: 4, website: "" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/listen/tok/comments");
    expect(JSON.parse(init.body)).toEqual({ name: "Sam", body: "Hi", at_step: 4 });
    expect(init.credentials).toBe("omit");
  });

  it("sends the honeypot only when it is filled", async () => {
    fetchMock.mockResolvedValue(json(201, { comment: { id: "c1" } }));
    await postComment("tok", { name: "Sam", body: "Hi", at_step: 4, website: "http://spam.example" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).website).toBe("http://spam.example");
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
