import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { login, logout, me, setUsername } from "./client";
import { navigateTo } from "./navigation";
import { PER_USER_IDB_DATABASES } from "./perUserStores";
import { signOutLocally } from "./signOut";

vi.mock("./navigation", () => ({ navigateTo: vi.fn() }));
// The real list is empty, which would leave the wipe path untested.
vi.mock("./perUserStores", async (original) => ({
  ...(await original<typeof import("./perUserStores")>()),
  PER_USER_IDB_DATABASES: ["wiped-db"],
}));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const errorBody = (code: string) => ({ error: { code, message: "server text" } });

const databaseNames = async () => (await indexedDB.databases()).map((d) => d.name);

function createDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(navigateTo).mockClear();
  window.history.replaceState(null, "", "/?song=a#top");
});
afterEach(() => vi.unstubAllGlobals());

describe("signOutLocally", () => {
  it("clears every songbird.* key but not foreign keys, and every registered database", async () => {
    localStorage.setItem("songbird.metronome.v1", "x");
    localStorage.setItem("songbird.patterns.u1.drums.v1", "x");
    localStorage.setItem("unrelated", "keep");
    const [registered] = PER_USER_IDB_DATABASES;
    await createDatabase(registered);
    await createDatabase("keyval-store");
    await createDatabase("songbird-samples.u1");

    await signOutLocally();

    expect(localStorage.getItem("songbird.metronome.v1")).toBeNull();
    expect(localStorage.getItem("songbird.patterns.u1.drums.v1")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
    const names = await databaseNames();
    expect(names).not.toContain(registered);
    expect(names).toContain("keyval-store");
    expect(names).toContain("songbird-samples.u1");
  });

  it("navigates to login with the current path, query and fragment encoded", async () => {
    await signOutLocally();
    expect(navigateTo).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/?song=a#top")}`);
  });

  it("does not navigate when already on the login page", async () => {
    window.history.replaceState(null, "", "/login");
    await signOutLocally();
    expect(navigateTo).not.toHaveBeenCalled();
  });
});

describe("401 handling in request()", () => {
  it("signs out on 401 unauthenticated and still rejects", async () => {
    localStorage.setItem("songbird.studio.lastSong", "s1");
    vi.stubGlobal("fetch", vi.fn(async () => json(errorBody("unauthenticated"), 401)));

    await expect(me()).rejects.toMatchObject({ code: "unauthenticated", status: 401 });

    expect(localStorage.getItem("songbird.studio.lastSong")).toBeNull();
    expect(navigateTo).toHaveBeenCalledTimes(1);
  });

  it("does not sign out when login fails with invalid_credentials", async () => {
    localStorage.setItem("songbird.studio.lastSong", "s1");
    vi.stubGlobal("fetch", vi.fn(async () => json(errorBody("invalid_credentials"), 401)));

    const error = await login("a@b.c", "wrong").catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("Email or password is incorrect.");
    expect(localStorage.getItem("songbird.studio.lastSong")).toBe("s1");
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("keeps Retry-After on throttled responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(errorBody("too_many_requests"), 429, { "Retry-After": "7" })));
    await expect(login("a@b.c", "x")).rejects.toMatchObject({ code: "too_many_requests", retryAfterMs: 7000 });
  });
});

describe("setUsername", () => {
  it("puts the username and returns the updated user", async () => {
    const fn = vi.fn<typeof fetch>(async () => json({ user: { id: "u1", email: "a@b.c", username: "ana" } }));
    vi.stubGlobal("fetch", fn);
    expect(await setUsername("ana")).toEqual({ id: "u1", email: "a@b.c", username: "ana" });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("/api/v1/account/username");
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(init!.body as string)).toEqual({ username: "ana" });
  });

  it("maps 409 username_taken to a readable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(errorBody("username_taken"), 409)));
    await expect(setUsername("ana")).rejects.toMatchObject({
      code: "username_taken",
      status: 409,
      message: "That username is taken. Try another.",
    });
  });

  it("maps 422 invalid_username to the rules, not the server's developer text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(errorBody("invalid_username"), 422)));
    const error = await setUsername("1ana").catch((e) => e);
    expect(error).toMatchObject({ code: "invalid_username", status: 422 });
    expect(error.message).toMatch(/3 to 30 characters/);
  });

  it("keeps Retry-After when throttled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(errorBody("too_many_requests"), 429, { "Retry-After": "60" })));
    await expect(setUsername("ana")).rejects.toMatchObject({ status: 429, retryAfterMs: 60_000 });
  });

  it("does not sign out when told not to", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(errorBody("unauthenticated"), 401)));
    await expect(setUsername("ana", { signOutOnUnauthenticated: false })).rejects.toMatchObject({ status: 401 });
    expect(navigateTo).not.toHaveBeenCalled();
  });
});

describe("auth client", () => {
  it("login posts the credentials and returns the user", async () => {
    const fn = vi.fn<typeof fetch>(async () => json({ user: { id: "u1", email: "a@b.c" } }));
    vi.stubGlobal("fetch", fn);

    expect(await login("a@b.c", "pw")).toEqual({ id: "u1", email: "a@b.c" });

    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("/api/v1/auth/login");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ email: "a@b.c", password: "pw" });
  });

  it("me returns the signed-in user with their username", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ user: { id: "u1", email: "a@b.c", username: null } })));
    expect(await me()).toEqual({ id: "u1", email: "a@b.c", username: null });
  });

  it("logout posts and accepts 204", async () => {
    const fn = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fn);
    await logout();
    expect(fn.mock.calls[0][0]).toBe("/api/v1/auth/logout");
    expect(fn.mock.calls[0][1]!.method).toBe("POST");
  });
});
