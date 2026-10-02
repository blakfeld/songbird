import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAMES } from "@/lib/auth/sessionCookie";

// Only the cookie's presence is checked: the backend is the authority, and validating here would
// cost a server-to-server call per navigation. A stale cookie is caught by the first API 401.
export function proxy(request: NextRequest) {
  if (SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))) {
    return NextResponse.next();
  }
  const { pathname, search } = request.nextUrl;
  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

// Next requires a literal here so it can be analysed at build time. Health probes carry no cookie
// and the proxy runs before rewrites, so gating them would answer a redirect instead of the
// backend's health response. Any path with a dot is treated as a static asset.
export const config = {
  matcher: ["/((?!(?:login|healthz|readyz|api|_next)(?:/|$)|.*\\..*).*)"],
};
