import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

// Next anchors matchers to the whole path, so the same is done here to reuse the real pattern.
const matcher = new RegExp(`^${config.matcher[0]}$`);
const gated = (path: string) => matcher.test(path);

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);

describe("proxy matcher", () => {
  it.each(["/", "/studio", "/instruments/drums", "/drum-machine", "/loginx", "/apix", "/listenx"])("gates %s", (path) => {
    expect(gated(path)).toBe(true);
  });

  it.each([
    "/login",
    "/login/extra",
    "/listen/abc",
    "/healthz",
    "/readyz",
    "/api/v1/auth/me",
    "/_next/static/chunks/a.js",
    "/_next/image",
    "/favicon.ico",
    "/kits/808/kick.wav",
    "/globe.svg",
  ])("leaves %s alone", (path) => {
    expect(gated(path)).toBe(false);
  });
});

describe("proxy", () => {
  it("redirects a cookie-less page request to login with the path kept", () => {
    const res = proxy(request("/studio?song=abc"));
    expect(res.status).toBe(307);
    const target = new URL(res.headers.get("location")!);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe("/studio?song=abc");
  });

  it.each(["__Host-songbird_session=t", "songbird_session=t"])("lets a request with %s through", (cookie) => {
    const res = proxy(request("/studio", cookie));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("ignores unrelated cookies", () => {
    expect(proxy(request("/studio", "other=1")).status).toBe(307);
  });

  it("shows a listen page to a visitor with no cookie, and to one with a session, alike", () => {
    expect(gated("/listen/abc")).toBe(false);
    expect(gated("/listen/abc/extra")).toBe(false);
  });

  it("does not redirect a cookie-less /healthz", () => {
    expect(gated("/healthz")).toBe(false);
  });
});
